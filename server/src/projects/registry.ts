import fs from 'node:fs';
import { log } from '../log.js';
import { config } from '../config.js';

/**
 * Project names for the sidebar's auto-derived project groups.
 *
 * A project is not a stored entity: it is implied by the pinned sessions that
 * share one (host, cwd) pair — the group (and its default `host · basename`
 * title) is derived client-side from the session list. Only one thing is worth
 * persisting: a user-chosen display name per project key. Hosts never contain
 * `::` and cwds keep their side of the first `::`, so the key round-trips.
 */

interface ProjectFile {
  names?: Record<string, string>;
}

export function projectKey(host: string | undefined, cwd: string): string {
  return `${host ?? ''}::${cwd}`;
}

export function parseProjectKey(key: string): { host?: string; cwd: string } {
  const i = key.indexOf('::');
  if (i < 0) return { cwd: key };
  return { host: key.slice(0, i) || undefined, cwd: key.slice(i + 2) };
}

function read(): ProjectFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(config.projectNamesFile, 'utf8')) as ProjectFile;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {}; /* first run */
  }
}

function write(file: ProjectFile): void {
  const tmp = `${config.projectNamesFile}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(file, null, 2));
  fs.renameSync(tmp, config.projectNamesFile);
}

/** All custom project names (project key → display name). */
export function loadProjectNames(): Record<string, string> {
  return read().names ?? {};
}

/** Set (or clear, with an empty name) one project's custom name. Returns the
 *  full map so the API can echo the new state. */
export function setProjectName(key: string, name: string): Record<string, string> {
  const file = read();
  const names = { ...(file.names ?? {}) };
  if (name.trim()) names[key] = name.trim();
  else delete names[key];
  try {
    write({ names });
  } catch (err) {
    log.warn('failed to persist project names', err);
    return file.names ?? {};
  }
  return names;
}
