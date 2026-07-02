import { memo, useState } from 'react';
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
} from 'lucide-react';
import type {
  AssistantBlock,
  ChatBlock,
  ErrorBlock,
  ResultBlock,
  ThinkingBlock,
  ToolBlock,
  UserBlock,
} from '@shared/protocol';
import { Markdown } from './Markdown';
import { cn, formatTokens } from '../lib/format';

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
    default:
      return null;
  }
});

function UserView({ block }: { block: UserBlock }) {
  return (
    <div className="flex justify-end animate-fade-in">
      <div className="max-w-[85%] whitespace-pre-wrap break-words rounded-2xl rounded-br-md bg-accent/15 px-4 py-2.5 text-[14.5px] leading-relaxed text-slate-100">
        {block.text}
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
  if (!block.text) return null;
  const open = manual ?? block.streaming;
  return (
    <div className="animate-fade-in rounded-xl border border-white/5 bg-ink-900/40">
      <button
        onClick={() => setManual(!open)}
        className="flex w-full items-center gap-2 px-3 py-2 text-left text-[12px] font-medium text-slate-500 transition hover:text-slate-300"
      >
        <Brain className={cn('h-3.5 w-3.5', block.streaming && 'animate-pulse-dot text-accent')} />
        <span>{block.streaming ? 'Thinking…' : 'Thought process'}</span>
        <ChevronRight className={cn('ml-auto h-3.5 w-3.5 transition-transform', open && 'rotate-90')} />
      </button>
      {open && (
        <div className="whitespace-pre-wrap break-words border-t border-white/5 px-3 py-2.5 font-mono text-[12px] leading-relaxed text-slate-500">
          {block.text}
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

/** Canonical display kind for a tool, engine-agnostic. Claude, Cursor and Codex
 *  name the same actions differently (Claude `Bash` vs Cursor `Shell`, or Claude
 *  `file_path` vs Cursor `path`), and Cursor wraps results in a JSON envelope.
 *  Collapsing the name to a kind lets one set of icons/labels/details and one
 *  result renderer cover every engine. */
type ToolKind =
  | 'read' | 'edit' | 'write' | 'bash' | 'glob' | 'grep'
  | 'search' | 'webfetch' | 'websearch' | 'todo' | 'task' | 'plan' | 'other';

const TOOL_KIND_ALIASES: Record<string, ToolKind> = {
  read: 'read', readfile: 'read',
  edit: 'edit', editfile: 'edit', multiedit: 'edit', strreplace: 'edit',
  write: 'write', writefile: 'write', createfile: 'write',
  bash: 'bash', shell: 'bash', runterminalcommand: 'bash', terminal: 'bash', runcommand: 'bash',
  glob: 'glob', listdir: 'glob', listdirectory: 'glob', ls: 'glob', findfiles: 'glob',
  grep: 'grep', searchfiles: 'grep', ripgrep: 'grep',
  semsearch: 'search', codebasesearch: 'search', semanticsearch: 'search', directorysearch: 'search',
  webfetch: 'webfetch', fetch: 'webfetch', fetchweb: 'webfetch',
  websearch: 'websearch', searchweb: 'websearch',
  todowrite: 'todo', todo: 'todo', updatetodo: 'todo',
  task: 'task', subagent: 'task',
  exitplanmode: 'plan',
};

export function toolKind(name: string): ToolKind {
  const key = String(name ?? '').toLowerCase().replace(/[_\-\s]/g, '');
  return TOOL_KIND_ALIASES[key] ?? 'other';
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

export function toolMeta(name: string, input: unknown): ToolMeta {
  const i = (input ?? {}) as Record<string, any>;
  const path = firstOf(i, ['file_path', 'path', 'relativePath', 'filePath']);
  switch (toolKind(name)) {
    case 'bash':
      return { icon: Terminal, label: 'Terminal', detail: firstOf(i, ['command', 'cmd']) };
    case 'read':
      return { icon: FileText, label: 'Read', detail: path };
    case 'write':
      return { icon: FilePen, label: 'Write', detail: path };
    case 'edit':
      return { icon: FilePen, label: 'Edit', detail: path };
    case 'glob':
      return { icon: Search, label: 'Glob', detail: firstOf(i, ['pattern', 'globPattern']) };
    case 'grep':
      return { icon: Search, label: 'Grep', detail: firstOf(i, ['pattern', 'regex', 'query']) };
    case 'search':
      return { icon: Search, label: 'Search', detail: firstOf(i, ['query']) };
    case 'webfetch':
      return { icon: Globe, label: 'Fetch', detail: firstOf(i, ['url']) };
    case 'websearch':
      return { icon: Globe, label: 'Search', detail: firstOf(i, ['query']) };
    case 'todo':
      return { icon: ListTodo, label: 'Update todos', detail: Array.isArray(i.todos) ? `${i.todos.length} items` : undefined };
    case 'plan':
      return { icon: ClipboardList, label: 'Plan', detail: Array.isArray(i.allowedPrompts) && i.allowedPrompts.length ? `${i.allowedPrompts.length} permissions` : undefined };
    case 'task':
      return { icon: Wrench, label: `Task: ${i.subagent_type ?? ''}`.trim(), detail: i.description };
    default:
      return { icon: Wrench, label: name, detail: typeof input === 'object' ? undefined : String(input) };
  }
}

function ToolView({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(block.name, block.input);
  const Icon = meta.icon;

  return (
    <div className="animate-fade-in overflow-hidden rounded-xl border border-white/5 bg-ink-900/50">
      <button
        onClick={() => setOpen((o) => !o)}
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
          <pre className="overflow-x-auto rounded-lg bg-ink-950 p-2.5 font-mono text-[12px] leading-relaxed text-slate-400">
            {JSON.stringify(block.input, null, 2)}
          </pre>
          <ToolResultBody block={block} />
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

function editSummary(p: Record<string, any>): string | undefined {
  const add = typeof p.linesAdded === 'number' ? p.linesAdded : undefined;
  const rem = typeof p.linesRemoved === 'number' ? p.linesRemoved : undefined;
  if (add == null && rem == null) return undefined;
  return `+${add ?? 0} −${rem ?? 0} lines`;
}

/** Renders a tool result, pulling the meaningful payload out of Cursor's JSON
 *  envelope (a unified diff for edits, file content for reads) so Cursor shows
 *  what it actually did — matching (and for edits, exceeding) Claude's display.
 *  Falls back to the raw result text for Claude and anything unrecognized. */
function ToolResultBody({ block }: { block: ToolBlock }) {
  const raw = block.result ?? '';
  const kind = toolKind(block.name);
  const parsed = tryJson(raw);

  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    const p = parsed as Record<string, any>;
    // Edit: Cursor returns a unified diff. Require it to actually look like one
    // so we never misread a JSON file the model happened to Read.
    if (kind === 'edit' && typeof p.diffString === 'string') {
      const d = p.diffString;
      if (d.trim() && (d.includes('@@') || d.startsWith('---'))) {
        return <DiffView diff={d} summary={editSummary(p)} />;
      }
    }
    // Read: Cursor returns { content, totalLines, fileSize, ... }. Gate on the
    // envelope markers so a JSON file with a `content` key isn't misread.
    if (
      kind === 'read' &&
      typeof p.content === 'string' &&
      (p.totalLines != null || p.isEmpty != null || p.exceededLimit != null || p.fileSize != null || p.readRange != null)
    ) {
      return <ReadContentView content={p.content} meta={p} isError={block.isError} />;
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

/** Line-by-line unified-diff renderer (added lines green, removed red). */
function DiffView({ diff, summary }: { diff: string; summary?: string }) {
  const lines = diff.split('\n');
  return (
    <div className="overflow-hidden rounded-lg border border-white/5 bg-ink-950">
      {summary && (
        <div className="border-b border-white/5 px-3 py-1.5 font-mono text-[11px] text-slate-500">{summary}</div>
      )}
      <div className="max-h-80 overflow-auto py-1.5 font-mono text-[12px] leading-relaxed">
        {lines.map((ln, idx) => {
          let cls = 'text-slate-500';
          if (ln.startsWith('+++') || ln.startsWith('---')) cls = 'text-slate-400';
          else if (ln.startsWith('@@')) cls = 'text-accent/80';
          else if (ln.startsWith('+')) cls = 'bg-emerald-500/10 text-emerald-300';
          else if (ln.startsWith('-')) cls = 'bg-rose-500/10 text-rose-300';
          return (
            <div key={idx} className={cn('whitespace-pre-wrap break-words px-3', cls)}>
              {ln || ' '}
            </div>
          );
        })}
      </div>
    </div>
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
  const parts: string[] = [];
  if (block.usage) parts.push(`${formatTokens(block.usage.contextUsed)} ctx`);
  if (typeof block.costUsd === 'number' && block.costUsd > 0) parts.push(`$${block.costUsd.toFixed(4)}`);
  if (typeof block.durationMs === 'number') parts.push(`${(block.durationMs / 1000).toFixed(1)}s`);
  if (parts.length === 0) return null;
  return (
    <div className="flex items-center gap-2 py-1 text-[11px] text-slate-600">
      <span className="h-px flex-1 bg-white/5" />
      <span>{parts.join('  ·  ')}</span>
      <span className="h-px flex-1 bg-white/5" />
    </div>
  );
}

function ErrorView({ block }: { block: ErrorBlock }) {
  return (
    <div className="flex items-start gap-2.5 rounded-xl border border-rose-500/20 bg-rose-500/5 px-3.5 py-3 text-[13px] text-rose-300 animate-fade-in">
      <CircleAlert className="mt-0.5 h-4 w-4 shrink-0" />
      <div className="whitespace-pre-wrap">{block.text}</div>
    </div>
  );
}
