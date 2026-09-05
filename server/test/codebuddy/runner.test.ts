import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import type { LiveEvent } from '../../../shared/protocol.js';
import { codebuddyAdapter } from '../../src/switch/adapters/codebuddy.js';
import { codebuddyProjectKey, legacyCodebuddyProjectKey } from '../../src/codebuddy/projectKey.js';
import { toCanonicalTurns } from '../../src/switch/canonical.js';
import {
  repairLegacyCodebuddyResumePath,
  startCodebuddyRun,
  type CodebuddyRunOptions,
} from '../../src/codebuddy/runner.js';
import {
  compareTurns,
  fixtureDanglingUser,
  makeTempEnv,
  readBackNative,
} from '../switch/helpers.js';

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  exitCode: number | null = null;
  killed = false;
  private closed = false;

  kill(signal: NodeJS.Signals | number = 'SIGTERM'): boolean {
    if (this.closed) return false;
    this.killed = true;
    this.close(typeof signal === 'number' ? signal : 1, typeof signal === 'string' ? signal : null);
    return true;
  }

  close(code = 0, signal: NodeJS.Signals | null = null): void {
    if (this.closed) return;
    this.closed = true;
    this.exitCode = code;
    queueMicrotask(() => this.emit('close', code, signal));
  }
}

const RUN_OPTIONS: CodebuddyRunOptions = {
  prompt: '继续',
  cwd: '/mnt/work/projects/poly_status/',
  model: 'hy4-preview',
  permissionMode: 'bypassPermissions',
  effort: 'max',
  resume: 'c49e9bd1-76c9-4329-a225-1b8f3bcb757b',
  allowedTools: [],
  remote: {
    sshTarget: 'fake-msi',
    cwd: '/mnt/work/projects/poly_status/',
  },
};

function fakeCallbacks(events: LiveEvent[]) {
  return {
    onEvent: (event: LiveEvent) => events.push(event),
    onClaudeSessionId: () => undefined,
    requestPermission: async () => ({ allow: false }),
  };
}

function startFakeRun(
  child: FakeChild,
  events: LiveEvent[],
  startupTimeoutMs: number,
  firstResponseTimeoutMs: number,
) {
  return startCodebuddyRun(RUN_OPTIONS, fakeCallbacks(events), {
    spawnProcess: (() => child as unknown as ChildProcess) as typeof spawn,
    sshExec: async () => ({ code: 0, stdout: '', stderr: '', timedOut: false }),
    startupTimeoutMs,
    firstResponseTimeoutMs,
  });
}

