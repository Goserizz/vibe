import crypto from 'node:crypto';
import type { Request, Response } from 'express';
import { config } from '../config.js';
import { hostRegistry } from '../remote/hosts.js';
import { sessionStore } from '../sessions/store.js';
import { sessionVisible } from '../sessions/visibility.js';
import { monitorService } from './service.js';
import { monitorStore } from './store.js';
import {
  monitorCreateDraftToolSchema,
  monitorCreateToolSchema,
  monitorIdToolSchema,
  monitorInputSchema,
  monitorUpdateToolSchema,
} from './validation.js';
import type { McpServerDef, Monitor, MonitorInput } from '../../../shared/protocol.js';
import type { MonitorCreateDraftToolInput } from './validation.js';

const CAPABILITY_TTL_MS = 12 * 60 * 60_000;
const MCP_NAME = 'vibe-monitor';
const TOOLS = {
  list: 'monitor_list',
  create: 'monitor_create',
  createDraft: 'monitor_create_draft',
  update: 'monitor_update',
  start: 'monitor_start',
  stop: 'monitor_stop',
  runNow: 'monitor_run_now',
} as const;
const MANAGEMENT_TOOL_NAMES = new Set<string>(Object.values(TOOLS));

interface CapabilityContext {
  owner: string;
  sessionId: string;
  exp: number;
}

