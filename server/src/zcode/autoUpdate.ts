import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../config.js';
import { log } from '../log.js';
import { fetchZcodeCdnLatest } from './cdn.js';
import { invalidateLocalZcodeVersion } from './bundle.js';

/**
 * Keep the LOCAL ZCode CLI current — in the push-install model the local
 * machine is the fleet's source of truth, so if it never updates neither do
 * the remote hosts. ZCode publishes no update feed (the desktop app receives
 * one at login), so `cdn.ts` discovers new releases by probing the CDN around
 * the last version we saw; this job checks daily and swaps /opt/zcode-app
 * only after the downloaded copy proves it can run.
 *
 * Disable with VIBE_ZCODE_AUTO_UPDATE=0.
 */

const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const FIRST_CHECK_DELAY_MS = 2 * 60_000;

const INSTALLED_FILE = 'zcode-installed-desktop';
const APP_ROOT = '/opt/zcode-app';
const NODE_FOR_VERIFY = '/opt/node/bin/node';

let timer: ReturnType<typeof setTimeout> | null = null;
let stopped = false;
let running = false;

function stateFile(name: string): string {
  return path.join(config.home, name);
}

function readInstalledDesktop(): string | undefined {
  try {
    return fs.readFileSync(stateFile(INSTALLED_FILE), 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
}

function writeInstalledDesktop(version: string): void {
  try {
    fs.writeFileSync(stateFile(INSTALLED_FILE), version, { mode: 0o600 });
  } catch {
    /* best effort */
  }
}

/** True while any zcode CLI process is running (lazy-loaded files under
 *  /opt/zcode-app would break under a swap). */
function zcodeBusy(): boolean {
  try {
    const out = execFileSyncText('pgrep', ['-f', 'resources/glm/zcode.cjs']);
    return out.trim().length > 0;
  } catch {
    // pgrep exits 1 when nothing matched — that is the "idle" answer.
    return false;
  }
}

function execFileSyncText(bin: string, args: string[]): string {
  return execFileSync(bin, args, { encoding: 'utf8', timeout: 10_000 });
}

function download(url: string, outFile: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn('curl', ['-fsSL', '--max-time', '600', '-o', outFile, url], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 620_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`curl exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

function extractAppImage(appImage: string, outDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(appImage, ['--appimage-extract'], { cwd: outDir, stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d: Buffer) => (stderr += d.toString()));
    const timer = setTimeout(() => child.kill('SIGKILL'), 180_000);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`appimage-extract exited ${code}: ${stderr.slice(0, 200)}`));
    });
  });
}

function cliVersionOf(root: string): string | undefined {
  const cjs = path.join(root, 'resources', 'glm', 'zcode.cjs');
  if (!fs.existsSync(cjs)) return undefined;
  const node = fs.existsSync(NODE_FOR_VERIFY) ? NODE_FOR_VERIFY : 'node';
  try {
    const out = execFileSyncText(node, [cjs, '--version']);
    return out.split('\n')[0]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

/** Download + verify + swap in a new desktop release. Never touches the old
 *  tree unless the replacement is proven runnable. */
export async function installZcodeRelease(version: string): Promise<{ cliVersion?: string }> {
  const work = `/tmp/vibe-zcode-update-${version}`;
  const appImage = path.join(work, 'ZCode.AppImage');
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  try {
    const url = `https://cdn-zcode.z.ai/zcode/electron/releases/${version}/linux-x64/ZCode-${version}-linux-x64.AppImage`;
    log.info(`zcode auto-update: downloading ${version} (linux-x64 AppImage)…`);
    await download(url, appImage);
    fs.chmodSync(appImage, 0o755);
    await extractAppImage(appImage, work);
    const extracted = path.join(work, 'squashfs-root');
    const cliVersion = cliVersionOf(extracted);
    if (!cliVersion) throw new Error('extracted CLI failed verification (zcode.cjs --version)');
    fs.rmSync(path.join(extracted, 'AppRun'), { force: true });

    fs.rmSync(APP_ROOT, { recursive: true, force: true });
    fs.renameSync(extracted, APP_ROOT);
    writeInstalledDesktop(version);
    invalidateLocalZcodeVersion();
    log.ok(`zcode auto-update: installed desktop ${version} (CLI ${cliVersion}) at ${APP_ROOT}`);
    return { cliVersion };
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
}

async function checkOnce(): Promise<void> {
  if (!config.zcodeExecutable) return;
  const installed = readInstalledDesktop();
  const latest = await fetchZcodeCdnLatest();
  if (!latest) {
    log.debug('zcode auto-update: could not resolve the latest CDN release');
    return;
  }
  if (!installed) {
    // First run on a machine whose zcode was installed outside Vibe: record
    // whatever the CDN currently ships as the baseline and touch nothing.
    writeInstalledDesktop(latest);
    log.info(`zcode auto-update: baseline recorded (${latest}); future releases will auto-install`);
    return;
  }
  if (latest === installed) return;
  if (zcodeBusy()) {
    log.info(`zcode auto-update: ${latest} available, deferring — a zcode session is running`);
    return;
  }
  await installZcodeRelease(latest);
}

function schedule(delayMs: number): void {
  if (stopped) return;
  timer = setTimeout(() => {
    timer = null;
    running = true;
    void checkOnce()
      .catch((err) => log.warn('zcode auto-update check failed', err))
      .finally(() => {
        running = false;
        schedule(CHECK_INTERVAL_MS);
      });
  }, delayMs);
  timer.unref?.();
}

export function scheduleZcodeAutoUpdate(): void {
  if (process.env.VIBE_ZCODE_AUTO_UPDATE === '0') {
    log.info('zcode auto-update: disabled (VIBE_ZCODE_AUTO_UPDATE=0)');
    return;
  }
  schedule(FIRST_CHECK_DELAY_MS);
  log.info('zcode auto-update: daily check scheduled');
}

export function stopZcodeAutoUpdate(): void {
  stopped = true;
  if (timer) clearTimeout(timer);
  timer = null;
  void running;
}
