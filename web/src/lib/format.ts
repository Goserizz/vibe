import { clsx, type ClassValue } from 'clsx';
import type { AgentKind, EffortLevel, PermissionMode } from '@shared/protocol';

export const cn = (...inputs: ClassValue[]) => clsx(inputs);

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

export function shortenPath(p: string, max = 3): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= max) return p;
  return '…/' + parts.slice(-max).join('/');
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

export const AGENTS: { value: AgentKind; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
];

export const MODELS: { value: string; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'opusplan', label: 'Opus Plan' },
];

export interface ModelOption {
  value: string;
  label: string;
}

/**
 * Fallback Cursor models, used only until the live list from `cursor-agent
 * models` loads (or if the CLI is unavailable). The real list is fetched from
 * the server and threaded in via `cursorModels`. `auto` lets Cursor pick.
 */
export const CURSOR_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { value: 'composer-2.5', label: 'Composer 2.5' },
  { value: 'gpt-5.3-codex', label: 'Codex 5.3' },
  { value: 'gpt-5.5-medium', label: 'GPT-5.5' },
  { value: 'claude-4.6-sonnet-medium', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-8-thinking-high', label: 'Opus 4.8 Thinking' },
];

/** Codex has no models subcommand; this static list + custom typing covers it.
 *  `auto` lets Codex pick per its config.toml. */
export const CODEX_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.1-codex', label: 'Codex 5.1' },
  { value: 'gpt-5.3-codex', label: 'Codex 5.3' },
  { value: 'o3', label: 'o3' },
];

/** Model options for an agent. Cursor uses the live CLI list when available;
 *  Codex uses a static list; Claude uses the built-in set. */
export function modelsForAgent(agent: AgentKind, cursorModels?: ModelOption[]): ModelOption[] {
  if (agent === 'cursor') return cursorModels && cursorModels.length ? cursorModels : CURSOR_MODELS;
  if (agent === 'codex') return CODEX_MODELS;
  return MODELS;
}

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before risky tools' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Allow everything (careful)' },
];

/** Cursor headless mode has only coarse, mode-level permissions. */
export const CURSOR_PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Agent', hint: 'Run tools automatically' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
];

/** Codex headless mode is sandbox-level only: full-auto (workspace-write) vs read-only. */
export const CODEX_PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Auto', hint: 'Sandboxed, auto-run (workspace-write)' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
];

export function permissionModesForAgent(agent: AgentKind): { value: PermissionMode; label: string; hint: string }[] {
  if (agent === 'cursor') return CURSOR_PERMISSION_MODES;
  if (agent === 'codex') return CODEX_PERMISSION_MODES;
  return PERMISSION_MODES;
}

export function agentLabel(agent: AgentKind): string {
  return AGENTS.find((a) => a.value === agent)?.label ?? agent;
}

export const EFFORT_LEVELS: { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest, minimal thinking' },
  { value: 'medium', label: 'Medium', hint: 'Moderate thinking' },
  { value: 'high', label: 'High', hint: 'Deep reasoning' },
  { value: 'xhigh', label: 'X-High', hint: 'Deeper than high' },
  { value: 'max', label: 'Max', hint: 'Maximum effort (default)' },
];

export function modelLabel(value: string, cursorModels?: ModelOption[]): string {
  return (
    MODELS.find((m) => m.value === value)?.label ??
    cursorModels?.find((m) => m.value === value)?.label ??
    CURSOR_MODELS.find((m) => m.value === value)?.label ??
    CODEX_MODELS.find((m) => m.value === value)?.label ??
    value
  );
}

export function permissionModeLabel(value: PermissionMode): string {
  return PERMISSION_MODES.find((m) => m.value === value)?.label ?? value;
}

export function effortLabel(value: EffortLevel): string {
  return EFFORT_LEVELS.find((e) => e.value === value)?.label ?? value;
}
