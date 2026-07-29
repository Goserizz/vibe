/**
 * Tool call / result formatting for Telegram — kept in sync with
 * `web/src/components/blocks.tsx` (`toolKind` / `toolMeta`).
 */

import { escHtml } from './format.js';

type ToolKind =
  | 'read'
  | 'edit'
  | 'write'
  | 'delete'
  | 'move'
  | 'bash'
  | 'await'
  | 'glob'
  | 'grep'
  | 'search'
  | 'webfetch'
  | 'websearch'
  | 'todo'
  | 'task'
  | 'plan'
  | 'lints'
  | 'image'
  | 'mode'
  | 'mcp'
  | 'other';

const TOOL_KIND_ALIASES: Record<string, ToolKind> = {
  read: 'read',
  readfile: 'read',
  edit: 'edit',
  editfile: 'edit',
  multiedit: 'edit',
  strreplace: 'edit',
  editnotebook: 'edit',
  notebookedit: 'edit',
  write: 'write',
  writefile: 'write',
  createfile: 'write',
  delete: 'delete',
  deletefile: 'delete',
  removefile: 'delete',
  move: 'move',
  movefile: 'move',
  rename: 'move',
  renamefile: 'move',
  bash: 'bash',
  shell: 'bash',
  runterminalcommand: 'bash',
  terminal: 'bash',
  runcommand: 'bash',
  execute: 'bash',
  awaitshell: 'await',
  await: 'await',
  glob: 'glob',
  listdir: 'glob',
  listdirectory: 'glob',
  ls: 'glob',
  findfiles: 'glob',
  grep: 'grep',
  searchfiles: 'grep',
  ripgrep: 'grep',
  semsearch: 'search',
  codebasesearch: 'search',
  semanticsearch: 'search',
  directorysearch: 'search',
  webfetch: 'webfetch',
  fetch: 'webfetch',
  fetchweb: 'webfetch',
  websearch: 'websearch',
  searchweb: 'websearch',
  todowrite: 'todo',
  todo: 'todo',
  updatetodo: 'todo',
  task: 'task',
  subagent: 'task',
  exitplanmode: 'plan',
  readlints: 'lints',
  getdiagnostics: 'lints',
  diagnostics: 'lints',
  generateimage: 'image',
  image: 'image',
  switchmode: 'mode',
  listmcpresources: 'mcp',
  fetchmcpresource: 'mcp',
  callmcptool: 'mcp',
};

function toolKind(name: string): ToolKind {
  const key = String(name ?? '')
    .toLowerCase()
    .replace(/[_\-\s]/g, '');
  return TOOL_KIND_ALIASES[key] ?? 'other';
}

function firstOf(obj: Record<string, unknown>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== '') return String(v);
  }
  return undefined;
}

function pathsDetail(i: Record<string, unknown>): string | undefined {
  const paths = Array.isArray(i.paths) ? i.paths.map(String).filter(Boolean) : [];
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) return `${paths.length} paths`;
  return undefined;
}

/** Best-effort one-line detail for unknown / sparsely-mapped tools. */
function fallbackDetail(i: Record<string, unknown>): string | undefined {
  return (
    pathsDetail(i) ||
    firstOf(i, [
      'command',
      'cmd',
      'file_path',
      'path',
      'relativePath',
      'filePath',
      'target_file',
      'target_notebook',
      'filename',
      'uri',
      'url',
      'query',
      'search_term',
      'searchTerm',
      'pattern',
      'glob_pattern',
      'globPattern',
      'regex',
      'description',
      'prompt',
      'title',
      'explanation',
      'target_mode_id',
      'targetModeId',
      'mode',
      'server',
      'toolName',
      'tool_name',
      'name',
      'shell_id',
      'shellId',
    ])
  );
}

