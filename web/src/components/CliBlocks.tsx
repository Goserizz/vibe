import { memo, useLayoutEffect, useRef, useState } from 'react';
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
import { CompactEditDiff, editChangeLines, toolKind, toolMeta, writeChangeLines } from './blocks';
import { parseList, todoSnapshotFromBlock } from './TodoPane';
import { beijingClock, cn, formatTokens } from '../lib/format';
import { stripAttachments } from '../lib/attachments';

/**
 * Terminal-transcript rendering of the same structured blocks the card UI
 * uses. Layout and glyphs follow the coding-agent CLIs (Claude Code / Cursor /
 * Codex / Grok): `❯` for the user, `■` for tools, a stretching `└` bracket
 * (.cli-bracket) for results, dim italic
 * for thinking. Assistant prose has no gutter glyph.
 */
export const CliBlockView = memo(function CliBlockView({ block }: { block: ChatBlock }) {
  switch (block.kind) {
    case 'user':
      return <CliUserView block={block} />;
    case 'assistant':
      return <CliAssistantView block={block} />;
    case 'thinking':
      return <CliThinkingView block={block} />;
    case 'tool':
      return <CliToolView block={block} />;
    case 'result':
      return <CliResultView block={block} />;
    case 'error':
      return <CliErrorView block={block} />;
    default:
      return null;
  }
});

function CliUserView({ block }: { block: UserBlock }) {
  const { text, files } = stripAttachments(block.text);
  const display =
    text.trim() || (files.length ? `${files.length} file${files.length > 1 ? 's' : ''} attached` : '');
  return (
    <div className="cli-turn mt-5 font-mono text-[13.5px] leading-relaxed first:mt-0">
      <div className="flex items-start gap-2">
        <span className="cli-gutter select-none text-accent">❯</span>
        <div className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-100">{display}</div>
      </div>
    </div>
  );
}

function CliAssistantView({ block }: { block: AssistantBlock }) {
  if (!block.text && !block.streaming) return null;
  return (
    <div className={cn('cli-md', block.streaming && 'cli-md--streaming')}>
      {block.text ? <Markdown>{block.text}</Markdown> : <span className="cli-cursor" aria-hidden />}
    </div>
  );
}

function CliThinkingView({ block }: { block: ThinkingBlock }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const open = manual ?? block.streaming;
  const displayText = block.text;

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight > el.clientHeight + 1 ? el.scrollHeight : 0;
  }, [displayText, open]);

  if (!block.text) return null;

  return (
    <div className="font-mono text-[13px] leading-relaxed">
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="flex w-full items-start gap-2 text-left text-slate-500 transition hover:text-slate-300"
      >
        <span className="cli-gutter select-none">{block.streaming ? '✶' : '·'}</span>
        <span className={cn(block.streaming && 'thinking-shimmer')}>
          {block.streaming ? 'Thinking…' : 'Thought'}
        </span>
      </button>
      {open && (
        <div
          ref={viewportRef}
          className={cn(
            'whitespace-pre-wrap break-words pl-[1.75rem] text-[12.5px] italic text-slate-600',
            block.streaming && 'max-h-28 overflow-hidden',
          )}
        >
          {displayText}
        </div>
      )}
    </div>
  );
}

const CLI_TOOL_NAMES: Record<string, string> = {
  read: 'Read',
  edit: 'Edit',
  write: 'Write',
  delete: 'Delete',
  move: 'Move',
  bash: 'Bash',
  await: 'Await',
  glob: 'Glob',
  grep: 'Grep',
  search: 'Search',
  webfetch: 'WebFetch',
  websearch: 'WebSearch',
  todo: 'TodoWrite',
  task: 'Task',
  plan: 'ExitPlanMode',
  lints: 'ReadLints',
  image: 'Image',
  mode: 'SwitchMode',
  mcp: 'MCP',
};

function cliToolTitle(name: string, input: unknown): string {
  const kind = toolKind(name);
  const label = kind === 'other' || kind === 'mcp' ? name : CLI_TOOL_NAMES[kind] || name;
  const detail = toolMeta(name, input).detail;
  if (!detail) return label;
  const clipped = detail.length > 88 ? `${detail.slice(0, 85)}…` : detail;
  return `${label}(${clipped})`;
}

