import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import type { AgentKind, EffortLevel, PermissionMode } from '../../../shared/protocol.js';

/** Last successful /new choices (reused as the next form defaults). */
export interface LastNewPrefs {
  /** '' = local; otherwise a remote host name. */
  host?: string;
  agent?: AgentKind;
  model?: string;
  permissionMode?: PermissionMode;
  effort?: EffortLevel;
  cwd?: string;
}

export interface ChatState {
  /** Active Vibe session id for this Telegram chat. */
  sessionId?: string;
  /** Pending multi-step /new wizard fields. */
  draft?: {
    /** Current wizard step. */
    step?: 'form' | 'cwd' | 'title' | 'model_custom';
    /** '' or undefined = local machine; otherwise a registered host name. */
    host?: string;
    agent?: AgentKind;
    model?: string;
    permissionMode?: PermissionMode;
    effort?: EffortLevel;
    cwd?: string;
    title?: string;
    /** Skip the directory picker: create a throwaway folder (see workdirs base). */
    autoCwd?: boolean;
    /** Form message id (for edits). */
    messageId?: number;
  };
  /** Preferences from the last created session (not title). */
  lastNew?: LastNewPrefs;
}

interface PersistShape {
  chats: Record<string, ChatState>;
}

const stateFile = path.join(config.home, 'telegram.json');

class TelegramState {
  private chats = new Map<string, ChatState>();
  private writeTimer: NodeJS.Timeout | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = fs.readFileSync(stateFile, 'utf8');
      const parsed = JSON.parse(raw) as PersistShape;
      for (const [id, st] of Object.entries(parsed.chats ?? {})) {
        this.chats.set(id, st);
      }
    } catch {
      // first run
    }
  }

  private scheduleWrite(): void {
    if (this.writeTimer) return;
    this.writeTimer = setTimeout(() => {
      this.writeTimer = null;
      const payload: PersistShape = { chats: Object.fromEntries(this.chats) };
      const tmp = `${stateFile}.tmp`;
      try {
        fs.writeFileSync(tmp, JSON.stringify(payload, null, 2));
        fs.renameSync(tmp, stateFile);
      } catch (err) {
        log.error('failed to persist telegram state', err);
      }
    }, 250);
  }

  /** Known chat ids (from persisted telegram.json). */
  chatIds(): number[] {
    return [...this.chats.keys()].map((k) => Number(k)).filter((n) => Number.isFinite(n));
  }

  get(chatId: number | string): ChatState {
    const key = String(chatId);
    let st = this.chats.get(key);
    if (!st) {
      st = {};
      this.chats.set(key, st);
    }
    return st;
  }

  setSession(chatId: number | string, sessionId: string | undefined): void {
    const st = this.get(chatId);
    st.sessionId = sessionId;
    this.scheduleWrite();
  }

  setDraft(chatId: number | string, draft: ChatState['draft'] | undefined): void {
    const st = this.get(chatId);
    st.draft = draft;
    this.scheduleWrite();
  }

  setLastNew(chatId: number | string, prefs: LastNewPrefs | undefined): void {
    const st = this.get(chatId);
    st.lastNew = prefs;
    this.scheduleWrite();
  }
}

export const telegramState = new TelegramState();
