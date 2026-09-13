import { outlinePanelBounds } from '../../../shared/conversationOutline.js';

/** Dock only in the readable message area. Chat overlays its composer, whereas
 * TUI/Vibot reserve a separate row, so both boundaries need to be respected. */
export function outlineReadingBounds(
  surface: { top: number; height: number },
  viewport: { bottom: number },
  headerBottom?: number,
  composerTop?: number,
) {
  const bottom = Math.min(surface.top + surface.height, viewport.bottom, composerTop ?? Infinity);
  return outlinePanelBounds({ top: surface.top, height: Math.max(0, bottom - surface.top) }, headerBottom);
}
