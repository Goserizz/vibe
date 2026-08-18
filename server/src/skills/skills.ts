import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { hostRegistry } from '../remote/hosts.js';
import { sshExec, loginShellCommand, shQuote, type SshResult } from '../remote/ssh.js';
import { buildSkillFile, parseSkill, serializeSkill } from './frontmatter.js';
import type { AgentKind, SkillDetail, SkillEntry, SkillScope } from '../../../shared/protocol.js';

/** Allowed skill (directory) name: alphanumeric start, then word/dash/dot. */
export const SKILL_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
export function validateSkillName(name: string): boolean {
  return SKILL_NAME_RE.test(name);
}

/**
 * Per-agent skill layout. All six agents share the Agent Skills standard
 * (`<name>/SKILL.md` + YAML frontmatter); they differ only in directory.
 *  - `personalRel` is the remote path (`~` left bare so the remote login shell
 *    expands it; never interpolates user input).
 *  - `personalLocal` is the absolute local equivalent.
 *  - `system` are read-only scan roots: `flat` = immediate subdirs each holding
 *    a SKILL.md; `marketplace` = a recursive tree where `skills/<name>/SKILL.md`
 *    sits at arbitrary depth (Claude's plugin marketplaces).
 */
interface SystemScan {
  rel: string;
  local: () => string;
  mode: 'flat' | 'marketplace';
}
interface AgentSkills {
  personalRel: string;
  personalLocal: () => string;
  system: SystemScan[];
}

const home = () => os.homedir();
const AGENT_SKILLS: Record<AgentKind, AgentSkills> = {
  claude: {
    personalRel: '~/.claude/skills',
    personalLocal: () => path.join(home(), '.claude', 'skills'),
    system: [{ rel: '~/.claude/plugins/marketplaces', local: () => path.join(home(), '.claude', 'plugins', 'marketplaces'), mode: 'marketplace' }],
  },
  cursor: {
    personalRel: '~/.cursor/skills',
    personalLocal: () => path.join(home(), '.cursor', 'skills'),
    // Cursor's own built-in skills live here (its docs say never author here).
    system: [{ rel: '~/.cursor/skills-cursor', local: () => path.join(home(), '.cursor', 'skills-cursor'), mode: 'flat' }],
  },
  codex: {
    personalRel: '~/.codex/skills',
    personalLocal: () => path.join(home(), '.codex', 'skills'),
    // Codex's system skills; `.system` is excluded from the personal listing.
    system: [{ rel: '~/.codex/skills/.system', local: () => path.join(home(), '.codex', 'skills', '.system'), mode: 'flat' }],
  },
  kimi: {
    personalRel: '~/.kimi-code/skills',
    personalLocal: () => path.join(home(), '.kimi-code', 'skills'),
    // Kimi also reads ~/.claude/skills + ~/.codex/skills at runtime, but those
    // are surfaced under their own agents — no extra read-only scan here.
    system: [],
  },
  kiro: {
    personalRel: '~/.kiro/skills',
    personalLocal: () => path.join(home(), '.kiro', 'skills'),
    system: [],
  },
  grok: {
    personalRel: '~/.grok/skills',
    personalLocal: () => path.join(home(), '.grok', 'skills'),
    system: [],
  },
  zcode: {
    // ZCode reads user skills from the shared ~/.agents/skills dir (verified
    // via `zcode skills list`); plugin skills live under its own cache.
    personalRel: '~/.agents/skills',
    personalLocal: () => path.join(home(), '.agents', 'skills'),
    system: [],
  },
};

/** host name → SSH target (mirrors api.ts's private resolveFileTarget). */
function resolveTarget(host?: string): { remote: boolean; target: string } {
  if (!host) return { remote: false, target: '' };
  const h = hostRegistry.get(host);
  return { remote: true, target: h?.ssh ?? host };
}

/** Run a command on a remote host inside a login shell; throw on timeout. */
async function run(target: string, inner: string, opts: { input?: string; timeoutMs?: number } = {}): Promise<SshResult> {
  const r = await sshExec(target, loginShellCommand(inner), opts);
  if (r.timedOut) throw new Error('remote operation timed out');
  return r;
}

function sortSkills(entries: SkillEntry[]): SkillEntry[] {
  return entries.sort((a, b) => {
    if (a.scope !== b.scope) return a.scope === 'personal' ? -1 : 1;
    return a.name.localeCompare(b.name);
  });
}

