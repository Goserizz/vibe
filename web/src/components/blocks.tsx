import { memo, useLayoutEffect, useRef, useState } from 'react';
import {
  Brain,
  ChevronRight,
  Terminal,
  FileText,
  FilePen,
  Search,
  Globe,
  Wrench,
  CircleAlert,
  Loader2,
  Check,
  ListTodo,
  ClipboardList,
  Trash2,
  Image,
  ArrowLeftRight,
  Clock,
  RefreshCw,
} from '../lib/icons';
import type {
  AssistantBlock,
  ChatBlock,
  ErrorBlock,
  ResultBlock,
  SystemBlock,
  ThinkingBlock,
  ToolBlock,
  UserBlock,
} from '@shared/protocol';
import { Markdown } from './Markdown';
import { beijingClock, cn, formatTokens } from '../lib/format';
import { stripAttachments } from '../lib/attachments';

export const BlockView = memo(function BlockView({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case 'user':
      return <UserView block={block} />;
    case 'assistant':
      return <AssistantView block={block} />;
    case 'thinking':
      return <ThinkingView block={block} />;
    case 'tool':
      return <ToolView block={block} />;
    case 'result':
      return <ResultView block={block} />;
    case 'error':
      return <ErrorView block={block} />;
    case 'system':
      return <SystemView block={block} />;
    default:
      return null;
  }
});

function UserView({ block }: { block: UserBlock }) {
  // Hide the attachment boilerplate block the Composer folds into the prompt
  // (the agent still sees it; the user just sees what they typed). If the
  // message was attachments-only, keep the bubble from going empty.
  const { text, files } = stripAttachments(block.text);
  const display = text.trim() || (files.length ? `📎 ${files.length} file${files.length > 1 ? 's' : ''} attached` : '');
  return (
    <div className="flex justify-end animate-fade-in">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-[14.5px] leading-relaxed text-slate-100">
        {display}
      </div>
    </div>
  );
}

function AssistantView({ block }: { block: AssistantBlock }) {
  if (!block.text && block.streaming) return null;
  return (
    <div className="animate-fade-in">
      <Markdown>{block.text}</Markdown>
    </div>
  );
}

function ThinkingView({ block }: { block: ThinkingBlock }) {
  // Auto-expand while thinking, auto-collapse once done; a manual toggle overrides.
  const [manual, setManual] = useState<boolean | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const open = manual ?? block.streaming;

  // Stream the full reasoning as it arrives — no per-paragraph paging.
  const displayText = block.text;

  // The preview grows with the text up to a cap; once the text overflows that
  // cap, pin the height and scroll to the newest line so only the latest
  // content shows. While it hasn't filled the box yet, leave it top-aligned.
  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight > el.clientHeight + 1 ? el.scrollHeight : 0;
  }, [displayText, open]);

  if (!block.text) return null;

  return (
    <div className="animate-fade-in rounded-xl border border-white/5 bg-ink-900/40">
      <button
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-slate-500 transition hover:text-slate-300"
      >
        <Brain className={cn('h-3.5 w-3.5', block.streaming && 'animate-pulse-dot text-accent')} />
        <span className={cn(block.streaming && 'thinking-shimmer')}>
          {block.streaming ? 'Thinking…' : 'Thought process'}
        </span>
        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div
          ref={viewportRef}
          className={cn(
            'border-t border-white/5',
            block.streaming && 'max-h-28 overflow-hidden',
          )}
        >
          <div className="whitespace-pre-wrap break-words px-3 py-2.5 font-mono text-[12px] leading-relaxed text-slate-500">
            {displayText}
          </div>
        </div>
      )}
    </div>
  );
}

interface ToolMeta {
  icon: typeof Terminal;
  label: string;
  detail?: string;
}

/** Canonical display kind for a tool, engine-agnostic. Claude, Cursor, Codex and Kimi
 *  name the same actions differently (Claude `Bash` vs Cursor `Shell`, or Claude
 *  `file_path` vs Cursor `path`), and Cursor wraps results in a JSON envelope.
 *  Collapsing the name to a kind lets one set of icons/labels/details and one
 *  result renderer cover every engine. */
