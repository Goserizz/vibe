import { execFile } from 'node:child_process';
import { config } from '../config.js';
import { log } from '../log.js';
import { hostRegistry, proxyForAgent } from '../remote/hosts.js';
import { cleanRemoteStderr, loginShellCommand, proxyEnvPrefix, shQuote, sshExec } from '../remote/ssh.js';
import type { PermissionMode } from '../../../shared/protocol.js';
import { createSwrCache } from '../util/swrCache.js';

export interface DevinModel {
  /** A *family* uid (e.g. `claude-opus-5`), not a variant. The variant uid sent
   *  to Devin is assembled from this plus the chosen effort — see
   *  `resolveDevinModelId`. */
  value: string;
  label: string;
  /** Effort levels this family actually ships, low → high. Drives the effort
   *  picker; empty when the family has a single undifferentiated variant. */
  efforts?: string[];
  /** The variant Devin would pick on its own for this family. */
  defaultEffort?: string;
}

export interface DevinPermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

const AUTO_MODEL: DevinModel = { value: 'auto', label: 'Auto' };

/**
 * Permission modes Devin exposes through the ACP `mode` config option. Its CLI
 * flag list differs from the ACP ids (`--permission-mode` takes
 * auto/accept-edits/smart/dangerous), so these are the ACP ids as reported by
 * `config_option_update`.
 */
export const DEVIN_PERMISSIONS: DevinPermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Answer and read, no changes (`ask`)' },
  { value: 'acceptEdits', label: 'Code', hint: 'Write and edit code (`accept-edits`)' },
  { value: 'plan', label: 'Plan', hint: 'Plan before implementing (`plan`)' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Auto-approve all tool calls (`bypass`)' },
];

/** ACP mode id for a Vibe permission mode. Falls back to `ask` (the safest of
 *  Devin's modes — `smart` has no Vibe equivalent, so it is not mapped). */
export function devinModeIdFor(permissionMode: PermissionMode): string {
  switch (permissionMode) {
    case 'plan':
      return 'plan';
    case 'acceptEdits':
      return 'accept-edits';
    case 'bypassPermissions':
      return 'bypass';
    default:
      return 'ask';
  }
}

const FALLBACK: DevinModel[] = [AUTO_MODEL];

const TTL_MS = 5 * 60_000;
const cache = createSwrCache<DevinCatalog>({
  ttlMs: TTL_MS,
  fallback: { models: FALLBACK, variants: new Map() },
  isEmpty: (c) => c.models.length <= 1,
  onError: (key, err) => log.debug('devin models refresh failed', key || 'local', err),
});

// ---------------------------------------------------------------------------
// Effort parsing
// ---------------------------------------------------------------------------

/**
 * Effort tokens Devin encodes into a variant uid, low → high.
 *
 * `ultra` is deliberately absent: it would false-positive on unrelated uids
 * (`nemotron-3-ultra`), and Devin does not actually use it as an effort.
 */
const EFFORT_TOKENS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;

/** Effort levels Vibe can represent in its own picker. `none`/`minimal` are real
 *  Devin variants but have no `EffortLevel` equivalent, so they are parsed (to
 *  keep variant selection honest) yet never surfaced as a choice. */
const SURFACED_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * Suffix tokens that mark a *variant tier* rather than an effort — e.g.
 * `claude-opus-5-low-fast` is the `low` effort on the fast tier. Used to prefer
 * the plain variant of an effort when several exist.
 */
const TIER_TOKENS = new Set(['fast', 'priority', '1m', 'thinking', 'lightning']);

interface Variant {
  uid: string;
  effort?: string;
  /** How many tier tokens the uid carries — 0 means the plain variant. */
  tier: number;
  /** The variant's context window, from the catalog's max_context_tokens. */
  maxContextTokens?: number;
}

function parseEffort(uid: string): { effort?: string; tier: number } {
  const tokens = uid
    .toLowerCase()
    .replace(/_/g, '-')
    .split('-')
    .filter(Boolean);
  let effort: string | undefined;
  let tier = 0;
  for (const token of tokens) {
    if (TIER_TOKENS.has(token)) {
      tier++;
      continue;
    }
    // Take the *first* effort token: in `claude-opus-5-max-fast`, `max` is the
    // effort and `fast` the tier, and effort always precedes its tier suffix.
    if (!effort && (EFFORT_TOKENS as readonly string[]).includes(token)) effort = token;
  }
  return { effort, tier };
}

// ---------------------------------------------------------------------------
// Catalog
// ---------------------------------------------------------------------------

