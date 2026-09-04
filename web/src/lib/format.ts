import { clsx, type ClassValue } from 'clsx';
import type { AgentKind, EffortLevel, PermissionMode } from '@shared/protocol';

export const cn = (...inputs: ClassValue[]) => clsx(inputs);

export function basename(p: string): string {
  const parts = p.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || p;
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);

/** True for image extensions /files/raw serves with an image MIME, so the UI
 *  can render them via <img> instead of the text /files/read endpoint. */
export function isImagePath(p: string): boolean {
  const ext = p.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

export function shortenPath(p: string, max = 3): string {
  const parts = p.split('/').filter(Boolean);
  if (parts.length <= max) return p;
  return '…/' + parts.slice(-max).join('/');
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** End-of-turn clock, always Beijing time (UTC+8) regardless of viewer locale. */
const beijingTime = new Intl.DateTimeFormat('en-GB', {
  timeZone: 'Asia/Shanghai',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
  hourCycle: 'h23',
});

export function beijingClock(ts: number): string {
  return Number.isFinite(ts) ? `${beijingTime.format(ts)} UTC+8` : '';
}

/** Compact token count: 950 → "950", 84213 → "84.2k", 1250000 → "1.3M". */
export function formatTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '';
  if (n < 1000) return String(Math.round(n));
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 100_000 ? 1 : 0)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

export const AGENTS: { value: AgentKind; label: string }[] = [
  { value: 'claude', label: 'Claude' },
  { value: 'cursor', label: 'Cursor' },
  { value: 'codex', label: 'Codex' },
  { value: 'kimi', label: 'Kimi' },
  { value: 'kiro', label: 'Kiro' },
  { value: 'grok', label: 'Grok' },
  { value: 'zcode', label: 'ZCode' },
  { value: 'codebuddy', label: 'CodeBuddy' },
  { value: 'opencode', label: 'opencode' },
  { value: 'devin', label: 'Devin' },
];

export const MODELS: { value: string; label: string }[] = [
  { value: 'sonnet', label: 'Sonnet' },
  { value: 'opus', label: 'Opus' },
  { value: 'haiku', label: 'Haiku' },
  { value: 'opusplan', label: 'Opus Plan' },
];

export interface ModelOption {
  value: string;
  label: string;
  /** Codex/ZCode only: the reasoning values this model advertises (Codex from
   *  its cache, ZCode from the live thought-level catalog). Drives the effort
   *  picker per-model. */
  efforts?: string[];
  /** Codex/ZCode only: the model's default reasoning level. */
  defaultEffort?: string;
}

export interface PermissionOption {
  value: PermissionMode;
  label: string;
  hint: string;
}

/**
 * Fallback Cursor models, used only until the live list from `cursor-agent
 * models` loads (or if the CLI is unavailable). The real list is fetched from
 * the server and threaded in via `cursorModels`. `auto` lets Cursor pick.
 */
export const CURSOR_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'composer-2.5-fast', label: 'Composer 2.5 Fast' },
  { value: 'composer-2.5', label: 'Composer 2.5' },
  { value: 'gpt-5.3-codex', label: 'Codex 5.3' },
  { value: 'gpt-5.5-medium', label: 'GPT-5.5' },
  { value: 'claude-4.6-sonnet-medium', label: 'Sonnet 4.6' },
  { value: 'claude-opus-4-8-thinking-high', label: 'Opus 4.8 Thinking' },
];

/** Fallback Codex models until the live list from `~/.codex/models_cache.json`
 *  loads (or if the cache is missing). `auto` lets Codex pick per its config.toml. */
export const CODEX_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'gpt-5.5', label: 'GPT-5.5' },
  { value: 'gpt-5.4', label: 'GPT-5.4' },
  { value: 'gpt-5.4-mini', label: 'GPT-5.4-Mini' },
];

/** Kimi accepts configured model aliases; `auto` preserves its own default. */
export const KIMI_MODELS: ModelOption[] = [{ value: 'auto', label: 'Auto' }];