/** Pull a plain-text payload out of Cursor's JSON envelope so the transcript
 *  shows what the tool actually did, matching Claude's raw CLI output. */
function unwrapToolResult(block: ToolBlock): string {
  const raw = block.result ?? '';
  if (!raw) return '';
  const kind = toolKind(block.name);
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      if (kind === 'edit' && typeof parsed.diffString === 'string') {
        const d = parsed.diffString;
        if (d.trim() && (d.includes('@@') || d.startsWith('---'))) return d;
      }
      if (
        kind === 'read' &&
        typeof parsed.content === 'string' &&
        (parsed.totalLines != null || parsed.isEmpty != null || parsed.fileSize != null || parsed.readRange != null)
      ) {
        return parsed.content;
      }
      if (typeof parsed.stdout === 'string' || typeof parsed.stderr === 'string') {
        return `${parsed.stdout ?? ''}${parsed.stderr ?? ''}`;
      }
    }
  } catch {
    /* already plain text */
  }
  return raw;
}

function diffCounts(text: string): { add: number; rem: number } | null {
  if (!text.includes('@@') && !text.startsWith('---') && !text.startsWith('diff ')) return null;
  let add = 0;
  let rem = 0;
  for (const line of text.split('\n')) {
    if (line.startsWith('+') && !line.startsWith('+++')) add++;
    else if (line.startsWith('-') && !line.startsWith('---')) rem++;
  }
  if (add === 0 && rem === 0) return null;
  return { add, rem };
}

function toolSummary(block: ToolBlock, lines: string[], body: string): string {
  const kind = toolKind(block.name);
  if (block.status === 'running' && lines.length === 0) return 'Running…';
  if (kind === 'read' && lines.length > 0) {
    return `Read ${lines.length} line${lines.length === 1 ? '' : 's'}`;
  }
  const counts = kind === 'edit' ? diffCounts(body) : null;
  if (counts) return `+${counts.add} −${counts.rem}`;
  if (lines.length === 0) return block.status === 'error' ? 'Error' : 'Done';
  const joined = lines.join('\n');
  if (lines.length <= 2 && joined.length < 180) return joined;
  if (block.isError) return (lines[0] ?? '').trim() || 'Error';
  return `${lines.length} lines`;
}

interface CliTodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
}

function todoItemsFromBlock(block: ToolBlock): CliTodoItem[] {
  const input = (block.input ?? {}) as Record<string, unknown>;
  const list =
    todoSnapshotFromBlock(block)
    ?? parseList(input.tasks)
    ?? parseList(input.new_tasks)
    ?? [];
  return list.map(({ content, status }) => ({ content, status }));
}

function todoMark(status: CliTodoItem['status']): string {
  if (status === 'completed') return '☒';
  if (status === 'in_progress') return '■';
  return '☐';
}

