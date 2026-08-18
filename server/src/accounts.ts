import fs from 'node:fs';
import crypto from 'node:crypto';
import { config } from './config.js';
import { log } from './log.js';
import { ADMIN_ACCOUNT } from '../../shared/protocol.js';

/** Identity resolved from a valid token. */
export interface AccountRef {
  name: string;
  isAdmin: boolean;
}

interface StoredAccount {
  name: string;
  /** `scrypt(password, salt)` hex; absent for token-only accounts. */
  passwordHash?: string;
  salt?: string;
  /** Per-account access token (Bearer / ?token=). Never the admin token. */
  token: string;
  createdAt: number;
}

interface PersistShape {
  /** Non-admin accounts only. */
  accounts: StoredAccount[];
  /** Optional password for the virtual admin account (token stays external). */
  adminPasswordHash?: string;
  adminSalt?: string;
}

export class AccountError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export const ACCOUNT_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,31}$/;

/** Constant-time string compare (length-safe). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** Login throttling: per-account failure counter with a cool-down. */
const MAX_LOGIN_FAILURES = 5;
const LOCK_MS = 60_000;
const loginFailures = new Map<string, { count: number; lockedUntil: number }>();

function checkLoginThrottle(name: string): void {
  const entry = loginFailures.get(name);
  if (entry && entry.lockedUntil > Date.now()) {
    const secs = Math.ceil((entry.lockedUntil - Date.now()) / 1000);
    throw new AccountError(`too many failed attempts — try again in ${secs}s`, 429);
  }
}

function recordLoginFailure(name: string): void {
  const entry = loginFailures.get(name) ?? { count: 0, lockedUntil: 0 };
  entry.count += 1;
  if (entry.count >= MAX_LOGIN_FAILURES) {
    entry.count = 0;
    entry.lockedUntil = Date.now() + LOCK_MS;
  }
  loginFailures.set(name, entry);
}

function clearLoginFailures(name: string): void {
  loginFailures.delete(name);
}

/**
 * Multi-account registry persisted to ~/.vibe/accounts.json (0600). The admin
 * account is virtual — its token is always `config.token` — and has superuser
 * visibility; every other account only sees hosts and sessions it owns.
 */