interface JsonRpcRequest {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

interface JsonRpcResponse {
  jsonrpc: '2.0';
  id: string | number | null;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

function encodeCapability(context: CapabilityContext): string {
  const payload = Buffer.from(JSON.stringify(context)).toString('base64url');
  const signature = crypto.createHmac('sha256', config.token).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyCapability(token: string): CapabilityContext | undefined {
  const dot = token.lastIndexOf('.');
  if (dot <= 0) return undefined;
  const payload = token.slice(0, dot);
  const actual = token.slice(dot + 1);
  const expected = crypto.createHmac('sha256', config.token).update(payload).digest('base64url');
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return undefined;
  try {
    const value = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as CapabilityContext;
    if (!value.owner || !value.sessionId || !Number.isFinite(value.exp) || value.exp < Date.now()) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

function bearer(req: Request): string | undefined {
  const header = req.header('authorization');
  return header?.startsWith('Bearer ') ? header.slice(7).trim() : undefined;
}

/** Definition injected in addition to user-configured MCP servers. For remote
 * sessions there is no safe guess for how that host reaches Vibe, so an
 * explicit VIBE_MONITOR_MCP_URL is required. */
export function monitorMcpDefinitionFor(input: {
  owner: string;
  sessionId: string;
  host?: string;
}): McpServerDef | undefined {
  const url = input.host
    ? config.monitorMcpUrl
    : `http://127.0.0.1:${config.port}/api/internal/monitor-mcp`;
  if (!url) return undefined;
  const capability = encodeCapability({
    owner: input.owner,
    sessionId: input.sessionId,
    exp: Date.now() + CAPABILITY_TTL_MS,
  });
  return {
    name: MCP_NAME,
    transport: 'http',
    url,
    headers: { Authorization: `Bearer ${capability}` },
  };
}

export function isMonitorManagementTool(name: string): boolean {
  const normalized = name.toLowerCase().replace(/\s/g, '');
  for (const tool of MANAGEMENT_TOOL_NAMES) {
    if (
      normalized === `${MCP_NAME}.${tool}`
      || normalized === `${MCP_NAME}/${tool}`
      || normalized === `mcp__${MCP_NAME}__${tool}`
    ) return true;
  }
  return false;
}

const probeInputSchema = {
  oneOf: [
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'command' },
        command: { type: 'string', description: 'One-shot health command: exit 0 healthy, non-zero unhealthy.' },
        timeoutMs: { type: 'integer', minimum: 1000, default: 30000 },
      },
      required: ['kind', 'command'],
    },
    {
      type: 'object',
      additionalProperties: false,
      properties: {
        kind: { const: 'http' },
        url: { type: 'string', format: 'uri' },
        method: { type: 'string', enum: ['GET', 'HEAD'], default: 'GET' },
        timeoutMs: { type: 'integer', minimum: 1000, default: 15000 },
        expectedStatusMin: { type: 'integer', default: 200 },
        expectedStatusMax: { type: 'integer', default: 399 },
        bodyIncludes: { type: 'string' },
      },
      required: ['kind', 'url'],
    },
  ],
};

const monitorConfigProperties = {
  name: { type: 'string', description: 'Short monitor name.' },
  objective: {
    type: 'string',
    description: 'Runbook: what to diagnose, what may be changed, and how to verify recovery.',
  },
  intervalMinutes: { type: 'number', minimum: 1 / 6, description: 'Probe interval; minimum 10 seconds.' },
  probe: probeInputSchema,
  actionMode: { type: 'string', enum: ['notify', 'wake-agent'] },
  maxWakeAttempts: { type: 'integer', minimum: 1, maximum: 20 },
  remindMinutes: {
    type: 'number',
    minimum: 0.5,
    description: 'Delay before another wake; must be at least intervalMinutes.',
  },
  notifyOnRecovery: { type: 'boolean' },
};

const toolDefinitions = [
  {
    name: TOOLS.list,
    description:
      'List every Vibe Monitor owned by the current account, including ids, current configuration, enabled state, health, and active incident. '
      + 'Call this before changing or stopping an existing monitor.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
  },
  {
    name: TOOLS.create,
    description:
      'Create a Vibe Monitor attached to the current conversation. By default it is enabled immediately. '
      + 'Use only for ongoing/recurring monitoring, never for a one-time check. The probe must be a bounded one-shot check, not an infinite loop.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...monitorConfigProperties,
        intervalMinutes: { ...monitorConfigProperties.intervalMinutes, default: 5 },
        actionMode: { ...monitorConfigProperties.actionMode, default: 'wake-agent' },
        maxWakeAttempts: { ...monitorConfigProperties.maxWakeAttempts, default: 3 },
        remindMinutes: {
          ...monitorConfigProperties.remindMinutes,
          description: 'Delay before another wake; defaults to max(5, intervalMinutes).',
        },
        notifyOnRecovery: { type: 'boolean', default: true },
        enabled: { type: 'boolean', default: true },
      },
      required: ['name', 'objective', 'probe'],
    },
  },
  {
    name: TOOLS.createDraft,
    description:
      'Create a disabled Vibe Monitor draft attached to the current conversation. Use monitor_create instead when the user wants it started now.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        ...monitorConfigProperties,
        intervalMinutes: { ...monitorConfigProperties.intervalMinutes, default: 5 },
        actionMode: { ...monitorConfigProperties.actionMode, default: 'wake-agent' },
        maxWakeAttempts: { ...monitorConfigProperties.maxWakeAttempts, default: 3 },
        remindMinutes: {
          ...monitorConfigProperties.remindMinutes,
          description: 'Delay before another wake; defaults to max(5, intervalMinutes).',
        },
        notifyOnRecovery: { type: 'boolean', default: true },
      },
      required: ['name', 'objective', 'probe'],
    },
  },
  {
    name: TOOLS.update,
    description:
      'Modify an existing Monitor owned by the current Vibe account. Omitted fields stay unchanged. '
      + 'An enabled monitor is checked again immediately after a relevant change. Use monitor_list first and preserve fields the user did not ask to change.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        monitorId: { type: 'string' },
        ...monitorConfigProperties,
        sessionId: {
          type: 'string',
          description: 'Optional already-managed Vibe session id to rebind this monitor to; it must belong to the same account.',
        },
      },
      required: ['monitorId'],
    },
  },
  {
    name: TOOLS.start,
    description: 'Enable a stopped/draft Monitor and schedule its first health check immediately.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { monitorId: { type: 'string' } }, required: ['monitorId'],
    },
  },
  {
    name: TOOLS.stop,
    description: 'Stop/pause a Monitor. This prevents future checks and wakes; it does not delete configuration or incident history.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { monitorId: { type: 'string' } }, required: ['monitorId'],
    },
  },
  {
    name: TOOLS.runNow,
    description: 'Run one real health check immediately, persist the result, and update/open/resolve its incident as appropriate.',
    inputSchema: {
      type: 'object', additionalProperties: false,
      properties: { monitorId: { type: 'string' } }, required: ['monitorId'],
    },
  },
];

function rpcError(id: JsonRpcRequest['id'], code: number, message: string, data?: unknown): JsonRpcResponse {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data === undefined ? {} : { data }) } };
}

function validationError(
  id: JsonRpcRequest['id'],
  prefix: string,
  issues: ReadonlyArray<{ path: PropertyKey[]; message: string }>,
): JsonRpcResponse {
  const detail = issues
    .map((issue) => `${issue.path.length ? issue.path.map(String).join('.') : 'input'}: ${issue.message}`)
    .join('; ');
  return rpcError(id, -32602, detail ? `${prefix}: ${detail}` : prefix, issues);
}

function textResult(value: unknown): unknown {
  return {
    content: [{ type: 'text', text: JSON.stringify(value, null, 2) }],
    structuredContent: value,
    isError: false,
  };
}

function publicMonitor(value: Monitor & { owner: string }): Monitor {
  const copy = { ...value } as Record<string, unknown>;
  delete copy.owner;
  return copy as unknown as Monitor;
}