describe('CodeBuddy resume path + silent-run guards', () => {
  it('project key exactly matches CodeBuddy for trailing/mixed separators and long UTF-8 cwd', () => {
    assert.equal(
      codebuddyProjectKey('/mnt/work/projects/poly_status/'),
      'mnt-work-projects-poly_status',
    );
    assert.equal(codebuddyProjectKey('C:\\Users\\developer\\poly_status\\'), 'C-Users-developer-poly_status');
    assert.equal(codebuddyProjectKey('///mnt//e///poly_status///'), 'mnt-e-poly_status');

    const longKey = codebuddyProjectKey(`/tmp/${'会话'.repeat(180)}/`);
    assert.ok(Buffer.byteLength(longKey, 'utf8') <= 255);
    assert.ok(Buffer.byteLength(longKey.split('-').slice(0, -1).join('-'), 'utf8') <= 180);
    // Golden suffix from CodeBuddy 2.141.0's generated compress-path source.
    assert.ok(longKey.endsWith('-wm7ght'));
    assert.equal(codebuddyProjectKey(`/tmp/${'会话'.repeat(180)}/`), longKey, 'hash shortening must be stable');
  });

  it('adapter writes trailing-slash cwd into the CLI-visible project and preserves a dangling user turn', async () => {
    const env = makeTempEnv('codebuddy-trailing-cwd');
    try {
      const blocks = fixtureDanglingUser();
      const nativeId = codebuddyAdapter.newNativeId();
      const built = await codebuddyAdapter.build({
        fs: env.fs,
        paths: env.paths,
        vibeSessionId: 'poly-status-vibe',
        blocks,
        turns: toCanonicalTurns(blocks),
        cwd: '/mnt/work/projects/poly_status/',
        model: 'hy4-preview',
        title: 'poly_status',
        nativeId,
        now: 1_788_248_720_533,
        carryThinking: true,
      });

      assert.equal(
        path.basename(path.dirname(built.files[0])),
        'mnt-work-projects-poly_status',
      );
      const back = await readBackNative('codebuddy', env, nativeId);
      compareTurns('codebuddy', blocks, back.blocks);
      assert.equal(back.blocks.at(-1)?.kind, 'user');
    } finally {
      env.cleanup();
    }
  });

  it('reuses an existing CodeBuddy project when stored/current cwd differ only by a trailing slash', async () => {
    const env = makeTempEnv('codebuddy-existing-project');
    try {
      const existing = path.join(env.paths.codebuddyProjectsDir, 'canonical-existing-project');
      await env.fs.mkdirp(existing);
      await env.fs.writeFile(
        path.join(existing, 'existing.jsonl'),
        `${JSON.stringify({
          id: 'existing-user',
          timestamp: 1,
          sessionId: 'existing',
          cwd: '/mnt/work/projects/poly_status',
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'existing' }],
        })}\n`,
      );

      const blocks = fixtureDanglingUser();
      const nativeId = codebuddyAdapter.newNativeId();
      const built = await codebuddyAdapter.build({
        fs: env.fs,
        paths: env.paths,
        vibeSessionId: 'poly-status-existing',
        blocks,
        turns: toCanonicalTurns(blocks),
        cwd: '/mnt/work/projects/poly_status/',
        model: 'hy4-preview',
        title: 'poly_status',
        nativeId,
        now: 1_788_248_720_533,
        carryThinking: true,
      });
      assert.equal(path.dirname(built.files[0]), existing);
    } finally {
      env.cleanup();
    }
  });

  it('non-destructively repairs a transcript already written under the legacy trailing-hyphen key', async () => {
    const env = makeTempEnv('codebuddy-legacy-repair');
    try {
      const cwd = '/mnt/work/projects/poly_status/';
      const resume = 'legacy-poly-status-session';
      const legacyFile = path.join(
        env.paths.codebuddyProjectsDir,
        legacyCodebuddyProjectKey(cwd),
        `${resume}.jsonl`,
      );
      const canonicalFile = path.join(
        env.paths.codebuddyProjectsDir,
        codebuddyProjectKey(cwd),
        `${resume}.jsonl`,
      );
      await env.fs.writeFile(legacyFile, '{"type":"message","role":"user"}\n');

      await repairLegacyCodebuddyResumePath(
        { ...RUN_OPTIONS, cwd, resume, remote: undefined },
        { codebuddyProjectsDir: env.paths.codebuddyProjectsDir },
      );

      assert.equal(await env.fs.readFile(canonicalFile), '{"type":"message","role":"user"}\n');
      assert.equal(await env.fs.readFile(legacyFile), '{"type":"message","role":"user"}\n');
    } finally {
      env.cleanup();
    }
  });

  it('repairs the same legacy path remotely under the login HOME without hard-coding /root', async () => {
    let command = '';
    await repairLegacyCodebuddyResumePath(
      { ...RUN_OPTIONS, resume: 'remote-legacy-poly-status-session' },
      {
        sshExec: async (_target, remoteCmd) => {
          command = remoteCmd;
          return {
            code: 0,
            stdout: 'VIBE_CODEBUDDY_RESUME_REPAIRED',
            stderr: '',
            timedOut: false,
          };
        },
      },
    );

    assert.match(command, /\$HOME/);
    assert.match(command, /mnt-work-projects-poly_status-/);
    assert.match(command, /mnt-work-projects-poly_status\//);
    assert.match(command, /cp -p/);
    assert.doesNotMatch(command, /\/root\//);
  });

  it('passes CodeBuddy an absolute remote MCP path instead of a shell-quoted literal tilde', async () => {
    const child = new FakeChild();
    const events: LiveEvent[] = [];
    const sshCalls: Array<{ command: string; input?: string | Buffer }> = [];
    let spawnedArgs: readonly string[] = [];
    const absoluteConfig = '/home/tester/.vibe/codebuddy-mcp/0123456789abcdef0123456789abcdef.json';
    const run = startCodebuddyRun(
      {
        ...RUN_OPTIONS,
        resume: undefined,
        vibeSessionId: 'remote::session/with vendor characters',
        mcpServers: [{
          name: 'vibe-monitor',
          transport: 'http',
          url: 'https://vibe.example.test/api/internal/monitor-mcp',
          headers: { Authorization: 'Bearer test-capability' },
        }],
      },
      fakeCallbacks(events),
      {
        spawnProcess: ((_bin: string, args: readonly string[]) => {
          spawnedArgs = args;
          queueMicrotask(() => {
            child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`);
            child.close(0);
          });
          return child as unknown as ChildProcess;
        }) as typeof spawn,
        sshExec: async (_target, command, options = {}) => {
          sshCalls.push({ command, input: options.input });
          if (command.includes('cat > "$tmp"')) {
            return { code: 0, stdout: `MCP_OK:${absoluteConfig}\n`, stderr: '', timedOut: false };
          }
          return { code: 0, stdout: '', stderr: '', timedOut: false };
        },
        startupTimeoutMs: 100,
        firstResponseTimeoutMs: 100,
      },
    );
    await run.done;

    const upload = sshCalls.find((call) => call.command.includes('cat > "$tmp"'));
    assert.ok(upload, 'remote MCP config must be uploaded before spawn');
    assert.match(upload.command, /\$HOME\/\.vibe\/codebuddy-mcp/);
    assert.match(String(upload.input), /"vibe-monitor"/);
    const remoteLaunch = String(spawnedArgs.at(-1));
    assert.match(remoteLaunch, new RegExp(absoluteConfig.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
    assert.doesNotMatch(remoteLaunch, /~\/\.vibe\/codebuddy-mcp/);
    assert.equal(events.some((event) => event.k === 'error'), false);
  });

  it('terminates a child that never emits CodeBuddy protocol output', async () => {
    const child = new FakeChild();
    const events: LiveEvent[] = [];
    const run = startFakeRun(child, events, 20, 200);
    await run.done;

    assert.equal(child.killed, true);
    assert.ok(events.some((event) => event.k === 'error' && event.text.includes('no protocol output')));
  });

  it('keeps the response watchdog armed after init and reports a readable timeout', async () => {
    const child = new FakeChild();
    const events: LiveEvent[] = [];
    const run = startFakeRun(child, events, 100, 30);
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: 'system', subtype: 'init', session_id: 'native-id' })}\n`);
    }, 5);
    await run.done;

    assert.equal(child.killed, true);
    assert.ok(events.some((event) => event.k === 'error' && event.text.includes('no response event')));
  });

  it('clears both watchdogs when the CLI returns a result', async () => {
    const child = new FakeChild();
    const events: LiveEvent[] = [];
    const run = startFakeRun(child, events, 30, 30);
    setTimeout(() => {
      child.stdout.write(`${JSON.stringify({ type: 'result', subtype: 'success', duration_ms: 1 })}\n`);
      child.close(0);
    }, 5);
    await run.done;

    assert.equal(child.killed, false);
    assert.equal(events.some((event) => event.k === 'error'), false);
  });
});
