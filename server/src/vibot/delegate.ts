import { log } from '../log.js';
import { hub, CallbackConn } from '../ws/hub.js';
import { vibotHub } from './hub.js';
import type { PermissionDecision, ServerEvent } from '../../../shared/protocol.js';

/**
 * When Vibot delegates a task to a coding agent (`create_session` with
 * manage:'auto'), it watches that session and acts on its behalf:
 *
 *  - **During the run**: every permission prompt the agent raises is resolved
 *    automatically per a whitelist policy, and plans (ExitPlanMode) are approved.
 *  - **On completion**: the agent ran in the background, so when it finishes
 *    (foreground idle AND no native background tasks left) Vibot is *woken* — a
 *    new Vibot turn starts, seeded with the outcome tally, so it can report
 *    results and decide on next steps. Exactly how Claude's own background-task
 *    completion re-engages the agent.
 *
 * The watcher is a long-lived {@link CallbackConn} subscribed to the delegate
 * session. It outlives Vibot's own turn (which ends as soon as `create_session`
 * returns) because prompts and task notifications arrive asynchronously. It
 * tears itself down after a few minutes of inactivity so it never leaks.
 *
 * This layers cleanly on top of the permission auto-approval (during-run) — the
 * wake is the after-run counterpart, and the two never overlap.
 */

const IDLE_TEARDOWN_MS = 3 * 60_000;
const TICK_MS = 30_000;
/** A task status that means work is still in flight (vs. completed/failed/stopped). */
const ACTIVE_TASK_STATUS = new Set(['pending', 'running', 'paused']);

/** Tool names that execute arbitrary commands — the risky category. These are
 *  still auto-allowed (the user opted into auto-management), but per-call
 *  (remember:false) so each command stays individually visible, rather than
 *  blanket-allowing all future commands of that tool. */
const COMMAND_TOOL_RE = /^(bash|shell|runterminalcommand|terminal|runcommand|execute|executebash|awaitshell|await)$/i;

function normalizeToolName(name: string): string {
  return String(name ?? '').replace(/[_\-\s]/g, '').toLowerCase();
}

function isCommandTool(name: string): boolean {
  return COMMAND_TOOL_RE.test(normalizeToolName(name));
}

interface Manager {
  sessionId: string;
  title: string;
  vibotConvId: string;
  conn: CallbackConn;
  approved: number;
  commands: number;
  plans: number;
  errored: boolean;
  /** True once we've woken Vibot for this delegate run. */
  woken: boolean;
  /** Foreground model turn currently running (run_state). */
  foregroundRunning: boolean;
  /** Native background task ids still in flight (task_upsert). */
  activeTasks: Set<string>;
  lastEventAt: number;
  timer: ReturnType<typeof setInterval> | null;
  torn: boolean;
}

const managers = new Map<string, Manager>();

/**
 * Create the watcher for a delegate session. The returned connection must be
 * passed to `hub.send(...)` so it becomes a subscriber before the first prompt
 * can arrive. Status notes / the wake go to `vibotConvId`.
 */
export function createDelegateWatcher(sessionId: string, title: string, vibotConvId: string): CallbackConn {
  teardown(sessionId); // idempotent: replace any prior watcher for this session
  const m: Manager = {
    sessionId,
    title,
    vibotConvId,
    conn: undefined as unknown as CallbackConn,
    approved: 0,
    commands: 0,
    plans: 0,
    errored: false,
    woken: false,
    foregroundRunning: true, // the turn is starting; assume busy until proven idle
    activeTasks: new Set(),
    lastEventAt: Date.now(),
    timer: null,
    torn: false,
  };
  m.conn = new CallbackConn((msg) => handle(m, msg));
  managers.set(sessionId, m);
  m.timer = setInterval(() => maybeIdleTeardown(m), TICK_MS);
  m.timer.unref?.();
  log.info(`vibot: watching delegate session ${sessionId} (conv ${vibotConvId})`);
  return m.conn;
}

