import crypto from 'node:crypto';
import { spawn, type ChildProcess } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
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

type JsonRpcId = number | string;

interface PendingRpc {
  resolve: (value: any) => void;
  reject: (error: Error) => void;
}

export interface KiroAcpRunOptions {
  prompt: string;
  cwd: string;
  model: string;
  permissionMode: PermissionMode;
  effort?: EffortLevel;
  resume?: string;
  mcpServers?: McpServerDef[];
  remote?: { sshTarget: string; cwd: string; proxy?: string };
}

/** Spawn-time trust flags from Vibe permission modes. */
function trustArgs(mode: PermissionMode): string[] {
  if (mode === 'bypassPermissions') return ['--trust-all-tools'];
  if (mode === 'acceptEdits') return ['--trust-tools=fs_read,fs_write'];
  return [];
}

function acpArgs(opts: KiroAcpRunOptions): string[] {
  const args = ['acp', ...trustArgs(opts.permissionMode)];
  if (opts.model && opts.model !== 'auto') args.push('--model', opts.model);
  return args;
}

function buildAcpSpawn(opts: KiroAcpRunOptions): { bin?: string; args: string[]; remote: boolean; cwd?: string } {
  const args = acpArgs(opts);
  if (!opts.remote) return { bin: config.kiroExecutable, args, remote: false, cwd: opts.cwd };

  const invoke = `"$kiro_bin" ${args.map(shQuote).join(' ')}`;
  const inner = [
    'kiro_fallback="$HOME/.local/bin/kiro-cli"',
    'if command -v kiro-cli >/dev/null 2>&1; then kiro_bin="$(command -v kiro-cli)"; '
      + 'elif [ -x "$kiro_fallback" ]; then kiro_bin="$kiro_fallback"; '
      + 'else echo "kiro-cli not found" >&2; exit 127; fi',
    `exec ${invoke}`,
  ].join('\n');
  const remoteCmd = proxyEnvPrefix(opts.remote.proxy) + loginShellCommand(inner);
  const { bin, opts: sshOpts } = sshConnectPrefix();
  return { bin, args: [...sshOpts, '-T', opts.remote.sshTarget, remoteCmd], remote: true };
}

function textOfContent(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!content || typeof content !== 'object') return '';
  const value = content as { text?: unknown; content?: unknown; type?: unknown };
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
      else if (item?.type === 'diff') parts.push(`diff ${item.path ?? ''}`);
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

function modeIdFor(permissionMode: PermissionMode): string {
  return permissionMode === 'plan' ? 'kiro_planner' : 'kiro_default';
}

/** One Kiro ACP process for one turn (initialize → new/load → configure → prompt). */
export class KiroAcpClient {
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
    private readonly opts: KiroAcpRunOptions,
    private readonly cb: RunCallbacks,
  ) {}

  abort(): void {
    this.aborted = true;
    if (this.sessionId && this.child?.stdin?.writable) this.notify('session/cancel', { sessionId: this.sessionId });
    this.child?.kill('SIGTERM');
    this.rejectAll(new Error('aborted'));
  }

  async run(): Promise<{ error?: string }> {
    const spawnSpec = buildAcpSpawn(this.opts);
    if (!spawnSpec.bin) return { error: 'kiro-cli not found — install Kiro CLI or set KIRO_CLI_PATH' };

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
        this.rejectAll(new Error(cleanRemoteStderr(this.stderr) || `kiro-cli acp exited with code ${code}`));
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

      await this.request('session/prompt', {
        sessionId: this.sessionId,
        prompt: [{ type: 'text', text: this.opts.prompt }],
      });
      this.flushStream();
      return {};
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
        this.ignoreUpdates = true;
        await this.request('session/load', { sessionId: this.opts.resume, cwd, mcpServers });
        this.ignoreUpdates = false;
        return this.opts.resume;
      } catch (error) {
        this.ignoreUpdates = false;
        log.warn('kiro acp session/load failed, starting new session', error);
      }
    }
    const created = await this.request('session/new', { cwd, mcpServers });
    const id = typeof created?.sessionId === 'string' ? created.sessionId : '';
    if (!id) throw new Error('session/new did not return sessionId');
    return id;
  }

  private async applySessionConfig(): Promise<void> {
    if (!this.sessionId) return;
    const modeId = modeIdFor(this.opts.permissionMode);
    try {
      await this.request('session/set_mode', { sessionId: this.sessionId, modeId });
    } catch (error) {
      log.debug('kiro acp set_mode failed', modeId, error);
    }
    if (this.opts.model && this.opts.model !== 'auto') {
      try {
        await this.request('session/set_model', { sessionId: this.sessionId, modelId: this.opts.model });
      } catch (error) {
        log.debug('kiro acp set_model failed', this.opts.model, error);
      }
    }
    if (this.opts.effort && this.opts.effort !== 'ultra') {
      try {
        await this.request('session/set_config_option', {
          sessionId: this.sessionId,
          configId: 'effort',
          value: this.opts.effort,
        });
      } catch {
        /* optional — older builds may lack this config */
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

    // Kiro sends standard updates on `session/update` and a few extra ones on a
    // vendor-prefixed method (`_kiro.dev/session/update`) — including the
    // `tool_call_chunk` that carries the real tool name.
    if (message.method === 'session/update' || message.method === '_kiro.dev/session/update') {
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
      log.warn('kiro acp handler failed', message.method, error);
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
      // Announced before the tool_call itself and the only place the actual tool
      // name appears (`todo_list`) — a tool_call's `title` is prose ("Creating
      // task list: …"), which the UI can't map to a kind. Remember it as the
      // fallback name for this call.
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
      const name = toolNameFromUpdate(update) ?? previous?.rawName ?? previous?.name ?? 'tool';
      const enriched = enrichToolInput(update);
      const input = enriched ? { ...(previous?.input ?? {}), ...enriched } : (previous?.input ?? {});
      this.tools.set(id, { name, rawName: previous?.rawName, input });
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

  private async handleRequestPermission(params: any): Promise<unknown> {
    if (this.aborted) return { outcome: { outcome: 'cancelled' } };
    const toolCall = params?.toolCall ?? {};
    const toolName = String(toolCall.title || toolCall.kind || toolCall.toolCallId || 'tool');
    const content = contentListText(toolCall.content);
    const rawInput = toolCall.rawInput ?? toolCall.raw_input;
    const input = rawInput ?? {
      kind: toolCall.kind,
      title: toolCall.title,
      description: content || undefined,
    };
    const request: PermissionRequest = {
      requestId: crypto.randomUUID(),
      toolName,
      input,
      plan: /ExitPlanMode|kiro_planner/i.test(toolName) && content ? content : undefined,
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
      const id = `kiro_acp_${crypto.randomUUID()}`;
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