export interface DevinCatalog {
  /** Families for the UI model picker. */
  models: DevinModel[];
  /** family uid → its variants, used to assemble a uid at turn time. */
  variants: Map<string, Variant[]>;
}

/**
 * Parse `devin models list --format json`.
 *
 * The catalog is two-level: a family (`claude-opus-5`) has many variants
 * (`claude-opus-5-low`, `-medium`, `-high`, …). Vibe shows families and lets the
 * user pick an effort separately, so the catalog keeps both levels — the variant
 * list is what `resolveDevinModelId` needs later.
 *
 * Note that a family uid is **not** always a prefix of its variant uids
 * (`gpt-5.2` ships `MODEL_GPT_5_2_LOW`), so effort must be parsed per variant
 * rather than by stripping a family prefix.
 */
export function parseDevinModels(raw: string): DevinCatalog {
  let parsed: any;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { models: [], variants: new Map() };
  }
  const families: any[] = Array.isArray(parsed?.families) ? parsed.families : [];
  const models: DevinModel[] = [];
  const variants = new Map<string, Variant[]>();

  for (const family of families) {
    const familyUid = String(family?.family_uid ?? family?.slug ?? '').trim();
    if (!familyUid || variants.has(familyUid)) continue;
    const rawVariants: any[] = Array.isArray(family?.variants) ? family.variants : [];
    if (!rawVariants.length) continue;

    const list: Variant[] = [];
    for (const v of rawVariants) {
      const uid = String(v?.model_uid ?? '').trim();
      if (!uid) continue;
      const { effort, tier } = parseEffort(uid);
      const window = Number(v?.max_context_tokens);
      list.push({
        uid,
        effort,
        tier,
        maxContextTokens: Number.isFinite(window) && window > 0 ? window : undefined,
      });
    }
    if (!list.length) continue;
    variants.set(familyUid, list);

    // Surface efforts in ladder order, de-duplicated.
    const efforts: string[] = [];
    for (const token of SURFACED_EFFORTS) {
      if (list.some((v) => v.effort === token) && !efforts.includes(token)) efforts.push(token);
    }

    // Devin's own default: the variant carrying no effort token. Families that
    // only ship effort-suffixed variants fall back to `medium`, then to the
    // first variant, so there is always something to send.
    const plain = list.find((v) => !v.effort);
    const medium = list.find((v) => v.effort === 'medium');
    const defaultVariant = plain ?? medium ?? list[0]!;

    const label = String(family?.family_label ?? family?.slug ?? familyUid).trim() || familyUid;
    models.push({
      value: familyUid,
      label,
      efforts: efforts.length ? efforts : undefined,
      defaultEffort: defaultVariant.effort && SURFACED_EFFORTS.includes(defaultVariant.effort) ? defaultVariant.effort : undefined,
    });
  }

  return { models, variants };
}

/** Pick the variant to actually send: fewest tier suffixes wins, so
 *  `…-low` beats `…-low-fast`. */
function variantFor(familyVariants: Variant[], effort: string): Variant | undefined {
  const matches = familyVariants.filter((v) => v.effort === effort);
  if (!matches.length) return undefined;
  matches.sort((a, b) => a.tier - b.tier || a.uid.length - b.uid.length);
  return matches[0];
}

/**
 * Assemble the model uid handed to Devin from the family + effort the user chose.
 *
 * `model` may already be a full variant uid (sessions created before the family
 * split, or one restored from disk) — in that case an explicit effort still
 * wins, and we re-assemble within the same family when we can identify it.
 */
export function resolveDevinModelId(model: string, effort?: string | null, catalog?: DevinCatalog): string {
  return resolveDevinVariant(model, effort, catalog).uid;
}

/** Same as resolveDevinModelId, but also carries the variant's context window
 *  (from the catalog's max_context_tokens) so turns can report it. */
export function resolveDevinVariant(
  model: string,
  effort?: string | null,
  catalog?: DevinCatalog,
): { uid: string; contextWindow?: number } {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === 'auto') return { uid: trimmed || 'auto' };
  const cat = catalog ?? cache.peek('');
  if (!cat?.variants.size) return { uid: trimmed };

  // Exact variant uid: keep it, unless an effort asks us to re-pick.
  for (const list of cat.variants.values()) {
    const exact = list.find((v) => v.uid === trimmed);
    if (exact) {
      if (!effort || effort === 'auto') return { uid: trimmed, contextWindow: exact.maxContextTokens };
      const picked = variantFor(list, effort) ?? exact;
      return { uid: picked.uid, contextWindow: picked.maxContextTokens };
    }
  }

  // Family uid: assemble `<family>-<effort>` via the real catalog.
  const list = cat.variants.get(trimmed);
  if (!list) return { uid: trimmed };
  if (!effort || effort === 'auto') {
    const plain = list.find((v) => !v.effort);
    const medium = list.find((v) => v.effort === 'medium');
    const picked = plain ?? medium ?? list[0]!;
    return { uid: picked.uid, contextWindow: picked.maxContextTokens };
  }
  const picked = variantFor(list, effort) ?? (list.find((v) => !v.effort) ?? list[0]!);
  return { uid: picked.uid, contextWindow: picked.maxContextTokens };
}

