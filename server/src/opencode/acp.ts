import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, shQuote, sshConnectPrefix } from '../remote/ssh.js';
import type {
  EffortLevel,
  McpServerDef,
  PermissionDecision,
  PermissionMode,
  PermissionRequest,
} from '../../../shared/protocol.js';
import type { RunCallbacks } from '../claude/types.js';
import { toAcpMcpServers } from '../mcp/apply.js';

type JsonRpcId = number | string;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface OpencodeAcpRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  /** Reasoning effort → the session model's `variant` (`set_model`). */
  effort?: EffortLevel;
  /** Native opencode session id (`ses_…`) to resume. */
  resume?: string;
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

/** Map a Vibe effort level to opencode's provider-specific `variant`
 *  (reasoning effort, e.g. `high`, `max`, `minimal`). Unknown tiers fold down
 *  to the nearest known one; undefined ⇒ omit (opencode default applies). */
export function opencodeVariantValue(effort?: EffortLevel): string | undefined {
  if (!effort) return undefined;
  if (effort === 'ultra') return 'max';
  if (effort === 'low' || effort === 'medium' || effort === 'high' || effort === 'xhigh' || effort === 'max') {
    return effort;
  }
  return undefined;
}

function buildAcpSpawn(opts: OpencodeAcpRunOptions): { bin?: string; args: string[]; remote: boolean; cwd?: string } {
  const args = ['acp'];
  if (!opts.remote) return { bin: config.opencodeExecutable, args, remote: false, cwd: opts.cwd };

  const invoke = `"$opencode_bin" ${args.map(shQuote).join(' ')}`;
  const inner = [
    'opencode_fallback="$HOME/.opencode/bin/opencode"',
    'if command -v opencode >/dev/null 2>&1; then opencode_bin="$(command -v opencode)"; '
      + 'elif [ -x "$opencode_fallback" ]; then opencode_bin="$opencode_fallback"; '
      + 'else echo "opencode not found" >&2; exit 127; fi',
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

/** opencode ships tool results as `[{type:'content', content:{type:'text', text}}]`. */
function toolResultFromUpdate(update: any): { content: string; isError: boolean } {
  const raw = update?.rawOutput ?? update?.content;
  const isError = update?.status === 'failed' || update?.status === 'cancelled';
  if (raw == null) return { content: '', isError };
  if (typeof raw === 'string') return { content: raw, isError };
  if (Array.isArray(raw)) {
    const parts: string[] = [];
    for (const item of raw) {
      if (item?.type === 'content') parts.push(textOfContent(item.content));
      else if (typeof item === 'string') parts.push(item);
      else parts.push(JSON.stringify(item));
    }
    return { content: parts.filter(Boolean).join('\n'), isError };
  }
  return { content: JSON.stringify(raw, null, 2), isError };
}

/**
 * Display name for an opencode tool call. ACP doesn't send the CLI tool name
 * (`title` is a path, `kind` is `other`), so infer from the input shape.
 */
function toolNameFromUpdate(update: any, previous?: string): string {
  const title = typeof update?.title === 'string' ? update.title.trim() : '';
  if (title && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(title) && !title.includes('/')) return title;
  const raw = update?.rawInput ?? update?.raw_input;
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const rec = raw as Record<string, unknown>;
    if ('command' in rec || 'cmd' in rec) return 'bash';
    // Content appears only once the call is underway — at permission time a
    // file op carries just `{filepath}`, whose direction is unknowable, so
    // stay neutral instead of guessing read vs write.
    if ('content' in rec || 'data' in rec) return 'write';
    if ('filepath' in rec || 'filePath' in rec || 'path' in rec) return 'file';
  }
  const kind = typeof update?.kind === 'string' ? update.kind : '';
  if (kind && kind !== 'other') return kind;
  return previous ?? 'tool';
}

interface AcpUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cachedReadTokens?: number;
  cost?: number;
}