/** Fallback Kiro models until `kiro-cli chat --list-models` loads. */
export const KIRO_MODELS: ModelOption[] = [{ value: 'auto', label: 'Auto' }];

/** Fallback Grok models until `grok models` loads. */
export const GROK_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'grok-build', label: 'Grok Build' },
  { value: 'grok-4.6', label: 'Grok 4.6' },
];

/** Fallback ZCode models until ~/.zcode/cli/config.json loads. Values are
 *  `providerID/modelID` — the format ZCode's config uses for `model.main`. */
export const ZCODE_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'bigmodel/GLM-5.3', label: 'GLM-5.3' },
  { value: 'bigmodel/GLM-5.2', label: 'GLM-5.2' },
  { value: 'bigmodel/GLM-5-Turbo', label: 'GLM-5-Turbo' },
];

/** Fallback CodeBuddy models until the live list from `codebuddy --help`
 *  loads. The server parses the CLI's `--model` help line for the catalog. */
export const CODEBUDDY_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'hy4-preview', label: 'HY4 Preview' },
  { value: 'hy3', label: 'HY3' },
  { value: 'glm-5.3', label: 'GLM-5.3' },
  { value: 'glm-5.3-flash', label: 'GLM-5.3 Flash' },
  { value: 'glm-5.2', label: 'GLM-5.2' },
  { value: 'glm-5.1', label: 'GLM-5.1' },
  { value: 'glm-5v-turbo', label: 'GLM-5V Turbo' },
  { value: 'minimax-m3-pay', label: 'MiniMax M3' },
  { value: 'kimi-k3-2', label: 'Kimi K3.2' },
  { value: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro' },
  { value: 'deepseek-v4-flash', label: 'DeepSeek V4 Flash' },
];

/** Fallback Devin models until `devin models list` loads. Values are family
 *  uids — Devin encodes the effort level into the variant uid, so the picker
 *  offers families here and effort separately (the server assembles the two). */
export const DEVIN_MODELS: ModelOption[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'claude-opus-5', label: 'Claude Opus 5' },
  { value: 'claude-sonnet-5', label: 'Claude Sonnet 5' },
  { value: 'claude-fable-5-1', label: 'Claude Fable 5.1' },
];

/** Fallback opencode models until `opencode models` loads. Values are
 *  `provider/model` — `auto` lets opencode pick from its own config. */
export const OPENCODE_MODELS: ModelOption[] = [{ value: 'auto', label: 'Auto' }];

/** Model options for an agent. */
export function modelsForAgent(
  agent: AgentKind,
  cursorModels?: ModelOption[],
  codexModels?: ModelOption[],
  kimiModels?: ModelOption[],
  kiroModels?: ModelOption[],
  grokModels?: ModelOption[],
  zcodeModels?: ModelOption[],
  codebuddyModels?: ModelOption[],
  devinModels?: ModelOption[],
  opencodeModels?: ModelOption[],
): ModelOption[] {
  if (agent === 'cursor') return cursorModels && cursorModels.length ? cursorModels : CURSOR_MODELS;
  if (agent === 'codex') return codexModels && codexModels.length ? codexModels : CODEX_MODELS;
  if (agent === 'kimi') return kimiModels && kimiModels.length ? kimiModels : KIMI_MODELS;
  if (agent === 'kiro') return kiroModels && kiroModels.length ? kiroModels : KIRO_MODELS;
  if (agent === 'grok') return grokModels && grokModels.length ? grokModels : GROK_MODELS;
  if (agent === 'zcode') return zcodeModels && zcodeModels.length ? zcodeModels : ZCODE_MODELS;
  if (agent === 'codebuddy') return codebuddyModels && codebuddyModels.length ? codebuddyModels : CODEBUDDY_MODELS;
  if (agent === 'devin') return devinModels && devinModels.length ? devinModels : DEVIN_MODELS;
  if (agent === 'opencode') return opencodeModels && opencodeModels.length ? opencodeModels : OPENCODE_MODELS;
  return MODELS;
}