function CliToolView({ block }: { block: ToolBlock }) {
  const [manual, setManual] = useState<boolean | null>(null);
  const title = cliToolTitle(block.name, block.input);
  const body = unwrapToolResult(block);
  const lines = body ? body.split('\n') : [];
  const kind = toolKind(block.name);
  const todos = kind === 'todo' ? todoItemsFromBlock(block) : [];
  const fileChanges =
    kind === 'edit'
      ? editChangeLines(body, block.input)
      : kind === 'write'
        ? writeChangeLines(body, block.input)
        : [];
  const running = block.status === 'running';
  const errored = block.status === 'error' || block.isError;
  const open = manual ?? (fileChanges.length > 0 || (running && lines.length > 0));
  const summary = toolSummary(block, lines, body);

  return (
    <div className="font-mono text-[13px] leading-relaxed">
      <button
        type="button"
        onClick={() => setManual(!open)}
        className="flex w-full items-start gap-2 text-left transition hover:text-slate-100"
      >
        <span className={cn('cli-gutter select-none', errored ? 'text-rose-400' : 'text-accent-soft', running && 'animate-pulse-dot')}>■</span>
        <span className="min-w-0 flex-1 break-words text-slate-200">
          {title}
        </span>
      </button>
      {todos.length > 0 ? (
        <div className="flex items-start gap-2">
          <span className="cli-bracket select-none text-slate-600" aria-hidden />
          <div className="min-w-0 flex-1 text-slate-400">
            {todos.map((item, idx) => (
              <div
                key={idx}
                className={cn(
                  'whitespace-pre-wrap break-words',
                  item.status === 'completed' && 'text-slate-600',
                  item.status === 'in_progress' && 'text-accent-soft',
                )}
              >
                <span className={cn(item.status === 'in_progress' && 'animate-pulse-dot')}>{todoMark(item.status)}</span>{' '}
                {item.content}
              </div>
            ))}
          </div>
        </div>
      ) : fileChanges.length > 0 ? (
        <div className="flex items-start gap-2">
          <span className="cli-bracket select-none text-slate-600" aria-hidden />
          {open ? (
            <CompactEditDiff changes={fileChanges} className="cli-tool-body flex-1 text-[12.5px] leading-relaxed" />
          ) : (
            <span className="min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-500">{summary}</span>
          )}
        </div>
      ) : (
        (summary || (open && body)) && (
          <div className="flex items-start gap-2">
            <span className="cli-bracket select-none text-slate-600" aria-hidden />
            {open && body ? (
              <CliResultBody text={body} isError={!!errored} />
            ) : (
              <span className={cn('min-w-0 flex-1 whitespace-pre-wrap break-words text-slate-500', errored && 'text-rose-300')}>
                {summary}
              </span>
            )}
          </div>
        )
      )}
    </div>
  );
}

function CliResultBody({ text, isError }: { text: string; isError: boolean }) {
  const lines = text.split('\n');
  const looksLikeDiff = text.includes('@@') || text.startsWith('---') || text.startsWith('diff ');
  return (
    <pre
      className={cn(
        'cli-tool-body min-w-0 flex-1 overflow-auto whitespace-pre-wrap break-words text-[12.5px]',
        isError && 'text-rose-300',
      )}
    >
      {looksLikeDiff
        ? lines.map((line, idx) => (
            <div
              key={idx}
              className={cn(
                line.startsWith('+') && !line.startsWith('+++') && 'text-emerald-300',
                line.startsWith('-') && !line.startsWith('---') && 'text-rose-300',
                (line.startsWith('@@') || line.startsWith('diff ')) && 'text-accent/80',
                !line.startsWith('+') &&
                  !line.startsWith('-') &&
                  !line.startsWith('@@') &&
                  !line.startsWith('diff ') &&
                  'text-slate-500',
              )}
            >
              {line || ' '}
            </div>
          ))
        : text}
    </pre>
  );
}

function CliResultView({ block }: { block: ResultBlock }) {
  // Cost is deliberately not shown — only how long the turn ran, when it ended,
  // and the API-reported context size.
  const parts: string[] = [];
  if (typeof block.durationMs === 'number') parts.push(`Worked for ${(block.durationMs / 1000).toFixed(1)}s`);
  const ended = beijingClock(block.ts);
  if (ended) parts.push(ended);
  const used = formatTokens(block.contextUsed ?? 0);
  if (used) {
    const window = formatTokens(block.contextWindow ?? 0);
    parts.push(window ? `${used} / ${window} tokens` : `${used} tokens`);
  }
  if (!parts.length) return null;
  return (
    <div className="flex items-start gap-2 font-mono text-[12px] text-slate-600">
      <span className="cli-gutter select-none">✶</span>
      <span>{parts.join(' · ')}</span>
    </div>
  );
}

function CliErrorView({ block }: { block: ErrorBlock }) {
  return (
    <div className="flex items-start gap-2 font-mono text-[13px] leading-relaxed text-rose-300">
      <span className="cli-gutter select-none">✘</span>
      <div className="min-w-0 flex-1 whitespace-pre-wrap break-words">{block.text}</div>
    </div>
  );
}