type ToolKind =
  | 'read' | 'edit' | 'write' | 'delete' | 'move' | 'bash' | 'await' | 'glob' | 'grep'
  | 'search' | 'webfetch' | 'websearch' | 'todo' | 'task' | 'plan' | 'lints'
  | 'image' | 'mode' | 'mcp' | 'other';

const TOOL_KIND_ALIASES: Record<string, ToolKind> = {
  read: 'read', readfile: 'read', fsread: 'read',
  edit: 'edit', editfile: 'edit', multiedit: 'edit', strreplace: 'edit',
  editnotebook: 'edit', notebookedit: 'edit',
  write: 'write', writefile: 'write', createfile: 'write', fswrite: 'write',
  delete: 'delete', deletefile: 'delete', removefile: 'delete',
  move: 'move', movefile: 'move', rename: 'move', renamefile: 'move',
  bash: 'bash', shell: 'bash', runterminalcommand: 'bash', terminal: 'bash', runcommand: 'bash', execute: 'bash',
  executebash: 'bash',
  awaitshell: 'await', await: 'await',
  glob: 'glob', listdir: 'glob', listdirectory: 'glob', ls: 'glob', findfiles: 'glob',
  grep: 'grep', searchfiles: 'grep', ripgrep: 'grep',
  semsearch: 'search', codebasesearch: 'search', semanticsearch: 'search', directorysearch: 'search',
  webfetch: 'webfetch', fetch: 'webfetch', fetchweb: 'webfetch',
  websearch: 'websearch', searchweb: 'websearch',
  todowrite: 'todo', todo: 'todo', updatetodo: 'todo', todolist: 'todo', tasklist: 'todo',
  task: 'task', subagent: 'task',
  exitplanmode: 'plan',
  readlints: 'lints', getdiagnostics: 'lints', diagnostics: 'lints',
  generateimage: 'image', image: 'image',
  switchmode: 'mode',
  listmcpresources: 'mcp', fetchmcpresource: 'mcp', callmcptool: 'mcp',
};

export function toolKind(name: string): ToolKind {
  const key = String(name ?? '').toLowerCase().replace(/[_\-\s]/g, '');
  return TOOL_KIND_ALIASES[key] ?? 'other';
}

export type EditChange = { op: '+' | '-'; text: string };

function looksLikeUnifiedDiff(text: string): boolean {
  return text.includes('@@') || text.startsWith('---') || text.startsWith('diff ');
}

/** Added/removed lines only — no file headers, hunk marks, or context. */
export function editChangeLines(resultText: string, input: unknown): EditChange[] {
  let text = resultText;
  if (text.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      if (parsed && typeof parsed.diffString === 'string') text = parsed.diffString;
    } catch {
      /* not a JSON envelope */
    }
  }
  if (text && looksLikeUnifiedDiff(text)) {
    const out: EditChange[] = [];
    for (const line of text.split('\n')) {
      if (
        line.startsWith('+++') ||
        line.startsWith('---') ||
        line.startsWith('@@') ||
        line.startsWith('diff ') ||
        line.startsWith('index ')
      ) {
        continue;
      }
      if (line.startsWith('+')) out.push({ op: '+', text: line.slice(1) });
      else if (line.startsWith('-')) out.push({ op: '-', text: line.slice(1) });
    }
    if (out.length) return out;
  }
  if (input && typeof input === 'object') {
    const i = input as Record<string, unknown>;
    const oldS = [i.old_string, i.oldString, i.old_str].find((v) => typeof v === 'string') as string | undefined;
    const newS = [i.new_string, i.newString, i.new_str].find((v) => typeof v === 'string') as string | undefined;
    if (oldS != null && newS != null) {
      return [
        ...oldS.split('\n').map((text) => ({ op: '-' as const, text })),
        ...newS.split('\n').map((text) => ({ op: '+' as const, text })),
      ];
    }
    if (Array.isArray(i.edits)) {
      const out: EditChange[] = [];
      for (const entry of i.edits) {
        if (!entry || typeof entry !== 'object') continue;
        const e = entry as Record<string, unknown>;
        const o = [e.old_string, e.oldString, e.old_str].find((v) => typeof v === 'string') as string | undefined;
        const n = [e.new_string, e.newString, e.new_str].find((v) => typeof v === 'string') as string | undefined;
        if (o == null || n == null) continue;
        out.push(
          ...o.split('\n').map((text) => ({ op: '-' as const, text })),
          ...n.split('\n').map((text) => ({ op: '+' as const, text })),
        );
      }
      if (out.length) return out;
    }
  }
  return [];
}

