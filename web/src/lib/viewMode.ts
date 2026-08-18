/** Conversation chrome: the default card UI, or a CLI-style transcript.
 *  Preference is stored in localStorage so it survives reloads. */

export type ViewMode = 'chat' | 'cli';

const STORAGE_KEY = 'vibe.viewMode';
const DEFAULT_MODE: ViewMode = 'chat';

export function loadViewMode(): ViewMode {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'cli' || raw === 'chat') return raw;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_MODE;
}

export function saveViewMode(mode: ViewMode): void {
  try {
    localStorage.setItem(STORAGE_KEY, mode);
  } catch {
    /* ignore */
  }
  applyViewModeClass(mode);
}

const THEME_COLOR_CLI = '#0c0c0c';
const THEME_COLOR_CLI_LIGHT = '#fafafa';
const THEME_COLOR_DARK = '#0a0b0f';
const THEME_COLOR_LIGHT = '#ffffff';
const TUI_FONT_HREF = '/fonts/sarasa-term-sc-nerd/result.css';

/** xterm cannot inherit CSS font-family (canvas), so panes pass this stack.
 *  JetBrains Mono stays first so ASCII/Latin keep the original TUI face;
 *  Sarasa Term SC Nerd only covers CJK (and Nerd icons) as fallback. */
export const TUI_FONT_FAMILY =
  '"JetBrains Mono", "Sarasa Term SC Nerd", ui-monospace, SFMono-Regular, Menlo, monospace';
export const CHAT_MONO_FAMILY =
  '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace';

function ensureTuiFontStylesheet(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById('tui-fonts')) return;
  const link = document.createElement('link');
  link.id = 'tui-fonts';
  link.rel = 'stylesheet';
  link.href = TUI_FONT_HREF;
  document.head.appendChild(link);
}

const FAVICON_CLI = '/favicon-cli.svg';
const FAVICON_CHAT = '/favicon.svg';

function applyFavicon(mode: ViewMode): void {
  if (typeof document === 'undefined') return;
  const href = mode === 'cli' ? FAVICON_CLI : FAVICON_CHAT;
  const set = (rel: string, type?: string) => {
    document.querySelectorAll(`link[rel="${rel}"]`).forEach((el) => el.remove());
    const link = document.createElement('link');
    link.rel = rel;
    link.href = href;
    if (type) link.type = type;
    document.head.appendChild(link);
  };
  set('icon', 'image/svg+xml');
  set('apple-touch-icon');
}

/** Lets CSS (and the title-bar toggle) see the current chrome without
 *  threading a prop through every surface. The TUI ground follows the app
 *  theme (near-black / paper white), so the status-bar color is picked from
 *  the current `.light` class on <html>. */
export function applyViewModeClass(mode: ViewMode): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('cli-mode', mode === 'cli');
  applyFavicon(mode);
  if (mode === 'cli') ensureTuiFontStylesheet();
  syncThemeColorMeta(mode);
}

function syncThemeColorMeta(mode: ViewMode): void {
  for (const meta of document.querySelectorAll('meta[name="theme-color"]')) {
    if (mode === 'cli') {
      const light = document.documentElement.classList.contains('light');
      meta.setAttribute('content', light ? THEME_COLOR_CLI_LIGHT : THEME_COLOR_CLI);
      continue;
    }
    const media = meta.getAttribute('media') ?? '';
    meta.setAttribute('content', media.includes('light') ? THEME_COLOR_LIGHT : THEME_COLOR_DARK);
  }
}
