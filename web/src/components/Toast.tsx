import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store/store';
import { Glass } from './LiquidGlass';

export function Toast() {
  const toast = useStore((s) => s.toast);
  const setToast = useStore((s) => s.setToast);

  useEffect(() => {
    if (!toast) return;
    const t = setTimeout(() => setToast(null), 5000);
    return () => clearTimeout(t);
  }, [toast, setToast]);

  if (!toast) return null;
  return (
    <div className="pointer-events-none fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
      <Glass className="pointer-events-auto max-w-md rounded-xl" cornerRadius={12}>
        <div className="flex items-center gap-3 px-4 py-3 text-sm text-slate-200">
          <span className="flex-1">{toast}</span>
          <button onClick={() => setToast(null)} className="text-slate-500 hover:text-slate-300">
            <X className="h-4 w-4" />
          </button>
        </div>
      </Glass>
    </div>
  );
}
