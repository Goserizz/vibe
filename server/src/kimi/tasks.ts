import fs from 'node:fs';
import path from 'node:path';
import { findKimiSessionDir } from './discovery.js';
import { findRemoteKimiSessionDir } from './remote.js';
import { kimiWireBlocks } from './transcript.js';
import { loginShellCommand, shQuote, sshExec } from '../remote/ssh.js';
import type { BackgroundTask, BackgroundTaskStatus, ChatBlock } from '../../../shared/protocol.js';

interface KimiTaskFile {
  taskId?: unknown;
  description?: unknown;
  status?: unknown;
  startedAt?: unknown;
  endedAt?: unknown;
  kind?: unknown;
  command?: unknown;
  prompt?: unknown;
  cwd?: unknown;
  pid?: unknown;
  exitCode?: unknown;
  stopReason?: unknown;
  error?: unknown;
}

const ACTIVE = new Set(['pending', 'running', 'started', 'paused', 'stopping']);
const LOCAL_POLL_MS = 750;
const REMOTE_POLL_MS = 2_000;
const OUTPUT_TAIL_BYTES = 8_000;
const WIRE_CHUNK_BYTES = 1024 * 1024;

interface KimiTaskMonitorHooks {
  onNativeTurnStart?: (turnId: string) => void;
  /** Changed blocks from a Kimi-native task/cron turn. ACP does not stream
   *  these turns, so the wire monitor publishes snapshots while it runs. */
  onNativeTurnBlocks?: (turnId: string, blocks: ChatBlock[]) => void;
  onNativeTurnComplete?: (
    turnId: string,
    blocks: ChatBlock[],
    outcome: 'completed' | 'cancelled' | 'interrupted',
  ) => void;
}

function mapStatus(value: unknown): BackgroundTaskStatus {
  const status = String(value ?? '').toLowerCase();
  if (status === 'pending' || status === 'started') return 'pending';
  if (status === 'running' || status === 'stopping') return 'running';
  if (status === 'paused') return 'paused';
  if (status === 'completed' || status === 'succeeded' || status === 'success') return 'completed';
  if (status === 'killed' || status === 'stopped' || status === 'cancelled' || status === 'canceled') return 'stopped';
  return 'failed';
}

