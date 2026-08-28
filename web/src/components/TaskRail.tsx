import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode } from 'react';
import { cn } from '../lib/format';

export const TASK_RAIL_MIN_WIDTH = 260;
export const TASK_RAIL_DEFAULT_WIDTH = 320;
export const TASK_RAIL_MAX_WIDTH = 640;
export const TASK_RAIL_CHAT_MIN_WIDTH = 360;
export const TASK_RAIL_WIDTH_KEY = 'vibe.taskRailWidth';

/**
 * Wide-screen right column used by coding ChatView (todos / background tasks)
 * and Vibot (background agents). Hidden below `lg`; width is shared via
 * `vibe.taskRailWidth` so both surfaces stay in sync.
 *
 * `clearFloatingHeader` adds top padding for ChatView's absolute titlebar.
 * Vibot's titlebar is in normal flow above the flex row — pass false there.
 */
export function TaskRail({
  children,
  'aria-label': ariaLabel = 'Session tasks',
  clearFloatingHeader = true,
}: {
  children: ReactNode;
  'aria-label'?: string;
  clearFloatingHeader?: boolean;
}) {
  const railRef = useRef<HTMLElement>(null);
  const dragCleanupRef = useRef<(() => void) | null>(null);
  const [width, setWidth] = useState(() => {
    let saved = Number.NaN;
    try {
      saved = Number(localStorage.getItem(TASK_RAIL_WIDTH_KEY));
    } catch {
      /* use the default when storage is unavailable */
    }
    return Number.isFinite(saved) && saved >= TASK_RAIL_MIN_WIDTH
      ? Math.min(saved, TASK_RAIL_MAX_WIDTH)
      : TASK_RAIL_DEFAULT_WIDTH;
  });

  const maxWidth = () => {
    const available = railRef.current?.parentElement?.clientWidth ?? window.innerWidth;
    return Math.max(TASK_RAIL_MIN_WIDTH, Math.min(TASK_RAIL_MAX_WIDTH, available - TASK_RAIL_CHAT_MIN_WIDTH));
  };
  const clampWidth = (value: number) => Math.max(TASK_RAIL_MIN_WIDTH, Math.min(maxWidth(), value));

  useEffect(() => {
    try {
      localStorage.setItem(TASK_RAIL_WIDTH_KEY, String(width));
    } catch {
      /* ignore unavailable storage */
    }
  }, [width]);

  useEffect(() => {
    const clampToViewport = () => {
      const rail = railRef.current;
      // The same component stays mounted on compact viewports but is hidden by
      // CSS. Do not let a phone-sized viewport overwrite the saved desktop width.
      if (!rail || getComputedStyle(rail).display === 'none') return;
      const available = rail.parentElement?.clientWidth ?? window.innerWidth;
      const maximum = Math.max(
        TASK_RAIL_MIN_WIDTH,
        Math.min(TASK_RAIL_MAX_WIDTH, available - TASK_RAIL_CHAT_MIN_WIDTH),
      );
      setWidth((value) => Math.max(TASK_RAIL_MIN_WIDTH, Math.min(maximum, value)));
    };
    window.addEventListener('resize', clampToViewport);
    clampToViewport();
    return () => window.removeEventListener('resize', clampToViewport);
  }, []);

  useEffect(() => () => dragCleanupRef.current?.(), []);

  const resizeBy = (delta: number) => setWidth((value) => clampWidth(value + delta));
  const startDrag = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rail = railRef.current;
    if (!rail || (event.pointerType === 'mouse' && event.button !== 0)) return;
    event.preventDefault();
    dragCleanupRef.current?.();
    const right = rail.getBoundingClientRect().right;
    const onMove = (moveEvent: PointerEvent) => setWidth(clampWidth(right - moveEvent.clientX));
    const previousUserSelect = document.body.style.userSelect;
    const previousCursor = document.body.style.cursor;
    const finishDrag = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', finishDrag);
      window.removeEventListener('pointercancel', finishDrag);
      document.body.style.userSelect = previousUserSelect;
      document.body.style.cursor = previousCursor;
      if (dragCleanupRef.current === finishDrag) dragCleanupRef.current = null;
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', finishDrag);
    window.addEventListener('pointercancel', finishDrag);
    dragCleanupRef.current = finishDrag;
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'col-resize';
  };

  return (
    <aside
      ref={railRef}
      aria-label={ariaLabel}
      style={{ width: `${width}px` }}
      className={cn(
        'relative hidden shrink-0 border-l border-white/5 bg-ink-900/25 lg:flex lg:flex-col',
        clearFloatingHeader && 'pt-16',
      )}
    >
      <div
        role="separator"
        aria-label="Resize task panel"
        aria-orientation="vertical"
        aria-valuemin={TASK_RAIL_MIN_WIDTH}
        aria-valuemax={Math.round(maxWidth())}
        aria-valuenow={Math.round(width)}
        tabIndex={0}
        title="Drag to resize · Double-click to reset"
        onPointerDown={startDrag}
        onDoubleClick={() => setWidth(clampWidth(TASK_RAIL_DEFAULT_WIDTH))}
        onKeyDown={(event) => {
          if (event.key === 'ArrowLeft') {
            event.preventDefault();
            resizeBy(16);
          } else if (event.key === 'ArrowRight') {
            event.preventDefault();
            resizeBy(-16);
          } else if (event.key === 'Home') {
            event.preventDefault();
            setWidth(TASK_RAIL_MIN_WIDTH);
          }
        }}
        className="absolute inset-y-0 -left-1 z-20 hidden w-2 cursor-col-resize touch-none transition-colors hover:bg-accent/30 focus:bg-accent/30 focus:outline-none lg:block"
      />
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {children}
      </div>
    </aside>
  );
}
