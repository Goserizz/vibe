import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { once } from 'node:events';
import express from 'express';
import { createApiRouter } from '../../src/http/api.js';
import { config } from '../../src/config.js';
import { sessionStore } from '../../src/sessions/store.js';
import { accountManager } from '../../src/accounts.js';
import { hostRegistry } from '../../src/remote/hosts.js';
import type { ChatBlock } from '../../../shared/protocol.js';
import type { ConversationOutlinePage } from '../../../shared/conversationOutline.js';

describe('Read-only conversation outline API', () => {
  it('pages old user headings without transferring tools or changing history, with account isolation', async () => {
    assert.ok(config.home.startsWith('/tmp/'), 'Tests must use an isolated VIBE_HOME');
    const owner = accountManager.create(`outline-${crypto.randomUUID().slice(0, 8)}`, 'synthetic-only-password');
    const foreign = accountManager.create(`outline-${crypto.randomUUID().slice(0, 8)}`, 'synthetic-only-password');
    const host = `outline-host-${crypto.randomUUID().slice(0, 8)}`;
    hostRegistry.add({ name: host, ssh: 'synthetic-never-connect' }, owner.name);
    const session = sessionStore.create({ owner: owner.name, host, agent: 'codex', cwd: config.home, model: 'auto', permissionMode: 'default' });
    const blocks: ChatBlock[] = Array.from({ length: 750 }, (_, i) => i % 5 === 0
      ? { id: `q-${i}`, kind: 'user', text: `Synthetic question ${i}`, ts: i }
      : { id: `tool-${i}`, kind: 'tool', toolUseId: `tool-${i}`, name: 'Read', input: {}, result: 'TOOL_DATA_NOT_IN_INDEX', status: 'done', ts: i });
    fs.mkdirSync(config.codexTranscriptsDir, { recursive: true });
    const file = path.join(config.codexTranscriptsDir, `${encodeURIComponent(session.id)}.jsonl`);
    const original = blocks.map(block => JSON.stringify(block)).join('\n') + '\n';
    fs.writeFileSync(file, original);
    const app = express(); app.use('/api', createApiRouter());
    const server = http.createServer(app).listen(0, '127.0.0.1'); await once(server, 'listening');
    const origin = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const read = (suffix = '', token = owner.token) => fetch(`${origin}/api/sessions/${session.id}/outline${suffix}`, { headers: { Authorization: `Bearer ${token}` } });
    try {
      const first = await read(); assert.equal(first.status, 200);
      assert.equal(first.headers.get('cache-control'), 'private, no-store');
      const page = await first.json() as ConversationOutlinePage;
      assert.equal(page.entries.length, 100); assert.equal(page.hasMore, true); assert.ok(page.cursor);
      assert.ok(!JSON.stringify(page).includes('TOOL_DATA_NOT_IN_INDEX'));
      const old = await (await read(`?cursor=${page.cursor}`)).json() as ConversationOutlinePage;
      assert.equal(old.entries[0]?.id, 'q-0'); assert.equal(old.entries.length, 50); assert.equal(old.hasMore, false);
      const denied = await read('', foreign.token); assert.ok([403, 404].includes(denied.status));
      assert.equal((await read('', 'invalid-synthetic-token')).status, 401);
      for (const value of ['-1', 'NaN', '1.2', '9007199254740992']) assert.equal((await read(`?cursor=${value}`)).status, 400);
      assert.equal(fs.readFileSync(file, 'utf8'), original);
    } finally {
      server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
      sessionStore.remove(session.id); accountManager.remove(owner.name); accountManager.remove(foreign.name);
      hostRegistry.remove(host, owner.name);
      fs.unlinkSync(file);
    }
  });
});