class AccountManager {
  private accounts = new Map<string, StoredAccount>();
  private adminPasswordHash?: string;
  private adminSalt?: string;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const parsed = JSON.parse(fs.readFileSync(config.accountsFile, 'utf8')) as PersistShape;
      for (const a of parsed.accounts ?? []) {
        if (a?.name && a?.token && a.name !== ADMIN_ACCOUNT) this.accounts.set(a.name, a);
      }
      this.adminPasswordHash = parsed.adminPasswordHash;
      this.adminSalt = parsed.adminSalt;
    } catch {
      /* first run — no accounts yet */
    }
  }

  private save(): void {
    const tmp = `${config.accountsFile}.tmp`;
    const payload: PersistShape = {
      accounts: [...this.accounts.values()],
      adminPasswordHash: this.adminPasswordHash,
      adminSalt: this.adminSalt,
    };
    try {
      fs.writeFileSync(tmp, JSON.stringify(payload, null, 2), { mode: 0o600 });
      fs.renameSync(tmp, config.accountsFile);
    } catch (err) {
      log.error('failed to persist accounts', err);
    }
  }

  /** Which account (if any) a presented token belongs to. */
  resolveToken(token: string | undefined | null): AccountRef | undefined {
    if (!token) return undefined;
    if (safeEqual(token, config.token)) return { name: ADMIN_ACCOUNT, isAdmin: true };
    for (const a of this.accounts.values()) {
      if (safeEqual(token, a.token)) return { name: a.name, isAdmin: false };
    }
    return undefined;
  }

  /** Password login (rate-limited). Admin is allowed once it has a password set. */
  verifyLogin(name: string, password: string): AccountRef {
    const key = name.trim().toLowerCase() === ADMIN_ACCOUNT ? ADMIN_ACCOUNT : name.trim();
    checkLoginThrottle(key);
    if (key === ADMIN_ACCOUNT) {
      if (!this.adminPasswordHash || !this.adminSalt || !this.passwordMatches(this.adminPasswordHash, this.adminSalt, password)) {
        recordLoginFailure(key);
        throw new AccountError('invalid name or password', 401);
      }
      clearLoginFailures(key);
      return { name: ADMIN_ACCOUNT, isAdmin: true };
    }
    const account = this.accounts.get(key);
    if (!account?.passwordHash || !account.salt || !this.passwordMatches(account.passwordHash, account.salt, password)) {
      recordLoginFailure(key);
      throw new AccountError('invalid name or password', 401);
    }
    clearLoginFailures(key);
    return { name: account.name, isAdmin: false };
  }

  /** Token for a freshly logged-in account (admin: the server token). */
  tokenFor(name: string): string {
    if (name === ADMIN_ACCOUNT) return config.token;
    const account = this.accounts.get(name);
    if (!account) throw new AccountError('account not found', 404);
    return account.token;
  }

  private passwordMatches(hash: string, salt: string, password: string): boolean {
    return safeEqual(hashPassword(password, salt), hash);
  }

  list(): { name: string; createdAt: number; hasPassword: boolean }[] {
    return [...this.accounts.values()]
      .map((a) => ({ name: a.name, createdAt: a.createdAt, hasPassword: Boolean(a.passwordHash) }))
      .sort((a, b) => a.createdAt - b.createdAt);
  }

  exists(name: string): boolean {
    return this.accounts.has(name);
  }

  /** Create an account; returns its one-time token. */
  create(name: string, password: string): { name: string; token: string } {
    const clean = name.trim();
    if (clean === ADMIN_ACCOUNT) throw new AccountError("'admin' is reserved", 400);
    if (!ACCOUNT_NAME_RE.test(clean)) throw new AccountError('name must match [A-Za-z0-9][A-Za-z0-9_-]{0,31}', 400);
    if (this.accounts.has(clean)) throw new AccountError('account already exists', 409);
    if (password.length < 6) throw new AccountError('password must be at least 6 characters', 400);
    const salt = crypto.randomBytes(16).toString('hex');
    const account: StoredAccount = {
      name: clean,
      salt,
      passwordHash: hashPassword(password, salt),
      token: crypto.randomBytes(18).toString('base64url'),
      createdAt: Date.now(),
    };
    this.accounts.set(clean, account);
    this.save();
    return { name: clean, token: account.token };
  }

  /** Set or replace a password (the admin's own account supported too — only
   *  the hash is stored, its token always comes from config). */
  setPassword(name: string, password: string): void {
    const clean = name.trim();
    if (password.length < 6) throw new AccountError('password must be at least 6 characters', 400);
    if (clean === ADMIN_ACCOUNT) {
      this.adminSalt = crypto.randomBytes(16).toString('hex');
      this.adminPasswordHash = hashPassword(password, this.adminSalt);
      this.save();
      return;
    }
    const account = this.accounts.get(clean);
    if (!account) throw new AccountError('account not found', 404);
    account.salt = crypto.randomBytes(16).toString('hex');
    account.passwordHash = hashPassword(password, account.salt);
    this.save();
  }

  /** Issue a fresh token (old one stops working immediately). */
  resetToken(name: string): { name: string; token: string } {
    const clean = name.trim();
    if (clean === ADMIN_ACCOUNT) throw new AccountError('the admin token is the server token — rotate it via VIBE_TOKEN', 400);
    const account = this.accounts.get(clean);
    if (!account) throw new AccountError('account not found', 404);
    account.token = crypto.randomBytes(18).toString('base64url');
    this.save();
    return { name: clean, token: account.token };
  }

  remove(name: string): void {
    const clean = name.trim();
    if (clean === ADMIN_ACCOUNT) throw new AccountError('cannot delete the admin account', 400);
    if (!this.accounts.delete(clean)) throw new AccountError('account not found', 404);
    loginFailures.delete(clean);
    this.save();
  }
}

export const accountManager = new AccountManager();
