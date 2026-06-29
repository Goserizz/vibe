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
      {block.streaming && <span className="stream-caret" />}
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

export function toolMeta(name: string, input: unknown): ToolMeta {
  const i = (input ?? {}) as Record<string, any>;
  switch (name) {
    case 'Bash':
      return { icon: Terminal, label: 'Terminal', detail: i.command };
    case 'Read':
      return { icon: FileText, label: 'Read', detail: i.file_path };
    case 'Write':
      return { icon: FilePen, label: 'Write', detail: i.file_path };
    case 'Edit':
    case 'MultiEdit':
      return { icon: FilePen, label: 'Edit', detail: i.file_path };
    case 'Glob':
      return { icon: Search, label: 'Glob', detail: i.pattern };
    case 'Grep':
      return { icon: Search, label: 'Grep', detail: i.pattern };
    case 'WebFetch':
      return { icon: Globe, label: 'Fetch', detail: i.url };
    case 'WebSearch':
      return { icon: Globe, label: 'Search', detail: i.query };
    case 'TodoWrite':
      return { icon: ListTodo, label: 'Update todos', detail: Array.isArray(i.todos) ? `${i.todos.length} items` : undefined };
    case 'ExitPlanMode':
      return { icon: ClipboardList, label: 'Plan', detail: Array.isArray(i.allowedPrompts) && i.allowedPrompts.length ? `${i.allowedPrompts.length} permissions` : undefined };
    case 'Task':
      return { icon: Wrench, label: `Task: ${i.subagent_type ?? ''}`.trim(), detail: i.description };
    default:
      return { icon: Wrench, label: name, detail: typeof input === 'object' ? undefined : String(input) };
  }
}

function ToolView({ block }: { block: ToolBlock }) {
  const [open, setOpen] = useState(false);
  const meta = toolMeta(block.name, block.input);
  const Icon = meta.icon;
  const hasResult = block.result != null && block.result !== '';

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
          {hasResult && (
            <pre
              className={cn(
                'max-h-72 overflow-auto whitespace-pre-wrap rounded-lg bg-ink-950 p-2.5 font-mono text-[12px] leading-relaxed',
                block.isError ? 'text-rose-300' : 'text-slate-400',
              )}
            >
              {block.result}
            </pre>
          )}
        </div>
      )}
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