function boundInput(
  args: MonitorCreateDraftToolInput,
  context: CapabilityContext,
  stored: NonNullable<ReturnType<typeof sessionStore.get>>,
): MonitorInput {
  return {
    name: args.name,
    sessionId: context.sessionId,
    host: stored.host,
    cwd: stored.cwd,
    intervalMs: Math.round(args.intervalMinutes * 60_000),
    probe: args.probe,
    actionMode: args.actionMode,
    instructions: args.objective,
    maxWakeAttempts: args.maxWakeAttempts,
    remindEveryMs: Math.round((args.remindMinutes ?? Math.max(5, args.intervalMinutes)) * 60_000),
    notifyOnRecovery: args.notifyOnRecovery,
  };
}

async function handleRpc(request: JsonRpcRequest, context: CapabilityContext): Promise<JsonRpcResponse | undefined> {
  const id = request.id ?? null;
  if (!request.method) return rpcError(id, -32600, 'Invalid Request');
  if (request.method === 'notifications/initialized' || request.method === 'notifications/cancelled') return undefined;
  if (request.method === 'initialize') {
    const requested = typeof request.params?.protocolVersion === 'string'
      ? request.params.protocolVersion
      : '2025-03-26';
    return {
      jsonrpc: '2.0',
      id,
      result: {
        protocolVersion: requested,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: MCP_NAME, version: config.serverVersion },
      },
    };
  }
  if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (request.method === 'tools/list') {
    return { jsonrpc: '2.0', id, result: { tools: toolDefinitions } };
  }
  if (request.method !== 'tools/call') return rpcError(id, -32601, 'Method not found');
  const name = typeof request.params?.name === 'string' ? request.params.name : '';
  if (!MANAGEMENT_TOOL_NAMES.has(name)) return rpcError(id, -32602, `Unknown tool: ${name || '(missing)'}`);
  const stored = sessionStore.get(context.sessionId);
  if (!stored || !sessionVisible(context.owner, context.sessionId)) {
    return rpcError(id, -32001, 'The Vibe session attached to this capability no longer exists');
  }

  try {
    if (name === TOOLS.list) {
      return {
        jsonrpc: '2.0',
        id,
        result: textResult({ monitors: monitorStore.list(context.owner).map(publicMonitor) }),
      };
    }

    if (name === TOOLS.create || name === TOOLS.createDraft) {
      const parsed = (name === TOOLS.create ? monitorCreateToolSchema : monitorCreateDraftToolSchema)
        .safeParse(request.params?.arguments ?? {});
      if (!parsed.success) return validationError(id, 'Invalid monitor definition', parsed.error.issues);
      const normalized = monitorInputSchema.safeParse(boundInput(parsed.data, context, stored));
      if (!normalized.success) return validationError(id, 'Invalid monitor definition', normalized.error.issues);
      let monitor = monitorService.createDraft(context.owner, normalized.data);
      const enable = name === TOOLS.create && monitorCreateToolSchema.parse(parsed.data).enabled;
      if (enable) {
        monitor = monitorStore.setEnabled(monitor.id, context.owner, true)!;
        monitorService.announceChanged(context.owner, monitor.id);
      }
      return {
        jsonrpc: '2.0',
        id,
        result: textResult({
          monitor: publicMonitor(monitor),
          created: true,
          enabled: monitor.enabled,
          ...(name === TOOLS.createDraft
            ? { draftId: monitor.id, requiresConfirmation: false }
            : {}),
          message: monitor.enabled
            ? 'Monitor created and enabled; its first check is scheduled immediately.'
            : 'Monitor created in a stopped/draft state.',
        }),
      };
    }

    if (name === TOOLS.update) {
      const parsed = monitorUpdateToolSchema.safeParse(request.params?.arguments ?? {});
      if (!parsed.success) return validationError(id, 'Invalid monitor update', parsed.error.issues);
      const args = parsed.data;
      const current = monitorStore.getOwned(args.monitorId, context.owner);
      if (!current) return rpcError(id, -32004, 'Monitor not found');

      let sessionId = current.sessionId;
      let host = current.host;
      let cwd = current.cwd;
      if (args.sessionId !== undefined && args.sessionId !== current.sessionId) {
        const target = sessionStore.get(args.sessionId);
        if (!target || !sessionVisible(context.owner, args.sessionId)) {
          return rpcError(id, -32004, 'Target Vibe session not found or not owned by this account');
        }
        sessionId = args.sessionId;
        host = target.host;
        cwd = target.cwd;
      }
      const candidate: MonitorInput = {
        name: args.name ?? current.name,
        sessionId,
        host,
        cwd,
        intervalMs: args.intervalMinutes === undefined
          ? current.intervalMs
          : Math.round(args.intervalMinutes * 60_000),
        probe: args.probe ?? current.probe,
        actionMode: args.actionMode ?? current.actionMode,
        instructions: args.objective ?? current.instructions,
        maxWakeAttempts: args.maxWakeAttempts ?? current.maxWakeAttempts,
        remindEveryMs: args.remindMinutes === undefined
          ? current.remindEveryMs
          : Math.round(args.remindMinutes * 60_000),
        notifyOnRecovery: args.notifyOnRecovery ?? current.notifyOnRecovery,
      };
      const normalized = monitorInputSchema.safeParse(candidate);
      if (!normalized.success) {
        return validationError(id, 'Invalid resulting monitor configuration', normalized.error.issues);
      }
      const monitor = monitorStore.update(current.id, context.owner, normalized.data);
      if (!monitor) return rpcError(id, -32004, 'Monitor not found');
      monitorService.announceChanged(context.owner, monitor.id);
      return {
        jsonrpc: '2.0',
        id,
        result: textResult({
          monitor: publicMonitor(monitor),
          updated: true,
          message: monitor.enabled
            ? 'Monitor updated; a verification check is scheduled immediately.'
            : 'Stopped monitor updated.',
        }),
      };
    }

    if (name === TOOLS.start || name === TOOLS.stop || name === TOOLS.runNow) {
      const parsed = monitorIdToolSchema.safeParse(request.params?.arguments ?? {});
      if (!parsed.success) return validationError(id, 'Invalid monitor id', parsed.error.issues);
      let monitor = monitorStore.getOwned(parsed.data.monitorId, context.owner);
      if (!monitor) return rpcError(id, -32004, 'Monitor not found');

      if (name === TOOLS.runNow) {
        const result = await monitorService.runNow(monitor.id);
        monitor = monitorStore.getOwned(monitor.id, context.owner) ?? monitor;
        return {
          jsonrpc: '2.0',
          id,
          result: textResult({ monitor: publicMonitor(monitor), result }),
        };
      }

      if (name === TOOLS.start) {
        if (monitor.sessionId) {
          const target = sessionStore.get(monitor.sessionId);
          if (!target || !sessionVisible(context.owner, monitor.sessionId)) {
            return rpcError(id, -32004, 'Attached Vibe session no longer exists');
          }
          // Refresh authoritative location in case session metadata changed.
          monitor = monitorStore.update(monitor.id, context.owner, {
            host: target.host,
            cwd: target.cwd,
          }) ?? monitor;
        } else if (!hostRegistry.visibleTo(context.owner, monitor.host ?? 'local')) {
          return rpcError(id, -32004, 'Monitor host no longer exists or is not owned by this account');
        }
      }
      monitor = monitorStore.setEnabled(monitor.id, context.owner, name === TOOLS.start) ?? monitor;
      monitorService.announceChanged(context.owner, monitor.id);
      return {
        jsonrpc: '2.0',
        id,
        result: textResult({
          monitor: publicMonitor(monitor),
          message: monitor.enabled
            ? 'Monitor enabled; its first check is scheduled immediately.'
            : 'Monitor stopped. Configuration and incident history were preserved.',
        }),
      };
    }
  } catch (error) {
    return rpcError(id, -32603, error instanceof Error ? error.message : 'Monitor operation failed');
  }
  return rpcError(id, -32602, `Unknown tool: ${name}`);
}

