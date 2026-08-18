import { useState } from 'react';
import { useStore } from '../store/store';
import { setToken } from '../lib/token';
import { api, ApiError } from '../lib/api';
import { Logo } from './Logo';
import { Glass } from './LiquidGlass';

/**
 * Sign-in screen with two modes: account name + password (created by the
 * server admin), or a raw access token (the link the server prints, or a
 * per-account token). On success the token is stored and the app boots via
 * the store's init() — exactly the legacy TokenGate flow.
 */
export function LoginGate() {
  const init = useStore((s) => s.init);
  const [mode, setMode] = useState<'account' | 'token'>('account');
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [token, setTokenValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const boot = async (tokenValue: string) => {
    setBusy(true);
    setError('');
    setToken(tokenValue);
    useStore.setState({ phase: 'loading' });
    await init(tokenValue);
    // init flips phase to unauthorized on a rejected token; surface that.
    if (useStore.getState().phase === 'unauthorized') setError('invalid token');
    setBusy(false);
  };

  const submitAccount = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || !password) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.login({ name: name.trim(), password });
      await boot(res.token);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'could not reach server');
      setBusy(false);
    }
  };

  const submitToken = async (e: React.FormEvent) => {
    e.preventDefault();
    const value = token.trim();
    if (!value) return;
    await boot(value);
  };

  const inputCls =
    'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2.5 text-sm text-slate-200 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20';

  return (
    <div className="app-shell flex w-full items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <Glass className="rounded-2xl" cornerRadius={16}>
          <div className="p-7">
            <div className="mb-5 flex items-center gap-3">
              <Logo className="h-8 w-8 text-accent" />
              <div>
                <h1 className="text-lg font-semibold text-slate-100">Vibe</h1>
                <p className="text-xs text-slate-500">Remote multi-agent vibe coding</p>
              </div>
            </div>

            <div className="mb-4 flex gap-1 rounded-lg bg-ink-900/60 p-1 text-xs">
              <button
                type="button"
                onClick={() => { setMode('account'); setError(''); }}
                className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                  mode === 'account' ? 'bg-accent text-accent-fg' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Sign in
              </button>
              <button
                type="button"
                onClick={() => { setMode('token'); setError(''); }}
                className={`flex-1 rounded-md px-3 py-1.5 font-medium transition ${
                  mode === 'token' ? 'bg-accent text-accent-fg' : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                Access token
              </button>
            </div>

            {mode === 'account' ? (
              <form onSubmit={submitAccount}>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Account</label>
                <input
                  autoFocus
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="your account name"
                  autoComplete="username"
                  className={inputCls}
                />
                <label className="mb-1.5 mt-3 block text-xs font-medium text-slate-400">Password</label>
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="your password"
                  autoComplete="current-password"
                  className={inputCls}
                />
                {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !name.trim() || !password}
                  className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? 'Signing in…' : 'Sign in'}
                </button>
                <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-600">
                  Accounts are created by the server admin.
                </p>
              </form>
            ) : (
              <form onSubmit={submitToken}>
                <label className="mb-1.5 block text-xs font-medium text-slate-400">Access token</label>
                <input
                  autoFocus
                  value={token}
                  onChange={(e) => setTokenValue(e.target.value)}
                  placeholder="Paste the token from your terminal"
                  className={inputCls}
                />
                {error && <p className="mt-3 text-xs text-rose-400">{error}</p>}
                <button
                  type="submit"
                  disabled={busy || !token.trim()}
                  className="mt-4 w-full rounded-lg bg-accent py-2.5 text-sm font-semibold text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? 'Connecting…' : 'Connect'}
                </button>
                <p className="mt-4 text-center text-[11px] leading-relaxed text-slate-600">
                  The server prints a ready-to-use link with the token on startup.
                </p>
              </form>
            )}
          </div>
        </Glass>
      </div>
    </div>
  );
}