const WRITE_CONTENT_KEYS = ['contents', 'content', 'file_text', 'fileText', 'text'];

function pickStringField(src: unknown, keys: string[]): string | undefined {
  if (!src || typeof src !== 'object') return undefined;
  const o = src as Record<string, unknown>;
  const v = keys.map((k) => o[k]).find((x) => typeof x === 'string');
  return typeof v === 'string' ? v : undefined;
}

/** Write is all additions — show the new file in green. */
export function writeChangeLines(resultText: string, input: unknown): EditChange[] {
  let content = pickStringField(input, WRITE_CONTENT_KEYS);
  if (content == null && resultText.trim().startsWith('{')) {
    try {
      content = pickStringField(JSON.parse(resultText), WRITE_CONTENT_KEYS);
    } catch {
      /* ignore */
    }
  }
  if (content != null) return content.split('\n').map((text) => ({ op: '+' as const, text }));
  return editChangeLines(resultText, input);
}

export function CompactEditDiff({ changes, className }: { changes: EditChange[]; className?: string }) {
  if (changes.length === 0) return null;
  return (
    <pre className={cn('min-w-0 overflow-auto whitespace-pre-wrap break-words font-mono', className)}>
      {changes.map((c, idx) => (
        <div key={idx} className={c.op === '+' ? 'text-emerald-300' : 'text-rose-300'}>
          {c.op}
          {c.text || ' '}
        </div>
      ))}
    </pre>
  );
}

/** First non-empty value among the given keys — detail extraction then works
 *  across engines whose arg field names differ (file_path / path / relativePath). */
function firstOf(obj: Record<string, any>, keys: string[]): string | undefined {
  for (const k of keys) {
    const v = obj?.[k];
    if (v != null && v !== '') return String(v);
  }
  return undefined;
}

function pathsDetail(i: Record<string, any>): string | undefined {
  const paths = Array.isArray(i.paths) ? i.paths.map(String).filter(Boolean) : [];
  if (paths.length === 1) return paths[0];
  if (paths.length > 1) return `${paths.length} paths`;
  return undefined;
}

/** Best-effort one-line detail for unknown / sparsely-mapped tools. */
function fallbackDetail(i: Record<string, any>): string | undefined {
  return (
    pathsDetail(i) ||
    firstOf(i, [
      'command', 'cmd',
      'file_path', 'path', 'relativePath', 'filePath', 'target_file', 'target_notebook',
      'filename', 'uri', 'url',
      'query', 'search_term', 'searchTerm', 'pattern', 'glob_pattern', 'globPattern', 'regex',
      'description', 'prompt', 'title', 'explanation',
      'target_mode_id', 'targetModeId', 'mode',
      'server', 'toolName', 'tool_name', 'name',
      'shell_id', 'shellId',
    ])
  );
}

