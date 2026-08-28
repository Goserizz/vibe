import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MutableRefObject,
  type Ref,
  type TextareaHTMLAttributes,
} from 'react';
import { cn } from '../lib/format';

/** Code point at `index` for reverse-video block caret (CJK is one full cell). */
function caretUnit(value: string, index: number): { unit: string; empty: boolean } {
  if (index >= value.length) return { unit: '', empty: true };
  const cp = value.codePointAt(index)!;
  if (cp === 10) return { unit: '\n', empty: true };
  return { unit: value.slice(index, index + (cp > 0xffff ? 2 : 1)), empty: false };
}

function assignRef<T>(ref: Ref<T> | undefined, value: T | null) {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as MutableRefObject<T | null>).current = value;
}

type Props = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'value' | 'onChange' | 'children'> & {
  value: string;
  onChange: (value: string) => void;
  /** Optional external ref (auto-grow / focus); merged with the internal caret ref. */
  textareaRef?: Ref<HTMLTextAreaElement>;
};

/**
 * CLI-mode prompt field shared by coding Composer and VibotComposer.
 * Native caret is hidden (`.cli-prompt { caret-color: transparent }`); a
 * reverse-video block caret is painted via the mirror layer instead.
 */
export function CliPromptTextarea({
  value,
  onChange,
  className,
  textareaRef,
  onFocus,
  onBlur,
  onKeyUp,
  onClick,
  onSelect,
  ...rest
}: Props) {
  const innerRef = useRef<HTMLTextAreaElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);
  const [caret, setCaret] = useState(0);
  const [promptFocused, setPromptFocused] = useState(false);

  const setRefs = (el: HTMLTextAreaElement | null) => {
    (innerRef as MutableRefObject<HTMLTextAreaElement | null>).current = el;
    assignRef(textareaRef, el);
  };

  const syncCaret = () => {
    const el = innerRef.current;
    if (!el) return;
    setCaret(el.selectionStart ?? 0);
  };

  useLayoutEffect(() => {
    const ta = innerRef.current;
    const mirror = mirrorRef.current;
    if (!ta || !mirror) return;
    const sync = () => {
      mirror.scrollTop = ta.scrollTop;
      mirror.scrollLeft = ta.scrollLeft;
    };
    sync();
    ta.addEventListener('scroll', sync);
    return () => ta.removeEventListener('scroll', sync);
  }, [value, caret, promptFocused]);

  useEffect(() => {
    if (!promptFocused) return;
    const onSel = () => syncCaret();
    document.addEventListener('selectionchange', onSel);
    return () => document.removeEventListener('selectionchange', onSel);
  }, [promptFocused]);

  const { unit: caretCh, empty: caretEmpty } = caretUnit(value, caret);

  return (
    <div className="cli-prompt-wrap min-w-0 flex-1">
      <textarea
        {...rest}
        ref={setRefs}
        value={value}
        onChange={(e) => {
          onChange(e.target.value);
          setCaret(e.target.selectionStart ?? e.target.value.length);
        }}
        onKeyUp={(e) => {
          syncCaret();
          onKeyUp?.(e);
        }}
        onClick={(e) => {
          syncCaret();
          onClick?.(e);
        }}
        onSelect={(e) => {
          syncCaret();
          onSelect?.(e);
        }}
        onFocus={(e) => {
          setPromptFocused(true);
          syncCaret();
          onFocus?.(e);
        }}
        onBlur={(e) => {
          setPromptFocused(false);
          onBlur?.(e);
        }}
        rows={rest.rows ?? 1}
        className={cn(
          'cli-prompt max-h-[220px] w-full flex-1 resize-none bg-ink-950 py-1.5 font-mono text-[13.5px] leading-relaxed text-slate-100 placeholder:text-slate-600 focus:outline-none',
          className,
        )}
      />
      {promptFocused && (
        <div ref={mirrorRef} className="cli-prompt-mirror" aria-hidden>
          {value.slice(0, caret)}
          <span className={cn('cli-cursor--prompt', caretEmpty && 'cli-cursor--prompt-empty')}>
            {caretEmpty ? '\u00a0' : caretCh}
          </span>
          {caretCh === '\n' ? '\n' : ''}
          {caretEmpty ? value.slice(caret) : value.slice(caret + caretCh.length)}
          {'\n'}
        </div>
      )}
    </div>
  );
}
