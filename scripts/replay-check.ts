/**
 * Regression check for background-session replay: a turn that streams while the
 * client is unsubscribed must replay its finished assistant/thinking text when
 * the client switches back. Run: VIBE_HOME=$(mktemp -d) npx tsx scripts/replay-check.ts
 */
import assert from 'node:assert/strict';
import { hub, CallbackConn } from '../server/src/ws/hub.js';
import { sessionStore } from '../server/src/sessions/store.js';
import { reduceView, emptyView, type SessionView } from '../web/src/store/blocks.js';
import type { LiveEvent, ServerEvent } from '../shared/protocol.js';

const session = sessionStore.create({ cwd: process.cwd(), model: 'auto', permissionMode: 'default', agent: 'kiro' });

// A client connection that feeds frames through the real web-client reducer.
function makeClient() {
  let view: SessionView = emptyView();
  let reset = false;
  const conn = new CallbackConn((msg: ServerEvent) => {
    if (msg.t === 'event') view = reduceView(view, [{ seq: msg.seq, ev: msg.ev }]);
    if (msg.t === 'subscribed') reset = msg.reset;
  });
  return {
    conn,
    get view() { return view; },
    get reset() { return reset; },
  };
}

const client = makeClient();
hub.subscribe(client.conn, session.id, 0);

const rt: any = (hub as any).runtimes.get(session.id);
assert.ok(rt, 'runtime created');
const emit = (ev: LiveEvent) => rt.emit(ev);

// --- the client is watching this session -----------------------------------
emit({ k: 'run_state', running: true });
emit({ k: 'block', block: { id: 'u1', kind: 'user', text: 'hi', ts: Date.now() } });
const seqWhenSwitchedAway = client.view.lastSeq;
assert.equal(seqWhenSwitchedAway, 2);

// --- user switches to another session: unsubscribe, turn keeps running ------
hub.unsubscribe(client.conn, session.id);

emit({ k: 'block', block: { id: 't1', kind: 'thinking', text: '', streaming: true, ts: Date.now() } });
emit({ k: 'delta', id: 't1', field: 'text', chunk: 'pondering' });
emit({ k: 'block_end', id: 't1', text: 'pondering' });
emit({ k: 'block', block: { id: 'a1', kind: 'assistant', text: '', streaming: true, ts: Date.now() } });
emit({ k: 'delta', id: 'a1', field: 'text', chunk: 'Hello ' });
emit({ k: 'delta', id: 'a1', field: 'text', chunk: 'world' });
emit({ k: 'block_end', id: 'a1', text: 'Hello world' });
emit({ k: 'block', block: { id: 'tool1', kind: 'tool', toolUseId: 'tool1', name: 'Read', input: {}, status: 'done', ts: Date.now() } });
emit({ k: 'tool_result', toolUseId: 'tool1', content: 'ok', isError: false });
emit({ k: 'run_state', running: false });

// --- user switches back: resubscribe from the seq it last saw ---------------
hub.subscribe(client.conn, session.id, seqWhenSwitchedAway);

assert.equal(client.reset, false, 'no reset needed');
const kinds = client.view.blocks.map((b) => `${b.kind}:${b.id}`);
assert.deepEqual(kinds, ['user:u1', 'thinking:t1', 'assistant:a1', 'tool:tool1'], `blocks replayed in order, got ${kinds}`);
const assistant = client.view.blocks.find((b) => b.id === 'a1') as any;
assert.equal(assistant.text, 'Hello world', 'assistant text survived the background turn');
assert.equal(assistant.streaming, false, 'assistant block finalized');
const thinking = client.view.blocks.find((b) => b.id === 't1') as any;
assert.equal(thinking.text, 'pondering', 'thinking text survived');

// --- deltas are still folded away (log stays small) ------------------------
const logged: string[] = rt.logBuf.map((e: any) => e.ev.k);
assert.equal(logged.filter((k) => k === 'delta').length, 0, 'deltas folded out of the log');

// --- a client ahead of the runtime (GC'd runtime / server restart) resets ---
const stale = makeClient();
hub.subscribe(stale.conn, session.id, 9999);
assert.equal(stale.reset, true, 'stale client is told to reload the transcript');

console.log('replay-check OK');
