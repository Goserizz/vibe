import { clsx, type ClassValue } from 'clsx';
import type { EffortLevel, PermissionMode } from '@shared/protocol';

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

export const MODELS: { value: string; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'opusplan', label: 'Opus Plan' },
];

export const PERMISSION_MODES: { value: PermissionMode; label: string; hint: string }[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before risky tools' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Allow everything (careful)' },
];

export const EFFORT_LEVELS: { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest, minimal thinking' },
  { value: 'medium', label: 'Medium', hint: 'Moderate thinking' },
  { value: 'high', label: 'High', hint: 'Deep reasoning (default)' },
  { value: 'xhigh', label: 'X-High', hint: 'Deeper than high' },
  { value: 'max', label: 'Max', hint: 'Maximum effort' },
];

export function modelLabel(value: string): string {
  return MODELS.find((m) => m.value === value)?.label ?? value;
}

export function permissionModeLabel(value: PermissionMode): string {
  return PERMISSION_MODES.find((m) => m.value === value)?.label ?? value;
}

export function effortLabel(value: EffortLevel): string {
  return EFFORT_LEVELS.find((e) => e.value === value)?.label ?? value;
}
