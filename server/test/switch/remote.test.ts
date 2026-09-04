import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import type { AgentKind } from '../../../shared/protocol.js';
import { switchSessionAgent, fidelityFor } from '../../src/switch/index.js';
import { switchPathsForHome, transcriptFileFor, tempSwitchPaths } from '../../src/switch/paths.js';
import { resolveRemoteSwitchPaths } from '../../src/switch/remotePaths.js';
import { createSshFs, type SshRunner } from '../../src/switch/fs.js';
import { openSqliteReadonly } from '../../src/switch/sqlite.js';
import type { StoredSession } from '../../src/sessions/store.js';
import { AGENTS, loadFixture, makeTempEnv, readBackNative, compareTurns, type TempEnv } from './helpers.js';

/**
 * 远端主机的切换：沿用项目既有的转发模式 —— 不在远端跑另一个 Vibe，而是由本
 * 地 Vibe 把文件操作通过 SSH 下发到**会话所在的那台主机**上执行
 * （与 `http/api.ts` 的远端文件路由、`remote/discovery.ts` 的远端 transcript
 * 读取是同一套路）。
 *
 * 这里用一个「假 SSH」：把远端主机模拟成另一个临时目录，把 shell 命令翻译成
 * 本地文件操作。这样既能真跑一遍命令拼装与执行路径，又不需要真的 SSH。
 */

