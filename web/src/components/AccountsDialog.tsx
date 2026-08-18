import { useEffect, useState } from 'react';
import type { AccountInfo } from '@shared/protocol';
import { api, ApiError } from '../lib/api';
import { useStore } from '../store/store';
import { Check, Copy, KeyRound, Loader2, Plus, Users, X } from '../lib/icons';

/**
 * Admin-only account management: list, create (the per-account token is shown
 * exactly once), reset token, set password, delete. Deleting an account hands
 * its hosts over to admin.
 */
export function AccountsDialog({ onClose }: { onClose: () => void }) {
  const setToast = useStore((s) => s.setToast);
  const [accounts, setAccounts] = useState<AccountInfo[] | null>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [issued, setIssued] = useState<{ name: string; token: string } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState('');

  const reload = () => {
    api
      .listAccounts()
      .then(setAccounts)
      .catch((err) => setError(err instanceof ApiError ? err.message : 'failed to load accounts'));
  };

  useEffect(reload, []);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!name.trim() || password.length < 6) return;
    setBusy(true);
    setError('');
    try {
      const res = await api.createAccount(name.trim(), password);
      setIssued(res);
      setName('');
      setPassword('');
      reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'create failed');
    } finally {
      setBusy(false);
    }
  };

  const resetToken = async (target: string) => {
    try {
      const res = await api.resetAccountToken(target);
      setIssued(res);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'reset failed');
    }
  };

  const setPasswordFor = async (target: string) => {
    const next = window.prompt(`New password for "${target}" (min 6 chars)`);
    if (!next) return;
    if (next.length < 6) {
      setToast('password must be at least 6 characters');
      return;
    }
    try {
      await api.setAccountPassword(target, next);
      setToast(`password updated for ${target}`);
      reload();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'update failed');
    }
  };

  const remove = async (target: string) => {
    setConfirmDelete(null);
    try {
      const res = await api.deleteAccount(target);
      setToast(`account "${target}" deleted — ${res.hostsRemoved} host(s) removed`);
      if (issued?.name === target) setIssued(null);
      reload();
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'delete failed');
    }
  };

  const copyToken = async (token: string) => {
    try {
      await navigator.clipboard.writeText(token);
      setToast('token copied');
    } catch {
      setToast('copy failed — select the token manually');
    }
  };

  const inputCls =
    'w-full rounded-lg border border-ink-700 bg-ink-900 px-3 py-2 text-sm text-slate-200 outline-none transition focus:border-accent/60 focus:ring-2 focus:ring-accent/20';

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-transparent p-4"
      style={{ background: 'transparent', backdropFilter: 'none', WebkitBackdropFilter: 'none' }}
      onClick={onClose}
    >
      <div className="new-session-panel w-full max-w-xl rounded-2xl">
        <div className="flex max-h-[calc(100dvh-2rem)] flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
          <div className="dialog-titlebar flex shrink-0 items-center justify-between border-b border-white/5 px-5 py-3.5">
            <div className="flex items-center gap-2">
              <Users className="h-4 w-4 text-accent" />
              <h2 className="text-sm font-semibold text-slate-100">Accounts</h2>
            </div>
            <button onClick={onClose} className="rounded p-1 text-slate-500 hover:text-slate-300">
              <X className="h-4 w-4" />
            </button>
          </div>

          <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-5">
            <p className="text-xs leading-relaxed text-slate-500">
              Each account signs in with a name + password and manages its own SSH hosts (and the sessions on them).
              Accounts are peers — even <span className="text-slate-300">admin</span> only sees the hosts it added itself
              (plus the local machine). Deleting an account also deletes its hosts.
            </p>

            {issued && (
              <div className="rounded-lg border border-accent/40 bg-accent/5 p-3">
                <div className="mb-1.5 flex items-center gap-1.5 text-xs font-medium text-accent-soft">
                  <KeyRound className="h-3.5 w-3.5" />
                  Access token for “{issued.name}” — shown once
                </div>
                <div className="flex items-center gap-2">
                  <code className="min-w-0 flex-1 overflow-x-auto rounded bg-ink-900/80 px-2 py-1.5 text-[11px] text-slate-300">
                    {issued.token}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copyToken(issued.token)}
                    className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-ink-700 bg-ink-900/40 text-slate-300 transition hover:border-accent/50 hover:text-accent"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="mt-1.5 text-[11px] text-slate-600">
                  Share it for token login (or an API client); the account can also sign in with its password.
                </p>
              </div>
            )}

            <div className="space-y-1.5">
              <div className="flex items-center justify-between rounded-lg border border-white/5 bg-ink-900/30 px-3 py-2.5">
                <div>
                  <div className="text-sm text-slate-200">admin</div>
                  <div className="text-[11px] text-slate-500">
                    manages accounts · local machine · token = the server token
                  </div>
                </div>
                <button
                  type="button"
                  onClick={() => void setPasswordFor('admin')}
                  className="flex h-7 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[11px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
                >
                  <KeyRound className="h-3 w-3" />
                  Set password
                </button>
              </div>

              {accounts === null ? (
                <div className="flex justify-center py-4 text-slate-500">
                  <Loader2 className="h-4 w-4 animate-spin" />
                </div>
              ) : (
                accounts.map((a) => (
                  <div
                    key={a.name}
                    className="flex items-center justify-between rounded-lg border border-white/5 bg-ink-900/30 px-3 py-2.5"
                  >
                    <div className="min-w-0">
                      <div className="truncate text-sm text-slate-200">{a.name}</div>
                      <div className="text-[11px] text-slate-500">
                        created {new Date(a.createdAt).toLocaleDateString()} · {a.hasPassword ? 'password set' : 'token only'}
                      </div>
                    </div>
                    <div className="flex shrink-0 items-center gap-1.5">
                      <button
                        type="button"
                        onClick={() => void resetToken(a.name)}
                        title="Issue a fresh token (the old one stops working)"
                        className="flex h-7 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[11px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
                      >
                        Reset token
                      </button>
                      <button
                        type="button"
                        onClick={() => void setPasswordFor(a.name)}
                        className="flex h-7 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[11px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
                      >
                        <KeyRound className="h-3 w-3" />
                        Password
                      </button>
                      {confirmDelete === a.name ? (
                        <span className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => void remove(a.name)}
                            className="flex h-7 items-center rounded-md border border-rose-500/50 bg-rose-500/10 px-2 text-[11px] font-medium text-rose-300"
                          >
                            <Check className="h-3 w-3" />
                            Delete
                          </button>
                          <button
                            type="button"
                            onClick={() => setConfirmDelete(null)}
                            className="flex h-7 items-center rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[11px] text-slate-400"
                          >
                            <X className="h-3 w-3" />
                          </button>
                        </span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(a.name)}
                          title="Delete this account (its hosts move to admin)"
                          className="flex h-7 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-2 text-[11px] font-medium text-slate-300 transition hover:border-rose-500/50 hover:text-rose-300"
                        >
                          <X className="h-3 w-3" />
                          Delete
                        </button>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>

            <form onSubmit={submit} className="space-y-2 rounded-lg border border-white/5 bg-ink-900/20 p-3">
              <div className="text-xs font-medium text-slate-300">Create account</div>
              <div className="flex flex-col gap-2 sm:flex-row">
                <input
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="name (letters, digits, - _)"
                  className={inputCls}
                />
                <input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="password (min 6 chars)"
                  autoComplete="new-password"
                  className={inputCls}
                />
                <button
                  type="submit"
                  disabled={busy || !name.trim() || password.length < 6}
                  className="flex h-9 shrink-0 items-center justify-center gap-1 rounded-lg bg-accent px-3 text-sm font-semibold text-accent-fg transition hover:bg-accent-soft disabled:cursor-not-allowed disabled:opacity-40"
                >
                  {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plus className="h-4 w-4" />}
                  Create
                </button>
              </div>
              {error && <p className="text-xs text-rose-400">{error}</p>}
            </form>
          </div>
        </div>
      </div>
    </div>
  );
}
