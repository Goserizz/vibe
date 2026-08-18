/** UI contrast: the default look, or a high-contrast variant where hairlines
 *  become pure white (dark) / pure black (light) and faint text is boosted.
 *  Preference is stored in localStorage so it survives reloads. */

export type Contrast = 'normal' | 'high';

const STORAGE_KEY = 'vibe.contrast';
const DEFAULT_CONTRAST: Contrast = 'normal';

export function loadContrast(): Contrast {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === 'high' || raw === 'normal') return raw;
  } catch {
    /* storage unavailable */
  }
  return DEFAULT_CONTRAST;
}

export function saveContrast(contrast: Contrast): void {
  try {
    localStorage.setItem(STORAGE_KEY, contrast);
  } catch {
    /* ignore */
  }
  applyContrastClass(contrast);
}

/** Lets CSS see the contrast variant without threading a prop through every
 *  surface. index.html applies the class before first paint; this keeps it in
 *  sync when the user toggles the setting. */
export function applyContrastClass(contrast: Contrast): void {
  if (typeof document === 'undefined') return;
  document.documentElement.classList.toggle('hc', contrast === 'high');
}