/** 极简 shell 解释：只支持 adapter 生成命令会用到的那几种形态。 */
function fakeSsh(remoteRoot: string): SshRunner {
  /**
   * 远端路径解析。命令里的路径都是「远端主机上的绝对路径」（由
   * `tempSwitchPaths(remoteRoot)` 生成，天然落在 remoteRoot 内），这里只做一次
   * 越界检查，防止写穿到真实文件系统。
   */
  const abs = (p: string): string => {
    const full = path.resolve(p.startsWith('/') ? p : path.join(remoteRoot, p));
    if (full !== remoteRoot && !full.startsWith(remoteRoot + path.sep)) {
      throw new Error(`path escapes the fake remote root: ${p}`);
    }
    return full;
  };

  return async (_target, rawCmd, opts) => {
    // Production SwitchFs explicitly enters POSIX sh so the remote login shell
    // may be fish/zsh/bash.  Unwrap the single safely quoted `sh -c` argument
    // before feeding it to this deliberately tiny command interpreter.
    assert.ok(rawCmd.startsWith("sh -c '") && rawCmd.endsWith("'"), `missing POSIX shell wrapper: ${rawCmd}`);
    const cmd = rawCmd.slice("sh -c '".length, -1).split("'\\''").join("'");
    const run = (): { code: number | null; stdout: string; stderr: string } => {
      // `test -e <path> && echo yes`
      let m = cmd.match(/^test -e '((?:[^'\\]|\\.)*)' && echo yes$/);
      if (m) return { code: 0, stdout: fs.existsSync(abs(m[1])) ? 'yes\n' : '', stderr: '' };
      // `if test -e <path>; then cat <path>; else exit 44; fi`
      m = cmd.match(/^if test -e '((?:[^'\\]|\\.)*)'; then cat '((?:[^'\\]|\\.)*)'; else exit 44; fi$/);
      if (m) {
        try {
          return { code: 0, stdout: fs.readFileSync(abs(m[1]), 'utf8'), stderr: '' };
        } catch {
          return { code: 44, stdout: '', stderr: '' };
        }
      }
      // `if test -e <path>; then base64 < <path>; else exit 44; fi`（SQLite 二进制下载）
      m = cmd.match(/^if test -e '((?:[^'\\]|\\.)*)'; then base64 < '((?:[^'\\]|\\.)*)'; else exit 44; fi$/);
      if (m) {
        try {
          return { code: 0, stdout: `${fs.readFileSync(abs(m[1])).toString('base64')}\n`, stderr: '' };
        } catch {
          return { code: 44, stdout: '', stderr: '' };
        }
      }
      // 带长度 + SHA-256 校验的上传；只有校验通过才 mv。
      if (cmd.startsWith('mkdir -p ') && cmd.includes(' && cat > ') && cmd.includes(' | grep -qx ') && cmd.includes(' && mv ')) {
        const quoted = [...cmd.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]);
        const expectedBytes = Number(cmd.match(/\)" -eq (\d+)/)?.[1]);
        const expectedHash = cmd.match(/grep -qx ([0-9a-f]{64})/)?.[1] ?? '';
        const dir = quoted[0];
        const tmp = quoted[1];
        const movedTmp = quoted.at(-2);
        const destination = quoted.at(-1);
        if (!dir || !tmp || movedTmp !== tmp || !destination) {
          return { code: 127, stdout: '', stderr: `malformed verified-write command: ${cmd}` };
        }
        const input = Buffer.isBuffer(opts?.input) ? opts.input : Buffer.from(opts?.input ?? '', 'utf8');
        const actualHash = crypto.createHash('sha256').update(input).digest('hex');
        if (input.length !== expectedBytes || actualHash !== expectedHash) {
          return { code: 74, stdout: '', stderr: 'transfer verification failed' };
        }
        fs.mkdirSync(abs(dir), { recursive: true });
        fs.writeFileSync(abs(tmp), input);
        fs.renameSync(abs(tmp), abs(destination));
        return { code: 0, stdout: '', stderr: '' };
      }
      m = cmd.match(/^mkdir -p '((?:[^'\\]|\\.)*)' && cat >> '((?:[^'\\]|\\.)*)'$/);
      if (m) {
        fs.mkdirSync(abs(m[1]), { recursive: true });
        fs.appendFileSync(abs(m[2]), opts?.input ?? '');
        return { code: 0, stdout: '', stderr: '' };
      }
      m = cmd.match(/^rm -f '((?:[^'\\]|\\.)*)'$/);
      if (m) {
        fs.rmSync(abs(m[1]), { force: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      m = cmd.match(/^mkdir -p '((?:[^'\\]|\\.)*)'$/);
      if (m) {
        fs.mkdirSync(abs(m[1]), { recursive: true });
        return { code: 0, stdout: '', stderr: '' };
      }
      // `ls -1Ap <dir> 2>/dev/null`
      m = cmd.match(/^ls -1Ap '((?:[^'\\]|\\.)*)' 2>\/dev\/null$/);
      if (m) {
        try {
          const names = fs.readdirSync(abs(m[1]), { withFileTypes: true })
            .map((e) => (e.isDirectory() ? `${e.name}/` : e.name));
          return { code: 0, stdout: names.length ? `${names.join('\n')}\n` : '', stderr: '' };
        } catch {
          return { code: 2, stdout: '', stderr: 'no such dir' };
        }
      }
      // `head -c <n> <file> 2>/dev/null`
      m = cmd.match(/^head -c (\d+) '((?:[^'\\]|\\.)*)' 2>\/dev\/null$/);
      if (m) {
        try {
          const fd = fs.openSync(abs(m[2]), 'r');
          const buf = Buffer.alloc(Number(m[1]));
          const n = fs.readSync(fd, buf, 0, buf.length, 0);
          fs.closeSync(fd);
          return { code: 0, stdout: buf.subarray(0, n).toString('utf8'), stderr: '' };
        } catch {
          return { code: 1, stdout: '', stderr: '' };
        }
      }
      // ZCode 共享库的远端 Python sqlite3 事务。测试路径都先做越界检查，
      // 再用本机 Python 执行与生产完全相同的脚本。
      if (cmd.startsWith('python3 - ')) {
        const quoted = [...cmd.matchAll(/'((?:[^'\\]|\\.)*)'/g)].map((match) => match[1]);
        if (quoted.length < 6 || quoted.length > 8) return { code: 127, stdout: '', stderr: 'malformed python command' };
        abs(quoted[0]);
        abs(quoted[1]);
        const script = path.join(remoteRoot, `.fake-ssh-${crypto.randomBytes(6).toString('hex')}.py`);
        try {
          fs.writeFileSync(script, opts?.input ?? '', 'utf8');
          const child = spawnSync('python3', [script, ...quoted], { encoding: 'utf8' });
          return { code: child.status, stdout: child.stdout, stderr: child.stderr };
        } finally {
          fs.rmSync(script, { force: true });
        }
      }
      return { code: 127, stdout: '', stderr: `unsupported fake-ssh command: ${cmd}` };
    };
    return run();
  };
}

