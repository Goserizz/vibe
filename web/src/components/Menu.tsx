import { useState, type ReactNode } from 'react';
import { Check } from 'lucide-react';
import { cn } from '../lib/format';

export interface MenuItem {
  value: string;
  label: string;
  hint?: string;
  active?: boolean;
}

export function Menu({ trigger, items, onSelect, align = 'left' }: {
  trigger: ReactNode;
  items: MenuItem[];
  onSelect: (value: string) => void;
  align?: 'left' | 'right';
}) {
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen((o) => !o)}>{trigger}</button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div
            className={cn(
              'glass absolute z-50 mt-1.5 min-w-[180px] overflow-hidden rounded-xl p-1 shadow-2xl animate-fade-in',
              align === 'right' ? 'right-0' : 'left-0',
            )}
          >
            {items.map((item) => (
              <button
                key={item.value}
                onClick={() => {
                  onSelect(item.value);
                  setOpen(false);
                }}
                className="flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-left transition hover:bg-ink-700"
              >
                <span className="flex-1">
                  <span className="block text-[13px] text-slate-200">{item.label}</span>
                  {item.hint && <span className="block text-[11px] text-slate-500">{item.hint}</span>}
                </span>
                {item.active && <Check className="h-3.5 w-3.5 text-accent" />}
              </button>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