export function toolMeta(name: string, input: unknown): ToolMeta {
  const i = (input ?? {}) as Record<string, any>;
  const path = firstOf(i, [
    'file_path', 'path', 'relativePath', 'filePath', 'target_file', 'target_notebook',
  ]);
  switch (toolKind(name)) {
    case 'bash':
      return { icon: Terminal, label: 'Terminal', detail: firstOf(i, ['command', 'cmd']) };
    case 'await':
      return {
        icon: Clock,
        label: 'Await',
        detail: firstOf(i, ['shell_id', 'shellId', 'pattern', 'command', 'cmd']),
      };
    case 'read':
      return { icon: FileText, label: 'Read', detail: path };
    case 'write':
      return { icon: FilePen, label: 'Write', detail: path };
    case 'edit':
      return { icon: FilePen, label: name.toLowerCase().includes('notebook') ? 'Notebook' : 'Edit', detail: path };
    case 'delete':
      return { icon: Trash2, label: 'Delete', detail: path };
    case 'move': {
      const from = firstOf(i, ['from', 'source', 'old_path', 'oldPath', 'path']);
      const to = firstOf(i, ['to', 'dest', 'destination', 'new_path', 'newPath']);
      const detail = from && to ? `${from} → ${to}` : from || to || path;
      return { icon: ArrowLeftRight, label: 'Move', detail };
    }
    case 'glob': {
      const pat = firstOf(i, ['pattern', 'glob_pattern', 'globPattern', 'glob']);
      const target = firstOf(i, ['path', 'target_directory', 'targetDirectory', 'dir']);
      const detail = pat && target ? `${pat} in ${target}` : pat || target;
      return { icon: Search, label: 'Glob', detail };
    }
    case 'grep': {
      const pat = firstOf(i, ['pattern', 'regex', 'query']);
      const target = firstOf(i, ['path', 'file_path', 'target_directory', 'targetDirectory', 'dir']);
      const glob = firstOf(i, ['glob', 'glob_pattern', 'globPattern']);
      const where = [target, glob].filter(Boolean).join(' ');
      const detail = pat && where ? `${pat} in ${where}` : pat || where;
      return { icon: Search, label: 'Grep', detail };
    }
    case 'search': {
      const q = firstOf(i, ['query', 'pattern', 'search_term', 'searchTerm']);
      const target = firstOf(i, ['path', 'file_path', 'target_directory', 'targetDirectory', 'dir']);
      const detail = q && target ? `${q} in ${target}` : q || target;
      return { icon: Search, label: 'Search', detail };
    }
    case 'webfetch':
      return { icon: Globe, label: 'Fetch', detail: firstOf(i, ['url', 'uri']) };
    case 'websearch':
      return { icon: Globe, label: 'Search', detail: firstOf(i, ['query', 'search_term', 'searchTerm']) };
    case 'todo': {
      // Claude sends a full snapshot (`todos`); Kiro sends a command plus the
      // affected tasks (`create` / `add` / `complete` / `remove`).
      const items = Array.isArray(i.todos) ? i.todos : Array.isArray(i.tasks) ? i.tasks : Array.isArray(i.new_tasks) ? i.new_tasks : null;
      if (items) return { icon: ListTodo, label: 'Update todos', detail: `${items.length} items` };
      const done = Array.isArray(i.completed_task_ids) ? i.completed_task_ids.map(String) : [];
      if (done.length) return { icon: ListTodo, label: 'Update todos', detail: `completed #${done.join(', #')}` };
      const removed = Array.isArray(i.remove_task_ids) ? i.remove_task_ids.length : 0;
      if (removed) return { icon: ListTodo, label: 'Update todos', detail: `removed ${removed}` };
      return { icon: ListTodo, label: 'Update todos', detail: firstOf(i, ['command']) };
    }
    case 'plan':
      return { icon: ClipboardList, label: 'Plan', detail: Array.isArray(i.allowedPrompts) && i.allowedPrompts.length ? `${i.allowedPrompts.length} permissions` : undefined };
    case 'task': {
      const sub = firstOf(i, ['subagent_type', 'subagentType', 'agent']);
      return {
        icon: Wrench,
        label: sub ? `Task: ${sub}` : 'Task',
        detail: firstOf(i, ['description', 'prompt']),
      };
    }
    case 'lints':
      return { icon: CircleAlert, label: 'Lints', detail: pathsDetail(i) || path };
    case 'image':
      return {
        icon: Image,
        label: 'Image',
        detail: firstOf(i, ['filename', 'description', 'path', 'file_path']),
      };
    case 'mode':
      return {
        icon: ArrowLeftRight,
        label: 'Switch mode',
        detail: firstOf(i, ['target_mode_id', 'targetModeId', 'mode']),
      };
    case 'mcp': {
      const server = firstOf(i, ['server']);
      const tool = firstOf(i, ['toolName', 'tool_name', 'name']);
      const uri = firstOf(i, ['uri', 'url']);
      const detail = [server, tool || uri].filter(Boolean).join(' · ') || uri;
      return { icon: Wrench, label: 'MCP', detail };
    }
    default:
      return {
        icon: Wrench,
        label: name,
        detail: typeof input === 'object' && input != null ? fallbackDetail(i) : input != null ? String(input) : undefined,
      };
  }
}

