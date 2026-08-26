import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Loader2, LogIn, Copy, Check, ExternalLink, X, AlertCircle, RefreshCw } from '../lib/icons';
import type { AgentLoginAccount, AgentLoginStatus, LoginAgent } from '@shared/protocol';
import { useStore } from '../store/store';
import { api, ApiError } from '../lib/api';
import { cn } from '../lib/format';

export const LOGIN_AGENT_LABELS: Record<LoginAgent, string> = { cursor: 'Cursor', codex: 'Codex' };
export const LOGIN_AGENTS: LoginAgent[] = ['cursor', 'codex'];

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
        <span className="flex w-14 shrink-0 items-center gap-1 text-slate-400">
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
          <button
            type="button"
            onClick={() => void start()}
            disabled={starting || accountLoading}
            title={account?.loggedIn ? `Sign in with a different ${label} account` : `Sign in to ${label} — Vibe gives you the link`}
            className="flex h-6 shrink-0 items-center gap-1 rounded-md border border-ink-700/80 bg-ink-900/40 px-1.5 text-[10px] font-medium text-slate-300 transition hover:border-accent/50 hover:text-accent disabled:opacity-40"
          >
            {starting ? <Loader2 className="h-3 w-3 animate-spin" /> : <LogIn className="h-3 w-3" />}
            {account?.loggedIn ? 'Switch' : 'Sign in'}
          </button>
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
              <p className="flex items-center gap-2 text-[10.5px] text-slate-500">
                <Loader2 className="h-3 w-3 animate-spin" />
                Waiting for you to finish in the browser — Vibe confirms when you&apos;re done.
              </p>
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
