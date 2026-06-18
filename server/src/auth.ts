import type { Request, Response, NextFunction } from 'express';
import crypto from 'node:crypto';
import { config } from './config.js';

/** Constant-time token comparison to avoid timing leaks. */
export function tokenMatches(provided: string | undefined | null): boolean {
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(config.token);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function extractToken(req: Request): string | undefined {
  const header = req.header('authorization');
  if (header?.startsWith('Bearer ')) return header.slice(7).trim();
  const x = req.header('x-vibe-token');
  if (x) return x.trim();
  const q = req.query.token;
  if (typeof q === 'string') return q;
  return undefined;
}

export function requireAuth(req: Request, res: Response, next: NextFunction): void {
  if (tokenMatches(extractToken(req))) {
    next();
    return;
  }
  res.status(401).json({ error: 'unauthorized' });
}
