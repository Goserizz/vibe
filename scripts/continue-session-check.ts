/**
 * Minimal check for Vibot's continue_session tool: an existing remote session id
 * ("host::uuid") resolves its host and meta, a bare local uuid resolves the
 * local machine, a running session is refused, and unknown ids / hosts error
 * clearly. Nothing is sent to a real coding agent — hub.send is stubbed for the
 * success paths. Run: VIBE_HOME=$(mktemp -d) npx tsx scripts/continue-session-check.ts
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { config } from '../server/src/config.js';
import { hub } from '../server/src/ws/hub.js';
import { sessionStore } from '../server/src/sessions/store.js';
import { hostRegistry } from '../server/src/remote/hosts.js';
import { dispatchTool } from '../server/src/vibot/tools.js';
import { teardownDelegateSession } from '../server/src/vibot/delegate.js';
import { ADMIN_ACCOUNT } from '../shared/protocol.js';

// --- fixtures (isolated VIBE_HOME ⇒ empty store/registry) --------------------
await hostRegistry.add({ name: 'msi', ssh: 'user@msi.example' }, ADMIN_ACCOUNT);
const remote = sessionStore.create({ cwd: '/srv/app', model: 'opus', permissionMode: 'default', agent: 'claude', host: 'msi' });
const local = sessionStore.create({ cwd: '/tmp/app', model: 'opus', permissionMode: 'default', agent: 'cursor' });
assert.match(remote.id, /^msi::[0-9a-f-]+$/);
assert.match(local.id, /^[0-9a-f-]+$/);

// --- 1. existing remote id: host parsed, meta resolved, turn "started" -------
const realSend = hub.send.bind(hub);
const realIsRunning = hub.isRunning.bind(hub);
let sent = '';
(hub as any).send = (conn: unknown, sessionId: string, msgId: string, text: string) => {
  sent = `${sessionId}|${msgId}|${text}`;
};
// Stub running as "true once our stub send fired" — mirrors how startTurn flips
// it synchronously inside hub.send.
(hub as any).isRunning = (sessionId: string) => sent.startsWith(`${sessionId}|`);

const okRemote = JSON.parse(await dispatchTool('continue_session', { sessionId: remote.id, prompt: 'keep going' }, { convId: 'check-conv' }));
assert.equal(okRemote.sessionId, remote.id);
assert.equal(okRemote.host, 'msi');
assert.equal(okRemote.agent, 'claude');
assert.equal(okRemote.title, remote.title);
assert.equal(okRemote.started, true);
assert.equal(okRemote.managed, true);
assert.ok(sent.startsWith(`${remote.id}|`), 'hub.send received the session id');
assert.ok(sent.endsWith('|keep going'), 'hub.send received the prompt verbatim');
teardownDelegateSession(remote.id);

// --- 2. bare local id: resolves to the local machine, own agent --------------
sent = '';
const okLocal = JSON.parse(await dispatchTool('continue_session', { sessionId: local.id, prompt: 'next step' }, { convId: 'check-conv' }));
assert.equal(okLocal.sessionId, local.id);
assert.equal(okLocal.host, config.localName);
assert.equal(okLocal.agent, 'cursor');
assert.equal(okLocal.started, true);
assert.equal(okLocal.managed, true);
teardownDelegateSession(local.id);

// --- 3. unmanaged: still starts, just not watched ----------------------------
sent = '';
const okUnmanaged = JSON.parse(await dispatchTool('continue_session', { sessionId: local.id, prompt: 'again', manage: 'none' }, { convId: 'check-conv' }));
assert.equal(okUnmanaged.started, true);
assert.equal(okUnmanaged.managed, false);

// Restore the real hub before the guard tests.
(hub as any).send = realSend;
(hub as any).isRunning = realIsRunning;

// --- 4. running session: refused, nothing sent -------------------------------
sent = '';
(hub as any).runtimes.set(remote.id, { running: true, subscribers: new Set(), pending: new Map(), tasks: new Map() });
const running = await dispatchTool('continue_session', { sessionId: remote.id, prompt: 'hello?' }, { convId: 'check-conv' });
assert.match(running, /currently running/);
assert.equal(sent, '', 'nothing sent to a running session');
(hub as any).runtimes.delete(remote.id);

// --- 5. nonexistent local id: clear error, fast (no discovery wait) ----------
const missing = crypto.randomUUID();
const notFound = await dispatchTool('continue_session', { sessionId: missing, prompt: 'x' });
assert.match(notFound, new RegExp(`Session ${missing} not found`));

// --- 6. unknown host prefix + missing prompt ---------------------------------
assert.match(
  await dispatchTool('continue_session', { sessionId: `ghost::${crypto.randomUUID()}`, prompt: 'x' }),
  /Unknown host "ghost"/,
);
assert.match(await dispatchTool('continue_session', { sessionId: local.id, prompt: '  ' }), /prompt is required/);

console.log('continue-session-check: all assertions passed');