function ToolView({ block }: { block: ToolBlock }) {
  const kind = toolKind(block.name);
  const fileChanges =
    kind === 'edit'
      ? editChangeLines(block.result ?? '', block.input)
      : kind === 'write'
        ? writeChangeLines(block.result ?? '', block.input)
        : [];
  const [manual, setManual] = useState<boolean | null>(null);
  const open = manual ?? fileChanges.length > 0;
  const meta = toolMeta(block.name, block.input);
  const Icon = meta.icon;

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/50">
      <button
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2.5 px-3 py-2 text-left transition hover:bg-ink-800/40"
      >
        <Icon className="h-4 w-4 shrink-0 text-slate-500" />
        <span className="shrink-0 text-[12.5px] font-medium text-slate-300">{meta.label}</span>
        {meta.detail && (
          <span className="truncate font-mono text-[12px] text-slate-500">{meta.detail}</span>
        )}
        <span className="ml-auto flex shrink-0 items-center gap-1.5">
          <StatusDot block={block} />
          <ChevronRight className={cn('h-3.5 w-3.5 text-slate-600 transition-transform', open && 'rotate-90')} />
        </span>
      </button>
      {open && (
        <div className="space-y-2 border-t border-white/5 px-3 py-2.5">
          {fileChanges.length > 0 ? (
            <CompactEditDiff changes={fileChanges} className="max-h-80 text-[12px] leading-relaxed" />
          ) : (
            <>
              <pre className="overflow-x-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[12px] leading-relaxed text-slate-400">
                {JSON.stringify(block.input, null, 2)}
              </pre>
              <ToolResultBody block={block} />
            </>
          )}
        </div>
      )}
    </div>
  );
}

/** Parses `s` as JSON, or returns null. Cursor's results arrive as a JSON
 *  envelope string; Claude's are already plain text (so this returns null). */
function tryJson(s: string | undefined): any | null {
  if (!s) return null;
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** Renders a tool result, pulling the meaningful payload out of Cursor's JSON
 *  envelope (file content for reads) so Cursor shows what it actually did.
 *  Falls back to the raw result text for Claude and anything unrecognized. */
function ToolResultBody({ block }: { block: ToolBlock }) {
  const raw = block.result ?? '';
  const kind = toolKind(block.name);
  const parsed = tryJson(raw);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const p = parsed as Record<string, any>;
    if (
      kind === 'read' &&
      typeof p.content === 'string' &&
      (p.totalLines != null || p.isEmpty != null || p.exceededLimit != null || p.fileSize != null || p.readRange != null)
    ) {
      return <ReadContentView content={p.content} meta={p} isError={block.isError} />;
    }
    // Vibot run_command (and similar) returns { exitCode, output, timedOut, … }.
    if (kind === 'bash' && typeof p.output === 'string' && ('exitCode' in p || 'timedOut' in p || p.denied)) {
      const status = p.denied
        ? `denied — ${p.reason ?? 'blocked'}`
        : [
            p.timedOut ? 'timed out' : null,
            p.exitCode != null ? `exit ${p.exitCode}` : null,
            p.truncated ? 'truncated' : null,
            p.host ? `@ ${p.host}` : null,
          ]
            .filter(Boolean)
            .join(' · ');
      return (
        <div className="space-y-1.5">
          {status && (
            <div className={cn('font-mono text-[11px]', p.denied || p.timedOut || block.isError ? 'text-rose-400' : 'text-slate-500')}>
              {status}
            </div>
          )}
          {p.output ? (
            <pre
              className={cn(
                'code-block max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-2.5 font-mono text-[12px] leading-relaxed',
                block.isError || p.denied ? 'text-rose-300' : 'text-slate-400',
              )}
            >
              {p.output}
            </pre>
          ) : p.denied ? null : (
            <div className="font-mono text-[11px] text-slate-600">(no output)</div>
          )}
        </div>
      );
    }
  }

  if (!raw) return null;
  return (
    <pre
      className={cn(
        'max-h-80 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-2.5 font-mono text-[12px] leading-relaxed',
        block.isError ? 'text-rose-300' : 'text-slate-400',
      )}
    >
      {raw}
    </pre>
  );
}

