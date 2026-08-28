import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';

/**
 * Bundle the LOCAL ZCode CLI to install it on remote hosts over SSH (a ~9MB
 * tar.gz vs the ~200MB CDN AppImage). The desktop-only payload (the Electron
 * binary and app.asar — ~480MB) is not needed headless: a CLI install is
 * complete with just resources/{glm,tools,model-providers,config} plus a
 * wrapper script (verified end-to-end against GLM on zcode 0.16.3).
 */

/** Resource dirs under <app>/resources that make up the CLI. */
const BUNDLE_PARTS = ['glm', 'tools', 'model-providers', 'config'] as const;

const BUNDLE_FILE = 'zcode-bundle.tar.gz';
const MARKER_FILE = 'zcode-bundle.marker';

/**
 * Locate the local ZCode app root by parsing the wrapper script (it names the
 * exact zcode.cjs path). Falls back to the documented install location.
 */
export function findZcodeAppRoot(): string | null {
  const bin = config.zcodeExecutable;
  if (bin) {
    try {
      const wrapper = fs.readFileSync(bin, 'utf8');
      const hit = wrapper.match(/(\S+)\/resources\/glm\/zcode\.cjs/);
      if (hit) {
        const root = path.dirname(path.dirname(path.dirname(hit[1]!)));
        if (fs.existsSync(path.join(root, 'resources', 'glm', 'zcode.cjs'))) return root;
      }
    } catch {
      /* wrapper unreadable — fall through */
    }
  }
  const fallback = '/opt/zcode-app';
  return fs.existsSync(path.join(fallback, 'resources', 'glm', 'zcode.cjs')) ? fallback : null;
}

function bundleFingerprint(root: string): string | null {
  try {
    const st = fs.statSync(path.join(root, 'resources', 'glm', 'zcode.cjs'));
    return `${st.size}:${Math.floor(st.mtimeMs)}`;
  } catch {
    return null;
  }
}

/** Local zcode CLI version (briefly cached; only used for install logs). */
let versionCache: { at: number; value?: string } | null = null;
export function invalidateLocalZcodeVersion(): void {
  versionCache = null;
}
export function localZcodeVersion(): string | undefined {
  if (!config.zcodeExecutable) return undefined;
  if (versionCache && Date.now() - versionCache.at < 60_000) return versionCache.value;
  let value: string | undefined;
  try {
    value = execFileSync(config.zcodeExecutable, ['--version'], { timeout: 15_000, encoding: 'utf8' })
      .split('\n')[0]?.trim() || undefined;
  } catch {
    value = undefined;
  }
  versionCache = { at: Date.now(), value };
  return value;
}

export interface ZcodeBundle {
  /** Absolute path of the cached tar.gz. */
  file: string;
  /** Fingerprint of the zcode.cjs it was built from. */
  fingerprint: string;
  /** Local CLI version, when known. */
  version?: string;
}

/**
 * Build (or reuse a cached) CLI bundle tar.gz. The archive's entries are the
 * resource dir names (glm/, tools/, …), so the remote side extracts it
 * directly into <app>/resources/. Synchronous by design: it runs once per
 * install click, blocks ~2s on tar, and keeps the caller simple.
 */
export function buildZcodeBundle(): ZcodeBundle | null {
  const root = findZcodeAppRoot();
  if (!root) return null;
  const fingerprint = bundleFingerprint(root);
  if (!fingerprint) return null;

  const file = path.join(config.home, BUNDLE_FILE);
  const marker = path.join(config.home, MARKER_FILE);
  let cached: string | undefined;
  try {
    cached = fs.readFileSync(marker, 'utf8').trim();
  } catch {
    /* no marker yet */
  }
  if (cached === fingerprint && fs.existsSync(file) && fs.statSync(file).size > 0) {
    return { file, fingerprint, version: localZcodeVersion() };
  }

  const resourcesDir = path.join(root, 'resources');
  const parts = BUNDLE_PARTS.filter((part) => fs.existsSync(path.join(resourcesDir, part)));
  if (!parts.includes('glm')) return null;

  fs.rmSync(file, { force: true });
  try {
    execFileSync('tar', ['-czf', file, ...parts], { cwd: resourcesDir, timeout: 120_000, stdio: ['ignore', 'ignore', 'pipe'] });
    fs.writeFileSync(marker, fingerprint, { mode: 0o600 });
    log.info(`zcode bundle built: ${file} (${parts.join(', ')})`);
    return { file, fingerprint, version: localZcodeVersion() };
  } catch (error) {
    log.warn('zcode bundle build failed', error);
    fs.rmSync(file, { force: true });
    return null;
  }
}
