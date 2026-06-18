import { useEffect } from 'react';
import { X } from 'lucide-react';
import { useStore } from '../store/store';

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
      <div className="glass pointer-events-auto flex max-w-md items-center gap-3 rounded-xl px-4 py-3 text-sm text-slate-200 shadow-2xl animate-fade-in">
        <span className="flex-1">{toast}</span>
        <button onClick={() => setToast(null)} className="text-slate-500 hover:text-slate-300">
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
