import type {
  ChatBlock,
  EffortLevel,
  HostStatus,
  PermissionMode,
  ProjectDir,
  RemoteHost,
  SearchResult,
  SessionMeta,
} from '@shared/protocol';

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

  validateDir: (path: string) =>
    request<{ ok: boolean; path: string; error?: string }>('/projects/validate', {
      method: 'POST',
      body: JSON.stringify({ path }),
    }),

  listSessions: () => request<{ sessions: SessionMeta[] }>('/sessions').then((r) => r.sessions),

  createSession: (input: { cwd: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel; title?: string; host?: string }) =>
    request<{ session: SessionMeta }>('/sessions', {
      method: 'POST',
      body: JSON.stringify(input),
    }).then((r) => r.session),

  listHosts: () => request<{ hosts: RemoteHost[]; localName: string }>('/hosts'),

  addHost: (host: RemoteHost) =>
    request<{ host: RemoteHost }>('/hosts', { method: 'POST', body: JSON.stringify(host) }).then((r) => r.host),

  removeHost: (name: string) => request<{ ok: boolean }>(`/hosts/${encodeURIComponent(name)}`, { method: 'DELETE' }),

  checkHost: (name: string) => request<HostStatus>(`/hosts/${encodeURIComponent(name)}/check`),

  updateSession: (id: string, patch: { title?: string; model?: string; permissionMode?: PermissionMode; effort?: EffortLevel }) =>
    request<{ session: SessionMeta }>(`/sessions/${id}`, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    }).then((r) => r.session),

  deleteSession: (id: string) => request<{ ok: boolean }>(`/sessions/${id}`, { method: 'DELETE' }),

  getMessages: (id: string) => request<{ blocks: ChatBlock[]; seq: number }>(`/sessions/${id}/messages`),

  search: (q: string) =>
    request<{ results: SearchResult[] }>(`/search?q=${encodeURIComponent(q)}`).then((r) => r.results),
};