/** File-content renderer with a line-number gutter (Cursor's Read content has
 *  no numbers of its own; Claude's already ships `cat -n` numbers in the text). */
function ReadContentView({
  content,
  meta,
  isError,
}: {
  content: string;
  meta: Record<string, any>;
  isError?: boolean;
}) {
  const lines = content.split('\n');
  const total = typeof meta.totalLines === 'number' ? meta.totalLines : lines.length;
  const gutterWidth = `${String(total).length}ch`;
  const showHeader = meta.totalLines != null;
  return (
    <div className="overflow-hidden rounded-lg border border-white/5 bg-ink-950">
      {showHeader && (
        <div className="border-b border-white/5 px-3 py-1.5 font-mono text-[11px] text-slate-500">
          {meta.totalLines} lines{typeof meta.fileSize === 'number' ? `  ·  ${formatBytes(meta.fileSize)}` : ''}
        </div>
      )}
      <div
        className={cn(
          'max-h-80 overflow-auto py-1.5 font-mono text-[12px] leading-relaxed',
          isError && 'text-rose-300',
        )}
      >
        {lines.map((ln, idx) => (
          <div key={idx} className="flex px-3">
            <span
              className="mr-3 shrink-0 select-none text-right text-slate-600"
              style={{ width: gutterWidth }}
            >
              {idx + 1}
            </span>
            <span className="whitespace-pre-wrap break-words text-slate-400">{ln || ' '}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function StatusDot({ block }: { block: ToolBlock }) {
  if (block.status === 'running') return <Loader2 className="h-3.5 w-3.5 animate-spin text-accent" />;
  if (block.status === 'error') return <CircleAlert className="h-3.5 w-3.5 text-rose-400" />;
  return <Check className="h-3.5 w-3.5 text-emerald-400/70" />;
}

function ResultView({ block }: { block: ResultBlock }) {
  // Cost is deliberately not shown — only how long the turn ran, when it ended,
  // and the API-reported context size. The turn separator above the next user
  // message draws the boundary line, so this renders as a plain footnote.
  const parts: string[] = [];
  if (typeof block.durationMs === 'number') parts.push(`${(block.durationMs / 1000).toFixed(1)}s`);
  const ended = beijingClock(block.ts);
  if (ended) parts.push(ended);
  const used = formatTokens(block.contextUsed ?? 0);
  if (used) {
    const window = formatTokens(block.contextWindow ?? 0);
    parts.push(window ? `${used} / ${window} tokens` : `${used} tokens`);
  }
  if (!parts.length) return null;
  return <div className="py-1 text-[11px] text-slate-600">{parts.join(' · ')}</div>;
}

function ErrorView({ block }: { block: ErrorBlock }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/20 bg-rose-500/5 px-3.5 py-3 text-[13px] text-rose-300 animate-fade-in">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="whitespace-pre-wrap">{block.text}</div>
    </div>
  );
}

/** Muted engine notice as a dashed divider — e.g. a background task woke the agent. */
function SystemView({ block }: { block: SystemBlock }) {
  return (
    <div className="flex animate-fade-in items-center gap-3 px-3 py-1.5">
      <span className="min-w-8 flex-1 border-t border-dashed border-white/10" />
      <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-slate-500">
        <RefreshCw className="h-3 w-3" />
        {block.text}
        <span>· {beijingClock(block.ts)}</span>
      </span>
      <span className="min-w-8 flex-1 border-t border-dashed border-white/10" />
    </div>
  );
}
