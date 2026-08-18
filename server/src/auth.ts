import type { Request, Response, NextFunction } from 'express';
import { accountManager, type AccountRef } from './accounts.js';
import { ADMIN_ACCOUNT } from '../../shared/protocol.js';

declare module 'express-serve-static-core' {
  interface Request {
    /** Account resolved from the presented token; set by requireAuth. */
    vibeAccount?: AccountRef;
  }
}

/** Resolve which account a token belongs to (admin token or a per-account
 *  token from ~/.vibe/accounts.json). Constant-time comparisons throughout. */
export function resolveAccountByToken(token: string | undefined | null): AccountRef | undefined {
  return accountManager.resolveToken(token);
}

export function extractToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const x = req.header('x-vibe-token');
  if (x) return x.trim();
  const q = req.query.token;
  if (typeof q === 'string') return q;
  return undefined;
}

/** The account a request acts as. Always valid inside requireAuth'd routes. */
export function accountOf(req: Request): AccountRef {
  return req.vibeAccount ?? { name: ADMIN_ACCOUNT, isAdmin: true };
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  const account = resolveAccountByToken(extractToken(req));
  if (account) {
    req.vibeAccount = account;
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}

/** Route guard for admin-only endpoints (account management, Vibot). */
export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  if (accountOf(req).isAdmin) {
    next();
    return;
  }
  res.status(403).json({ error: 'admin only' });
}
