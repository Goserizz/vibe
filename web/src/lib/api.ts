import type {
  AccountInfo,
  AgentKind,
  AgentLatestVersions,
  AgentLoginAccount,
  AgentLoginStatus,
  AgentUpdateResult,
  ChatBlock,
  EffortLevel,
  FileEntry,
  HostStatus,
  LoginAgent,
  LoginRequest,
  LoginResponse,
  McpConfigSnapshot,
  McpServerDef,
  Monitor,
  MonitorEvent,
  MonitorInput,
  MonitorProbeResult,
  PermissionMode,
  ProjectDir,
  RemoteHost,
  SearchResult,
  SkillDetail,
  SkillEntry,
  SkillScope,
  SnapshotPage,
  ConfigFileDetail,
  ConfigFileEntry,
  SessionMeta,
  SessionPreset,
  SwitchFidelityMatrix,
  SwitchSessionResult,
  VibotConfigClient,
  VibotConvMeta,
  VibotMemory,
} from '@shared/protocol';
import type { ModelOption, PermissionOption } from './format';

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

let authToken = '';
export function setApiToken(token: string): void {
  authToken = token;
}

async function request<T>(path: string, options: RequestInit = {}): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${authToken}`,
      ...(options.headers ?? {}),
    },
  });
  if (!res.ok) {
    let message = res.statusText;
    try {
      const body = await res.json();
      message = body.error || message;
    } catch {
      /* ignore */
    }
    throw new ApiError(res.status, message);
  }
  return res.json() as Promise<T>;
}

export interface MeInfo {
  ok: boolean;
  serverVersion: string;
  defaultModel: string;
  account: string;
  isAdmin: boolean;
}

export const api = {
  me: () => request<MeInfo>('/me'),

  /** Password login — sent without a token (the caller has none yet). */
  login: (body: LoginRequest) =>
    request<LoginResponse>('/auth/login', { method: 'POST', body: JSON.stringify(body) }),

  listAccounts: () => request<{ accounts: AccountInfo[] }>('/accounts').then((r) => r.accounts),

  createAccount: (name: string, password: string) =>
    request<{ name: string; token: string }>('/accounts', {
      method: 'POST',
      body: JSON.stringify({ name, password }),
    }),

  deleteAccount: (name: string) =>
    request<{ ok: boolean; hostsRemoved: number }>(`/accounts/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  resetAccountToken: (name: string) =>
    request<{ name: string; token: string }>(`/accounts/${encodeURIComponent(name)}/token`, { method: 'POST' }),

  setAccountPassword: (name: string, password: string) =>
    request<{ ok: boolean }>(`/accounts/${encodeURIComponent(name)}/password`, {
      method: 'PUT',
      body: JSON.stringify({ password }),
    }),

  listProjects: () => request<{ projects: ProjectDir[] }>('/projects').then((r) => r.projects),

  // -- Durable monitors -----------------------------------------------------

  listMonitors: () => request<{ monitors: Monitor[] }>('/monitors').then((r) => r.monitors),

  listMonitorEvents: (monitorId?: string, limit = 100) => {
    const qs = new URLSearchParams({ limit: String(limit) });
    if (monitorId) qs.set('monitorId', monitorId);
    return request<{ events: MonitorEvent[] }>(`/monitor-events?${qs.toString()}`).then((r) => r.events);
  },

  createMonitor: (input: MonitorInput) =>
    request<{ monitor: Monitor }>('/monitors', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.monitor),

  updateMonitor: (id: string, input: MonitorInput) =>
    request<{ monitor: Monitor }>(`/monitors/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: JSON.stringify(input),
    }).then((r) => r.monitor),

  deleteMonitor: (id: string) =>
    request<{ ok: boolean }>(`/monitors/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  setMonitorEnabled: (id: string, enabled: boolean) =>
    request<{ monitor: Monitor }>(`/monitors/${encodeURIComponent(id)}/enabled`, {
      method: 'POST',
      body: JSON.stringify({ enabled }),
    }).then((r) => r.monitor),

  testMonitor: (input: MonitorInput) =>
    request<{ result: MonitorProbeResult }>('/monitors/test', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.result),

  runMonitor: (id: string) =>
    request<{ result: MonitorProbeResult; monitor: Monitor }>(`/monitors/${encodeURIComponent(id)}/run`, {
      method: 'POST',
    }),

  listCursorModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: { value: string; label: string }[] }>(`/cursor/models${q}`).then((r) => r.models);
  },

  listCodexModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[] }>(`/codex/models${q}`).then((r) => r.models);
  },

  getKimiCapabilities: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[]; acp: boolean }>(`/kimi/capabilities${q}`);
  },

  listKiroModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[] }>(`/kiro/models${q}`);
  },

  listGrokModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[] }>(`/grok/models${q}`);
  },

  listZcodeModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[] }>(`/zcode/models${q}`);
  },

  listCodebuddyModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[] }>(`/codebuddy/models${q}`);
  },

  listDevinModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[] }>(`/devin/models${q}`);
  },

  listOpencodeModels: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ models: ModelOption[]; permissions: PermissionOption[] }>(`/opencode/models${q}`);
  },

  validateDir: (path: string) =>
    request<{ ok: boolean; path: string; error?: string }>('/projects/validate', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  completeDir: ({ path, host }: { path: string; host?: string }) =>
    request<{ path: string; entries: { name: string; full: string; dir: boolean }[] }>('/projects/complete', {
      method: 'POST',
      body: JSON.stringify({ path, host }),
    }),

  listSessions: () => request<{ sessions: SessionMeta[] }>('/sessions').then((r) => r.sessions),

  createSession: (input: { cwd?: string; autoCwd?: boolean; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; agent?: AgentKind; title?: string; host?: string }) =>
    request<{ session: SessionMeta }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.session),

  listHosts: () => request<{ hosts: RemoteHost[]; localName: string }>('/hosts'),

  addHost: (host: RemoteHost) =>
    request<{ host: RemoteHost }>('/hosts', { method: 'POST', body: JSON.stringify(host) }).then((r) => r.host),

  updateHost: (name: string, patch: { ssh?: string; proxy?: string; proxyByAgent?: Partial<Record<AgentKind, string>> }) =>
    request<{ host: RemoteHost }>(`/hosts/${encodeURIComponent(name)}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.host),

  removeHost: (name: string) => request<{ ok: boolean }>(`/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  checkHost: (name: string) => request<HostStatus>(`/hosts/${encodeURIComponent(name)}/check`),

  // -- MCP servers (global registry + per-scope enable) ---------------------

  listMcp: () => request<McpConfigSnapshot>('/mcp'),

  upsertMcpServer: (def: McpServerDef) =>
    request<{ server: McpServerDef }>('/mcp/servers', { method: 'POST', body: JSON.stringify(def) }).then((r) => r.server),

  deleteMcpServer: (name: string) =>
    request<{ ok: boolean }>(`/mcp/servers/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  setMcpEnabled: (scope: string, names: string[]) =>
    request<{ enabled: string[]}>(`/mcp/enabled/${encodeURIComponent(scope)}`, {
      method: 'PUT',
      body: JSON.stringify({ names }),
    }).then((r) => r.enabled),

  startMcpOAuth: (name: string) =>
    request<{ authUrl: string }>('/mcp/oauth/start', { method: 'POST', body: JSON.stringify({ name }) }).then((r) => r.authUrl),

  disconnectMcpOAuth: (name: string) =>
    request<{ ok: boolean; oauth: Record<string, unknown> }>(`/mcp/oauth/disconnect/${encodeURIComponent(name)}`, {
      method: 'POST',
    }).then((r) => r.oauth),

  // -- Saved New-session presets (agent + model + permission + effort) --------

  listPresets: () => request<{ presets: SessionPreset[] }>('/presets').then((r) => r.presets),

  upsertPreset: (preset: SessionPreset) =>
    request<{ preset: SessionPreset }>('/presets', { method: 'POST', body: JSON.stringify(preset) }).then((r) => r.preset),

  deletePreset: (name: string) => request<{ ok: boolean }>(`/presets/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  // -- Agent skills (personal CRUD + read-only system view) ------------------

  listSkills: (agent: AgentKind, host?: string) => {
    const qs = new URLSearchParams({ agent });
    if (host) qs.set('host', host);
    return request<{ skills: SkillEntry[] }>(`/skills?${qs.toString()}`).then((r) => r.skills);
  },

  readSkill: (args: { agent: AgentKind; host?: string; name: string; scope?: SkillScope; source?: string }) => {
    const qs = new URLSearchParams({ agent: args.agent, name: args.name });
    if (args.host) qs.set('host', args.host);
    if (args.scope) qs.set('scope', args.scope);
    if (args.source) qs.set('source', args.source);
    return request<{ skill: SkillDetail }>(`/skills/read?${qs.toString()}`).then((r) => r.skill);
  },

  saveSkill: (input: { agent: AgentKind; name: string; description: string; whenToUse?: string; body: string; host?: string }) =>
    request<{ skill: SkillDetail }>('/skills', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.skill),

  deleteSkill: (args: { agent: AgentKind; host?: string; name: string }) => {
    const qs = new URLSearchParams({ agent: args.agent, name: args.name });
    if (args.host) qs.set('host', args.host);
    return request<{ ok: boolean }>(`/skills?${qs.toString()}`, { method: 'DELETE' });
  },

  // -- Agent config files (raw-text view/edit, local + remote) ----------------

  listAgentConfig: (agent: AgentKind, host?: string) => {
    const qs = new URLSearchParams({ agent });
    if (host) qs.set('host', host);
    return request<{ files: ConfigFileEntry[] }>(`/agent-config?${qs.toString()}`).then((r) => r.files);
  },

  readAgentConfig: (args: { agent: AgentKind; host?: string; id: string }) => {
    const qs = new URLSearchParams({ agent: args.agent, id: args.id });
    if (args.host) qs.set('host', args.host);
    return request<{ file: ConfigFileDetail }>(`/agent-config/read?${qs.toString()}`).then((r) => r.file);
  },

  saveAgentConfig: (input: { agent: AgentKind; host?: string; id: string; content: string }) =>
    request<{ file: ConfigFileDetail }>('/agent-config', { method: 'POST', body: JSON.stringify(input) }).then((r) => r.file),

  latestAgentVersions: () =>
    request<{ versions: AgentLatestVersions }>('/agents/latest').then((r) => r.versions),

  // -- Agent CLI sign-in (Cursor / Codex link-based login) ---------------------

  agentLoginAccount: (agent: LoginAgent, host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<AgentLoginAccount>(`/agents/${agent}/account${q}`);
  },

  agentLoginStatus: (agent: LoginAgent, host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ login: AgentLoginStatus | null }>(`/agents/${agent}/login${q}`).then((r) => r.login);
  },

  startAgentLogin: (agent: LoginAgent, host?: string) =>
    request<{ login: AgentLoginStatus }>(`/agents/${agent}/login`, {
      method: 'POST',
      body: JSON.stringify({ host: host ?? '' }),
    }).then((r) => r.login),

  cancelAgentLogin: (agent: LoginAgent, host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ ok: boolean }>(`/agents/${agent}/login${q}`, { method: 'DELETE' });
  },

  /** Deliver the pasted auth code to a flow waiting for it (Devin). */
  submitAgentLoginInput: (agent: LoginAgent, text: string, host?: string) =>
    request<{ login: AgentLoginStatus }>(`/agents/${agent}/login/input`, {
      method: 'POST',
      body: JSON.stringify({ text, host: host ?? '' }),
    }).then((r) => r.login),

  /** Sign the CLI out on a host. Destructive: only ever called from an explicit
   *  user action (Devin refuses to re-login while already signed in). */
  agentLogout: (agent: LoginAgent, host?: string) =>
    request<{ ok: boolean }>(`/agents/${agent}/logout`, {
      method: 'POST',
      body: JSON.stringify({ host: host ?? '' }),
    }),

  // -- CodeBuddy credential sign-in (no link flow — paste a key / token) -----

  codebuddyAccount: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<AgentLoginAccount>(`/agents/codebuddy/account${q}`);
  },

  /** Validate pasted credentials with a probe turn, then persist them. */
  saveCodebuddyCredentials: (input: { apiKey?: string; authToken?: string; host?: string }) =>
    request<{ ok: boolean; account: AgentLoginAccount }>('/agents/codebuddy/credentials', {
      method: 'POST',
      body: JSON.stringify({ ...input, host: input.host ?? '' }),
    }),

  /** Logout: remove the stored credential file (TUI logins untouched). */
  clearCodebuddyCredentials: (host?: string) => {
    const q = host ? `?host=${encodeURIComponent(host)}` : '';
    return request<{ ok: boolean; existed: boolean }>(`/agents/codebuddy/credentials${q}`, { method: 'DELETE' });
  },

  updateHostAgent: (name: string, agent: AgentKind) =>
    request<AgentUpdateResult>(`/hosts/${encodeURIComponent(name)}/agents/${agent}/update`, {
      method: 'POST',
    }),

  updateSession: (id: string, patch: { title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }) =>
    request<{ session: SessionMeta }>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.session),

  /**
   * 把一个会话切换成另一个 agent（历史无损保留）。
   * `fidelity` 为 `partial` 时表示本次目标 agent 的原生写入失败或运行时
   * 依赖不可用，历史会作为首轮上下文注入 —— UI 需要就此提示用户。
   */
  switchSessionAgent: (
    id: string,
    input: { agent: AgentKind; model?: string; carryThinking?: boolean },
  ): Promise<SwitchSessionResult> =>
    request<SwitchSessionResult>(`/sessions/${encodeURIComponent(id)}/switch`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),

  /** 10×10 = 100 个转换方向各自的保真等级（由目标 agent 的存储方式决定）。 */
  switchFidelity: (): Promise<SwitchFidelityMatrix> => request<SwitchFidelityMatrix>('/meta/switch-fidelity'),

  deleteSession: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),

  setSessionPinned: (id: string, pinned: boolean) =>
    request<{ ok: boolean; pinned: boolean }>(`/sessions/${id}/pin`, {
      method: 'PUT',
      body: JSON.stringify({ pinned }),
    }),

  getMessages: (id: string, opts: { cursor?: string; limit?: number } = {}) => {
    const qs = new URLSearchParams();
    if (opts.cursor) qs.set('cursor', opts.cursor);
    if (opts.limit) qs.set('limit', String(opts.limit));
    const suffix = qs.size > 0 ? `?${qs.toString()}` : '';
    return request<{ blocks: ChatBlock[]; seq: number } & SnapshotPage>(`/sessions/${id}/messages${suffix}`);
  },
  /** Unabridged text of a tool result that arrived truncated in a page. */
  getBlockResult: (id: string, blockId: string, ref: string) =>
    request<{ blockId: string; size: number; text: string }>(
      `/sessions/${id}/blocks/${encodeURIComponent(blockId)}/result?ref=${encodeURIComponent(ref)}`,
    ),

  search: (q: string) =>
    request<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.results),

  // -- Files panel (local + remote) -------------------------------------------
  // `host` is passed only for remote sessions; omit it for local.

  listFiles: ({ host, dir }: { host?: string; dir: string }) => {
    const qs = new URLSearchParams({ path: dir });
    if (host) qs.set('host', host);
    return request<{ path: string; entries: FileEntry[] }>(`/files?${qs.toString()}`).then((r) => r.entries);
  },

  readFile: ({ host, path }: { host?: string; path: string }) => {
    const qs = new URLSearchParams({ path });
    if (host) qs.set('host', host);
    return request<{ path: string; content: string }>(`/files/read?${qs.toString()}`).then((r) => r.content);
  },

  writeFile: ({ host, path, content }: { host?: string; path: string; content: string }) =>
    request<{ ok: boolean }>('/files', {
      method: 'PUT',
      body: JSON.stringify({ host, path, content }),
    }),

  // Direct URL for binary display (e.g. <img src>). Token in the query lets the
  // browser fetch it without a custom auth header.
  fileRawUrl: ({ host, path }: { host?: string; path: string }) => {
    const qs = new URLSearchParams({ path });
    if (host) qs.set('host', host);
    return `/api/files/raw?token=${encodeURIComponent(authToken)}&${qs.toString()}`;
  },

  // Direct URL for a Save-As download (server sets Content-Disposition: attachment).
  // Like fileRawUrl, the token rides in the query so a plain <a href> works.
  downloadFileUrl: ({ host, path }: { host?: string; path: string }) => {
    const qs = new URLSearchParams({ path });
    if (host) qs.set('host', host);
    return `/api/files/download?token=${encodeURIComponent(authToken)}&${qs.toString()}`;
  },

  // Upload one file (raw bytes) into `dir`. Sends the File as the body — not
  // JSON — so binary passes through untouched. Bypasses the JSON `request`
  // helper on purpose (it forces Content-Type: application/json).
  uploadFile: ({ host, dir, file }: { host?: string; dir: string; file: File }): Promise<{ ok: boolean; path: string }> => {
    const qs = new URLSearchParams({ dir, name: file.name });
    if (host) qs.set('host', host);
    return fetch(`/api/files/upload?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${authToken}` },
      body: file,
    }).then(async (res) => {
      if (!res.ok) {
        let message = res.statusText;
        try {
          const body = await res.json();
          message = body.error || message;
        } catch {
          /* keep statusText */
        }
        throw new ApiError(res.status, message);
      }
      return res.json();
    });
  },

  // Attach a file to a chat message in `sessionId`. The server stages it in a
  // per-session temp dir on the session's host and returns the absolute path,
  // which the composer folds into the prompt so the agent reads it with its own
  // tools. Raw bytes body — bypasses the JSON `request` helper on purpose.
  uploadAttachment: ({ sessionId, file }: { sessionId: string; file: File }): Promise<{ ok: boolean; path: string }> => {
    const qs = new URLSearchParams({ name: file.name });
    return fetch(`/api/sessions/${encodeURIComponent(sessionId)}/attachments?${qs.toString()}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/octet-stream', Authorization: `Bearer ${authToken}` },
      body: file,
    }).then(async (res) => {
      if (!res.ok) {
        let message = res.statusText;
        try {
          const body = await res.json();
          message = body.error || message;
        } catch {
          /* keep statusText */
        }
        throw new ApiError(res.status, message);
      }
      return res.json();
    });
  },

  // -- Vibot (the separate assistant interface) ------------------------------
  // Its own config (LLM API + system prompt), conversations, and memories.

  getVibotConfig: () => request<{ config: VibotConfigClient }>('/vibot/config').then((r) => r.config),

  saveVibotConfig: (input: { baseUrl?: string; apiKey?: string; model?: string; systemPrompt?: string; temperature?: number; reasoning_effort?: string | null }) =>
    request<{ config: VibotConfigClient }>('/vibot/config', { method: 'PUT', body: JSON.stringify(input) }).then((r) => r.config),

  listVibotConversations: () => request<{ convs: VibotConvMeta[] }>('/vibot/conversations').then((r) => r.convs),

  createVibotConversation: (title?: string) =>
    request<{ conv: VibotConvMeta }>('/vibot/conversations', { method: 'POST', body: JSON.stringify({ title }) }).then((r) => r.conv),

  renameVibotConversation: (id: string, title: string) =>
    request<{ conv: VibotConvMeta }>(`/vibot/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }).then((r) => r.conv),

  deleteVibotConversation: (id: string) => request<{ ok: boolean }>(`/vibot/conversations/${id}`, { method: 'DELETE' }),

  /** Unlink a coding session from a Vibot chat (does not delete the session). */
  unlinkVibotSession: (convId: string, sessionId: string) =>
    request<{ conv: VibotConvMeta }>(`/vibot/conversations/${convId}/sessions/${sessionId}`, { method: 'DELETE' }).then((r) => r.conv),

  getVibotMessages: (id: string) => request<{ blocks: ChatBlock[]; seq: number }>(`/vibot/conversations/${id}/messages`),

  listVibotMemories: () => request<{ memories: VibotMemory[] }>('/vibot/memories').then((r) => r.memories),
};