describe('远端主机切换（SSH 转发）', () => {
  let local: TempEnv;
  let remoteRoot: string;

  beforeEach(() => {
    local = makeTempEnv('remote-local');
    remoteRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-remote-host-'));
  });
  afterEach(() => {
    local.cleanup();
    fs.rmSync(remoteRoot, { recursive: true, force: true });
  });

  it('远端原生产物写入远端 HOME，源/目标 Vibe transcript 始终留在本机', async () => {
    const blocks = loadFixture('codex-tools.jsonl');
    const session: StoredSession = {
      id: 'msi::sess-remote',
      claudeSessionId: 'native-remote-1',
      title: '远端会话',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'codex',
      host: 'msi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 2,
    };
    // Vibe 驱动远端 agent 时，归一化 transcript 仍由本机 Vibe 持久化；只有
    // agent 自己的原生文件位于远端用户 HOME。
    const remoteHome = path.join(remoteRoot, 'home', 'tester');
    const remotePaths = switchPathsForHome(remoteHome);
    const srcFile = transcriptFileFor(local.paths, 'codex', session.id);
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const sshFs = createSshFs('msi', fakeSsh(remoteRoot));
    const outcome = await switchSessionAgent(
      { session, targetAgent: 'kiro', now: 1_700_000_100_000 },
      {
        nativeFs: sshFs,
        nativePaths: remotePaths,
        transcriptFs: local.fs,
        transcriptPaths: local.paths,
      },
    );

    assert.equal(outcome.fidelity, 'full');
    // 产物在远端：~/.kiro/sessions/cli/<id>.jsonl
    const remoteFile = path.join(remotePaths.kiroSessionsDir, `${outcome.nativeId}.jsonl`);
    assert.ok(fs.existsSync(remoteFile), '原生会话文件应产生在远端主机上');
    // 本地（Vibe server 这台机器）不应有任何 kiro 产物。
    assert.equal(
      fs.existsSync(path.join(local.paths.kiroSessionsDir, `${outcome.nativeId}.jsonl`)),
      false,
      '本地不应出现远端的原生会话文件',
    );
    const raw = fs.readFileSync(remoteFile, 'utf8');
    assert.ok(raw.split('\n').filter(Boolean).length > 0);
    const localTargetTranscript = transcriptFileFor(local.paths, 'kiro', session.id);
    assert.ok(fs.existsSync(localTargetTranscript), '目标归一化 transcript 应继续写在 Vibe 本机');
    assert.equal(
      fs.existsSync(transcriptFileFor(remotePaths, 'kiro', session.id)),
      false,
      '远端 ~/.vibe 不应收到本机归一化 transcript',
    );
  });

  it('远端切换后读回的内容与源一致（命令拼装正确）', async () => {
    const blocks = loadFixture('kimi-multiturn.jsonl');
    const session: StoredSession = {
      id: 'msi::sess-remote2',
      claudeSessionId: 'native-remote-2',
      title: '远端会话 2',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'kimi',
      host: 'msi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 2,
    };
    const remotePaths = tempSwitchPaths(remoteRoot);
    const srcFile = transcriptFileFor(remotePaths, 'kimi', session.id);
    fs.mkdirSync(path.dirname(srcFile), { recursive: true });
    fs.writeFileSync(srcFile, `${blocks.map((b) => JSON.stringify(b)).join('\n')}\n`);

    const sshFs = createSshFs('msi', fakeSsh(remoteRoot));
    const outcome = await switchSessionAgent(
      { session, targetAgent: 'claude', now: 1_700_000_100_000 },
      { fs: sshFs, paths: remotePaths },
    );
    // 用一个「直接读远端目录」的环境把产物读回来验证。
    const verifyEnv: TempEnv = { root: remoteRoot, paths: remotePaths, fs: local.fs, cleanup: () => undefined };
    const back = await readBackNative('claude', verifyEnv, outcome.nativeId);
    compareTurns('claude', outcome.blocks, back.blocks);
  });

  it('远端写入失败会抛出可读的错误（不会静默丢历史）', async () => {
    const blocks = loadFixture('grok-small.jsonl');
    const session: StoredSession = {
      id: 'msi::sess-fail',
      claudeSessionId: 'native-remote-3',
      title: '失败用例',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'grok',
      host: 'msi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    };
    const remotePaths = switchPathsForHome(path.join(remoteRoot, 'home', 'tester'));

    // 一个只会失败的 SSH（模拟主机不可达 / 权限不足）。
    const broken: SshRunner = async () => ({ code: 1, stdout: '', stderr: 'permission denied' });
    await assert.rejects(
      switchSessionAgent(
        { session, targetAgent: 'kiro', now: 1_700_000_100_000 },
        {
          sourceBlocks: blocks,
          nativeFs: createSshFs('msi', broken),
          nativePaths: remotePaths,
          transcriptFs: local.fs,
          transcriptPaths: local.paths,
        },
      ),
      /remote (mkdir|write|append) failed/,
      '远端写入失败必须抛错，不能静默成功',
    );
  });

  it('SSH 上传被截断时校验失败，不会用半截内容覆盖旧文件', async () => {
    const destination = path.join(remoteRoot, 'verified-upload', 'payload.bin');
    fs.mkdirSync(path.dirname(destination), { recursive: true });
    fs.writeFileSync(destination, 'original-complete-content');

    const truncateStdin: SshRunner = async (_target, command, opts) =>
      new Promise((resolve) => {
        const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('close', (code) => resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }));
        const full = Buffer.isBuffer(opts?.input)
          ? opts.input
          : Buffer.from(opts?.input ?? '', 'utf8');
        child.stdin.end(full.subarray(0, Math.max(1, Math.floor(full.length / 2))));
      });

    const sshFs = createSshFs('msi', truncateStdin);
    await assert.rejects(
      sshFs.writeBuffer(destination, Buffer.from('replacement-must-arrive-in-full')),
      /destination was left unchanged/,
    );
    assert.equal(fs.readFileSync(destination, 'utf8'), 'original-complete-content');
  });

  it('SSH 文件命令显式进入 POSIX sh，不受远端 fish 登录 shell 语法影响', async () => {
    const destination = path.join(remoteRoot, 'fish-safe', 'payload.bin');
    const commands: string[] = [];
    const fishLikeRunner: SshRunner = async (_target, command, opts) =>
      new Promise((resolve) => {
        commands.push(command);
        // A fish login shell only has to parse `sh -c '<quoted script>'` now;
        // execute that exact outer command to prove stdin reaches the inner
        // byte-count/SHA verifier and the destination is committed.
        const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
        const stdout: Buffer[] = [];
        const stderr: Buffer[] = [];
        child.stdout.on('data', (chunk: Buffer) => stdout.push(chunk));
        child.stderr.on('data', (chunk: Buffer) => stderr.push(chunk));
        child.on('close', (code) => resolve({
          code,
          stdout: Buffer.concat(stdout).toString('utf8'),
          stderr: Buffer.concat(stderr).toString('utf8'),
        }));
        child.stdin.end(opts?.input ?? '');
      });

    const sshFs = createSshFs('fish-host', fishLikeRunner);
    await sshFs.writeBuffer(destination, Buffer.from('works-through-posix-sh'));

    assert.equal(fs.readFileSync(destination, 'utf8'), 'works-through-posix-sh');
    assert.equal(commands.length, 1);
    assert.match(commands[0], /^sh -c '/);
  });

  it('ZCode 远端连续导入使用 SQLite 事务合并，保留先前会话且外键干净', async () => {
    const remotePaths = tempSwitchPaths(remoteRoot);
    const sshFs = createSshFs('msi', fakeSsh(remoteRoot));
    const baseSession: StoredSession = {
      id: 'msi::zcode-merge-a',
      claudeSessionId: 'source-a',
      title: '事务合并 A',
      cwd: '/tmp/project-a',
      model: 'glm-5.3',
      permissionMode: 'default',
      agent: 'codebuddy',
      host: 'msi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 2,
    };

    const first = await switchSessionAgent(
      { session: baseSession, targetAgent: 'zcode', now: 1_700_000_100_000 },
      {
        sourceBlocks: loadFixture('grok-small.jsonl'),
        nativeFs: sshFs,
        nativePaths: remotePaths,
        transcriptFs: local.fs,
        transcriptPaths: local.paths,
      },
    );
    const second = await switchSessionAgent(
      {
        session: {
          ...baseSession,
          id: 'msi::zcode-merge-b',
          claudeSessionId: 'source-b',
          title: '事务合并 B',
          cwd: '/tmp/project-b',
        },
        targetAgent: 'zcode',
        now: 1_700_000_200_000,
      },
      {
        sourceBlocks: loadFixture('kimi-multiturn.jsonl'),
        nativeFs: sshFs,
        nativePaths: remotePaths,
        transcriptFs: local.fs,
        transcriptPaths: local.paths,
      },
    );

    const dbPath = path.join(remotePaths.zcodeHome, 'cli', 'db', 'db.sqlite');
    const db = openSqliteReadonly(dbPath);
    assert.ok(db, 'ZCode 远端共享库必须可读');
    try {
      const row = db.prepare(
        'select count(*) as count from session where id in (?, ?)',
      ).get(first.nativeId, second.nativeId) as { count: number };
      assert.equal(row.count, 2, '第二次导入不得覆盖第一个会话');
      assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }]);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });

  it('Devin 远端共享 sessions.db 也逐会话事务合并', async () => {
    const remotePaths = tempSwitchPaths(remoteRoot);
    const sshFs = createSshFs('msi', fakeSsh(remoteRoot));
    const baseSession: StoredSession = {
      id: 'msi::devin-merge-a',
      claudeSessionId: 'source-a',
      title: 'Devin 合并 A',
      cwd: '/tmp/devin-a',
      model: 'auto',
      permissionMode: 'default',
      agent: 'codex',
      host: 'msi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 2,
    };
    const options = {
      nativeFs: sshFs,
      nativePaths: remotePaths,
      transcriptFs: local.fs,
      transcriptPaths: local.paths,
    };
    const first = await switchSessionAgent(
      { session: baseSession, targetAgent: 'devin', now: 1_700_000_100_000 },
      { ...options, sourceBlocks: loadFixture('grok-small.jsonl') },
    );
    const second = await switchSessionAgent(
      {
        session: {
          ...baseSession,
          id: 'msi::devin-merge-b',
          claudeSessionId: 'source-b',
          title: 'Devin 合并 B',
          cwd: '/tmp/devin-b',
        },
        targetAgent: 'devin',
        now: 1_700_000_200_000,
      },
      { ...options, sourceBlocks: loadFixture('codex-tools.jsonl') },
    );
    assert.equal(first.fidelity, 'full');
    assert.equal(second.fidelity, 'full');

    const dbPath = path.join(remotePaths.devinHome, 'cli', 'sessions.db');
    const db = openSqliteReadonly(dbPath);
    assert.ok(db, 'Devin 远端共享库必须可读');
    try {
      const row = db.prepare(
        'select count(*) as count from sessions where id in (?, ?)',
      ).get(first.nativeId, second.nativeId) as { count: number };
      assert.equal(row.count, 2);
      assert.deepEqual(db.pragma('quick_check'), [{ quick_check: 'ok' }]);
      assert.deepEqual(db.pragma('foreign_key_check'), []);
    } finally {
      db.close();
    }
  });

  it('所有 agent 都能在远端切换（保真等级与本地一致）', async () => {
    const blocks = loadFixture('cursor-tools.jsonl');
    const session: StoredSession = {
      id: 'msi::sess-all',
      claudeSessionId: 'native-remote-4',
      title: '全量远端',
      cwd: '/tmp/proj',
      model: 'auto',
      permissionMode: 'default',
      agent: 'cursor',
      host: 'msi',
      createdAt: 1_700_000_000_000,
      updatedAt: 1_700_000_002_000,
      messageCount: 1,
    };
    const remoteHome = path.join(remoteRoot, 'home', 'non-root-user');
    const remotePaths = switchPathsForHome(remoteHome);

    for (const target of AGENTS) {
      const sshFs = createSshFs('msi', fakeSsh(remoteRoot));
      const outcome = await switchSessionAgent(
        { session, targetAgent: target as AgentKind, now: 1_700_000_100_000 },
        {
          sourceBlocks: blocks,
          nativeFs: sshFs,
          nativePaths: remotePaths,
          transcriptFs: local.fs,
          transcriptPaths: local.paths,
        },
      );
      assert.equal(outcome.fidelity, fidelityFor(target as AgentKind), `${target} 远端保真等级应与本地一致`);
      if (outcome.fidelity === 'full') {
        for (const f of outcome.files) {
          assert.ok(fs.existsSync(f), `远端缺少产物 ${f}`);
          assert.ok(f.startsWith(`${remoteHome}${path.sep}`), `${target} 产物必须位于远端非 root HOME: ${f}`);
          assert.equal(f.includes('/root/'), false, `${target} 产物不得泄漏本机 /root 路径`);
        }
      }
      if (target !== 'claude') {
        assert.ok(
          fs.existsSync(transcriptFileFor(local.paths, target as AgentKind, session.id)),
          `${target} 的归一化 transcript 应留在本机`,
        );
        assert.equal(
          fs.existsSync(transcriptFileFor(remotePaths, target as AgentKind, session.id)),
          false,
          `${target} 不应向远端 ~/.vibe 写 transcript`,
        );
      }
    }
  });

  it('从远端登录环境解析 HOME 与 agent 专用 home，失败时拒绝回退到本机路径', async () => {
    let command = '';
    const paths = await resolveRemoteSwitchPaths('tester@example', async (_target, remoteCmd) => {
      command = remoteCmd;
      return {
        code: 0,
        stderr: '',
        stdout: [
          'login banner',
          '__VIBE_SWITCH_PATHS_V1__',
          '/home/tester',
          '/srv/kimi data',
          '',
          '/srv/zcode',
          'trailing banner',
        ].join('\n'),
      };
    });
    assert.match(command, /bash -lic/);
    assert.match(command, /KIMI_CODE_HOME/);
    assert.equal(paths.codebuddyProjectsDir, '/home/tester/.codebuddy/projects');
    assert.equal(paths.kimiHome, '/srv/kimi data');
    assert.equal(paths.grokSessionsDir, '/home/tester/.grok/sessions');
    assert.equal(paths.zcodeHome, '/srv/zcode');

    await assert.rejects(
      resolveRemoteSwitchPaths('tester@example', async () => ({
        code: 1,
        stdout: '',
        stderr: 'permission denied',
      })),
      /unable to resolve remote HOME: permission denied/,
    );
    await assert.rejects(
      resolveRemoteSwitchPaths('tester@example', async () => ({
        code: 0,
        stdout: '__VIBE_SWITCH_PATHS_V1__\nrelative-home\n\n\n\n',
        stderr: '',
      })),
      /remote HOME must be an absolute path/,
    );
  });
});
