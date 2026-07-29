/**
 * Accent color: optional manual override (localStorage) or OS `AccentColor`.
 * Writes `--accent*` tokens so Tailwind `bg-accent` / `text-accent` stay in sync.
 */

export type AccentMode = 'system' | 'custom';

export interface AccentPreference {
  mode: AccentMode;
  /** `#rrggbb` when mode === 'custom'. */
  hex?: string;
}

export const ACCENT_PRESETS: { hex: string; label: string }[] = [
  { hex: '#f97316', label: 'Orange' },
  { hex: '#eab308', label: 'Yellow' },
  { hex: '#22c55e', label: 'Green' },
  { hex: '#06b6d4', label: 'Cyan' },
  { hex: '#7c9cff', label: 'Blue' },
  { hex: '#a855f7', label: 'Purple' },
  { hex: '#ec4899', label: 'Pink' },
  { hex: '#f43f5e', label: 'Rose' },
];

const STORAGE_KEY = 'vibe.accent';
const ACCENT_VARS = ['--accent', '--accent-soft', '--accent-muted', '--accent-fg', '--accent-glow'] as const;

function parseRgb(color: string): [number, number, number] | null {
  const m = /^rgba?\(\s*([\d.]+)\s*[, ]\s*([\d.]+)\s*[, ]\s*([\d.]+)/i.exec(color.trim());
  if (!m) return null;
  return [Math.round(Number(m[1])), Math.round(Number(m[2])), Math.round(Number(m[3]))];
}

export function parseHex(hex: string): [number, number, number] | null {
  const m = /^#([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

export function rgbToHex(r: number, g: number, b: number): string {
  return (
    '#' +
    [r, g, b]
      .map((c) => Math.max(0, Math.min(255, c)).toString(16).padStart(2, '0'))
      .join('')
  );
}

function sampleSystemColor(name: 'AccentColor' | 'AccentColorText'): [number, number, number] | null {
  if (typeof document === 'undefined') return null;
  const el = document.createElement('div');
  el.style.color = name;
  el.style.position = 'fixed';
  el.style.left = '-9999px';
  el.style.pointerEvents = 'none';
  document.documentElement.appendChild(el);
  const parsed = parseRgb(getComputedStyle(el).color);
  el.remove();
  return parsed;
}

function mix(a: number, b: number, t: number): number {
  return Math.round(a + (b - a) * t);
}

function relativeLuminance(r: number, g: number, b: number): number {
  const lin = [r, g, b].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

function clearAccentOverrides(): void {
  const root = document.documentElement;
  for (const key of ACCENT_VARS) root.style.removeProperty(key);
}

/** Derive soft/muted/fg/glow and write CSS variables. */
export function applyAccentRgb(r: number, g: number, b: number, fg?: [number, number, number]): void {
  const soft = `${mix(r, 255, 0.22)} ${mix(g, 255, 0.22)} ${mix(b, 255, 0.22)}`;
  const muted = `${mix(r, 110, 0.42)} ${mix(g, 118, 0.42)} ${mix(b, 130, 0.42)}`;
  const root = document.documentElement;
  root.style.setProperty('--accent', `${r} ${g} ${b}`);
  root.style.setProperty('--accent-soft', soft);
  root.style.setProperty('--accent-muted', muted);
  root.style.setProperty('--accent-glow', `rgba(${r}, ${g}, ${b}, 0.18)`);
  if (fg) {
    root.style.setProperty('--accent-fg', `${fg[0]} ${fg[1]} ${fg[2]}`);
  } else {
    root.style.setProperty(
      '--accent-fg',
      relativeLuminance(r, g, b) > 0.55 ? '10 11 15' : '255 255 255',
    );
  }
}

export function loadAccentPreference(): AccentPreference {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { mode: 'system' };
    const parsed = JSON.parse(raw) as AccentPreference;
    if (parsed?.mode === 'custom' && typeof parsed.hex === 'string' && parseHex(parsed.hex)) {
      return { mode: 'custom', hex: parsed.hex.toLowerCase() };
    }
    if (parsed?.mode === 'system') return { mode: 'system' };
  } catch {
    /* ignore */
  }
  return { mode: 'system' };
}

export function saveAccentPreference(pref: AccentPreference): void {
  try {
    if (pref.mode === 'system') localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'system' }));
    else if (pref.hex && parseHex(pref.hex)) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ mode: 'custom', hex: pref.hex.toLowerCase() }));
    }
  } catch {
    /* ignore */
  }
}

/** Apply preference: custom hex, or OS AccentColor, or CSS fallbacks. */
export function applyAccent(pref: AccentPreference = loadAccentPreference()): void {
  if (pref.mode === 'custom' && pref.hex) {
    const rgb = parseHex(pref.hex);
    if (rgb) {
      applyAccentRgb(...rgb);
      return;
    }
  }
  const accent = sampleSystemColor('AccentColor');
  if (!accent) {
    clearAccentOverrides();
    return;
  }
  applyAccentRgb(...accent, sampleSystemColor('AccentColorText') ?? undefined);
}

/** @deprecated use applyAccent */
export const applySystemAccent = (): void => applyAccent({ mode: 'system' });

/** Re-apply on focus/theme only when following the system accent. */
export function startAccentWatcher(): void {
  applyAccent();
  const maybeRefresh = () => {
    if (loadAccentPreference().mode === 'system') applyAccent({ mode: 'system' });
  };
  window.addEventListener('focus', maybeRefresh);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') maybeRefresh();
  });
}

/** @deprecated use startAccentWatcher */
export const startSystemAccentWatcher = startAccentWatcher;
