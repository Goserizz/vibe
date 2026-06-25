import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { Check, Search } from 'lucide-react';
import { cn } from '../lib/format';
import { Glass } from './LiquidGlass';

export interface MenuItem {
  value: string;
  label: string;
  hint?: string;
  active?: boolean;
}

export function Menu({ trigger, triggerLabel, items, onSelect, align = 'left', searchable = false, allowCustom = false, customLabel }: {
  trigger: ReactNode;
  triggerLabel?: string;
  items: MenuItem[];
  onSelect: (value: string) => void;
  align?: 'left' | 'right';
  /** Show a filter box and scroll a long list (e.g. the Cursor model list). */
  searchable?: boolean;
  /** Offer the typed text as a custom value when it matches no item. */
  allowCustom?: boolean;
  /** Prefix for the custom-value row (defaults to "Use"). */
  customLabel?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const rootRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<CSSProperties>({});

  const close = useCallback(() => {
    setOpen(false);
    setQuery('');
  }, []);

  // Position the popover relative to the trigger (it's portaled to <body> so it
  // escapes the Header's backdrop-filter context, which is what lets its own
  // backdrop blur work).
  const openMenu = useCallback(() => {
    const r = rootRef.current?.getBoundingClientRect();
    if (r) {
      setPos(
        align === 'right'
          ? { top: r.bottom + 6, right: window.innerWidth - r.right }
          : { top: r.bottom + 6, left: r.left },
      );
    }
    setOpen(true);
  }, [align]);

  useEffect(() => {
    if (!open) return;

    const onPointerDown = (event: PointerEvent) => {
      if (rootRef.current?.contains(event.target as Node)) return;
      if (popRef.current?.contains(event.target as Node)) return;
      close();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    document.addEventListener('pointerdown', onPointerDown);
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown);
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [close, open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((i) => i.label.toLowerCase().includes(q) || i.value.toLowerCase().includes(q));
  }, [items, query]);

  const trimmed = query.trim();
  const showCustom = allowCustom && trimmed.length > 0 && !items.some((i) => i.value.toLowerCase() === trimmed.toLowerCase());

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        aria-label={triggerLabel}
        aria-haspopup="menu"
        aria-expanded={open}
        title={triggerLabel}
        className="block"
        onClick={() => (open ? close() : openMenu())}
      >
        {trigger}
      </button>
      {open &&
        createPortal(
          <div ref={popRef} style={{ position: 'fixed', zIndex: 50, ...pos }}>
            <Glass className="min-w-[200px] overflow-hidden rounded-xl shadow-2xl" cornerRadius={12} thin>
              <div className="overflow-hidden p-1">
          {searchable && (
            <div className="flex items-center gap-2 border-b border-white/5 px-2.5 py-1.5">
              <Search className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <input
                autoFocus
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search models…"
                className="w-full bg-transparent text-[13px] text-slate-200 placeholder:text-slate-600 outline-none"
              />
            </div>
          )}
          <div className={cn(searchable && 'max-h-72 overflow-y-auto')}>
            {filtered.map((item) => (
              <button
                key={item.value}
                onClick={() => {
                  onSelect(item.value);
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-ink-700/45"
              >
                <span className="flex-1">
                  <span className="block text-[13px] text-slate-200">{item.label}</span>
                  {item.hint && <span className="block text-[11px] text-slate-500">{item.hint}</span>}
                </span>
                {item.active && <Check className="h-3.5 w-3.5 shrink-0 text-accent" />}
              </button>
            ))}
            {showCustom && (
              <button
                onClick={() => {
                  onSelect(trimmed);
                  close();
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-ink-700/45"
              >
                <span className="block flex-1 text-[13px] text-slate-200">
                  {customLabel ?? 'Use'} <span className="font-mono text-accent-soft">{trimmed}</span>
                </span>
              </button>
            )}
            {!filtered.length && !showCustom && (
              <div className="px-2.5 py-3 text-center text-[12px] text-slate-500">No matches</div>
            )}
          </div>
        </div>
        </Glass>
        </div>,
        document.body,
      )}
    </div>
  );
}
