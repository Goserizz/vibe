import { after, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { once } from 'node:events';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Duplex } from 'node:stream';
import type { Socket } from 'node:net';
import express from 'express';
import type { MonitorInput, MonitorProbeResult } from '../../../shared/protocol.js';
import { MonitorStore, monitorStore } from '../../src/monitoring/store.js';
import { runMonitorProbe } from '../../src/monitoring/probes.js';
import { monitorService } from '../../src/monitoring/service.js';
import { isMonitorManagementTool, monitorMcpDefinitionFor } from '../../src/monitoring/mcp.js';
import { createApiRouter } from '../../src/http/api.js';
import { sessionStore } from '../../src/sessions/store.js';
import { config } from '../../src/config.js';
import { log } from '../../src/log.js';

function monitorInput(overrides: Partial<MonitorInput> = {}): MonitorInput {
  return {
    name: 'Test monitor',
    intervalMs: 60_000,
    probe: { kind: 'command', command: 'printf healthy', timeoutMs: 5_000 },
    actionMode: 'notify',
    instructions: 'Investigate and verify.',
    maxWakeAttempts: 3,
    remindEveryMs: 60_000,
    notifyOnRecovery: true,
    ...overrides,
  };
}

describe('MonitorStore durable incident state', { concurrency: false }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vibe-monitor-store-'));
  const file = path.join(root, 'monitors.sqlite');
  const store = new MonitorStore(file);

  after(() => {
    store.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('persists definitions and keeps one event for a continuous outage', () => {
    const draft = store.create('alice', monitorInput(), 1_000);
    assert.equal(draft.status, 'draft');
    assert.equal(draft.enabled, false);
    assert.equal(store.list('bob').length, 0, 'owners must be isolated');

    const enabled = store.setEnabled(draft.id, 'alice', true, 2_000)!;
    assert.equal(enabled.enabled, true);
    const claimed = store.claimDue(2_000, 'worker-a', 30_000);
    assert.deepEqual(claimed.map((entry) => entry.id), [draft.id]);
    assert.equal(store.claimDue(2_000, 'worker-b', 30_000).length, 0, 'lease prevents a duplicate check');

    const failed: MonitorProbeResult = {
      healthy: false,
      kind: 'observation',
      summary: 'Airflow task failed',
      detail: 'task=load state=failed',
      fingerprint: 'failure-1',
      checkedAt: 2_100,
      durationMs: 100,
      exitCode: 2,
    };
    const first = store.recordProbeResult(draft.id, 'worker-a', failed, 2_100)!;
    assert.equal(first.opened, true);
    assert.equal(first.monitor.status, 'firing');
    assert.ok(first.event);

    const due = store.claimDueEvents(2_100, 'event-worker', 30_000);
    assert.equal(due.length, 1);
    const dispatched = store.markEventDispatched(due[0]!.id, 'event-worker', 62_100, 2_100)!;
    assert.equal(dispatched.attemptCount, 1);
    assert.equal(dispatched.status, 'handling');

    const repeated = store.recordProbeResult(
      draft.id,
      undefined,
      { ...failed, summary: 'Still failed', checkedAt: 3_000 },
      3_000,
    )!;
    assert.equal(repeated.opened, false);
    assert.equal(repeated.event?.id, first.event?.id, 'polls during one outage update the same event');
    assert.equal(store.listEvents('alice', draft.id).length, 1);

    const recovered = store.recordProbeResult(draft.id, undefined, {
      healthy: true,
      kind: 'observation',
      summary: 'Airflow healthy',
      fingerprint: 'healthy',
      checkedAt: 4_000,
      durationMs: 20,
      exitCode: 0,
    }, 4_000)!;
    assert.equal(recovered.monitor.status, 'healthy');
    assert.equal(recovered.resolved?.id, first.event?.id);
    assert.equal(recovered.resolved?.status, 'resolved');

    const secondOutage = store.recordProbeResult(draft.id, undefined, failed, 5_000)!;
    assert.equal(secondOutage.opened, true);
    assert.notEqual(secondOutage.event?.id, first.event?.id, 'a new outage after recovery gets a new incident');
  });

  it('survives closing and reopening the SQLite file', () => {
    const created = store.create('persist-owner', monitorInput({ name: 'Persistent monitor' }), 10_000);
    const reader = new MonitorStore(file);
    try {
      assert.equal(reader.getOwned(created.id, 'persist-owner')?.name, 'Persistent monitor');
    } finally {
      reader.close();
    }
  });

  it('pauses deleted-session monitors and replenishes an escalated wake budget on explicit resume', () => {
    const monitor = store.create('alice', monitorInput({
      name: 'Retry monitor',
      sessionId: 'session-to-delete',
      actionMode: 'wake-agent',
      maxWakeAttempts: 1,
    }), 20_000);
    store.setEnabled(monitor.id, 'alice', true, 20_100);
    const failed = store.recordProbeResult(monitor.id, undefined, {
      healthy: false,
      kind: 'observation',
      summary: 'failed',
      fingerprint: 'failed',
      checkedAt: 20_200,
      durationMs: 1,
      exitCode: 1,
    }, 20_200)!;
    const claimed = store.claimDueEvents(20_200, 'retry-worker', 10_000)
      .find((event) => event.monitorId === monitor.id)!;
    store.markEventDispatched(claimed.id, 'retry-worker', 21_000, 20_200);
    assert.equal(store.escalateExhausted(21_000)[0]?.status, 'escalated');

    assert.deepEqual(store.pauseForSession('session-to-delete', 'alice', 21_100), [monitor.id]);
    assert.equal(store.get(monitor.id)?.enabled, false);
    store.setEnabled(monitor.id, 'alice', true, 21_200);
    const reset = store.getEvent(failed.event!.id)!;
    assert.equal(reset.status, 'open');
    assert.equal(reset.attemptCount, 0);
    assert.equal(reset.nextDispatchAt, 21_200);
  });

  it('disables only monitoring when its SQLite file is malformed', () => {
    const malformed = path.join(root, 'malformed.sqlite');
    fs.writeFileSync(malformed, 'not a sqlite database');
    const previous = log.error;
    log.error = () => {};
    try {
      const broken = new MonitorStore(malformed);
      assert.equal(broken.available(), false);
      assert.throws(() => broken.list('alice'), /storage is unavailable/);
    } finally {
      log.error = previous;
    }
  });
});

describe('monitor probes', { concurrency: false }, () => {
  it('uses command exit status as the health contract', async () => {
    const healthy = await runMonitorProbe(monitorInput({
      probe: { kind: 'command', command: 'printf "all good"', timeoutMs: 2_000 },
    }));
    assert.equal(healthy.healthy, true);
    assert.equal(healthy.exitCode, 0);
    assert.match(healthy.summary, /all good/);

    const unhealthy = await runMonitorProbe(monitorInput({
      probe: { kind: 'command', command: 'echo broken >&2; exit 7', timeoutMs: 2_000 },
    }));
    assert.equal(unhealthy.healthy, false);
    assert.equal(unhealthy.kind, 'observation');
    assert.equal(unhealthy.exitCode, 7);
    assert.match(unhealthy.summary, /broken/);

    const timedOut = await runMonitorProbe(monitorInput({
      probe: { kind: 'command', command: 'sleep 5', timeoutMs: 100 },
    }));
    assert.equal(timedOut.healthy, false);
    assert.equal(timedOut.kind, 'probe-error');
    assert.match(timedOut.summary, /timed out/);
  });

  it('supports HTTP status and literal-body checks without a listening socket', async () => {
    const result = await runMonitorProbe(monitorInput({
      probe: {
        kind: 'http',
        url: 'data:text/plain,service-ok',
        method: 'GET',
        timeoutMs: 2_000,
        expectedStatusMin: 200,
        expectedStatusMax: 299,
        bodyIncludes: 'service-ok',
      },
    }));
    assert.equal(result.healthy, true);

    const missing = await runMonitorProbe(monitorInput({
      probe: {
        kind: 'http',
        url: 'data:text/plain,service-ok',
        method: 'GET',
        timeoutMs: 2_000,
        expectedStatusMin: 200,
        expectedStatusMax: 299,
        bodyIncludes: 'different',
      },
    }));
    assert.equal(missing.healthy, false);
    assert.match(missing.summary, /did not contain/);
  });
});

describe('MonitorService dispatch and deterministic recovery', { concurrency: false }, () => {
  const createdIds: string[] = [];
  const handlerSession = sessionStore.create({
    cwd: os.tmpdir(),
    model: 'auto',
    permissionMode: 'default',
    agent: 'claude',
    title: 'Monitor service handler',
    owner: 'admin',
  });

  after(() => {
    for (const id of createdIds) monitorStore.delete(id, 'admin');
    sessionStore.remove(handlerSession.id);
    monitorService.configure({
      wakeAgent: () => 'not-found',
      appendNotice: () => {},
    });
  });

  it('wakes on failure and resolves only after a healthy probe', async () => {
    const wakes: string[] = [];
    const notices: string[] = [];
    monitorService.configure({
      wakeAgent: ({ prompt }) => {
        wakes.push(prompt);
        return 'started';
      },
      appendNotice: ({ text }) => notices.push(text),
    });
    const draft = monitorService.createDraft('admin', monitorInput({
      name: 'Dispatch test',
      sessionId: handlerSession.id,
      actionMode: 'wake-agent',
      probe: { kind: 'command', command: 'echo failed >&2; exit 9', timeoutMs: 2_000 },
    }));
    createdIds.push(draft.id);
    monitorStore.setEnabled(draft.id, 'admin', true);
    const failure = await monitorService.runNow(draft.id);
    assert.equal(failure.healthy, false);
    assert.equal(wakes.length, 1);
    assert.match(wakes[0]!, /untrusted-monitor-evidence/);
    assert.equal(monitorStore.listEvents('admin', draft.id)[0]?.status, 'handling');

    monitorStore.update(draft.id, 'admin', {
      probe: { kind: 'command', command: 'printf recovered', timeoutMs: 2_000 },
    });
    const healthy = await monitorService.runNow(draft.id);
    assert.equal(healthy.healthy, true);
    const event = monitorStore.listEvents('admin', draft.id)[0]!;
    assert.equal(event.status, 'resolved');
    assert.equal(notices.length, 1);
    assert.match(notices[0]!, /已恢复/);
  });
});

class MemorySocket extends Duplex {
  readonly chunks: Buffer[] = [];
  constructor() { super({ allowHalfOpen: true, autoDestroy: false }); }
  _read(): void {}
  _write(chunk: Buffer | string, _encoding: BufferEncoding, done: (error?: Error | null) => void): void {
    this.chunks.push(Buffer.isBuffer(chunk) ? Buffer.from(chunk) : Buffer.from(chunk));
    done();
  }
}

async function inject(
  app: (req: IncomingMessage, res: ServerResponse) => unknown,
  input: { method?: string; url: string; headers?: Record<string, string>; body?: unknown },
): Promise<{ status: number; text: string; json<T>(): T }> {
  const socket = new MemorySocket();
  const httpSocket = socket as unknown as Socket;
  const req = new IncomingMessage(httpSocket);
  (req as IncomingMessage & { _readableState: { autoDestroy: boolean } })._readableState.autoDestroy = false;
  req.method = input.method ?? 'GET';
  req.url = input.url;
  const body = input.body === undefined ? '' : JSON.stringify(input.body);
  req.headers = {
    ...(body ? { 'content-length': String(Buffer.byteLength(body)), 'content-type': 'application/json' } : {}),
    ...Object.fromEntries(Object.entries(input.headers ?? {}).map(([key, value]) => [key.toLowerCase(), value])),
  };
  const res = new ServerResponse(req);
  res.assignSocket(httpSocket);
  const finished = once(res, 'finish');
  app(req, res);
  if (body) req.push(body);
  req.push(null);
  await Promise.race([
    finished,
    new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error('response timeout')), 3_000)),
  ]);
  const raw = Buffer.concat(socket.chunks).toString('utf8');
  const split = raw.indexOf('\r\n\r\n');
  const text = split >= 0 ? raw.slice(split + 4) : '';
  return { status: res.statusCode, text, json: <T>() => JSON.parse(text) as T };
}