/** Parse `ls -1Ap` output (dirs end with `/`) into names, dropping dotfiles. */
function dirsFromLs(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const name = line.trim();
    if (name.endsWith('/') && !name.startsWith('.')) out.push(name.slice(0, -1));
  }
  return out;
}

/** Recursively collect marketplace skills by keying off `skills/<name>/SKILL.md`. */
function walkMarketplace(root: string, agent: AgentKind, acc: SkillEntry[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue; // symlinks report as non-directories → not followed
    const sub = path.join(root, e.name);
    if (e.name === 'skills') {
      let skillDirs: fs.Dirent[];
      try {
        skillDirs = fs.readdirSync(sub, { withFileTypes: true });
      } catch {
        skillDirs = [];
      }
      for (const sd of skillDirs) {
        if (!sd.isDirectory()) continue;
        const file = path.join(sub, sd.name, 'SKILL.md');
        if (fs.existsSync(file)) acc.push({ name: sd.name, scope: 'system', agent, source: file });
      }
    } else {
      walkMarketplace(sub, agent, acc);
    }
  }
}

/** Local listing of immediate subdirs that contain a SKILL.md. */
function listFlatLocal(root: string, agent: AgentKind, scope: SkillScope): SkillEntry[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  const out: SkillEntry[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const file = path.join(root, e.name, 'SKILL.md');
    if (fs.existsSync(file)) out.push({ name: e.name, scope, agent, source: file });
  }
  return out;
}

/**
 * List personal + system skills for an agent on this machine or a remote host.
 * Returns only `{name, scope, agent, source?}` — descriptions/bodies load via
 * readSkill() on open, so this is O(1) ssh round-trips per location.
 */
export async function listSkills(args: { agent: AgentKind; host?: string }): Promise<SkillEntry[]> {
  const { agent, host } = args;
  const cfg = AGENT_SKILLS[agent];
  const { remote, target } = resolveTarget(host);

  if (!remote) {
    const entries: SkillEntry[] = [];
    // personal — flat, excluding dotfiles (e.g. Codex's `.system`)
    try {
      for (const d of fs.readdirSync(cfg.personalLocal(), { withFileTypes: true })) {
        if (d.isDirectory() && !d.name.startsWith('.')) entries.push({ name: d.name, scope: 'personal', agent });
      }
    } catch {
      /* personal dir absent → no personal skills yet */
    }
    for (const s of cfg.system) {
      if (s.mode === 'flat') entries.push(...listFlatLocal(s.local(), agent, 'system'));
      else walkMarketplace(s.local(), agent, entries);
    }
    return sortSkills(entries);
  }

  // Remote: one parallel probe per location. `|| true` keeps a missing dir empty.
  const probes: Promise<SshResult>[] = [run(target, `ls -1Ap ${cfg.personalRel}/ 2>/dev/null || true`, { timeoutMs: 15_000 })];
  for (const s of cfg.system) {
    if (s.mode === 'flat') probes.push(run(target, `ls -1Ap ${s.rel}/ 2>/dev/null || true`, { timeoutMs: 15_000 }));
    else probes.push(run(target, `find ${s.rel} -type f -name SKILL.md 2>/dev/null || true`, { timeoutMs: 20_000 }));
  }
  const results = await Promise.all(probes);

  const entries: SkillEntry[] = [];
  // personal (first result)
  for (const name of dirsFromLs(results[0].stdout)) entries.push({ name, scope: 'personal', agent });
  // system scans
  cfg.system.forEach((s, i) => {
    const res = results[i + 1];
    if (s.mode === 'flat') {
      for (const name of dirsFromLs(res.stdout)) entries.push({ name, scope: 'system', agent, source: `${s.rel}/${name}/SKILL.md` });
    } else {
      for (const line of res.stdout.split('\n')) {
        const p = line.trim();
        if (p) entries.push({ name: path.basename(path.dirname(p)), scope: 'system', agent, source: p });
      }
    }
  });
  return sortSkills(entries);
}

/** Validate a system `source` path against the agent's scan roots. */
function assertSystemSource(agent: AgentKind, source: string | undefined, remote: boolean): void {
  if (!source || !source.endsWith('/SKILL.md') || source.includes('..')) {
    throw new Error('invalid system skill source');
  }
  const roots = AGENT_SKILLS[agent].system.map((s) => (remote ? s.rel : s.local()));
  const ok = roots.some((r) => (remote ? source.startsWith(r + '/') : path.resolve(source).startsWith(r + path.sep)));
  if (!ok) throw new Error('invalid system skill source');
}