function num(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** One opencode ACP process for one turn (initialize → new/load → prompt). */
export class OpencodeAcpClient {
  private child: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<JsonRpcId, PendingRpc>();
  private buffer = '';
  private stderr = '';
  private aborted = false;
  private ignoreUpdates = false;
  private closed = false;
  private sessionId: string | null = null;
  /** Model opencode resolved for this session (`provider/id`), from the
   *  `model` config option in session/new|load. Empty until opened. */
  private resolvedModel = '';
  private stream: { id: string; kind: 'assistant' | 'thinking'; text: string } | null = null;
  private tools = new Map<string, { name: string; input: Record<string, unknown>; result: string; isError: boolean }>();
  private usage: AcpUsage | null = null;

  constructor(
    private readonly opts: OpencodeAcpRunOptions,
    private readonly cb: RunCallbacks,
  ) {}

  abort(): void {
    this.aborted = true;
    if (this.sessionId && this.child?.stdin?.writable) this.notify('session/cancel', { sessionId: this.sessionId });
    this.child?.kill('SIGTERM');
    this.rejectAll(new Error('aborted'));
  }

  async run(): Promise<{ error?: string; usage?: AcpUsage | null; model?: string }> {
    const spawnSpec = buildAcpSpawn(this.opts);
    if (!spawnSpec.bin) return { error: 'opencode not found — install the opencode CLI (see https://opencode.ai) or set OPENCODE_CLI_PATH' };

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
        this.rejectAll(new Error(cleanRemoteStderr(this.stderr) || `opencode acp exited with code ${code}`));
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

      const result = await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: this.opts.prompt }],
      });
      this.mergeUsage(result?.usage);
      this.flushStream();
      const stopReason = typeof result?.stopReason === 'string' ? result.stopReason : 'end_turn';
      const failed = /error|cancel/i.test(stopReason);
      const out = failed
        ? { error: `opencode turn stopped (${stopReason})`, usage: this.usage, model: this.resolvedModel }
        : { usage: this.usage, model: this.resolvedModel };
      return out;
    } catch (error) {
      if (this.aborted) return { usage: this.usage, model: this.resolvedModel };
      const message = error instanceof Error ? error.message : String(error);
      const detail = cleanRemoteStderr(this.stderr);
      return { error: detail && !message.includes(detail) ? `${message}\n${detail}` : message, usage: this.usage, model: this.resolvedModel };
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
        this.ignoreUpdates = true;
        const loaded = await this.request('session/load', { sessionId: this.opts.resume, cwd, mcpServers });
        this.noteResolvedModel(loaded);
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (error) {
        this.ignoreUpdates = false;
        log.warn('opencode acp session/load failed, starting new session', error);
      }
    }
    const created = await this.request('session/new', { cwd, mcpServers });
    const id = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (!id) throw new Error('session/new did not return sessionId');
    this.noteResolvedModel(created);
    return id;
  }

  /** Remember the model opencode picked (used for the context-window label). */
  private noteResolvedModel(result: any): void {
    const options = Array.isArray(result?.configOptions) ? result.configOptions : [];
    const model = options.find((o: any) => o?.id === 'model');
    const current = typeof model?.currentValue === 'string' ? model.currentValue : '';
    if (current) this.resolvedModel = current;
  }

  private async applySessionConfig(): Promise<void> {
    if (!this.sessionId) return;
    // Model and reasoning variant travel together: `set_model` requires a
    // modelId, so an `auto` model falls back to the default opencode resolved
    // at session open. Variant comes from the session's effort level.
    const variant = opencodeVariantValue(this.opts.effort);
    const modelId =
      this.opts.model && this.opts.model !== 'auto' ? this.opts.model : this.resolvedModel || undefined;
    if (modelId) {
      try {
        await this.request('session/set_model', {
          sessionId: this.sessionId,
          modelId,
          ...(variant ? { variant } : {}),
        });
      } catch (error) {
        log.debug('opencode acp set_model failed', modelId, variant, error);
      }
    }
    // Plan mode disallows all edit tools server-side (verified option).
    if (this.opts.permissionMode === 'plan') {
      try {
        await this.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: 'mode',
          value: 'plan',
        });
      } catch {
        /* older builds may lack this config */
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

    if (message.method === 'session/update') {
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
      log.warn('opencode acp handler failed', message.method, error);
      this.respond(message.id, { outcome: { outcome: 'cancelled' } });
    }
  }

  private handleUpdate(update: any): void {
    if (!update || typeof update !== 'object') return;
    const kind = update.sessionUpdate;
    if (kind === 'agent_message_chunk') {
      const text = textOfContent(update.content);
      if (text) {
        this.cb.onTurnState?.(true);
        this.segment('assistant', text);
      }
      return;
    }
    if (kind === 'agent_thought_chunk') {
      const text = textOfContent(update.content);
      if (text) {
        this.cb.onTurnState?.(true);
        this.segment('thinking', text);
      }
      return;
    }
    if (kind === 'tool_call' || kind === 'tool_call_update') {
      this.flushStream();
      const id = String(update.toolCallId ?? '');
      if (!id) return;
      const previous = this.tools.get(id);
      const name = toolNameFromUpdate(update, previous?.name);
      const rawInput = update?.rawInput ?? update?.raw_input;
      const input =
        rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
          ? { ...(previous?.input ?? {}), ...(rawInput as Record<string, unknown>) }
          : (previous?.input ?? {});
      const { content, isError } = toolResultFromUpdate(update);
      // The terminal `completed` update carries no content — keep the last
      // non-empty result so history doesn't lose the output.
      const result = content || previous?.result || '';
      const status =
        update.status === 'completed' ? 'done' : update.status === 'failed' || update.status === 'cancelled' || isError ? 'error' : 'running';
      this.tools.set(id, { name, input, result, isError: status === 'error' });
      this.cb.onTurnState?.(true);
      this.cb.onEvent({
        k: 'block',
        block: {
          id,
          kind: 'tool',
          toolUseId: id,
          name,
          input,
          status,
          result: result || undefined,
          isError: status === 'error',
          ts: Date.now(),
        },
      });
      if (status === 'done' || status === 'error') {
        this.cb.onEvent({
          k: 'tool_result',
          toolUseId: id,
          content: result || (status === 'error' ? 'failed' : ''),
          isError: status === 'error',
        });
      }
      return;
    }
    if (kind === 'usage_update') {
      this.mergeUsage(update.usage ?? update);
    }
    // available_commands_update and other notices carry no conversation content.
  }

  /** Merge a usage payload from `usage_update` or the prompt result. Later
   *  (per-step) values win; absent fields keep the earlier ones. */
  private mergeUsage(raw: unknown): void {
    if (!raw || typeof raw !== 'object') return;
    const usage = raw as Record<string, unknown>;
    const prev = this.usage ?? {};
    this.usage = {
      inputTokens: num(usage.inputTokens) ?? prev.inputTokens,
      outputTokens: num(usage.outputTokens) ?? prev.outputTokens,
      totalTokens: num(usage.totalTokens) ?? prev.totalTokens,
      cachedReadTokens: num(usage.cachedReadTokens) ?? prev.cachedReadTokens,
      cost: num(usage.cost) ?? prev.cost,
    };
  }

  private async handleRequestPermission(params: any): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };
    // Always-approve: never surface a prompt even if opencode still asks.
    if (this.opts.permissionMode === 'bypassPermissions') {
      return this.permissionDecision(params, { allow: true, remember: true });
    }
    const toolCall = params?.toolCall ?? {};
    const toolName = toolNameFromUpdate(toolCall);
    const rawInput = toolCall.rawInput ?? toolCall.raw_input;
    const input =
      rawInput && typeof rawInput === 'object' && !Array.isArray(rawInput)
        ? (rawInput as Record<string, unknown>)
        : { kind: toolCall.kind, title: toolCall.title };
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName,
      input,
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
        ?? options.find((option) => /reject/i.test(option?.optionId ?? ''));
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
      const id = `opencode_acp_${crypto.randomUUID()}`;
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