/** Stop watching a session (e.g. it was deleted). Safe to call when none. */
export function teardownDelegateSession(sessionId: string): void {
  teardown(sessionId);
}

function handle(m: Manager, msg: ServerEvent): void {
  if (m.torn) return;
  m.lastEventAt = Date.now();

  switch (msg.t) {
    case 'permission_request': {
      if (msg.sessionId !== m.sessionId) return;
      const { toolName, requestId } = msg.request;
      const isPlan = normalizeToolName(toolName) === 'exitplanmode';
      const command = !isPlan && isCommandTool(toolName);
      // Always allow — the user opted into auto-management. Safe (non-command)
      // tools are remembered so the agent isn't re-prompted for the same tool;
      // commands and plans are allowed per-call to keep them individually tallied.
      const decision: PermissionDecision = { allow: true, remember: !command && !isPlan };
      hub.resolvePermission(m.sessionId, requestId, decision);
      m.approved++;
      if (isPlan) m.plans++;
      else if (command) m.commands++;
      log.debug(`vibot: approved ${toolName} (remember=${decision.remember}) in ${m.sessionId}`);
      break;
    }
    case 'event': {
      const ev = msg.ev;
      if (ev.k === 'run_state') {
        m.foregroundRunning = ev.running;
        maybeWake(m);
      } else if (ev.k === 'task_upsert') {
        const id = ev.task.id;
        if (ACTIVE_TASK_STATUS.has(ev.task.status)) m.activeTasks.add(id);
        else m.activeTasks.delete(id);
        maybeWake(m);
      } else if (ev.k === 'error') {
        m.errored = true;
      }
      break;
    }
    default:
      break;
  }
}

/**
 * Wake Vibot once the delegate is truly idle — foreground turn finished AND no
 * native background tasks still in flight. Mirrors how Claude waits for its
 * background tasks before closing a turn. Fires at most once per delegate run.
 */
function maybeWake(m: Manager): void {
  if (m.woken || m.foregroundRunning || m.activeTasks.size > 0) return;
  m.woken = true;
  const summary = summaryText(m, true);
  log.info(`vibot: delegate ${m.sessionId} finished — waking conv ${m.vibotConvId}`);
  vibotHub.wake(m.vibotConvId, summary);
}

function maybeIdleTeardown(m: Manager): void {
  if (m.torn || Date.now() - m.lastEventAt < IDLE_TEARDOWN_MS) return;
  teardown(m.sessionId);
}

function teardown(sessionId: string): void {
  const m = managers.get(sessionId);
  if (!m) return;
  m.torn = true;
  if (m.timer) clearInterval(m.timer);
  m.timer = null;
  try {
    hub.unsubscribe(m.conn, sessionId);
  } catch {
    /* runtime may already be gone */
  }
  managers.delete(sessionId);
  // If we never got to wake Vibot (e.g. the session was deleted mid-run, or it
  // never went idle), leave a final static note so the tally isn't lost.
  if (!m.woken) vibotHub.appendNote(m.vibotConvId, summaryText(m, true));
  log.info(`vibot: stopped watching delegate session ${sessionId} (approved ${m.approved})`);
}

/** Build the one-line outcome summary shown to the user / fed to the wake turn. */
function summaryText(m: Manager, _final: boolean): string {
  const parts: string[] = [`approved ${m.approved} tool call${m.approved === 1 ? '' : 's'}`];
  if (m.commands) parts.push(`${m.commands} command${m.commands === 1 ? '' : 's'}`);
  if (m.plans) parts.push(`${m.plans} plan${m.plans === 1 ? '' : 's'}`);
  const tail = m.errored ? ' ⚠️ finished with errors' : ' · finished';
  return `🤖 Delegate “${m.title}” ${parts.join(', ')}.${tail} Review the outcome and update the user; use read_session if you need details.`;
}