/** Stateless Streamable-HTTP MCP endpoint. Its short-lived capability grants
 * account-scoped monitor management while the originating Vibe session still
 * exists; it never carries the broad Vibe login token. */
export async function handleMonitorMcp(req: Request, res: Response): Promise<void> {
  // Agent MCP clients are not browsers and send no Origin. Reject browser
  // origins outright: the endpoint is capability-authenticated, but this also
  // closes the DNS-rebinding class called out by the Streamable HTTP spec.
  if (req.header('origin')) {
    res.status(403).json(rpcError(null, -32000, 'browser origins are not allowed'));
    return;
  }
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    res.status(405).json({ error: 'method not allowed' });
    return;
  }
  const token = bearer(req);
  const context = token ? verifyCapability(token) : undefined;
  if (!context) {
    res.status(401).json({ error: 'invalid or expired monitor capability' });
    return;
  }
  const input = req.body as JsonRpcRequest | JsonRpcRequest[];
  if (Array.isArray(input)) {
    const settled = await Promise.all(input.map((entry) => handleRpc(entry, context)));
    const responses = settled.filter(Boolean) as JsonRpcResponse[];
    if (!responses.length) {
      res.status(202).end();
      return;
    }
    res.json(responses);
    return;
  }
  if (!input || typeof input !== 'object') {
    res.status(400).json(rpcError(null, -32600, 'Invalid Request'));
    return;
  }
  const response = await handleRpc(input, context);
  if (!response) {
    res.status(202).end();
    return;
  }
  res.json(response);
}
