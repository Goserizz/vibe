/**
 * End-to-end check for mid-stream transport auto-resume: drives
 * startCursorRun against a stub `cursor-agent` that streams a partial reply,
 * then dies with the incident error ("RetriableError: [canceled] http/2
 * stream closed …"). Verifies the runner auto-resumes the same ACP session
 * exactly once with a "continue" prompt (not the original prompt), inserts a
 * UI note, and preserves the streamed content — and that a second transient
 * death after the resume still surfaces the error with no third attempt.
 * Also covers the folded variant (the agent catches the transport error and
 * ends its reply with it, so the turn "succeeds" at the ACP layer): that too
 * auto-resumes once, while a clean reply with no error never triggers one.
 * Fully isolated: stub CLI, temp HOME (so ~/.cursor/mcp.json is untouched)
 * and temp VIBE_HOME. Run: npx tsx scripts/cursor-resume-check.ts
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-resume-check-'));
fs.mkdirSync(path.join(tmp, 'home'));

// Stub cursor-agent: speaks just enough ACP. Round 1 streams a partial reply
// then exits with the http/2 cancel error; round 2 completes — unless
// STUB_FAIL_TWICE=1, in which case round 2 dies the same way. STUB_FOLD_ERROR=1
// instead makes round 1 end "successfully" with the agent folding the transport
// error into its final reply text; STUB_NORMAL=1 makes round 1 complete cleanly.
const stub = path.join(tmp, 'cursor-agent');
fs.writeFileSync(
  stub,
  `#!/usr/bin/env node
const fs = require('fs');
const dir = process.env.STUB_DIR;
const failTwice = process.env.STUB_FAIL_TWICE === '1';
const foldError = process.env.STUB_FOLD_ERROR === '1';
const normalFirst = process.env.STUB_NORMAL === '1';
let n = 0;
try { n = Number(fs.readFileSync(dir + '/count', 'utf8').trim()) || 0; } catch {}
n += 1;
fs.writeFileSync(dir + '/count', String(n));
const log = (obj) => fs.appendFileSync(dir + '/trace.jsonl', JSON.stringify(obj) + '\\n');
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n');
const respond = (id, result) => send({ jsonrpc: '2.0', id, result });
let buf = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let msg; try { msg = JSON.parse(line); } catch { continue; }
    handle(msg);
  }
});
function handle(msg) {
  const m = msg.method;
  if (m === 'initialize') return respond(msg.id, { protocolVersion: 1, agentInfo: { name: 'stub', version: '0' } });
  if (m === 'authenticate') return respond(msg.id, {});
  if (m === 'session/new') { log({ invocation: n, method: 'session/new' }); return respond(msg.id, { sessionId: 'stub-s' + n }); }
  if (m === 'session/resume' || m === 'session/load') {
    log({ invocation: n, method: m, sessionId: msg.params && msg.params.sessionId });
    return respond(msg.id, {});
  }
  if (m === 'session/prompt') {
    const text = ((msg.params && msg.params.prompt) || []).map((p) => (p && p.text) || '').join('');
    log({ invocation: n, method: 'session/prompt', prompt: text });
    const sid = msg.params && msg.params.sessionId;
    const chunk = (t) => send({ jsonrpc: '2.0', method: 'session/update', params: { sessionId: sid, update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: t } } } });
    if (foldError && n === 1) {
      chunk('progress fine, wrapping up shortly.');
      chunk('\\n\\nError: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)');
      respond(msg.id, { stopReason: 'end_turn' });
      setTimeout(() => process.exit(0), 30);
      return;
    }
    if (normalFirst && n === 1) {
      chunk('all done, no error here');
      respond(msg.id, { stopReason: 'end_turn' });
      setTimeout(() => process.exit(0), 30);
      return;
    }
    if (n === 1 || (failTwice && n === 2)) {
      chunk('partial ' + n);
      const delay = (n === 1 && Number(process.env.STUB_ROUND1_DELAY_MS)) || 30;
      setTimeout(() => {
        process.stderr.write('Error: RetriableError: [canceled] http/2 stream closed with error code CANCEL (0x8)\\n');
        process.exit(1);
      }, delay);
      return;
    }
    chunk('resumed-final');
    respond(msg.id, { stopReason: 'end_turn' });
    setTimeout(() => process.exit(0), 30);
    return;
  }
  return respond(msg.id, {});
}
setTimeout(() => process.exit(3), 60000);
`,
);
fs.chmodSync(stub, 0o755);

// Must be set before importing the runner: config resolves the CLI at import.
process.env.CURSOR_CLI_PATH = stub;
process.env.VIBE_HOME = path.join(tmp, 'vibe');
process.env.HOME = path.join(tmp, 'home');
process.env.STUB_DIR = tmp;

const { startCursorRun } = await import('../server/src/cursor/runner.js');

const RESUME_NOTE = '（传输中断，正在自动续跑…）';
type Ev = { k: string; block?: { kind?: string; text?: string }; text?: string };

async function runTurn(): Promise<Ev[]> {
  const events: Ev[] = [];
  const handle = startCursorRun(
    { prompt: 'do the thing', cwd: tmp, model: '', permissionMode: 'default' },
    {
      onEvent: (ev) => events.push(ev as Ev),
      onClaudeSessionId: () => undefined,
      requestPermission: async () => ({ allow: true }),
    },
  );
  await handle.done;
  return events;
}

const tracePath = path.join(tmp, 'trace.jsonl');
const countPath = path.join(tmp, 'count');
const trace = () => fs.readFileSync(tracePath, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
const invocations = () => Number(fs.readFileSync(countPath, 'utf8'));
const reset = () => { for (const f of [tracePath, countPath]) if (fs.existsSync(f)) fs.unlinkSync(f); };

// --- 1. mid-stream death → exactly one auto-resume, turn completes -----------
{
  const events = await runTurn();
  assert.equal(invocations(), 2, 'exactly two cursor-agent invocations');
  const tr = trace();
  assert.equal(tr[0].method, 'session/new', 'first invocation starts a session');
  const resumed = tr.find((e: any) => e.method === 'session/resume');
  assert.ok(resumed, 'second invocation resumes the session');
  assert.equal(resumed.sessionId, 'stub-s1', 'resumes the session from the dead turn');
  assert.equal(resumed.invocation, 2);
  const prompts = tr.filter((e: any) => e.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.equal(prompts[0].prompt, 'do the thing', 'first attempt uses the original prompt');
  assert.match(prompts[1].prompt, /Continue exactly where you left off/, 'resume sends a continue nudge, not the original prompt');
  assert.ok(
    events.some((e) => e.k === 'block' && e.block?.kind === 'assistant' && e.block?.text === RESUME_NOTE),
    'UI resume note present',
  );
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === 'partial 1'), 'round-1 content preserved');
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === 'resumed-final'), 'round-2 content streamed');
  assert.ok(!events.some((e) => e.k === 'error'), 'no error surfaced on successful resume');
}

// --- 2. second transient death after the resume → error surfaces, no 3rd try
{
  reset();
  process.env.STUB_FAIL_TWICE = '1';
  const events = await runTurn();
  assert.equal(invocations(), 2, 'no third invocation after a failed resume');
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === RESUME_NOTE), 'resume note still shown');
  const err = events.find((e) => e.k === 'error');
  assert.ok(err, 'error surfaced after failed resume');
  assert.match(err.text!, /http\/2 stream closed/);
}

// --- 3. user abort during the resume backoff → no resume attempt fires ------
{
  reset();
  delete process.env.STUB_FAIL_TWICE;
  process.env.STUB_ROUND1_DELAY_MS = '400'; // die at ~0.5s; backoff then spans ~2-3s
  const events: Ev[] = [];
  const handle = startCursorRun(
    { prompt: 'do the thing', cwd: tmp, model: '', permissionMode: 'default' },
    {
      onEvent: (ev) => events.push(ev as Ev),
      onClaudeSessionId: () => undefined,
      requestPermission: async () => ({ allow: true }),
    },
  );
  await new Promise((r) => setTimeout(r, 900)); // mid-backoff, after the note
  handle.abort();
  await handle.done;
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === RESUME_NOTE), 'failure already struck');
  assert.equal(invocations(), 1, 'abort during backoff must not start the resume attempt');
  assert.ok(!events.some((e) => e.k === 'error'));
}

// --- 4. agent folds the transport error into its reply → still one resume --
{
  reset();
  delete process.env.STUB_ROUND1_DELAY_MS;
  process.env.STUB_FOLD_ERROR = '1';
  const events = await runTurn();
  assert.equal(invocations(), 2, 'folded error still triggers exactly one auto-resume');
  const tr = trace();
  const resumed = tr.find((e: any) => e.method === 'session/resume');
  assert.ok(resumed, 'second invocation resumes the session');
  assert.equal(resumed.sessionId, 'stub-s1', 'resumes the session from the folded-error turn');
  const prompts = tr.filter((e: any) => e.method === 'session/prompt');
  assert.equal(prompts.length, 2);
  assert.match(prompts[1].prompt, /Continue exactly where you left off/, 'resume sends a continue nudge');
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === RESUME_NOTE), 'UI resume note present');
  assert.ok(
    events.some((e) => e.k === 'block_end' && /http\/2 stream closed/.test(e.text ?? '')),
    'folded error text kept in the rendered output',
  );
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === 'resumed-final'), 'round-2 content streamed');
  assert.ok(!events.some((e) => e.k === 'error'), 'folded variant surfaces no error event');
}

// --- 5. clean reply with no folded error → no resume (false-hit guard) ------
{
  reset();
  delete process.env.STUB_FOLD_ERROR;
  process.env.STUB_NORMAL = '1';
  const events = await runTurn();
  assert.equal(invocations(), 1, 'clean turn must not trigger a resume');
  assert.ok(!trace().some((e: any) => e.method === 'session/resume'), 'no session/resume issued');
  assert.ok(!events.some((e) => e.k === 'block' && e.block?.text === RESUME_NOTE), 'no resume note');
  assert.ok(events.some((e) => e.k === 'block' && e.block?.text === 'all done, no error here'), 'reply streamed');
  assert.ok(!events.some((e) => e.k === 'error'), 'no error surfaced');
}

console.log('cursor-resume-check: all assertions passed');