describe('monitor HTTP API and built-in MCP discovery', { concurrency: false }, () => {
  const createdIds: string[] = [];
  const session = sessionStore.create({
    cwd: os.tmpdir(),
    model: 'auto',
    permissionMode: 'default',
    agent: 'claude',
    title: 'Monitor endpoint session',
    owner: 'admin',
  });
  sessionStore.flush();
  const app = express();
  app.use(express.json());
  app.use('/api', createApiRouter());
  const auth = { Authorization: `Bearer ${config.token}` };
  let rpcId = 100;

  async function callTool<T>(authorization: string, name: string, args: Record<string, unknown>): Promise<T> {
    const response = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      headers: { Authorization: authorization },
      body: {
        jsonrpc: '2.0',
        id: rpcId++,
        method: 'tools/call',
        params: { name, arguments: args },
      },
    });
    assert.equal(response.status, 200, response.text);
    const body = response.json<{
      result?: { structuredContent?: T };
      error?: { message: string; data?: unknown };
    }>();
    assert.equal(body.error, undefined, JSON.stringify(body.error));
    assert.ok(body.result?.structuredContent);
    return body.result.structuredContent;
  }

  after(() => {
    for (const id of createdIds) monitorStore.delete(id, 'admin');
    sessionStore.remove(session.id);
    sessionStore.flush();
  });

  it('creates a disabled draft, tests it, enables it, and lists it', async () => {
    const input = monitorInput({ name: 'API monitor', sessionId: session.id });
    const create = await inject(app, { method: 'POST', url: '/api/monitors', headers: auth, body: input });
    assert.equal(create.status, 201, create.text);
    const body = create.json<{ monitor: { id: string; enabled: boolean; cwd?: string } }>();
    createdIds.push(body.monitor.id);
    assert.equal(body.monitor.enabled, false);
    assert.equal(body.monitor.cwd, os.tmpdir(), 'session metadata overrides client location');

    const test = await inject(app, { method: 'POST', url: '/api/monitors/test', headers: auth, body: input });
    assert.equal(test.status, 200, test.text);
    assert.equal(test.json<{ result: MonitorProbeResult }>().result.healthy, true);

    const enable = await inject(app, {
      method: 'POST',
      url: `/api/monitors/${encodeURIComponent(body.monitor.id)}/enabled`,
      headers: auth,
      body: { enabled: true },
    });
    assert.equal(enable.status, 200, enable.text);
    assert.equal(enable.json<{ monitor: { enabled: boolean } }>().monitor.enabled, true);

    const list = await inject(app, { url: '/api/monitors', headers: auth });
    assert.equal(list.status, 200, list.text);
    assert.ok(list.json<{ monitors: Array<{ id: string }> }>().monitors.some((entry) => entry.id === body.monitor.id));
  });

  it('advertises account-scoped management tools and keeps the draft alias stopped', async () => {
    assert.equal(isMonitorManagementTool('mcp__vibe-monitor__monitor_create_draft'), true);
    assert.equal(isMonitorManagementTool('vibe-monitor.monitor_start'), true);
    assert.equal(isMonitorManagementTool('monitor_create_draft'), false, 'an unnamespaced user tool is not auto-approved');
    const def = monitorMcpDefinitionFor({
      owner: 'admin',
      sessionId: session.id,
    });
    assert.ok(def?.headers?.Authorization);
    const mcpAuth = { Authorization: def.headers.Authorization };
    const initialize = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      headers: mcpAuth,
      body: { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } },
    });
    assert.equal(initialize.status, 200, initialize.text);
    assert.equal(initialize.json<{ result: { serverInfo: { name: string } } }>().result.serverInfo.name, 'vibe-monitor');

    const listTools = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      headers: mcpAuth,
      body: { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    });
    const tools = listTools.json<{ result: { tools: Array<{ name: string }> } }>().result.tools;
    assert.deepEqual(tools.map((tool) => tool.name), [
      'monitor_list',
      'monitor_create',
      'monitor_create_draft',
      'monitor_update',
      'monitor_start',
      'monitor_stop',
      'monitor_run_now',
    ]);

    const call = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      headers: mcpAuth,
      body: {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: {
          name: 'monitor_create_draft',
          arguments: {
            name: 'Agent-created draft',
            objective: 'Investigate and verify recovery.',
            intervalMinutes: 15,
            probe: { kind: 'command', command: 'true', timeoutMs: 2_000 },
          },
        },
      },
    });
    assert.equal(call.status, 200, call.text);
    const structured = call.json<{
      result: {
        structuredContent: {
          draftId: string;
          requiresConfirmation: boolean;
          monitor: { remindEveryMs: number };
        };
      };
    }>()
      .result.structuredContent;
    createdIds.push(structured.draftId);
    assert.equal(structured.requiresConfirmation, false);
    assert.equal(structured.monitor.remindEveryMs, 15 * 60_000, 'omitted reminder follows a longer interval');
    assert.equal(monitorStore.getOwned(structured.draftId, 'admin')?.enabled, false);

    const invalid = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      headers: mcpAuth,
      body: {
        jsonrpc: '2.0',
        id: 4,
        method: 'tools/call',
        params: {
          name: 'monitor_create',
          arguments: {
            name: 'Invalid reminder',
            objective: 'test',
            intervalMinutes: 15,
            remindMinutes: 5,
            probe: { kind: 'command', command: 'true' },
          },
        },
      },
    });
    const invalidBody = invalid.json<{ error: { message: string } }>();
    assert.match(invalidBody.error.message, /remindEveryMs.*greater than or equal to intervalMs/);
  });

  it('lets an agent create, list, modify, stop, start, and run a monitor', async () => {
    const def = monitorMcpDefinitionFor({ owner: 'admin', sessionId: session.id })!;
    const authorization = def.headers!.Authorization!;
    const created = await callTool<{
      monitor: { id: string; enabled: boolean };
      created: boolean;
    }>(authorization, 'monitor_create', {
      name: 'Agent-managed monitor',
      objective: 'Investigate failures and verify recovery.',
      intervalMinutes: 1,
      remindMinutes: 1,
      probe: { kind: 'command', command: 'printf agent-healthy', timeoutMs: 2_000 },
    });
    createdIds.push(created.monitor.id);
    assert.equal(created.created, true);
    assert.equal(created.monitor.enabled, true);

    const listed = await callTool<{ monitors: Array<{ id: string }> }>(authorization, 'monitor_list', {});
    assert.ok(listed.monitors.some((monitor) => monitor.id === created.monitor.id));

    const updated = await callTool<{
      monitor: { id: string; name: string; intervalMs: number; instructions: string };
    }>(authorization, 'monitor_update', {
      monitorId: created.monitor.id,
      name: 'Agent-updated monitor',
      objective: 'Use the updated runbook and verify twice.',
      intervalMinutes: 2,
      remindMinutes: 2,
    });
    assert.equal(updated.monitor.name, 'Agent-updated monitor');
    assert.equal(updated.monitor.intervalMs, 120_000);
    assert.match(updated.monitor.instructions, /updated runbook/);

    const stopped = await callTool<{ monitor: { enabled: boolean } }>(
      authorization,
      'monitor_stop',
      { monitorId: created.monitor.id },
    );
    assert.equal(stopped.monitor.enabled, false);

    const started = await callTool<{ monitor: { enabled: boolean } }>(
      authorization,
      'monitor_start',
      { monitorId: created.monitor.id },
    );
    assert.equal(started.monitor.enabled, true);

    const run = await callTool<{ result: MonitorProbeResult }>(
      authorization,
      'monitor_run_now',
      { monitorId: created.monitor.id },
    );
    assert.equal(run.result.healthy, true);
    assert.match(run.result.summary, /agent-healthy/);
  });

  it('rejects an MCP call without a scoped capability', async () => {
    const response = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(response.status, 401);
  });

  it('rejects browser-origin MCP requests to prevent DNS rebinding', async () => {
    const def = monitorMcpDefinitionFor({ owner: 'admin', sessionId: session.id })!;
    const response = await inject(app, {
      method: 'POST',
      url: '/api/internal/monitor-mcp',
      headers: { Authorization: def.headers!.Authorization!, Origin: 'https://attacker.example' },
      body: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    });
    assert.equal(response.status, 403);
  });
});