export const PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before risky tools' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Auto-accept file edits' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Allow everything (careful)' },
];

/** Cursor headless mode has only coarse, mode-level permissions. */
export const CURSOR_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Agent', hint: 'Run tools automatically' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
];

/** Codex headless mode is sandbox-level only: full-auto, read-only, or bypass. */
export const CODEX_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Auto', hint: 'Sandboxed, auto-run (workspace-write)' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning mode' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'YOLO mode, no sandbox (careful)' },
];

/** Conservative fallback while discovery loads (and for pre-ACP Kimi builds). */
export const KIMI_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Auto', hint: 'Kimi prompt mode auto-runs allowed tools' },
];

/** Kiro ACP: spawn trust flags + planner mode. */
export const KIRO_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before tool use' },
  { value: 'plan', label: 'Plan', hint: 'Kiro planner agent' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Trust filesystem read/write tools' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Trust all tools (careful)' },
];

/** Grok Build: Ask / Plan / Auto / Always-approve. */
export const GROK_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before tool use' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning; edit the plan file only' },
  { value: 'acceptEdits', label: 'Auto', hint: 'Classifier auto-approves safe tools' },
  { value: 'bypassPermissions', label: 'Always-approve', hint: 'Auto-approve tool calls (careful)' },
];

/** ZCode modes: build / edit / plan / yolo. */
export const ZCODE_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Approve risky tools before they run' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'acceptEdits', label: 'Edit', hint: 'Auto-approve edits and safe tools' },
  { value: 'bypassPermissions', label: 'Yolo', hint: 'Auto-approve tool calls (careful)' },
];

/** CodeBuddy maps the four Vibe modes 1:1 to `--permission-mode`; Ask routes
 *  tool approvals through Vibe's interactive prompts. */
export const CODEBUDDY_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Approve risky tools before they run' },
  { value: 'plan', label: 'Plan', hint: 'Read-only planning' },
  { value: 'acceptEdits', label: 'Auto-edit', hint: 'Auto-accept file edits' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Skip permission prompts (careful)' },
];

/** Devin's ACP `mode` config option. `smart` has no Vibe equivalent (it is a
 *  middle tier between auto-edit and bypass), so it is not offered. */
export const DEVIN_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Answer and read, no changes' },
  { value: 'acceptEdits', label: 'Code', hint: 'Write and edit code' },
  { value: 'plan', label: 'Plan', hint: 'Plan before implementing' },
  { value: 'bypassPermissions', label: 'Bypass', hint: 'Auto-approve all tool calls (careful)' },
];

/** opencode runs over ACP: risky tools arrive as `session/request_permission`
 *  and surface as inline Vibe prompts; only Always-approve skips the UI. */
export const OPENCODE_PERMISSION_MODES: PermissionOption[] = [
  { value: 'default', label: 'Ask', hint: 'Prompt before risky tools' },
  { value: 'plan', label: 'Plan', hint: 'Plan mode (edits disallowed) + prompts' },
  { value: 'acceptEdits', label: 'Auto', hint: 'opencode policy decides per tool' },
  { value: 'bypassPermissions', label: 'Always-approve', hint: 'Auto-approve tool calls (careful)' },
];

export function permissionModesForAgent(
  agent: AgentKind,
  kimiPermissions?: PermissionOption[],
  kiroPermissions?: PermissionOption[],
): PermissionOption[] {
  if (agent === 'cursor') return CURSOR_PERMISSION_MODES;
  if (agent === 'codex') return CODEX_PERMISSION_MODES;
  if (agent === 'kimi') return kimiPermissions && kimiPermissions.length ? kimiPermissions : KIMI_PERMISSION_MODES;
  if (agent === 'kiro') return kiroPermissions && kiroPermissions.length ? kiroPermissions : KIRO_PERMISSION_MODES;
  if (agent === 'grok') return GROK_PERMISSION_MODES;
  if (agent === 'zcode') return ZCODE_PERMISSION_MODES;
  if (agent === 'codebuddy') return CODEBUDDY_PERMISSION_MODES;
  if (agent === 'devin') return DEVIN_PERMISSION_MODES;
  if (agent === 'opencode') return OPENCODE_PERMISSION_MODES;
  return PERMISSION_MODES;
}

