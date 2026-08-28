import { log } from '../log.js';
import { hub, CallbackConn } from '../ws/hub.js';
import { vibotHub } from './hub.js';
import { isDelegateWakeActive, markDelegateWake } from './wakeSuppress.js';
import type { PermissionDecision, ServerEvent } from '../../../shared/protocol.js';

/**
 * When Vibot delegates a task to a coding agent (`create_session` with
 * manage:'auto'), it watches that session and acts on its behalf:
 *
 *  - **During the run**: every permission prompt the agent raises is resolved
 *    automatically per a whitelist policy, and plans (ExitPlanMode) are approved.
 *  - **On each foreground turn end**: Vibot is *woken* with an outcome tally
 *    (and a note if native background tasks are still running). A new turn on
 *    the same session resets the wake latch so every turn can notify Vibot.
 *
 * The watcher is a long-lived {@link CallbackConn} subscribed to the delegate
 * session. It outlives Vibot's own turn (which ends as soon as `create_session`
 * returns) because prompts and task notifications arrive asynchronously. It
 * tears itself down after a few minutes of inactivity so it never leaks.
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
  /** True after a wake for the current foreground turn; cleared when a new turn starts. */
  woken: boolean;
  /** Foreground model turn currently running (run_state). */
  foregroundRunning: boolean;
  /** Native background tasks still in flight (task_upsert) — id → short label for wake summaries. */
  activeTasks: Map<string, string>;
  /** Recently settled tasks (for wake-prompt detail); capped, newest last. */
  settledTasks: Array<{ id: string; label: string; status: string }>;
  lastEventAt: number;
  timer: ReturnType<typeof setInterval> | null;
  torn: boolean;
}

const managers = new Map<string, Manager>();

/** Re-export suppress helpers so callers (zcode) can import from delegate. */
export { isDelegateWakeActive, markDelegateWake, peekDelegateWakePrompt, refreshDelegateWake } from './wakeSuppress.js';

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
    activeTasks: new Map(),
    settledTasks: [],
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
        // A new foreground turn can wake Vibot again when it ends — except
        // turns that start inside the post-wake suppress window (zcode native
        // task notifications / polled wakes), which must not re-arm the latch.
        if (ev.running && !isDelegateWakeActive(m.sessionId)) m.woken = false;
        maybeWake(m);
      } else if (ev.k === 'task_upsert') {
        const id = ev.task.id;
        const label = (ev.task.description || ev.task.command || id).trim() || id;
        const short = label.length > 80 ? `${label.slice(0, 77)}…` : label;
        if (ACTIVE_TASK_STATUS.has(ev.task.status)) {
          m.activeTasks.set(id, short);
        } else {
          m.activeTasks.delete(id);
          m.settledTasks = [
            ...m.settledTasks.filter((t) => t.id !== id),
            { id, label: short, status: ev.task.status },
          ].slice(-6);
        }
        // Background tasks do not gate wake; tracking is for the next wake summary only.
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
 * Wake Vibot when the delegate's foreground turn finishes. Background tasks may
 * still be running — the prompt says so. At most one wake per foreground turn
 * (`woken` resets when the next turn starts).
 */
function maybeWake(m: Manager): void {
  if (m.woken || m.foregroundRunning) return;
  m.woken = true;
  const note = noteText(m);
  const prompt = promptText(m);
  // Suppress zcode polled/native-steered duplicates BEFORE vibotHub.wake so the
  // coding transport's service loop (which runs right after onTurnState false)
  // already sees the window.
  markDelegateWake(m.sessionId, prompt);
  log.info(`vibot: delegate ${m.sessionId} turn finished — waking conv ${m.vibotConvId}`);
  vibotHub.wake(m.vibotConvId, note, prompt, m.sessionId);
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
  // If we never woke for the current turn (e.g. session deleted mid-run), leave
  // a final static note so the tally isn't lost. Normal multi-turn wakes already
  // fire on each foreground idle, so this is mostly a mid-run delete path.
  if (!m.woken) vibotHub.appendNote(m.vibotConvId, noteText(m));
  log.info(`vibot: stopped watching delegate session ${sessionId} (approved ${m.approved})`);
}

/** Short coding-style system notice (dashed divider in the chat UI). */
function noteText(m: Manager): string {
  const parts: string[] = [`approved ${m.approved} tool call${m.approved === 1 ? '' : 's'}`];
  if (m.commands) parts.push(`${m.commands} command${m.commands === 1 ? '' : 's'}`);
  if (m.plans) parts.push(`${m.plans} plan${m.plans === 1 ? '' : 's'}`);
  const status = m.errored
    ? 'finished with errors'
    : m.activeTasks.size > 0
      ? `${m.activeTasks.size} background task${m.activeTasks.size === 1 ? '' : 's'} still running`
      : 'finished';
  // Mirrors coding hub emitWakeNotice: short title + reason to re-engage.
  return `委托「${m.title}」回合结束 · ${parts.join(', ')} · ${status}，唤醒 Vibot 继续`;
}

/** Full silent-turn seed for the LLM (not shown as a user bubble). */
function promptText(m: Manager): string {
  const parts: string[] = [`approved ${m.approved} tool call${m.approved === 1 ? '' : 's'}`];
  if (m.commands) parts.push(`${m.commands} command${m.commands === 1 ? '' : 's'}`);
  if (m.plans) parts.push(`${m.plans} plan${m.plans === 1 ? '' : 's'}`);
  const tail = m.errored ? ' finished with errors' : ' finished';
  const bgLabels = [...m.activeTasks.values()];
  let bgNote = '';
  if (bgLabels.length > 0) {
    const shown = bgLabels.slice(0, 3).map((l) => `"${l}"`).join(', ');
    const more = bgLabels.length > 3 ? ` (+${bgLabels.length - 3} more)` : '';
    bgNote =
      ` ${bgLabels.length} background task${bgLabels.length === 1 ? '' : 's'} still running` +
      ` (${shown}${more}) — outcome may not be final yet; you can remind the user to check back later.`;
  }
  let settledNote = '';
  if (m.settledTasks.length > 0) {
    const lines = m.settledTasks
      .slice(-4)
      .map((t) => `- ${t.id}: ${t.status} — ${t.label}`)
      .join('\n');
    settledNote = ` Recent background-task updates:\n${lines}\n`;
  }
  return (
    `Delegate "${m.title}" (session ${m.sessionId}) ${parts.join(', ')}.${tail}.${bgNote}` +
    settledNote +
    ` Review the outcome (call read_session with sessionId "${m.sessionId}" if you need details)` +
    ` and update the user; then decide on any next steps.`
  );
}
