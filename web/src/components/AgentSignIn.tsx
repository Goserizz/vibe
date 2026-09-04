import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, LogIn, Copy, Check, ExternalLink, X, AlertCircle, RefreshCw, LogOut } from '../lib/icons';
import type { AgentLoginAccount, AgentLoginStatus, LoginAgent } from '@shared/protocol';
import { useStore } from '../store/store';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/format';

export const LOGIN_AGENT_LABELS: Record<LoginAgent, string> = {
  cursor: 'Cursor',
  codex: 'Codex',
  codebuddy: 'CodeBuddy',
  devin: 'Devin',
};
/** Link-flow agents: Vibe drives the CLI's own login command. Devin additionally
 *  needs the auth code the browser shows pasted back into the CLI. */
export const LOGIN_AGENTS: LoginAgent[] = ['cursor', 'codex', 'devin'];

const POLL_MS = 1_500;

/**
 * Sign-in controls for one agent CLI on one machine. Vibe starts the CLI's own
 * link-based login (Cursor challenge link / Codex device link + one-time code),
 * shows the link here for the user to open in their own browser, then confirms
 * the signed-in state once the CLI finishes. `host` is undefined for this
 * machine, or a remote host name (login then runs there, over SSH).
 */
export function AgentLoginControls({ agent, host }: { agent: LoginAgent; host?: string }) {
  const setToast = useStore((s) => s.setToast);
  const label = LOGIN_AGENT_LABELS[agent];

  const [account, setAccount] = useState<AgentLoginAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [login, setLogin] = useState<AgentLoginStatus | null>(null);
  const [starting, setStarting] = useState(false);
  const [copied, setCopied] = useState<string | null>(null);
  /** Pasted auth code, for flows the CLI can't finish on its own (Devin). */
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const waiting = login?.phase === 'starting' || login?.phase === 'link';

  // A generation counter keeps stale responses (host list refreshing mid-check)
  // from clobbering the current view.
  const genRef = useRef(0);

  const refreshAccount = useCallback(
    async (gen: number) => {
      try {
        const acct = await api.agentLoginAccount(agent, host);
        if (gen === genRef.current) setAccount(acct);
      } catch {
        if (gen === genRef.current) setAccount(null);
      }
    },
    [agent, host],
  );

  // Mount / prop change: pick up any flow already waiting for this combo (e.g.
  // the panel was closed mid-login), and check the signed-in state.
  useEffect(() => {
    const gen = ++genRef.current;
    setAccount(null);
    setAccountLoading(true);
    setLogin(null);
    void (async () => {
      try {
        const running = await api.agentLoginStatus(agent, host);
        if (gen !== genRef.current) return;
        if (running && (running.phase === 'starting' || running.phase === 'link')) setLogin(running);
      } catch {
        /* the account check below still runs */
      }
      await refreshAccount(gen);
      if (gen === genRef.current) setAccountLoading(false);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [agent, host]);

  // Poll the flow while it waits on the user's browser.
  useEffect(() => {
    if (!waiting) return;
    let cancelled = false;
    const tick = async () => {
      try {
        const st = await api.agentLoginStatus(agent, host);
        if (cancelled) return;
        setLogin(st);
        // Whenever the flow settles (success, but also error/cancelled — the
        // CLI can be killed after the user already finished), re-confirm the
        // signed-in state instead of trusting the flow's own verdict.
        if (st && st.phase !== 'starting' && st.phase !== 'link') {
          if (st.phase === 'success') setToast(`${label} signed in`);
          void refreshAccount(genRef.current);
        }
      } catch {
        /* keep polling — a transient failure shouldn't kill the view */
      }
    };
    const timer = setInterval(() => void tick(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [waiting, agent, host]);

  const start = async () => {
    setStarting(true);
    try {
      const st = await api.startAgentLogin(agent, host);
      setLogin(st);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : `Failed to start ${label} sign-in`);
    } finally {
      setStarting(false);
    }
  };

  const cancel = async () => {
    try {
      await api.cancelAgentLogin(agent, host);
    } catch {
      /* server-side flow dies on its own timeout anyway */
    }
    setLogin(null);
  };

  // Devin's CLI refuses a second login while already signed in (it exits 0 doing
  // nothing), so switching accounts has to sign out first. That discards the
  // existing Devin session, so it is a separate explicit action — never implicit.
  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.agentLogout(agent, host);
      setToast(`${label} signed out`);
      setLogin(null);
      setCode('');
      void refreshAccount(genRef.current);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : `Failed to sign out of ${label}`);
    } finally {
      setSigningOut(false);
    }
  };

  const submitCode = async () => {
    const value = code.trim();
    if (!value) return;
    setSubmitting(true);
    try {
      setLogin(await api.submitAgentLoginInput(agent, value, host));
      setCode('');
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Could not submit the code');
    } finally {
      setSubmitting(false);
    }
  };

  const copy = async (what: string) => {
    try {
      await navigator.clipboard.writeText(what);
      setCopied(what);
      setTimeout(() => setCopied((c) => (c === what ? null : c)), 1_500);
    } catch {
      setToast('Copy failed — select the text manually');
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="flex w-[4.75rem] shrink-0 items-center gap-1 text-slate-400">
          <KeyRound className="h-3 w-3 text-slate-500" />
          {label}
        </span>
        {accountLoading ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" /> checking…
          </span>
        ) : (
          <span
            className={cn('min-w-0 flex-1 truncate', account?.loggedIn ? 'text-slate-300' : 'text-slate-600')}
            title={account?.loggedIn ? account.account : undefined}
          >
            {account?.loggedIn ? `signed in — ${account.account}` : 'not signed in'}
          </span>
        )}
        {!waiting && (
          <div className="flex shrink-0 items-center gap-1">
            {account?.loggedIn && agent === 'devin' && (
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut || accountLoading}
                title={`Sign ${label} out on this machine — required before signing in with a different account`}
                className="flex h-6 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-400 transition hover:border-rose-500/50 hover:text-rose-300 disabled:opacity-40"
              >
                {signingOut ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                Sign out
              </button>
            )}
            <button
              type="button"
              onClick={() => void start()}
              disabled={starting || accountLoading || signingOut}
              title={account?.loggedIn ? `Sign in with a different ${label} account` : `Sign in to ${label} — Vibe gives you the link`}
              className="flex h-6 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
            >
              {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}
              {account?.loggedIn ? 'Switch' : 'Sign in'}
            </button>
          </div>
        )}
      </div>

      {login && waiting && (
        <div className="space-y-2 rounded-lg border border-accent/25 bg-accent/5 p-2.5">
          {login.phase === 'starting' ? (
            <p className="flex items-center gap-2 text-[11px] text-slate-300">
              <Loader2 className="h-3 w-3 animate-spin text-accent" />
              Starting {label} sign-in…
            </p>
          ) : (
            <>
              <p className="text-[11px] leading-relaxed text-slate-300">
                Open this link in your browser — on any device — to sign in{host ? ` (authorizes the CLI on ${host})` : ''}:
              </p>
              <div className="flex items-center gap-1.5">
                <a
                  href={login.url}
                  target="_blank"
                  rel="noreferrer"
                  className="flex h-8 min-w-0 flex-1 items-center gap-1.5 rounded-lg border border-accent/40 bg-ink-900/50 px-2.5 text-[11px] font-medium text-accent transition hover:bg-accent/10"
                  title={login.url}
                >
                  <ExternalLink className="h-3 w-3 shrink-0" />
                  <span className="truncate font-mono">{login.url}</span>
                </a>
                <button
                  type="button"
                  onClick={() => void copy(login.url ?? '')}
                  title="Copy link"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-ink-700 text-slate-400 transition hover:border-accent/50 hover:text-accent"
                >
                  {copied === login.url ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                </button>
              </div>
              {login.code && (
                <div className="flex items-center gap-2">
                  <span className="text-[11px] text-slate-400">Then enter this one-time code:</span>
                  <code className="rounded-md border border-ink-700 bg-ink-900/60 px-2 py-0.5 font-mono text-[12px] font-semibold tracking-widest text-slate-100">
                    {login.code}
                  </code>
                  <button
                    type="button"
                    onClick={() => void copy(login.code ?? '')}
                    title="Copy code"
                    className="rounded-md p-1 text-slate-500 transition hover:bg-ink-700 hover:text-slate-200"
                  >
                    {copied === login.code ? <Check className="h-3 w-3 text-emerald-400" /> : <Copy className="h-3 w-3" />}
                  </button>
                </div>
              )}
              {login.needsInput ? (
                /* Devin's manual-token flow: after authorizing, the browser shows a
                   code that must go back into the CLI. cursor/codex never need this. */
                <form
                  className="space-y-1.5"
                  onSubmit={(e) => {
                    e.preventDefault();
                    void submitCode();
                  }}
                >
                  <label className="block text-[11px] leading-relaxed text-slate-300" htmlFor={`login-code-${agent}-${host ?? 'local'}`}>
                    After signing in, the page shows an auth code — paste it here:
                  </label>
                  <div className="flex items-center gap-1.5">
                    <input
                      id={`login-code-${agent}-${host ?? 'local'}`}
                      value={code}
                      onChange={(e) => setCode(e.target.value)}
                      placeholder="paste the code"
                      autoComplete="off"
                      spellCheck={false}
                      className="h-8 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/60 px-2.5 font-mono text-[11px] text-slate-100 outline-none transition placeholder:text-slate-600 focus:border-accent/60"
                    />
                    <button
                      type="submit"
                      disabled={submitting || !code.trim()}
                      className="flex h-8 shrink-0 items-center gap-1 rounded-lg border border-accent/40 bg-ink-900/50 px-2.5 text-[11px] font-medium text-accent transition hover:bg-accent/10 disabled:opacity-40"
                    >
                      {submitting ? <Loader2 className="h-3 w-3 animate-spin" /> : null}
                      Submit
                    </button>
                  </div>
                  <p className="flex items-center gap-2 text-[10.5px] text-slate-500">
                    <Loader2 className="h-3 w-3 animate-spin" />
                    Waiting for the code — Vibe confirms once {label} accepts it.
                  </p>
                </form>
              ) : (
                <p className="flex items-center gap-2 text-[10.5px] text-slate-500">
                  <Loader2 className="h-3 w-3 animate-spin" />
                  Waiting for you to finish in the browser — Vibe confirms when you&apos;re done.
                </p>
              )}
            </>
          )}
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void cancel()}
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[10.5px] text-slate-400 transition hover:text-slate-200"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
          </div>
        </div>
      )}

      {login?.phase === 'error' && (
        <div className="space-y-1.5 rounded-lg border border-rose-500/25 bg-rose-500/5 p-2.5">
          <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-300">
            <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
            <span className="min-w-0 break-words">{login.error || 'Sign-in failed'}</span>
          </p>
          <div className="flex justify-end">
            <button
              type="button"
              onClick={() => void start()}
              className="flex h-6 items-center gap-1 rounded-md border border-ink-700 px-2 text-[10.5px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent"
            >
              <RefreshCw className="h-3 w-3" />
              Try again
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Account labels produced by the server when Vibe-managed credentials exist. */
const VIBE_CRED_MARK = '(Vibe)';

/**
 * CodeBuddy sign-in: paste an API key / auth token, which Vibe verifies with a
 * probe turn and persists to ~/.codebuddy/vibe-auth.env (injected into every
 * turn). CodeBuddy has no link-based CLI login — a TUI `/login` on the machine
 * also works and is detected (Vibe leaves it alone; sign out happens in the TUI).
 */
export function CodebuddyLoginControls({ host }: { host?: string }) {
  const setToast = useStore((s) => s.setToast);

  const [account, setAccount] = useState<AgentLoginAccount | null>(null);
  const [accountLoading, setAccountLoading] = useState(true);
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<'apiKey' | 'authToken'>('apiKey');
  const [secret, setSecret] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const genRef = useRef(0);
  const refreshAccount = useCallback(
    async (gen: number) => {
      try {
        const acct = await api.codebuddyAccount(host);
        if (gen === genRef.current) setAccount(acct);
      } catch {
        if (gen === genRef.current) setAccount(null);
      }
    },
    [host],
  );

  useEffect(() => {
    const gen = ++genRef.current;
    setAccount(null);
    setAccountLoading(true);
    void refreshAccount(gen).finally(() => {
      if (gen === genRef.current) setAccountLoading(false);
    });
  }, [refreshAccount]);

  const vibeManaged = Boolean(account?.loggedIn && account.account?.includes(VIBE_CRED_MARK));

  const save = async () => {
    const trimmed = secret.trim();
    if (!trimmed) {
      setError('Paste an API key or an auth token first');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const res = await api.saveCodebuddyCredentials(host ? { host, [kind]: trimmed } : { [kind]: trimmed });
      setToast(`CodeBuddy signed in${res.account.account ? ` — ${res.account.account}` : ''}`);
      setSecret('');
      setOpen(false);
      await refreshAccount(genRef.current);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Credential check failed');
    } finally {
      setSaving(false);
    }
  };

  const signOut = async () => {
    setSigningOut(true);
    try {
      await api.clearCodebuddyCredentials(host);
      setToast('CodeBuddy credentials removed');
      await refreshAccount(genRef.current);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Sign out failed');
    } finally {
      setSigningOut(false);
    }
  };

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2 text-[11px]">
        <span className="flex w-[4.75rem] shrink-0 items-center gap-1 text-slate-400">
          <KeyRound className="h-3 w-3 text-slate-500" />
          CodeBuddy
        </span>
        {accountLoading ? (
          <span className="flex min-w-0 flex-1 items-center gap-1.5 text-slate-500">
            <Loader2 className="h-3 w-3 animate-spin" /> checking…
          </span>
        ) : (
          <span
            className={cn('min-w-0 flex-1 truncate', account?.loggedIn ? 'text-slate-300' : 'text-slate-600')}
            title={account?.loggedIn ? account.account : undefined}
          >
            {account?.loggedIn ? `signed in — ${account.account}` : 'not signed in'}
          </span>
        )}
        {!open && (
          <>
            <button
              type="button"
              onClick={() => {
                setOpen(true);
                setError(null);
              }}
              disabled={accountLoading}
              title="Paste a CodeBuddy API key or auth token — Vibe verifies it, then injects it into every turn"
              className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
            >
              <LogIn className="h-3 w-3" />
              {account?.loggedIn ? 'Switch' : 'Sign in'}
            </button>
            {vibeManaged && (
              <button
                type="button"
                onClick={() => void signOut()}
                disabled={signingOut}
                title="Remove the credentials Vibe stored in ~/.codebuddy/vibe-auth.env"
                className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-400 transition hover:border-rose-400/50 hover:text-rose-300 disabled:opacity-40"
              >
                {signingOut ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogOut className="h-3 w-3" />}
                Sign out
              </button>
            )}
          </>
        )}
      </div>

      {open && (
        <div className="space-y-2 rounded-lg border border-accent/25 bg-accent/5 p-2.5">
          <p className="text-[11px] leading-relaxed text-slate-300">
            Paste a CodeBuddy credential — Vibe runs a one-line probe to verify it, stores it in{' '}
            <code className="text-slate-400">~/.codebuddy/vibe-auth.env</code>
            {host ? ` on ${host}` : ''} (0600), and injects it as{' '}
            <code className="text-slate-400">CODEBUDDY_API_KEY</code>/<code className="text-slate-400">CODEBUDDY_AUTH_TOKEN</code>{' '}
            on every turn. You can instead run <code className="text-slate-400">/login</code> in the CodeBuddy TUI — Vibe
            detects that sign-in too.
          </p>
          <div className="flex items-center gap-1.5">
            {(['apiKey', 'authToken'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setKind(k)}
                className={cn(
                  'h-7 rounded-md px-2 text-[10.5px] font-medium transition',
                  kind === k ? 'bg-accent/15 text-accent' : 'text-slate-500 hover:text-slate-300',
                )}
              >
                {k === 'apiKey' ? 'API key' : 'Auth token'}
              </button>
            ))}
            <input
              type="password"
              autoFocus
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  void save();
                } else if (e.key === 'Escape') {
                  setOpen(false);
                  setSecret('');
                  setError(null);
                }
              }}
              placeholder={kind === 'apiKey' ? 'CODEBUDDY_API_KEY value' : 'CODEBUDDY_AUTH_TOKEN value'}
              className="h-8 min-w-0 flex-1 rounded-lg border border-ink-700 bg-ink-900/50 px-2.5 font-mono text-[11px] text-slate-200 outline-none focus:border-accent/60"
            />
          </div>
          {error && (
            <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-rose-300">
              <AlertCircle className="mt-0.5 h-3 w-3 shrink-0" />
              <span className="min-w-0 break-words">{error}</span>
            </p>
          )}
          <div className="flex justify-end gap-1.5">
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                setSecret('');
                setError(null);
              }}
              className="flex h-6 items-center gap-1 rounded-md px-2 text-[10.5px] text-slate-400 transition hover:text-slate-200"
            >
              <X className="h-3 w-3" />
              Cancel
            </button>
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || !secret.trim()}
              className="flex h-6 items-center gap-1 rounded-md border border-ink-700 px-2 text-[10.5px] font-medium text-slate-200 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
            >
              {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />}
              Verify & save
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
