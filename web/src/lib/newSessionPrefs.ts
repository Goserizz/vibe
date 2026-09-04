/**
 * Last-used New Session dialog options (everything except cwd/title).
 * Stored in localStorage so the next create form opens with the same choices.
 */

import type { AgentKind, EffortLevel, PermissionMode } from '@shared/protocol';
import { AGENTS, permissionModesForAgent } from './format';

const STORAGE_KEY = 'vibe.newSessionPrefs';

export interface NewSessionPrefs {
  /** '' = local; otherwise a remote host name. */
  host: string;
  agent: AgentKind;
  model: string;
  permissionMode: PermissionMode;
  effort: EffortLevel;
}

const AGENTS_SET = new Set<string>(AGENTS.map((a) => a.value));
const EFFORTS = new Set<string>(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const PERMISSIONS = new Set<string>(['default', 'plan', 'acceptEdits', 'bypassPermissions']);

function isAgent(v: unknown): v is AgentKind {
  return typeof v === 'string' && AGENTS_SET.has(v);
}

function isEffort(v: unknown): v is EffortLevel {
  return typeof v === 'string' && EFFORTS.has(v);
}

export function loadNewSessionPrefs(): NewSessionPrefs | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<NewSessionPrefs>;
    if (!isAgent(parsed.agent) || typeof parsed.model !== 'string' || !parsed.model) return null;
    if (typeof parsed.host !== 'string') return null;
    if (!isEffort(parsed.effort)) return null;
    // Kimi's actual modes arrive asynchronously from the selected host. Keep a
    // valid saved wire value here; the dialog drops it later if that CLI lacks it.
    const validPermission =
      parsed.agent === 'kimi' || parsed.agent === 'kiro' || parsed.agent === 'grok' || parsed.agent === 'zcode' || parsed.agent === 'codebuddy' || parsed.agent === 'opencode'
        ? typeof parsed.permissionMode === 'string' && PERMISSIONS.has(parsed.permissionMode)
        : permissionModesForAgent(parsed.agent).some((m) => m.value === parsed.permissionMode);
    if (!validPermission) return null;
    return {
      host: parsed.host,
      agent: parsed.agent,
      model: parsed.model,
      permissionMode: parsed.permissionMode as PermissionMode,
      effort: parsed.effort,
    };
  } catch {
    return null;
  }
}

export function saveNewSessionPrefs(prefs: NewSessionPrefs): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
  } catch {
    /* ignore quota / private mode */
  }
}