/** Same label/detail rules as web `toolMeta` (without icons). */
export function toolCallMeta(name: string, input: unknown): { label: string; detail?: string; kind: ToolKind } {
  const i = (input && typeof input === 'object' ? input : {}) as Record<string, unknown>;
  const path = firstOf(i, [
    'file_path',
    'path',
    'relativePath',
    'filePath',
    'target_file',
    'target_notebook',
  ]);
  const kind = toolKind(name);

  switch (kind) {
    case 'bash':
      return { kind, label: 'Terminal', detail: firstOf(i, ['command', 'cmd']) };
    case 'await':
      return {
        kind,
        label: 'Await',
        detail: firstOf(i, ['shell_id', 'shellId', 'pattern', 'command', 'cmd']),
      };
    case 'read':
      return { kind, label: 'Read', detail: path };
    case 'write':
      return { kind, label: 'Write', detail: path };
    case 'edit':
      return {
        kind,
        label: name.toLowerCase().includes('notebook') ? 'Notebook' : 'Edit',
        detail: path,
      };
    case 'delete':
      return { kind, label: 'Delete', detail: path };
    case 'move': {
      const from = firstOf(i, ['from', 'source', 'old_path', 'oldPath', 'path']);
      const to = firstOf(i, ['to', 'dest', 'destination', 'new_path', 'newPath']);
      const detail = from && to ? `${from} → ${to}` : from || to || path;
      return { kind, label: 'Move', detail };
    }
    case 'glob': {
      const pat = firstOf(i, ['pattern', 'glob_pattern', 'globPattern', 'glob']);
      const target = firstOf(i, ['path', 'target_directory', 'targetDirectory', 'dir']);
      const detail = pat && target ? `${pat} in ${target}` : pat || target;
      return { kind, label: 'Glob', detail };
    }
    case 'grep': {
      const pat = firstOf(i, ['pattern', 'regex', 'query']);
      const target = firstOf(i, ['path', 'file_path', 'target_directory', 'targetDirectory', 'dir']);
      const glob = firstOf(i, ['glob', 'glob_pattern', 'globPattern']);
      const where = [target, glob].filter(Boolean).join(' ');
      const detail = pat && where ? `${pat} in ${where}` : pat || where;
      return { kind, label: 'Grep', detail };
    }
    case 'search': {
      const q = firstOf(i, ['query', 'pattern', 'search_term', 'searchTerm']);
      const target = firstOf(i, ['path', 'file_path', 'target_directory', 'targetDirectory', 'dir']);
      const detail = q && target ? `${q} in ${target}` : q || target;
      return { kind, label: 'Search', detail };
    }
    case 'webfetch':
      return { kind, label: 'Fetch', detail: firstOf(i, ['url', 'uri']) };
    case 'websearch':
      return { kind, label: 'Search', detail: firstOf(i, ['query', 'search_term', 'searchTerm']) };
    case 'todo': {
      const n = Array.isArray(i.todos) ? i.todos.length : undefined;
      return { kind, label: 'Update todos', detail: n != null ? `${n} items` : undefined };
    }
    case 'plan': {
      const n = Array.isArray(i.allowedPrompts) ? i.allowedPrompts.length : undefined;
      return { kind, label: 'Plan', detail: n ? `${n} permissions` : undefined };
    }
    case 'task': {
      const sub = firstOf(i, ['subagent_type', 'subagentType', 'agent']);
      const desc = firstOf(i, ['description', 'prompt']);
      return {
        kind,
        label: sub ? `Task: ${sub}` : 'Task',
        detail: desc,
      };
    }
    case 'lints':
      return { kind, label: 'Lints', detail: pathsDetail(i) || path };
    case 'image':
      return {
        kind,
        label: 'Image',
        detail: firstOf(i, ['filename', 'description', 'path', 'file_path']),
      };
    case 'mode':
      return {
        kind,
        label: 'Switch mode',
        detail: firstOf(i, ['target_mode_id', 'targetModeId', 'mode']),
      };
    case 'mcp': {
      const server = firstOf(i, ['server']);
      const tool = firstOf(i, ['toolName', 'tool_name', 'name']);
      const uri = firstOf(i, ['uri', 'url']);
      const detail = [server, tool || uri].filter(Boolean).join(' · ') || uri;
      return { kind, label: 'MCP', detail };
    }
    default:
      return {
        kind,
        label: name,
        detail:
          typeof input === 'object' && input != null
            ? fallbackDetail(i)
            : input != null
              ? String(input)
              : undefined,
      };
  }
}

/** Inline-code span that safely contains its own backticks (CommonMark rule). */
function mdInlineCode(s: string): string {
  const maxRun = s.match(/`+/g)?.reduce((m, r) => Math.max(m, r.length), 0) ?? 0;
  const ticks = '`'.repeat(maxRun + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${ticks}${pad}${s}${pad}${ticks}`;
}

/** Fenced code block; inner ``` is backslash-escaped so it can't close the fence. */
function mdCodeBlock(s: string): string {
  return '```\n' + s.replace(/```/g, '\\`\\`\\`') + '\n```';
}

/**
 * Markdown summary for streamed chat lines: the tool name (label) is **bold**;
 * the detail is inline code, or a fenced block for multi-line commands (Terminal).
 */
export function formatToolCallMd(name: string, input: unknown): string {
  const { label, detail, kind } = toolCallMeta(name, input);
  if (!detail) return `**${label}**`;
  if (kind === 'bash' || detail.includes('\n')) {
    return `**${label}**\n${mdCodeBlock(detail.trimEnd())}`;
  }
  return `**${label}** ${mdInlineCode(detail)}`;
}

/** HTML summary (permission prompts): tool name in <b>, detail escaped. */
export function formatToolCallHtml(name: string, input: unknown): string {
  const { label, detail } = toolCallMeta(name, input);
  const bold = `<b>${escHtml(label)}</b>`;
  return detail ? `${bold} ${escHtml(detail)}` : bold;
}

/** True when the call has no useful detail yet (ACP empty rawInput). */
export function isBareToolCall(name: string, input: unknown): boolean {
  return !toolCallMeta(name, input).detail;
}