export function agentLabel(agent: AgentKind): string {
  return AGENTS.find((a) => a.value === agent)?.label ?? agent;
}

export const EFFORT_LEVELS: { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Fastest, minimal thinking' },
  { value: 'medium', label: 'Medium', hint: 'Moderate thinking' },
  { value: 'high', label: 'High', hint: 'Deep reasoning' },
  { value: 'xhigh', label: 'X-High', hint: 'Deeper than high' },
  { value: 'max', label: 'Max', hint: 'Maximum effort' },
  { value: 'ultra', label: 'Ultra', hint: 'Beyond max — gpt-5.6 models' },
];

export function modelLabel(
  value: string,
  cursorModels?: ModelOption[],
  codexModels?: ModelOption[],
  kimiModels?: ModelOption[],
  kiroModels?: ModelOption[],
  grokModels?: ModelOption[],
  zcodeModels?: ModelOption[],
  codebuddyModels?: ModelOption[],
  devinModels?: ModelOption[],
  opencodeModels?: ModelOption[],
): string {
  return (
    MODELS.find((m) => m.value === value)?.label ??
    cursorModels?.find((m) => m.value === value)?.label ??
    codexModels?.find((m) => m.value === value)?.label ??
    kimiModels?.find((m) => m.value === value)?.label ??
    kiroModels?.find((m) => m.value === value)?.label ??
    grokModels?.find((m) => m.value === value)?.label ??
    zcodeModels?.find((m) => m.value === value)?.label ??
    codebuddyModels?.find((m) => m.value === value)?.label ??
    devinModels?.find((m) => m.value === value)?.label ??
    opencodeModels?.find((m) => m.value === value)?.label ??
    CURSOR_MODELS.find((m) => m.value === value)?.label ??
    CODEX_MODELS.find((m) => m.value === value)?.label ??
    KIMI_MODELS.find((m) => m.value === value)?.label ??
    KIRO_MODELS.find((m) => m.value === value)?.label ??
    GROK_MODELS.find((m) => m.value === value)?.label ??
    ZCODE_MODELS.find((m) => m.value === value)?.label ??
    CODEBUDDY_MODELS.find((m) => m.value === value)?.label ??
    DEVIN_MODELS.find((m) => m.value === value)?.label ??
    OPENCODE_MODELS.find((m) => m.value === value)?.label ??
    value
  );
}

export function permissionModeLabel(
  value: PermissionMode,
  agent?: AgentKind,
  kimiPermissions?: PermissionOption[],
  kiroPermissions?: PermissionOption[],
): string {
  const modes = agent ? permissionModesForAgent(agent, kimiPermissions, kiroPermissions) : PERMISSION_MODES;
  return modes.find((m) => m.value === value)?.label ?? value;
}

/** Grok Build `/effort`: low / medium / high / xhigh (Extra High). No max/ultra. */
export const GROK_EFFORT_LEVELS: { value: EffortLevel; label: string; hint: string }[] = [
  { value: 'low', label: 'Low', hint: 'Quick, fast implementations' },
  { value: 'medium', label: 'Medium', hint: 'Balanced effort with standard testing' },
  { value: 'high', label: 'High', hint: 'Higher quality with extensive reasoning' },
  { value: 'xhigh', label: 'Extra High', hint: 'Highest effort and reasoning level' },
];

/** ZCode-only thought levels (models whose ladders aren't subsets of the shared
 *  ladder: GLM-5.2 offers `nothink`; GLM-5-Turbo is an on/off switch). */
const ZCODE_EXTRA_LEVELS: Partial<Record<EffortLevel, { label: string; hint: string }>> = {
  nothink: { label: 'No thinking', hint: 'Reasoning disabled for this model' },
  enabled: { label: 'Thinking on', hint: 'Reasoning enabled' },
  disabled: { label: 'Thinking off', hint: 'Reasoning disabled' },
};

