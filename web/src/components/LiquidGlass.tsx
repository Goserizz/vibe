import { type CSSProperties, type ReactNode } from 'react';
import { cn } from '../lib/format';

/**
 * <Glass> — Vibe's frosted-glass surface.
 *
 * A plain-CSS `backdrop-filter` panel (blur + saturate over a translucent fill
 * with a top sheen; see `.vglass` in index.css). It renders identically in
 * Chrome, Safari and Firefox, and matches the dialog panels (.new-session-panel)
 * that already do.
 *
 * It previously wrapped rdev/liquid-glass-react, whose "liquid" refraction is a
 * `backdrop-filter: url(#svg)` displacement. That only samples a real backdrop
 * for viewport-`fixed` elements (like the library's own demo); for Vibe's
 * in-flow header/composer/menus Chrome sampled an empty backdrop and painted the
 * displacement map as a flat GREY blob, while Safari ignored the displacement
 * and showed plain blur — so the two browsers never matched. This plain blur is
 * exactly the look Safari already rendered, now consistent everywhere (and it
 * drops the library's per-mousemove React re-renders).
 *
 * `thin` lightens the frost so more of the backdrop shows through (header,
 * composer, menus). `strength='strong'` adds a denser fill, deeper blur and a
 * drop shadow for free-floating dialogs/popovers.
 */
interface GlassProps {
  children: ReactNode;
  className?: string;
  /** Corner radius in px. 0 for square, edge-pinned panels (header, sidebar). */
  cornerRadius?: number;
  /** Lighter frost so more of the backdrop shows through. */
  thin?: boolean;
  /** Denser fill + drop shadow for floating dialogs/menus. */
  strength?: 'normal' | 'strong';
  style?: CSSProperties;
}

export function Glass({ children, className, cornerRadius = 16, thin = false, strength = 'normal', style }: GlassProps) {
  return (
    <div
      className={cn('vglass', thin && 'vglass--thin', strength === 'strong' && 'vglass--strong', className)}
      style={{ borderRadius: cornerRadius, ...style }}
    >
      {children}
    </div>
  );
}
