import type {
  AgentKind,
  AgentLatestVersions,
  AgentUpdateResult,
  ChatBlock,
  EffortLevel,
  FileEntry,
  HostStatus,
  McpConfigSnapshot,
  McpServerDef,
  PermissionMode,
  ProjectDir,
  RemoteHost,
  SearchResult,
  SkillDetail,
  SkillEntry,
  SkillScope,
  ConfigFileDetail,
  ConfigFileEntry,
  SessionMeta,
  SessionPreset,
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

export const api = {
  me: () => request<{ ok: boolean; serverVersion: string; defaultModel: string }>('/me'),

  listProjects: () => request<{ projects: ProjectDir[] }>('/projects').then((r) => r.projects),

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

  updateHostAgent: (name: string, agent: AgentKind) =>
    request<AgentUpdateResult>(`/hosts/${encodeURIComponent(name)}/agents/${agent}/update`, {
      method: 'POST',
    }),

  updateSession: (id: string, patch: { title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }) =>
    request<{ session: SessionMeta }>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.session),

  deleteSession: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),

  setSessionPinned: (id: string, pinned: boolean) =>
    request<{ ok: boolean; pinned: boolean }>(`/sessions/${id}/pin`, {
      method: 'PUT',
      body: JSON.stringify({ pinned }),
    }),

  getMessages: (id: string) => request<{ blocks: ChatBlock[]; seq: number }>(`/sessions/${id}/messages`),

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

  saveVibotConfig: (input: { baseUrl?: string; apiKey?: string; model?: string; systemPrompt?: string; temperature?: number }) =>
    request<{ config: VibotConfigClient }>('/vibot/config', { method: 'PUT', body: JSON.stringify(input) }).then((r) => r.config),

  listVibotConversations: () => request<{ convs: VibotConvMeta[] }>('/vibot/conversations').then((r) => r.convs),

  createVibotConversation: (title?: string) =>
    request<{ conv: VibotConvMeta }>('/vibot/conversations', { method: 'POST', body: JSON.stringify({ title }) }).then((r) => r.conv),

  renameVibotConversation: (id: string, title: string) =>
    request<{ conv: VibotConvMeta }>(`/vibot/conversations/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }).then((r) => r.conv),

  deleteVibotConversation: (id: string) => request<{ ok: boolean }>(`/vibot/conversations/${id}`, { method: 'DELETE' }),

  getVibotMessages: (id: string) => request<{ blocks: ChatBlock[]; seq: number }>(`/vibot/conversations/${id}/messages`),

  listVibotMemories: () => request<{ memories: VibotMemory[] }>('/vibot/memories').then((r) => r.memories),
};
