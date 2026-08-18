import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Discover the latest ZCode desktop release on the CDN. There is no update
 * feed (the desktop app gets one at login) and no directory listing, but the
 * CDN answers HEAD requests — so walk the version neighborhood around the
 * last version we saw: patch by patch up to a bounded horizon, then a few
 * minor/major bumps. The anchor persists in ~/.vibe so each day's probe
 * starts where the last one confirmed.
 */

const CDN_BASE = 'https://cdn-zcode.z.ai/zcode/electron/releases';
const ANCHOR_FILE = 'zcode-cdn-anchor';
/** Fallback for a machine that never recorded an anchor (3.7.7 is the
 *  release the documented install procedure shipped). */
const DEFAULT_ANCHOR = '3.7.7';
const TTL_MS = 15 * 60_000;
const PATCH_HORIZON = 15;
const MINOR_HORIZON = 4;

let cache: { at: number; value?: string } | null = null;

function anchorPath(): string {
  return path.join(config.home, ANCHOR_FILE);
}

function readAnchor(): string {
  try {
    const v = fs.readFileSync(anchorPath(), 'utf8').trim();
    if (/^\d+\.\d+\.\d+$/.test(v)) return v;
  } catch {
    /* not recorded yet */
  }
  return DEFAULT_ANCHOR;
}

function writeAnchor(version: string): void {
  try {
    fs.writeFileSync(anchorPath(), version, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

function parseVersion(v: string): [number, number, number] {
  const [major = 0, minor = 0, patch = 0] = v.split('.').map((n) => Number.parseInt(n, 10) || 0);
  return [major, minor, patch];
}

function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  for (let i = 0; i < 3; i++) {
    if (pa[i]! < pb[i]!) return -1;
    if (pa[i]! > pb[i]!) return 1;
  }
  return 0;
}

/** Candidate versions worth probing above the anchor. */
function candidatesAbove(anchor: string): string[] {
  const [major, minor] = parseVersion(anchor);
  const out: string[] = [];
  for (let patch = 1; patch <= PATCH_HORIZON; patch++) {
    out.push(`${major}.${minor}.${(parseVersion(anchor)[2] ?? 0) + patch}`);
  }
  for (let bump = 1; bump <= MINOR_HORIZON; bump++) {
    out.push(`${major}.${minor + bump}.0`);
  }
  out.push(`${major + 1}.0.0`);
  return out;
}

async function existsOnCdn(version: string): Promise<boolean> {
  const url = `${CDN_BASE}/${version}/linux-x64/ZCode-${version}-linux-x64.AppImage`;
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10_000);
    const res = await fetch(url, { method: 'HEAD', signal: ctrl.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    return false;
  }
}

/**
 * Latest desktop release visible on the CDN (cached 15 min). Returns the
 * anchor itself when nothing newer exists, undefined when even the anchor
 * could not be confirmed (network trouble) — callers treat that as "unknown".
 */
export async function fetchZcodeCdnLatest(): Promise<string | undefined> {
  if (cache && Date.now() - cache.at < TTL_MS) return cache.value;
  const anchor = readAnchor();
  const candidates = candidatesAbove(anchor);
  const answers = await Promise.all(candidates.map((v) => existsOnCdn(v)));
  const existing = candidates.filter((_, i) => answers[i]);
  let latest: string;
  if (!existing.length) {
    // Nothing above the anchor — confirm the anchor itself still exists so
    // "unknown" (CDN unreachable) is distinguishable from "current".
    const anchorOk = await existsOnCdn(anchor);
    latest = anchorOk ? anchor : '';
  } else {
    latest = existing.reduce((a, b) => (compareVersions(a, b) >= 0 ? a : b));
    writeAnchor(latest);
  }
  const value = latest || undefined;
  cache = { at: Date.now(), value };
  if (!value) log.debug('zcode cdn: could not confirm any release (network?)');
  return value;
}

// Exported for tests / manual probing.
export const __internals = { candidatesAbove, compareVersions, readAnchor, writeAnchor };
