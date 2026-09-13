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
  /** Present only on the `fusion` family: the models that can be fused, split
   *  by role. Drives the fusion pickers; the user's choice is stored as a
   *  `fusion:<strong>:<effort?>+<normal>:<effort?>` spec that
   *  `resolveDevinVariant` maps onto a concrete variant uid at turn time. */
  fusion?: { strong: FusionModelRef[]; normal: FusionModelRef[] };
}

/** One fusable model inside the fusion family, in one of the two roles. */
export interface FusionModelRef {
  /** Family uid with dots normalised to dashes (`gpt-5.6-sol` → `gpt-5-6-sol`),
   *  matching how fusion variant uids spell it. */
  value: string;
  label: string;
  /** Effort tiers this model ships inside fusion pairs, ladder order; absent
   *  when every pair pins it to a single undifferentiated variant. */
  efforts?: string[];
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
// Fusion
// ---------------------------------------------------------------------------

const FUSION_PREFIX = 'fusion-';
const SIDEKICK_SEP = '-sidekick-';
/** Stored-selection format: `fusion:<strong>:<effort?>+<normal>:<effort?>`. */
const FUSION_SPEC_PREFIX = 'fusion:';

/** The models a fusion variant uid names on either side of `-sidekick-`. */
export interface FusionSelection {
  strong: string;
  strongEffort?: string;
  normal: string;
  normalEffort?: string;
}

/** Split `family-effort-tier…` into its parts, stripping from the right. */
function splitFusionComponent(s: string): { family?: string; effort?: string; tier: number } {
  const toks = s.toLowerCase().split('-').filter(Boolean);
  let effort: string | undefined;
  let tier = 0;
  while (toks.length) {
    const last = toks[toks.length - 1]!;
    if ((EFFORT_TOKENS as readonly string[]).includes(last)) {
      if (!effort) effort = last;
      toks.pop();
      continue;
    }
    if (TIER_TOKENS.has(last)) {
      tier++;
      toks.pop();
      continue;
    }
    break;
  }
  if (!toks.length) return { tier };
  return { family: toks.join('-'), effort, tier };
}

/** Decompose a concrete fusion variant uid
 *  (`fusion-claude-opus-5-high-sidekick-swe-2-medium`). */
export function parseFusionUid(uid: string): FusionSelection | undefined {
  if (!uid.startsWith(FUSION_PREFIX) || !uid.includes(SIDEKICK_SEP)) return undefined;
  const rest = uid.slice(FUSION_PREFIX.length);
  const i = rest.indexOf(SIDEKICK_SEP);
  const strong = splitFusionComponent(rest.slice(0, i));
  const normal = splitFusionComponent(rest.slice(i + SIDEKICK_SEP.length));
  if (!strong.family || !normal.family) return undefined;
  return {
    strong: strong.family,
    strongEffort: strong.effort,
    normal: normal.family,
    normalEffort: normal.effort,
  };
}

/** Parse the stored selection spec. Colons and the `+` cannot appear in family
 *  uids or effort tokens, so the split is unambiguous. */
export function parseFusionSpec(model: string): FusionSelection | undefined {
  if (!model.startsWith(FUSION_SPEC_PREFIX)) return undefined;
  const [strongPart, normalPart] = model.slice(FUSION_SPEC_PREFIX.length).split('+');
  const [strong, strongEffort] = String(strongPart ?? '').split(':');
  const [normal, normalEffort] = String(normalPart ?? '').split(':');
  if (!strong || !normal) return undefined;
  return {
    strong,
    strongEffort: strongEffort || undefined,
    normal,
    normalEffort: normalEffort || undefined,
  };
}

/** Score how well a candidate's effort matches the request. `undefined` on
 *  either side is not a tie-breaker-free zero: without a preference we prefer
 *  the mildest tier the pair ships (the normal side exists to be cheap), and a
 *  candidate without any effort token sits a mild penalty away. */
function effortScore(want: string | undefined, have: string | undefined): number {
  const ladder = EFFORT_TOKENS as readonly string[];
  const hi = have ? ladder.indexOf(have) : -1;
  if (!want) return hi < 0 ? 0 : hi;
  const wi = ladder.indexOf(want);
  if (wi < 0) return hi < 0 ? 0 : hi;
  if (hi < 0) return 2;
  return Math.abs(wi - hi);
}

/** Map a fusion selection onto the best concrete variant uid of the fusion
 *  family: the named pair is a hard requirement, requested efforts are matched
 *  as closely as the catalog allows, plain variants beat tiered ones. */
export function resolveFusionUid(
  sel: FusionSelection,
  variants: readonly Variant[],
): string | undefined {
  const parsed = variants
    .map((v) => ({ v, sel: parseFusionUid(v.uid) }))
    .filter((x) => x.sel && x.sel.strong === sel.strong && x.sel.normal === sel.normal);
  if (!parsed.length) return undefined;
  parsed.sort((a, b) => {
    const da =
      effortScore(sel.strongEffort, a.sel!.strongEffort) +
      effortScore(sel.normalEffort, a.sel!.normalEffort);
    const db =
      effortScore(sel.strongEffort, b.sel!.strongEffort) +
      effortScore(sel.normalEffort, b.sel!.normalEffort);
    return da - db || a.v.tier - b.v.tier || a.v.uid.length - b.v.uid.length;
  });
  return parsed[0]!.v.uid;
}

/** Collect the fusable models per role from the fusion family's variants. */
function fusionRefs(
  variants: readonly Variant[],
  role: 'strong' | 'normal',
  labels: Map<string, string>,
): FusionModelRef[] {
  const byFamily = new Map<string, Set<string>>();
  for (const v of variants) {
    const sel = parseFusionUid(v.uid);
    if (!sel) continue;
    const family = role === 'strong' ? sel.strong : sel.normal;
    const effort = role === 'strong' ? sel.strongEffort : sel.normalEffort;
    let efforts = byFamily.get(family);
    if (!efforts) byFamily.set(family, (efforts = new Set()));
    if (effort) efforts.add(effort);
  }
  const out: FusionModelRef[] = [];
  for (const [family, efforts] of byFamily) {
    const ordered = SURFACED_EFFORTS.filter((e) => efforts.has(e));
    out.push({
      value: family,
      label: labels.get(family) ?? family,
      ...(ordered.length > 1 ? { efforts: ordered } : {}),
    });
  }
  out.sort((a, b) => a.label.localeCompare(b.label));
  return out;
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

  // Family labels by normalised uid (dots → dashes), for fusion refs: fusion
  // variant uids spell `gpt-5.6-sol` as `gpt-5-6-sol`.
  const labels = new Map<string, string>();
  for (const family of families) {
    const familyUid = String(family?.family_uid ?? family?.slug ?? '').trim();
    const label = String(family?.family_label ?? family?.slug ?? familyUid).trim() || familyUid;
    if (familyUid) labels.set(familyUid.replace(/\./g, '-'), label);
  }

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

    const label = labels.get(familyUid.replace(/\./g, '-')) ?? familyUid;

    // The fusion family is not effort-differentiated like plain families: its
    // "variants" are model pairs. Surface the fusable models per role instead
    // of a flat 200-entry list; the pair choice lives in the fusion pickers.
    if (familyUid === 'fusion') {
      const fusion = {
        strong: fusionRefs(list, 'strong', labels),
        normal: fusionRefs(list, 'normal', labels),
      };
      if (fusion.strong.length && fusion.normal.length) {
        models.push({ value: familyUid, label, fusion });
        continue;
      }
    }

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
  // A stored fusion selection (`fusion:<strong>:<effort?>+<normal>:<effort?>`):
  // map it onto the best concrete variant of the fusion family. The generic
  // effort ladder does not apply — the tiers are inside the selection.
  const spec = parseFusionSpec(trimmed);
  if (spec) {
    const cat = catalog ?? cache.peek('');
    const fusionList = cat?.variants.get('fusion');
    const uid = fusionList ? resolveFusionUid(spec, fusionList) : undefined;
    if (uid) {
      const exact = fusionList!.find((v) => v.uid === uid);
      return { uid, contextWindow: exact?.maxContextTokens };
    }
    // Unknown pair (catalog stale or CLI without fusion): send Devin's plain
    // family uid rather than a spec string it cannot parse.
    return { uid: 'fusion' };
  }
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
  // Fusion selections — both the stored spec and a concrete variant uid picked
  // up from Devin's own database — belong to the `fusion` family entry.
  if (trimmed.startsWith(FUSION_SPEC_PREFIX) || parseFusionUid(trimmed)) return 'fusion';
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
