import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { acpDiffText } from '../util/acpDiff.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, shQuote, sshConnectPrefix } from '../remote/ssh.js';
import {
  type EffortLevel,
  type McpServerDef,
  type PermissionDecision,
  type PermissionMode,
  type PermissionRequest,
} from '../../../shared/protocol.js';
import type { RunCallbacks } from '../claude/types.js';
import { toAcpMcpServers } from '../mcp/apply.js';
import { devinModeIdFor } from './models.js';

type JsonRpcId = number | string;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface DevinAcpRunOptions {
  prompt: string;
  cwd: string;
  /** Model *family* as stored on the session (e.g. `claude-opus-5`, or `auto`). */
  model: string;
  /**
   * The concrete variant uid to hand Devin, assembled from `model` + the
   * session's effort by the runner (`resolveDevinModelId`). Empty when the
   * session is on `auto`, in which case Devin keeps its own default.
   */
  modelId?: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  resume?: string;
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

/**
 * Devin's ACP transport takes no trust/permission flags — the mode is a session
 * config option applied after the session opens (see `applySessionConfig`).
 */
function buildAcpSpawn(opts: DevinAcpRunOptions): { bin?: string; args: string[]; remote: boolean; cwd?: string } {
  const args = ['acp'];
  if (!opts.remote) return { bin: config.devinExecutable, args, remote: false, cwd: opts.cwd };

  const invoke = `"$devin_bin" ${args.map(shQuote).join(' ')}`;
  const inner = [
    'devin_fallback="$HOME/.local/bin/devin"',
    'if command -v devin >/dev/null 2>&1; then devin_bin="$(command -v devin)"; '
      + 'elif [ -x "$devin_fallback" ]; then devin_bin="$devin_fallback"; '
      + 'else echo "devin CLI not found" >&2; exit 127; fi',
    `exec ${invoke}`,
  ].join('\n');
  const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(inner);
  const { bin, opts: sshOpts } = sshConnectPrefix();
  return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const value = content as { text?: unknown; content?: unknown };
  if (typeof value.text === 'string') return value.text;
  return textOfContent(value.content);
}

function contentListText(content: unknown): string {
  if (!Array.isArray(content)) return textOfContent(content);
  return content.map((item) => textOfContent(item)).filter(Boolean).join('\n');
}

function toolResultFromUpdate(update: any): { content: string; isError: boolean } {
  const raw = update?.rawOutput ?? update?.content;
  const isError = update?.status === 'failed';
  if (raw == null) return { content: '', isError };
  if (typeof raw === 'string') return { content: raw, isError };
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (item?.type === 'content') parts.push(textOfContent(item.content));
      else if (item?.type === 'diff') parts.push(acpDiffText(item));
      else if (typeof item === 'string') parts.push(item);
      else parts.push(JSON.stringify(item));
    }
    return { content: parts.filter(Boolean).join('\n'), isError };
  }
  return { content: JSON.stringify(raw, null, 2), isError };
}

const ACP_KIND_NAME: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  delete: 'Delete',
  move: 'Move',
  search: 'Grep',
  execute: 'Shell',
  fetch: 'Fetch',
  think: 'Think',
  switch_mode: 'SwitchMode',
};

const PLAN_EXIT_TOOL_RE = /exit[\s_-]*plan[\s_-]*mode/i;

function toolNameFromUpdate(update: any): string | null {
  const title = typeof update?.title === 'string' ? update.title.trim() : '';
  if (title && /^[A-Za-z][A-Za-z0-9_]*$/.test(title)) return title;
  const kind = typeof update?.kind === 'string' ? update.kind : '';
  if (kind && ACP_KIND_NAME[kind]) return ACP_KIND_NAME[kind]!;
  if (kind && kind !== 'other') return kind;
  return null;
}

function enrichToolInput(update: any): Record<string, unknown> | null {
  const raw = update?.rawInput ?? update?.raw_input;
  let input: Record<string, unknown> = {};
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) input = { ...(raw as Record<string, unknown>) };
  else if (typeof raw === 'string' && raw) input = { value: raw };

  if (Array.isArray(update?.locations) && update.locations.length) {
    const paths = update.locations
      .map((item: any) => item?.path)
      .filter((value: unknown): value is string => typeof value === 'string' && !!value);
    if (!input.path && paths.length) input.path = paths[0];
    if (paths.length > 1) input.paths = paths;
  }
  if (Array.isArray(update?.content)) {
    for (const item of update.content) {
      if (!input.path && item?.type === 'diff' && typeof item.path === 'string') input.path = item.path;
    }
  }
  return Object.keys(input).length ? input : null;
}