/**
 * Map a stored model uid back to its family.
 *
 * Discovered sessions carry a variant uid (`claude-opus-5-high`) because that is
 * what Devin writes to its own database. Vibe's picker is keyed by family, so
 * discovery needs the reverse of `resolveDevinModelId`. Returns the input when
 * the catalog has no answer (unknown model, or `auto`).
 */
export function devinFamilyForModel(model: string, catalog?: DevinCatalog): string {
  const trimmed = model?.trim();
  if (!trimmed || trimmed === 'auto') return trimmed || 'auto';
  const cat = catalog ?? cache.peek('');
  if (!cat?.variants.size) return trimmed;
  for (const [familyUid, list] of cat.variants) {
    if (familyUid === trimmed) return trimmed;
    if (list.some((v) => v.uid === trimmed)) return familyUid;
  }
  return trimmed;
}

// ---------------------------------------------------------------------------
// CLI invocation
// ---------------------------------------------------------------------------

function execDevin(args: string[]): Promise<string> {
  const bin = config.devinExecutable;
  if (!bin) return Promise.reject(new Error('devin CLI not found'));
  return new Promise((resolve, reject) => {
    execFile(bin, args, { timeout: 20_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** Devin installs to `~/.local/bin`, which a non-interactive remote shell may
 *  not have on PATH — probe `command -v` first, then fall back explicitly. */
function remoteInvocation(args: string[]): string {
  const invoke = `"$devin_bin" ${args.map(shQuote).join(' ')}`;
  return [
    'devin_fallback="$HOME/.local/bin/devin"',
    'if command -v devin >/dev/null 2>&1; then devin_bin="$(command -v devin)"; '
      + 'elif [ -x "$devin_fallback" ]; then devin_bin="$devin_fallback"; '
      + 'else echo "devin CLI not found" >&2; exit 127; fi',
    invoke,
  ].join('\n');
}

async function fetchLocal(): Promise<DevinCatalog | null> {
  if (!config.devinExecutable) return null;
  const out = await execDevin(['models', 'list', '--format', 'json']);
  const catalog = parseDevinModels(out);
  if (!catalog.variants.size) return null;
  catalog.models.unshift(AUTO_MODEL);
  return catalog;
}

async function fetchRemote(hostName: string): Promise<DevinCatalog | null> {
  const host = hostRegistry.get(hostName);
  if (!host) return fetchLocal();
  const proxyPrefix = proxyEnvPrefix(proxyForAgent(host, 'devin'));
  const res = await sshExec(
    host.ssh,
    proxyPrefix + loginShellCommand(remoteInvocation(['models', 'list', '--format', 'json'])),
    { timeoutMs: 25_000 },
  );
  const catalog = parseDevinModels(res.stdout);
  if (!catalog.variants.size) {
    log.debug('remote devin models empty', host.name, cleanRemoteStderr(res.stderr).slice(0, 200));
    return null;
  }
  catalog.models.unshift(AUTO_MODEL);
  return catalog;
}

export function invalidateDevinModelsCache(hostName?: string): void {
  cache.invalidate(hostName ?? '');
}

/** Model families advertised by the local Devin CLI. Never blocks on the CLI. */
export async function listDevinModels(): Promise<DevinModel[]> {
  return (await cache.serve('', fetchLocal)).models;
}

/** Model families from a remote host's Devin CLI. Never blocks on SSH. */
export async function listRemoteDevinModels(hostName: string): Promise<DevinModel[]> {
  if (!hostRegistry.get(hostName)) return listDevinModels();
  return (await cache.serve(hostName, () => fetchRemote(hostName))).models;
}

/** Warm local (and optionally remote) caches in the background. */
export function prefetchDevinModels(hostNames: string[] = []): void {
  cache.refresh('', fetchLocal);
  for (const name of hostNames) cache.refresh(name, () => fetchRemote(name));
}