/** Read + parse one SKILL.md into a SkillDetail. */
export async function readSkill(args: {
  agent: AgentKind;
  host?: string;
  name: string;
  scope?: SkillScope;
  source?: string;
}): Promise<SkillDetail> {
  const { agent, name } = args;
  const scope: SkillScope = args.scope ?? 'personal';
  const { remote, target } = resolveTarget(args.host);
  const cfg = AGENT_SKILLS[agent];

  let raw: string;
  if (scope === 'system') {
    if (!remote) {
      assertSystemSource(agent, args.source, false);
      try {
        raw = fs.readFileSync(args.source!, 'utf8');
      } catch {
        throw new Error('skill not found');
      }
    } else {
      assertSystemSource(agent, args.source, true);
      const r = await run(target, `cat ${shQuote(args.source!)} 2>/dev/null`, { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error('skill not found');
      raw = r.stdout;
    }
  } else {
    if (!validateSkillName(name)) throw new Error('invalid skill name');
    if (!remote) {
      const file = path.join(cfg.personalLocal(), name, 'SKILL.md');
      try {
        raw = fs.readFileSync(file, 'utf8');
      } catch {
        throw new Error('skill not found');
      }
    } else {
      const r = await run(target, `cat ${cfg.personalRel}/${shQuote(name)}/SKILL.md 2>/dev/null`, { timeoutMs: 15_000 });
      if (r.code !== 0) throw new Error('skill not found');
      raw = r.stdout;
    }
  }

  const p = parseSkill(raw);
  return {
    name,
    scope,
    agent,
    source: scope === 'system' ? args.source : undefined,
    frontmatterName: p.name,
    description: p.description,
    whenToUse: p.whenToUse,
    body: p.body,
    readOnly: scope === 'system',
  };
}

/** Create or update a personal skill. Preserves non-managed frontmatter keys. */
export async function writeSkill(args: {
  agent: AgentKind;
  host?: string;
  name: string;
  description: string;
  whenToUse?: string;
  body: string;
}): Promise<SkillDetail> {
  const { agent, name, description, whenToUse, body } = args;
  if (!validateSkillName(name)) throw new Error('invalid skill name');
  const { remote, target } = resolveTarget(args.host);
  const cfg = AGENT_SKILLS[agent];

  let content: string;
  if (!remote) {
    const dir = path.join(cfg.personalLocal(), name);
    const file = path.join(dir, 'SKILL.md');
    fs.mkdirSync(dir, { recursive: true });
    let existing = '';
    try {
      existing = fs.readFileSync(file, 'utf8');
    } catch {
      /* new skill */
    }
    if (existing) {
      const p = parseSkill(existing);
      p.name = name;
      p.description = description;
      p.whenToUse = whenToUse;
      p.body = body;
      content = serializeSkill(p);
    } else {
      content = buildSkillFile(name, description, whenToUse, body);
    }
    fs.writeFileSync(file, content, 'utf8');
  } else {
    const skillPath = `${cfg.personalRel}/${shQuote(name)}`;
    await run(target, `mkdir -p ${skillPath}`, { timeoutMs: 15_000 });
    const r = await run(target, `cat ${skillPath}/SKILL.md 2>/dev/null`, { timeoutMs: 15_000 });
    if (r.code === 0 && r.stdout) {
      const p = parseSkill(r.stdout);
      p.name = name;
      p.description = description;
      p.whenToUse = whenToUse;
      p.body = body;
      content = serializeSkill(p);
    } else {
      content = buildSkillFile(name, description, whenToUse, body);
    }
    await run(target, `cat > ${skillPath}/SKILL.md`, { input: content, timeoutMs: 30_000 });
  }

  return { name, scope: 'personal', agent, description, whenToUse, body, readOnly: false };
}

/** Delete a personal skill directory. */
export async function deleteSkill(args: { agent: AgentKind; host?: string; name: string }): Promise<void> {
  const { agent, name } = args;
  if (!validateSkillName(name)) throw new Error('invalid skill name');
  const { remote, target } = resolveTarget(args.host);
  const cfg = AGENT_SKILLS[agent];

  if (!remote) {
    fs.rmSync(path.join(cfg.personalLocal(), name), { recursive: true, force: true });
  } else {
    await run(target, `rm -rf ${cfg.personalRel}/${shQuote(name)}`, { timeoutMs: 20_000 });
  }
}