/** One Devin ACP process for one turn (initialize → new/load → configure → prompt). */
export class DevinAcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRpc>();
  private buffer = '';
  private stderr = '';
  private aborted = false;
  private ignoreUpdates = false;
  private closed = false;
  private sessionId: string | null = null;
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private tools = new Map<string, { name: string; rawName?: string; input: Record<string, unknown> }>();

  constructor(
    private readonly opts: DevinAcpRunOptions,
    private readonly cb: RunCallbacks,
  ) {}

  abort(): void {
    this.aborted = true;
    if (this.sessionId && this.child?.stdin?.writable) this.notify('session/cancel', { sessionId: this.sessionId });
    this.child?.kill('SIGTERM');
    this.rejectAll(new Error('aborted'));
  }

  async run(): Promise<{ error?: string; usage?: unknown }> {
    const spawnSpec = buildAcpSpawn(this.opts);
    if (!spawnSpec.bin) return { error: 'devin CLI not found — install it or set DEVIN_CLI_PATH' };

    this.child = spawn(spawnSpec.bin, spawnSpec.args, {
      cwd: spawnSpec.remote ? undefined : spawnSpec.cwd,
      env: { ...process.env },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    this.child.stdin?.on('error', () => undefined);
    this.child.stdout?.on('data', (data) => this.onStdout(data.toString()));
    this.child.stderr?.on('data', (data) => {
      this.stderr += data.toString();
    });

    const exitPromise = new Promise<void>((resolve) => {
      this.child!.on('error', (error) => {
        this.rejectAll(error instanceof Error ? error : new Error(String(error)));
        resolve();
      });
      this.child!.on('close', (code) => {
        this.closed = true;
        this.rejectAll(new Error(cleanRemoteStderr(this.stderr) || `devin acp exited with code ${code}`));
        resolve();
      });
    });

    try {
      await this.request('initialize', {
        protocolVersion: 1,
        clientCapabilities: {
          fs: { readTextFile: false, writeTextFile: false },
          terminal: false,
        },
        clientInfo: { name: 'vibe', version: '0.1.0' },
      });

      const cwd = this.opts.remote ? this.opts.remote.cwd : this.opts.cwd;
      this.sessionId = await this.openSession(cwd);
      this.cb.onClaudeSessionId(this.sessionId);
      await this.applySessionConfig();

      // ACP's final prompt response carries the turn's cumulative usage
      // ({totalTokens, inputTokens, outputTokens, cached*Tokens}) — the same
      // numbers Devin's own TUI reports at turn end.
      const promptResult = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: this.opts.prompt }],
      });
      this.flushStream();
      return { usage: (promptResult as { usage?: unknown } | undefined)?.usage };
    } catch (error) {
      if (this.aborted) return {};
      const message = error instanceof Error ? error.message : String(error);
      const detail = cleanRemoteStderr(this.stderr);
      return { error: detail && !message.includes(detail) ? `${message}\n${detail}` : message };
    } finally {
      this.flushStream();
      try {
        this.child?.stdin?.end();
      } catch {
        /* ignore */
      }
      const killer = setTimeout(() => this.child?.kill('SIGKILL'), 2000);
      await exitPromise.catch(() => undefined);
      clearTimeout(killer);
    }
  }

  private async openSession(cwd: string): Promise<string> {
    const mcpServers = await toAcpMcpServers(this.opts.mcpServers ?? []);
    if (this.opts.resume) {
      try {
        // Devin replays the whole stored conversation as message chunks while
        // loading, which would duplicate every block the UI already rendered
        // from Vibe's transcript. Swallow updates until the load settles.
        this.ignoreUpdates = true;
        await this.request('session/load', { sessionId: this.opts.resume, cwd, mcpServers });
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (error) {
        this.ignoreUpdates = false;
        // A session only becomes loadable once it has been persisted — which
        // needs at least one completed turn. Falling back to a fresh session is
        // correct for a first-turn retry, and better than failing the turn.
        log.warn('devin acp session/load failed, starting new session', error);
      }
    }
    const created = await this.request('session/new', { cwd, mcpServers });
    const id = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (!id) throw new Error('session/new did not return sessionId');
    return id;
  }

  private async applySessionConfig(): Promise<void> {
    if (!this.sessionId) return;
    const modeId = devinModeIdFor(this.opts.permissionMode);
    try {
      await this.request('session/set_config_option', {
        sessionId: this.sessionId,
        configId: 'mode',
        value: modeId,
      });
    } catch (error) {
      log.debug('devin acp set mode failed', modeId, error);
    }
    const modelId = this.opts.modelId?.trim();
    if (modelId) {
      try {
        await this.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: 'model',
          value: modelId,
        });
      } catch (error) {
        log.debug('devin acp set model failed', modelId, error);
      }
    }
  }

  private onStdout(chunk: string): void {
    this.buffer += chunk;
    let newline: number;
    while ((newline = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        void this.dispatch(JSON.parse(line));
      } catch {
        /* ignore non-JSON stdout noise */
      }
    }
  }

  private async dispatch(message: any): Promise<void> {
    if (!message || typeof message !== 'object') return;
    if (message.id != null && !message.method && (message.result !== undefined || message.error !== undefined)) {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error?.message ?? JSON.stringify(message.error)));
      else pending.resolve(message.result);
      return;
    }
    if (typeof message.method !== 'string') return;

    // Devin sends conversation updates on the standard `session/update` and
    // everything else (MCP connect chatter, server-list changes, terminal and
    // plan lifecycle events) under a `_cognition.ai/` vendor namespace. Only
    // `session/update` carries content the UI should render.
    if (message.method === 'session/update' || message.method === '_cognition.ai/session/update') {
      if (!this.ignoreUpdates) this.handleUpdate(message.params?.update);
      if (message.id != null) this.respond(message.id, {});
      return;
    }
    if (message.id == null) return;

    try {
      if (message.method === 'session/request_permission') {
        this.respond(message.id, await this.handleRequestPermission(message.params));
        return;
      }
      this.respond(message.id, {});
    } catch (error) {
      log.warn('devin acp handler failed', message.method, error);
      this.respond(message.id, { outcome: { outcome: 'cancelled' } });
    }
  }

  private handleUpdate(update: any): void {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = textOfContent(update.content);
      if (text) this.segment('assistant', text);
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = textOfContent(update.content);
      if (text) this.segment('thinking', text);
      return;
    }
    if (kind === 'tool_call_chunk') {
      const id = String(update.toolCallId ?? '');
      const rawName = toolNameFromUpdate(update);
      if (id && rawName) {
        const previous = this.tools.get(id);
        this.tools.set(id, { name: previous?.name ?? rawName, rawName, input: previous?.input ?? {} });
      }
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.flushStream();
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const previous = this.tools.get(id);
      // `cognition.ai/inferenceToolName` is Devin's own name for the tool
      // (`exit_plan_mode`, `exec`, `write_plan`, …) — the reliable identity of
      // otherwise-anonymous permission requests. Keep it across updates.
      const metaName = update?._meta?.['cognition.ai/inferenceToolName'];
      const rawName =
        typeof metaName === 'string' && metaName ? metaName : previous?.rawName;
      const name = toolNameFromUpdate(update) ?? rawName ?? previous?.name ?? 'tool';
      const enriched = enrichToolInput(update);
      const input = enriched ? { ...(previous?.input ?? {}), ...enriched } : (previous?.input ?? {});
      this.tools.set(id, { name, rawName, input });
      const { content, isError } = toolResultFromUpdate(update);
      const status = update.status === 'completed' ? 'done' : update.status === 'failed' || isError ? 'error' : 'running';
      this.cb.onEvent({
        k: 'block',
        block: {
          id,
          kind: 'tool',
          toolUseId: id,
          name,
          input,
          status,
          result: content || undefined,
          isError: status === 'error',
          ts: Date.now(),
        },
      });
      if (status === 'done' || status === 'error') {
        this.cb.onEvent({
          k: 'tool_result',
          toolUseId: id,
          content: content || (status === 'error' ? 'failed' : ''),
          isError: status === 'error',
        });
      }
      return;
    }
  }

  /**
   * Devin's request_permission params carry only the toolCallId — no title,
   * kind, or rawInput (verified against the live CLI). Everything the prompt
   * needs was already streamed as a tool_call update, which handleUpdate
   * tracked in `this.tools`; the plan-approval request is recognizable from
   * its `plan_accept_edits`/`plan_bypass` options.
   */
  private async handleRequestPermission(params: any): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };
    const toolCall = params?.toolCall ?? {};
    const toolCallId = String(toolCall.toolCallId ?? '');
    const tracked = toolCallId ? this.tools.get(toolCallId) : undefined;
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    const optionIds = options.map((option) => String(option?.optionId ?? ''));

    // Plan approval is the one request whose option set is `plan_*` + reject.
    const isPlanExit =
      optionIds.includes('plan_accept_edits') ||
      optionIds.includes('plan_bypass') ||
      PLAN_EXIT_TOOL_RE.test(String(tracked?.rawName ?? '')) ||
      PLAN_EXIT_TOOL_RE.test(String(toolCall.title ?? ''));

    // The command being approved, when Devin offers it for editing.
    const editableCommand = toolCall?._meta?.['cognition.ai/editableCommand'];
    const input =
      tracked?.input && Object.keys(tracked.input).length
        ? tracked.input
        : typeof editableCommand === 'string' && editableCommand
          ? { command: editableCommand }
          : {
              kind: toolCall.kind,
              title: toolCall.title,
              description: contentListText(toolCall.content) || undefined,
            };

    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName: isPlanExit
        ? 'ExitPlanMode'
        : String(tracked?.name ?? toolCall.title ?? toolCall.kind ?? 'tool'),
      input,
      // exit_plan_mode's rawInput carries the plan markdown.
      plan: isPlanExit && typeof (input as Record<string, unknown>).plan === 'string'
        ? ((input as Record<string, unknown>).plan as string)
        : undefined,
      ts: Date.now(),
    };
    const decision = await this.cb.requestPermission(request);
    return this.permissionDecision(params, decision);
  }

  private permissionDecision(params: any, decision: PermissionDecision): unknown {
    const options: any[] = Array.isArray(params?.options) ? params.options : [];
    if (!decision.allow) {
      const reject =
        options.find((option) => option?.kind === 'reject_once')
        ?? options.find((option) => /reject/i.test(option?.optionId));
      return { outcome: { outcome: 'selected', optionId: reject?.optionId ?? 'reject' } };
    }
    if (decision.remember) {
      const always = options.find((option) => option?.kind === 'allow_always');
      if (always?.optionId) return { outcome: { outcome: 'selected', optionId: always.optionId } };
    }
    const once = options.find((option) => option?.kind === 'allow_once');
    return { outcome: { outcome: 'selected', optionId: once?.optionId ?? 'approve_once' } };
  }

  private segment(kind: 'assistant' | 'thinking', text: string): void {
    if (this.stream && this.stream.kind !== kind) this.flushStream();
    if (!this.stream) {
      const id = `devin_acp_${crypto.randomUUID()}`;
      this.stream = { id, kind, text };
      this.cb.onEvent({ k: 'block', block: { id, kind, text, streaming: true, ts: Date.now() } });
      return;
    }
    this.stream.text += text;
    this.cb.onEvent({ k: 'delta', id: this.stream.id, field: 'text', chunk: text });
  }

  private flushStream(): void {
    if (!this.stream) return;
    this.cb.onEvent({ k: 'block_end', id: this.stream.id, text: this.stream.text });
    this.stream = null;
  }

  private request(method: string, params: unknown): Promise<any> {
    if (this.closed || !this.child?.stdin?.writable) return Promise.reject(new Error('acp process closed'));
    const id = this.nextId++;
    const payload = JSON.stringify({ jsonrpc: '2.0', id, method, params });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.child!.stdin!.write(payload + '\n', (error) => {
        if (!error) return;
        this.pending.delete(id);
        reject(error);
      });
    });
  }

  private notify(method: string, params: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method, params }) + '\n');
  }

  private respond(id: JsonRpcId, result: unknown): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
  }

  private rejectAll(error: Error): void {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }
}
