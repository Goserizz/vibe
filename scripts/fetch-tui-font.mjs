/**
 * Download Sarasa Term SC Nerd (Regular) and split it into unicode-range
 * woff2 chunks for the TUI view. Skips when the CSS already exists.
 *
 * Source: https://github.com/laishulu/Sarasa-Term-SC-Nerd
 */
import { execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, rm, unlink, readFile, writeFile, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT_DIR = path.join(ROOT, 'web/public/fonts/sarasa-term-sc-nerd');
const CSS_PATH = path.join(OUT_DIR, 'result.css');
const RELEASE = 'https://github.com/laishulu/Sarasa-Term-SC-Nerd/releases/download/v2.3.1/SarasaTermSCNerd-Unhinted.ttf.tar.gz';
const TTF_NAME = 'SarasaTermSCNerd-Regular.ttf';
const LOCAL_SRC =
  'local("Sarasa Term SC Nerd"),local("SarasaTermSCNerd-Regular"),local("更纱终端书呆黑体-简")';

if (await exists(CSS_PATH)) {
  console.log('TUI font already present, skip');
  process.exit(0);
}

await mkdir(OUT_DIR, { recursive: true });
const work = path.join(tmpdir(), `vibe-sarasa-${process.pid}`);
await mkdir(work, { recursive: true });
const archive = path.join(work, 'font.tar.gz');
const ttf = path.join(work, TTF_NAME);

try {
  console.log('Downloading Sarasa Term SC Nerd…');
  const res = await fetch(RELEASE);
  if (!res.ok || !res.body) throw new Error(`download failed: ${res.status}`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(archive));
  execFileSync('tar', ['-xzf', archive, '-C', work, TTF_NAME], { stdio: 'inherit' });

  console.log('Splitting webfonts…');
  execFileSync(
    'npx',
    [
      '--yes',
      'cn-font-split',
      'run',
      '-i',
      ttf,
      '-o',
      OUT_DIR,
      '--css.fontFamily',
      'Sarasa Term SC Nerd',
      '--css.fontWeight',
      '400',
      '--css.fontDisplay',
      'swap',
      '--css.fileName',
      'result.css',
      '--css.commentNameTable',
      'false',
      '--css.commentUnicodes',
      'false',
      '--testHtml',
      'false',
      '-r',
      'false',
    ],
    { stdio: 'inherit', cwd: ROOT },
  );

  let css = await readFile(CSS_PATH, 'utf8');
  const marker = 'local("Sarasa Term SC Nerd")';
  if (!css.includes(marker)) throw new Error('split CSS missing local() marker');
  css = css.replaceAll(marker, LOCAL_SRC);
  await writeFile(CSS_PATH, css);
  await unlink(path.join(OUT_DIR, 'index.proto')).catch(() => {});
} catch (err) {
  await rm(OUT_DIR, { recursive: true, force: true });
  throw err;
} finally {
  await rm(work, { recursive: true, force: true });
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}