function zcodeEffortDescriptor(value: string): { value: EffortLevel; label: string; hint: string } | undefined {
  const shared = EFFORT_LEVELS.find((x) => x.value === value);
  if (shared) return shared;
  const extra = ZCODE_EXTRA_LEVELS[value as EffortLevel];
  return extra ? { value: value as EffortLevel, ...extra } : undefined;
}

export function effortLabel(value: EffortLevel, agent?: AgentKind): string {
  if (agent) {
    const hit = effortLevelsForAgent(agent).find((e) => e.value === value);
    if (hit) return hit.label;
    if (agent === 'zcode') {
      const extra = ZCODE_EXTRA_LEVELS[value];
      if (extra) return extra.label;
    }
  }
  return EFFORT_LEVELS.find((e) => e.value === value)?.label ?? value;
}

/** Sensible default when switching the New Session / preset agent picker. */
export function defaultEffortForAgent(agent: AgentKind): EffortLevel {
  if (agent === 'codex') return 'xhigh';
  if (agent === 'grok') return 'high';
  // Devin's own default variant is `medium` across its families.
  if (agent === 'devin') return 'medium';
  return 'max';
}

/** Effort levels an agent exposes. Codex and ZCode are per-model — pass the
 *  selected model so the picker matches what the CLI offers for it (Codex from
 *  its cached `supported_reasoning_levels`; ZCode from the catalog probe's
 *  thought-level ladders, e.g. GLM-5.3 low|high|max, GLM-5.2 max|high|nothink).
 *  Cursor and Kimi do not expose a separate effort switch here. Kiro uses
 *  the Claude ladder. Grok is low / medium / high / extra-high. opencode
 *  maps the shared ladder (minus `ultra`) onto model variants.
 */
export function effortLevelsForAgent(
  agent: AgentKind,
  model?: ModelOption | null,
): { value: EffortLevel; label: string; hint: string }[] {
  if (agent === 'cursor' || agent === 'kimi') return [];
  if (agent === 'grok') return GROK_EFFORT_LEVELS;
  if (agent === 'zcode') {
    const efforts = model?.efforts;
    if (!efforts?.length) return [];
    // Preserve the catalog's order; drop anything we can't label.
    return efforts
      .map((e) => zcodeEffortDescriptor(e))
      .filter((x): x is { value: EffortLevel; label: string; hint: string } => Boolean(x));
  }
  if (agent === 'codex') {
    const efforts = model?.efforts;
    if (efforts?.length) {
      // Preserve the cache's order; drop anything we can't label.
      return efforts
        .map((e) => EFFORT_LEVELS.find((x) => x.value === e))
        .filter((x): x is { value: EffortLevel; label: string; hint: string } => Boolean(x));
    }
    // No model chosen (`auto`) or cache missing: the ladder common to all known models.
    return EFFORT_LEVELS.filter((e) => e.value !== 'max' && e.value !== 'ultra');
  }
  // CodeBuddy's `--effort` accepts minimal..max — the shared ladder minus `ultra`.
  if (agent === 'codebuddy') return EFFORT_LEVELS.filter((e) => e.value !== 'ultra');
  // opencode variants are provider-specific reasoning effort — the shared
  // ladder minus `ultra` (which folds to `max`).
  if (agent === 'opencode') return EFFORT_LEVELS.filter((e) => e.value !== 'ultra');
  if (agent === 'devin') {
    // Devin ships effort as part of the model uid, so it is per-family like
    // Codex's: offer exactly what the chosen family publishes. Families with a
    // single undifferentiated variant expose no ladder.
    const efforts = model?.efforts;
    if (!efforts?.length) return [];
    return efforts
      .map((e) => EFFORT_LEVELS.find((x) => x.value === e))
      .filter((x): x is { value: EffortLevel; label: string; hint: string } => Boolean(x));
  }
  return EFFORT_LEVELS;
}