function readTail(file: string, maxBytes = OUTPUT_TAIL_BYTES): string | undefined {
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size === 0) return undefined;
    const size = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(size);
    fd = fs.openSync(file, 'r');
    fs.readSync(fd, buffer, 0, size, Math.max(0, stat.size - size));
    return buffer.toString('utf8').trim() || undefined;
  } catch {
    return undefined;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseTime(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Some Kimi builds persist seconds, others milliseconds.
    return value < 1e12 ? value * 1_000 : value;
  }
  if (typeof value === 'string' && value) {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 0) return numeric < 1e12 ? numeric * 1_000 : numeric;
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

interface TaskSnapshot {
  name: string;
  rawText: string;
  signature: string;
  output?: string;
  outputFile?: string;
}

interface RemoteScan {
  tasks: TaskSnapshot[];
  wire?: { size: number; bytes: Buffer; reset: boolean };
}

interface WireTurn {
  id: string;
  kind: 'owned' | 'native';
  lines: string[];
  promptAttemptId?: number;
  /** JSON signature of each block already published through
   *  `onNativeTurnBlocks`, keyed by its stable, turn-scoped id. */
  publishedBlocks?: Map<string, string>;
}

interface WirePromptAttempt {
  id: number;
  recordSeen: boolean;
  previousPending?: WireTurn;
}

interface TurnWaiter {
  resolve: (observed: boolean) => void;
  timer?: ReturnType<typeof setTimeout>;
}

/** Watches Kimi's documented per-session task files and incrementally follows
 *  the session wire for agent-initiated turn lifecycle. Task state is written
 *  atomically, so polling stays cheap and avoids private in-process RPCs. */
export class KimiTaskMonitor {
  private timer: ReturnType<typeof setInterval> | undefined;
  private sessionDir: string | undefined;
  private taskDir: string | undefined;
  private signatures = new Map<string, string>();
  private native = new Map<string, KimiTaskFile>();
  private normalized = new Map<string, BackgroundTask>();
  private scanPromise: Promise<void> | undefined;
  /** Byte offset into the native append-only wire. Undefined means the first
   *  scan should adopt EOF as its baseline and must not replay old history. */
  private wireOffset: number | undefined;
  private wireRemainder = Buffer.alloc(0);
  private pendingWireTurn: WireTurn | undefined;
  private currentWireTurn: WireTurn | undefined;
  /** Goal continuation turns have no new turn.prompt/turn.steer record. */
  private lastWireTurnKind: WireTurn['kind'] = 'owned';
  private readonly endedWireTurns = new Set<string>();
  private readonly turnWaiters = new Map<string, Set<TurnWaiter>>();
  private nextPromptAttemptId = 1;
  private readonly promptAttempts = new Map<number, WirePromptAttempt>();
  private readonly promptAttemptOrder: number[] = [];
  private rejectedPromptRecordsToSkip = 0;
  readonly pollIntervalMs: number;

  constructor(
    private readonly sessionId: string,
    private readonly onTask: (task: BackgroundTask) => void,
    private readonly sshTarget?: string,
    private readonly hooks: KimiTaskMonitorHooks = {},
  ) {
    this.pollIntervalMs = sshTarget ? REMOTE_POLL_MS : LOCAL_POLL_MS;
  }

  start(): void {
    void this.scan();
    this.timer = setInterval(() => void this.scan(), this.pollIntervalMs);
    this.timer.unref?.();
  }

  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    const waiters = [...this.turnWaiters.values()].flatMap((group) => [...group]);
    this.turnWaiters.clear();
    this.promptAttempts.clear();
    this.promptAttemptOrder.length = 0;
    for (const waiter of waiters) {
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(false);
    }
  }

  tasks(): BackgroundTask[] {
    return [...this.normalized.values()];
  }

  hasNativeTurn(): boolean {
    return this.currentWireTurn?.kind === 'native' || this.pendingWireTurn?.kind === 'native';
  }

  /** Pair a session/prompt RPC with its persisted turn.prompt record. The RPC
   *  result arrives either before or after the next wire scan; keeping a tiny
   *  token lets a busy rejection roll back that record without mistaking a
   *  native continuation for the user's queued turn. */
  beginPromptAttempt(): number {
    const id = this.nextPromptAttemptId++;
    this.promptAttempts.set(id, { id, recordSeen: false });
    this.promptAttemptOrder.push(id);
    return id;
  }

  finishPromptAttempt(id: number | undefined, accepted: boolean): void {
    if (id === undefined) return;
    const attempt = this.promptAttempts.get(id);
    if (!attempt) return;

    if (!accepted) {
      if (!attempt.recordSeen) {
        // Kimi logs turn.prompt synchronously before emitting turn.agent_busy;
        // the next scan has not reached it yet, so skip exactly one record.
        this.rejectedPromptRecordsToSkip += 1;
      } else if (this.pendingWireTurn?.promptAttemptId === id) {
        this.pendingWireTurn = attempt.previousPending;
      } else if (this.currentWireTurn?.promptAttemptId === id) {
        const current = this.currentWireTurn;
        const inherited = attempt.previousPending?.kind ?? this.lastWireTurnKind;
        current.kind = inherited;
        current.promptAttemptId = undefined;
        current.lines = inherited === 'native'
          ? [...(attempt.previousPending?.lines ?? []), ...current.lines]
          : [];
        if (inherited === 'native') this.hooks.onNativeTurnStart?.(current.id);
      }
    }

    this.removePromptAttempt(id);
  }

  /** Wait for the native turn named in a `turn.agent_busy` response. Retrying
   *  only after its terminal wire record avoids both prompt loss and a stream
   *  of rejected `turn.prompt` records in Kimi's persisted history. */
  async waitForTurnEnd(turnId: string, timeoutMs = 30 * 60_000): Promise<boolean> {
    await this.scan();
    if (this.endedWireTurns.has(turnId)) return true;
    if (this.wireOffset === undefined) return false;
    return new Promise((resolve) => {
      const waiter: TurnWaiter = { resolve };
      const finish = (observed: boolean) => {
        const waiters = this.turnWaiters.get(turnId);
        waiters?.delete(waiter);
        if (waiters?.size === 0) this.turnWaiters.delete(turnId);
        if (waiter.timer) clearTimeout(waiter.timer);
        resolve(observed);
      };
      waiter.resolve = finish;
      waiter.timer = setTimeout(() => finish(false), timeoutMs);
      waiter.timer.unref?.();
      const waiters = this.turnWaiters.get(turnId) ?? new Set<TurnWaiter>();
      waiters.add(waiter);
      this.turnWaiters.set(turnId, waiters);
    });
  }

  /** Tasks created during this Vibe run. Including already-settled files closes
   *  the race where a very short task starts and finishes between two scans. */
  observedTaskIds(since: number): string[] {
    return [...this.normalized.values()].filter((task) => task.startedAt >= since).map((task) => task.id);
  }

  async stopTask(taskId: string): Promise<void> {
    await this.scan();
    const raw = this.native.get(taskId);
    const task = this.normalized.get(taskId);
    if (!raw || !task || !ACTIVE.has(String(raw.status ?? '').toLowerCase())) throw new Error('Kimi task is not running');
    const pid = Number(raw.pid);
    if (!Number.isInteger(pid) || pid <= 1 || raw.kind !== 'process') {
      throw new Error('Kimi does not expose an individual stop handle for this task');
    }
    // The PID comes from the task's own state file inside this exact session,
    // not from user input or process discovery.
    if (this.sshTarget) {
      const result = await sshExec(this.sshTarget, `kill -TERM ${pid}`, { timeoutMs: 10_000 });
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'remote task stop failed');
    } else {
      process.kill(pid, 'SIGTERM');
    }
  }

  async scan(): Promise<void> {
    // The interval and background-activity loop can land on the same tick.
    // Coalesce them so remote sessions never launch duplicate SSH scans.
    if (this.scanPromise) return this.scanPromise;
    const promise = this.scanOnce();
    this.scanPromise = promise;
    try {
      await promise;
    } finally {
      if (this.scanPromise === promise) this.scanPromise = undefined;
    }
  }

  private async scanOnce(): Promise<void> {
    if (this.sshTarget) {
      const result = await this.remoteSnapshots();
      for (const snapshot of result.tasks) this.applySnapshot(snapshot);
      if (result.wire) this.applyWireSnapshot(result.wire);
      else if (this.wireOffset === undefined && this.sessionDir) this.resetWire(0);
      return;
    }

    if (!this.sessionDir) {
      const sessionDir = findKimiSessionDir(this.sessionId);
      if (!sessionDir) return;
      this.sessionDir = sessionDir;
      const candidates = [path.join(sessionDir, 'agents', 'main', 'tasks'), path.join(sessionDir, 'tasks')];
      this.taskDir = candidates.find((candidate) => fs.existsSync(candidate));
    }

    if (this.taskDir) {
      let names: string[] = [];
      try {
        names = fs.readdirSync(this.taskDir).filter((name) => name.endsWith('.json'));
      } catch {
        /* task directory may disappear while Kimi rotates a session */
      }
      for (const name of names) {
        const file = path.join(this.taskDir, name);
        let rawText: string;
        let stat: fs.Stats;
        try {
          rawText = fs.readFileSync(file, 'utf8');
          stat = fs.statSync(file);
        } catch {
          continue;
        }
        const nameId = name.slice(0, -5);
        const outputFile = path.join(this.taskDir, nameId, 'output.log');
        let outputSize = 0;
        try { outputSize = fs.statSync(outputFile).size; } catch { /* no output yet */ }
        const signature = `${stat.mtimeMs}:${outputSize}`;
        this.applySnapshot({
          name: nameId,
          rawText,
          signature,
          output: readTail(outputFile),
          outputFile: fs.existsSync(outputFile) ? outputFile : undefined,
        });
      }
    }

    this.scanLocalWire();
  }

  /** Fetch every remote task state + bounded output tail in one SSH round trip.
   *  Base64 keeps arbitrary JSON/output bytes from corrupting line framing. */
  private async remoteSnapshots(): Promise<RemoteScan> {
    if (!this.sshTarget) return { tasks: [] };
    if (!this.sessionDir) {
      this.sessionDir = await findRemoteKimiSessionDir(this.sshTarget, this.sessionId);
      if (!this.sessionDir) return { tasks: [] };
    }
    const offset = this.wireOffset ?? -1;
    const command = [
      `d=${shQuote(this.sessionDir)}`,
      'td=',
      'for candidate in "$d/agents/main/tasks" "$d/tasks"; do',
      '  if [ -d "$candidate" ]; then td="$candidate"; break; fi',
      'done',
      'if [ -n "$td" ]; then',
      '  for f in "$td"/*.json; do',
      '    [ -f "$f" ] || continue',
      '    id=${f##*/}; id=${id%.json}',
      '    o="$td/$id/output.log"',
      '    [ -f "$o" ] && has_output=1 || has_output=0',
      '    printf "task\\t%s\\t%s\\t%s\\t" "$id" "$td" "$has_output"',
      '    base64 < "$f" 2>/dev/null | tr -d "\\r\\n"',
      '    printf "\\t"',
      `    [ "$has_output" = 1 ] && tail -c ${OUTPUT_TAIL_BYTES} "$o" 2>/dev/null | base64 | tr -d "\\r\\n"`,
      '    printf "\\n"',
      '  done',
      'fi',
      'w="$d/agents/main/wire.jsonl"',
      'if [ -f "$w" ]; then',
      '  wire_size=$(wc -c < "$w" 2>/dev/null | tr -d " \\r\\n")',
      `  wire_offset=${offset}`,
      '  wire_reset=0',
      '  wire_count=0',
      '  if [ "$wire_offset" -lt 0 ] || [ "$wire_size" -lt "$wire_offset" ]; then',
      '    wire_reset=1',
      '  elif [ "$wire_size" -gt "$wire_offset" ]; then',
      '    wire_count=$((wire_size - wire_offset))',
      `    [ "$wire_count" -gt ${WIRE_CHUNK_BYTES} ] && wire_count=${WIRE_CHUNK_BYTES}`,
      '  fi',
      '  printf "wire\\t%s\\t%s\\t%s\\t" "$wire_size" "$wire_count" "$wire_reset"',
      '  if [ "$wire_count" -gt 0 ]; then',
      '    wire_from=$((wire_offset + 1))',
      '    tail -c +"$wire_from" "$w" 2>/dev/null | head -c "$wire_count" | base64 | tr -d "\\r\\n"',
      '  fi',
      '  printf "\\n"',
      'fi',
    ].join('\n');
    const result = await sshExec(this.sshTarget, loginShellCommand(command), { timeoutMs: 15_000 });
    if (result.code !== 0) return { tasks: [] };

    const snapshots: TaskSnapshot[] = [];
    let wire: RemoteScan['wire'];
    for (const line of result.stdout.split('\n')) {
      if (!line) continue;
      const fields = line.split('\t');
      if (fields[0] === 'wire') {
        const size = Number(fields[1]);
        const count = Number(fields[2]);
        const reset = fields[3] === '1';
        if (!Number.isFinite(size) || size < 0 || !Number.isFinite(count) || count < 0) continue;
        try {
          const bytes = count > 0 ? Buffer.from(fields[4] ?? '', 'base64') : Buffer.alloc(0);
          wire = { size, bytes, reset };
        } catch {
          /* ignore malformed wire snapshot */
        }
        continue;
      }
      const [kind, name, taskDir, hasOutput, rawBase64, outputBase64 = ''] = fields;
      if (kind !== 'task') continue;
      if (!name || !taskDir || !rawBase64) continue;
      let rawText: string;
      let output: string | undefined;
      try {
        rawText = Buffer.from(rawBase64, 'base64').toString('utf8');
        output = hasOutput === '1' ? Buffer.from(outputBase64, 'base64').toString('utf8').trim() || undefined : undefined;
      } catch {
        continue;
      }
      this.taskDir = taskDir;
      snapshots.push({
        name,
        rawText,
        signature: `${rawText}\0${output ?? ''}`,
        output,
        outputFile: hasOutput === '1' ? path.posix.join(taskDir, name, 'output.log') : undefined,
      });
    }
    return { tasks: snapshots, wire };
  }

  private scanLocalWire(): void {
    if (!this.sessionDir) return;
    const file = path.join(this.sessionDir, 'agents', 'main', 'wire.jsonl');
    let fd: number | undefined;
    try {
      const stat = fs.statSync(file);
      if (this.wireOffset === undefined || stat.size < this.wireOffset) {
        this.resetWire(stat.size);
        return;
      }
      if (stat.size === this.wireOffset) return;
      const size = Math.min(WIRE_CHUNK_BYTES, stat.size - this.wireOffset);
      const bytes = Buffer.alloc(size);
      fd = fs.openSync(file, 'r');
      const read = fs.readSync(fd, bytes, 0, size, this.wireOffset);
      this.wireOffset += read;
      if (read > 0) this.consumeWireBytes(bytes.subarray(0, read));
    } catch {
      /* the wire may not exist until Kimi launches its first turn */
      if (this.wireOffset === undefined && !fs.existsSync(file)) this.resetWire(0);
    } finally {
      if (fd !== undefined) {
        try { fs.closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  private applyWireSnapshot(snapshot: NonNullable<RemoteScan['wire']>): void {
    if (this.wireOffset === undefined || snapshot.reset || snapshot.size < this.wireOffset) {
      this.resetWire(snapshot.size);
      return;
    }
    if (snapshot.bytes.length === 0) return;
    this.wireOffset += snapshot.bytes.length;
    this.consumeWireBytes(snapshot.bytes);
  }

  private resetWire(offset: number): void {
    this.wireOffset = offset;
    this.wireRemainder = Buffer.alloc(0);
    this.pendingWireTurn = undefined;
    if (this.currentWireTurn?.kind === 'native') this.finishWireTurn(this.currentWireTurn, false);
    this.currentWireTurn = undefined;
  }

  private consumeWireBytes(bytes: Buffer): void {
    const data = this.wireRemainder.length ? Buffer.concat([this.wireRemainder, bytes]) : bytes;
    let start = 0;
    for (let index = data.indexOf(0x0a, start); index >= 0; index = data.indexOf(0x0a, start)) {
      const line = data.subarray(start, index).toString('utf8');
      start = index + 1;
      if (line.trim()) this.consumeWireLine(line);
    }
    this.wireRemainder = start < data.length ? data.subarray(start) : Buffer.alloc(0);
    // A native background turn is invisible on ACP. Publish the blocks parsed
    // from this wire chunk now instead of holding everything until end_turn.
    if (this.currentWireTurn?.kind === 'native') this.publishWireTurn(this.currentWireTurn);
  }

  private consumeWireLine(line: string): void {
    let record: any;
    try { record = JSON.parse(line); } catch { return; }

    if (record.type === 'turn.prompt') {
      if (this.rejectedPromptRecordsToSkip > 0) {
        this.rejectedPromptRecordsToSkip -= 1;
        return;
      }
      const attemptId = this.promptAttemptOrder.find((id) => !this.promptAttempts.get(id)?.recordSeen);
      const attempt = attemptId === undefined ? undefined : this.promptAttempts.get(attemptId);
      if (attempt) attempt.recordSeen = true;

      // A prompt written while a turn is active is the busy request itself and
      // cannot own a later turn. When idle, tentatively classify the next turn
      // as owned; finishPromptAttempt rolls this back if ACP rejects it.
      if (this.currentWireTurn) {
        return;
      }
      const owned: WireTurn = { id: '', kind: 'owned', lines: [], promptAttemptId: attemptId };
      if (attempt) attempt.previousPending = this.pendingWireTurn;
      this.pendingWireTurn = owned;
      return;
    }

    if (record.type === 'turn.steer') {
      // A steer joins an active turn (which ACP already streams when it is
      // Vibe-owned), or launches a native task/cron turn while idle.
      if (this.currentWireTurn) {
        if (this.currentWireTurn.kind === 'native') this.currentWireTurn.lines.push(line);
        return;
      }
      if (!this.pendingWireTurn || this.pendingWireTurn.kind !== 'native') {
        this.pendingWireTurn = { id: '', kind: 'native', lines: [line] };
      } else {
        this.pendingWireTurn.lines.push(line);
      }
      return;
    }

    const event = record.type === 'context.append_loop_event' ? record.event : undefined;
    if (event?.type === 'step.begin') {
      const turnId = String(event.turnId ?? '');
      if (!turnId) return;
      if (this.currentWireTurn?.id !== turnId) {
        if (this.currentWireTurn) this.finishWireTurn(this.currentWireTurn, false);
        const pending = this.pendingWireTurn;
        this.pendingWireTurn = undefined;
        this.currentWireTurn = {
          id: turnId,
          kind: pending?.kind ?? this.lastWireTurnKind,
          lines: pending?.kind === 'native' ? [...pending.lines, line] : [line],
          promptAttemptId: pending?.promptAttemptId,
        };
        if (this.currentWireTurn.kind === 'native') this.hooks.onNativeTurnStart?.(turnId);
        return;
      }
    }

    const current = this.currentWireTurn;
    if (current?.kind === 'native' || current?.promptAttemptId !== undefined) current.lines.push(line);

    if (record.type === 'turn.cancel') {
      const cancelledId = record.turnId == null ? undefined : String(record.turnId);
      if (current && (cancelledId === undefined || cancelledId === current.id)) {
        this.finishWireTurn(current, true, 'cancelled');
        this.currentWireTurn = undefined;
        this.pendingWireTurn = undefined;
      }
      return;
    }

    // The newer engine persists an explicit lifecycle record after step.end;
    // older Kimi versions only have the terminal step record handled below.
    if (record.type === 'turn.ended' && current && String(record.turnId ?? '') === current.id) {
      const status = String(record.status ?? '').toLowerCase();
      const outcome = status.includes('cancel') || status.includes('interrupt')
        ? 'cancelled'
        : 'completed';
      this.finishWireTurn(current, true, outcome);
      this.currentWireTurn = undefined;
      return;
    }

    if (event?.type === 'step.end' && current && String(event.turnId ?? '') === current.id) {
      // Tool-call finishes are intermediate steps (the spelling differs across
      // engine generations). Every other reason closes the main turn; normal
      // completion is `end_turn`.
      if (event.finishReason !== 'tool_use' && event.finishReason !== 'tool_calls') {
        this.finishWireTurn(current, true, 'completed');
        this.currentWireTurn = undefined;
      }
    }
  }

  /** Normalize a native wire turn with stable ids, then emit only blocks which
   *  are new or changed since the previous scan. */
  private publishWireTurn(turn: WireTurn): ChatBlock[] {
    if (turn.kind !== 'native') return [];
    const blocks = kimiWireBlocks(`${turn.lines.join('\n')}\n`).map((block) => {
      const id = `kimi_native_${turn.id}_${block.id}`;
      return block.kind === 'tool'
        ? { ...block, id, toolUseId: id }
        : { ...block, id };
    });
    const published = turn.publishedBlocks ?? new Map<string, string>();
    turn.publishedBlocks = published;
    const changed: ChatBlock[] = [];
    for (const block of blocks) {
      const signature = JSON.stringify(block);
      if (published.get(block.id) === signature) continue;
      published.set(block.id, signature);
      changed.push(block);
    }
    if (changed.length) this.hooks.onNativeTurnBlocks?.(turn.id, changed);
    return blocks;
  }

  private finishWireTurn(
    turn: WireTurn,
    observed: boolean,
    outcome: 'completed' | 'cancelled' | 'interrupted' = 'interrupted',
  ): void {
    this.lastWireTurnKind = turn.kind;
    if (observed) {
      this.endedWireTurns.add(turn.id);
      while (this.endedWireTurns.size > 128) {
        const oldest = this.endedWireTurns.values().next().value as string | undefined;
        if (oldest === undefined) break;
        this.endedWireTurns.delete(oldest);
      }
    }

    if (turn.kind === 'native') {
      const blocks = this.publishWireTurn(turn);
      this.hooks.onNativeTurnComplete?.(turn.id, blocks, outcome);
    }

    const waiters = this.turnWaiters.get(turn.id);
    if (waiters) {
      this.turnWaiters.delete(turn.id);
      for (const waiter of waiters) {
        if (waiter.timer) clearTimeout(waiter.timer);
        waiter.resolve(observed);
      }
    }
  }

  private removePromptAttempt(id: number): void {
    this.promptAttempts.delete(id);
    const index = this.promptAttemptOrder.indexOf(id);
    if (index >= 0) this.promptAttemptOrder.splice(index, 1);
  }

  private applySnapshot(snapshot: TaskSnapshot): void {
    let raw: KimiTaskFile;
    try { raw = JSON.parse(snapshot.rawText) as KimiTaskFile; } catch { return; }
    const id = typeof raw.taskId === 'string' && raw.taskId ? raw.taskId : snapshot.name;
    if (this.signatures.get(id) === snapshot.signature) return;
    this.signatures.set(id, snapshot.signature);
    this.native.set(id, raw);

    const status = mapStatus(raw.status);
    const isActive = status === 'pending' || status === 'running' || status === 'paused';
    const now = Date.now();
    const previous = this.normalized.get(id);
    const task: BackgroundTask = {
      id,
      agent: 'kimi',
      kind: raw.kind === 'process' ? 'command' : raw.kind === 'agent' || raw.kind === 'subagent' ? 'subagent' : 'other',
      status,
      description: typeof raw.description === 'string' && raw.description ? raw.description : `Task ${id}`,
      startedAt: parseTime(raw.startedAt) ?? previous?.startedAt ?? now,
      updatedAt: now,
      endedAt: parseTime(raw.endedAt),
      command: typeof raw.command === 'string' ? raw.command : undefined,
      detail: typeof raw.prompt === 'string' ? raw.prompt : undefined,
      cwd: typeof raw.cwd === 'string' ? raw.cwd : undefined,
      output: snapshot.output,
      outputFile: snapshot.outputFile,
      exitCode: raw.exitCode != null && Number.isFinite(Number(raw.exitCode)) ? Number(raw.exitCode) : undefined,
      processId: raw.pid != null && Number.isInteger(Number(raw.pid)) && Number(raw.pid) > 1 ? String(raw.pid) : undefined,
      canStop: isActive && raw.kind === 'process' && Number(raw.pid) > 1,
      error: typeof raw.error === 'string'
        ? raw.error
        : status === 'failed' && typeof raw.stopReason === 'string' ? raw.stopReason : undefined,
    };
    this.normalized.set(id, task);
    this.onTask(task);
  }
}
