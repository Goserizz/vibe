import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { EditorView, keymap } from '@codemirror/view';
import { EditorState, Compartment } from '@codemirror/state';
import { basicSetup } from 'codemirror';
import { oneDark } from '@codemirror/theme-one-dark';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { ArrowUp, ChevronRight, Folder, FileText, Image as ImageIcon, Save, Loader2, AlertCircle } from 'lucide-react';
import { useStore } from '../store/store';
import { api, ApiError } from '../lib/api';
import { cn, basename } from '../lib/format';
import type { FileEntry } from '@shared/protocol';

/** Pick a CodeMirror language extension from a filename (empty = plain text). */
function languageForPath(filePath: string) {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  if (['js', 'mjs', 'cjs', 'jsx'].includes(ext)) return [javascript({ jsx: true })];
  if (['ts', 'mts', 'cts', 'tsx'].includes(ext)) return [javascript({ jsx: true, typescript: true })];
  if (ext === 'json') return [json()];
  if (['md', 'mdx', 'markdown'].includes(ext)) return [markdown()];
  if (ext === 'py') return [python()];
  if (['css', 'scss', 'less'].includes(ext)) return [css()];
  if (['html', 'htm', 'xml', 'svg'].includes(ext)) return [html()];
  return [];
}

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'ico', 'avif']);
function isImage(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTS.has(ext);
}

function joinPath(dir: string, name: string): string {
  return dir.endsWith('/') ? dir + name : dir + '/' + name;
}
function parentPath(dir: string): string {
  const trimmed = dir.replace(/\/+$/, '');
  const idx = trimmed.lastIndexOf('/');
  return idx <= 0 ? '/' : trimmed.slice(0, idx);
}

export function FilesPane() {
  const activeId = useStore((s) => s.activeId);
  const session = useStore((s) => s.sessions.find((x) => x.id === s.activeId));
  const localName = useStore((s) => s.localName);
  const theme = useStore((s) => s.theme);
  const setToast = useStore((s) => s.setToast);

  const remote = !!session && session.host !== localName;
  const hostArg = remote ? session!.host : undefined;
  const cwd = session?.cwd ?? '';

  const [dir, setDir] = useState(cwd);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [listLoading, setListLoading] = useState(false);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [fileName, setFileName] = useState('');
  const [readLoading, setReadLoading] = useState(false);
  const [readError, setReadError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  // Refs to avoid stale closures inside the once-created CodeMirror view.
  const editorEl = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const themeComp = useRef(new Compartment());
  const langComp = useRef(new Compartment());
  const savedRef = useRef('');
  const selectedRef = useRef<string | null>(null);
  selectedRef.current = selected;
  const hostRef = useRef(hostArg);
  hostRef.current = hostArg;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const prevSession = useRef(activeId);

  // Resizable split between the directory list (top) and the editor (bottom).
  const rootRef = useRef<HTMLDivElement>(null);
  const [listH, setListH] = useState(() => {
    const saved = Number(localStorage.getItem('vibe.filesListHeight'));
    return Number.isFinite(saved) && saved >= 60 ? Math.min(saved, 600) : 220;
  });
  useEffect(() => {
    try {
      localStorage.setItem('vibe.filesListHeight', String(listH));
    } catch {
      /* ignore */
    }
  }, [listH]);

  const startVDrag = (e: React.MouseEvent) => {
    e.preventDefault();
    const startY = e.clientY;
    const startH = listH;
    const root = rootRef.current;
    const onMove = (ev: MouseEvent) => {
      const max = Math.max(80, (root?.clientHeight ?? 600) - 140);
      setListH(Math.max(60, Math.min(max, startH + (ev.clientY - startY))));
    };
    const onUp = () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
    document.body.style.userSelect = 'none';
    document.body.style.cursor = 'row-resize';
  };

  const save = useCallback(async () => {
    const view = viewRef.current;
    const p = selectedRef.current;
    if (!view || !p) return;
    const text = view.state.doc.toString();
    setSaving(true);
    try {
      await api.writeFile({ host: hostRef.current, path: p, content: text });
      savedRef.current = text;
      setDirty(false);
    } catch (err) {
      setToast(err instanceof ApiError ? err.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  }, [setToast]);
  const saveRef = useRef<() => void>(() => {});
  saveRef.current = save;

  const openFile = useCallback(
    (p: string) => {
      if (dirtyRef.current && p !== selectedRef.current) {
        setToast('Unsaved changes to the previous file were discarded');
      }
      setSelected(p);
    },
    [setToast],
  );

  // Follow the active session: reset to its cwd when it changes. Warn if this
  // discards unsaved edits.
  useEffect(() => {
    if (prevSession.current !== activeId && dirtyRef.current) {
      setToast('Unsaved changes were discarded');
    }
    prevSession.current = activeId;
    setDir(cwd);
    setSelected(null);
    setFileName('');
    setReadError(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeId]);

  // List the current directory.
  useEffect(() => {
    if (!dir) return;
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    api
      .listFiles({ host: hostArg, dir })
      .then((e) => {
        if (!cancelled) setEntries(e);
      })
      .catch((err) => {
        if (!cancelled) setListError(err instanceof ApiError ? err.message : 'Failed to list directory');
      })
      .finally(() => {
        if (!cancelled) setListLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [dir, hostArg]);

  // Create the CodeMirror view once (the editor div is always mounted, toggled
  // hidden, so this runs against a real element).
  useEffect(() => {
    if (!editorEl.current) return;
    const view = new EditorView({
      parent: editorEl.current,
      state: EditorState.create({
        doc: '',
        extensions: [
          basicSetup,
          themeComp.current.of(theme === 'light' ? [] : oneDark),
          langComp.current.of([]),
          EditorView.lineWrapping,
          EditorView.theme({
            '&': { height: '100%', backgroundColor: 'transparent' },
            '.cm-scroller': {
              fontFamily: '"JetBrains Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
              fontSize: '12.5px',
            },
            '.cm-gutters': { backgroundColor: 'transparent', border: 'none' },
          }),
          keymap.of([
            {
              key: 'Mod-s',
              run: () => {
                void saveRef.current();
                return true;
              },
            },
          ]),
          EditorView.updateListener.of((u) => {
            if (u.docChanged) setDirty(view.state.doc.toString() !== savedRef.current);
          }),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Live theme switch without remounting the editor.
  useEffect(() => {
    viewRef.current?.dispatch({
      effects: themeComp.current.reconfigure(theme === 'light' ? [] : oneDark),
    });
  }, [theme]);

  // Load a file's content into the editor when selected changes.
  useEffect(() => {
    const p = selected;
    const view = viewRef.current;
    if (!p) {
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      return;
    }
    if (isImage(p)) {
      // Images render via <img src=/files/raw>; there's no text content to load.
      setFileName(basename(p));
      setReadError(null);
      view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: '' } });
      return;
    }
    let cancelled = false;
    setReadLoading(true);
    setReadError(null);
    api
      .readFile({ host: hostArg, path: p })
      .then((content) => {
        if (cancelled || !viewRef.current) return;
        savedRef.current = content;
        setDirty(false);
        setFileName(basename(p));
        viewRef.current.dispatch({
          changes: { from: 0, to: viewRef.current.state.doc.length, insert: content },
          effects: langComp.current.reconfigure(languageForPath(p)),
        });
      })
      .catch((err) => {
        if (!cancelled) setReadError(err instanceof ApiError ? err.message : 'Failed to read file');
      })
      .finally(() => {
        if (!cancelled) setReadLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selected, hostArg]);

  const sorted = useMemo(() => {
    const d = entries.filter((e) => e.dir).sort((a, b) => a.name.localeCompare(b.name));
    const f = entries.filter((e) => !e.dir).sort((a, b) => a.name.localeCompare(b.name));
    return [...d, ...f];
  }, [entries]);

  const crumbs = useMemo(() => {
    const rootName = basename(cwd) || cwd || 'root';
    const acc = [{ name: rootName, path: cwd }];
    if (!cwd || !dir.startsWith(cwd)) return acc;
    const rel = dir.slice(cwd.length).replace(/^\/+/, '');
    const parts = rel ? rel.split('/').filter(Boolean) : [];
    let cur = cwd.replace(/\/+$/, '');
    for (const part of parts) {
      cur = `${cur}/${part}`;
      acc.push({ name: part, path: cur });
    }
    return acc;
  }, [cwd, dir]);

  const imageMode = !!selected && isImage(selected);
  const editorVisible = !!session && !!selected && !imageMode && !readLoading && !readError;

  return (
    <div ref={rootRef} className="relative flex h-full w-full min-h-0 flex-col">
      {session && (
        <>
          {/* Breadcrumb / directory toolbar */}
          <div className="flex shrink-0 items-center gap-1 border-b border-white/5 px-2 py-1.5">
            <button
              onClick={() => setDir(parentPath(dir))}
              disabled={dir === cwd}
              title="Up"
              className={cn(
                'shrink-0 rounded p-1 transition',
                dir === cwd ? 'cursor-default text-slate-600' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200',
              )}
            >
              <ArrowUp className="h-3.5 w-3.5" />
            </button>
            <div className="flex min-w-0 items-center overflow-x-auto">
              {crumbs.map((c, i) => (
                <span key={c.path} className="flex shrink-0 items-center">
                  {i > 0 && <ChevronRight className="h-3 w-3 text-slate-600" />}
                  <button
                    onClick={() => setDir(c.path)}
                    className={cn(
                      'max-w-[160px] truncate rounded px-1 py-0.5 font-mono text-[11px] transition',
                      i === crumbs.length - 1 ? 'text-slate-200' : 'text-slate-400 hover:bg-ink-800 hover:text-slate-200',
                    )}
                  >
                    {c.name}
                  </button>
                </span>
              ))}
            </div>
          </div>

          {/* Directory listing (height set by the drag handle below) */}
          <div className="shrink-0 overflow-y-auto" style={{ height: listH }}>
            {listLoading ? (
              <div className="flex items-center gap-2 px-3 py-3 text-[12px] text-slate-500">
                <Loader2 className="h-3.5 w-3.5 animate-spin" /> Loading…
              </div>
            ) : listError ? (
              <div className="flex items-start gap-2 px-3 py-3 text-[12px] text-rose-400">
                <AlertCircle className="mt-px h-3.5 w-3.5 shrink-0" /> {listError}
              </div>
            ) : sorted.length === 0 ? (
              <div className="px-3 py-3 text-[12px] text-slate-600">Empty directory</div>
            ) : (
              sorted.map((e) => {
                const p = joinPath(dir, e.name);
                return (
                  <button
                    key={p}
                    onClick={() => (e.dir ? setDir(p) : openFile(p))}
                    className={cn(
                      'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[12px] transition',
                      !e.dir && selected === p ? 'bg-accent/10 text-accent-soft' : 'text-slate-300 hover:bg-ink-800',
                    )}
                  >
                    {e.dir ? (
                      <Folder className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    ) : isImage(e.name) ? (
                      <ImageIcon className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    ) : (
                      <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
                    )}
                    <span className="truncate">{e.name}</span>
                  </button>
                );
              })
            )}
          </div>

          {/* Drag handle: resize the directory list vs. the editor below. */}
          <div
            onMouseDown={startVDrag}
            title="Drag to resize"
            className="group relative shrink-0 cursor-row-resize"
            style={{ height: 6 }}
          >
            <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/10 transition-colors group-hover:bg-accent/50" />
          </div>

          {/* Editor save bar (text files only — images aren't editable here) */}
          {selected && !imageMode && (
            <div className="flex shrink-0 items-center gap-2 border-b border-white/5 px-3 py-1.5">
              <FileText className="h-3.5 w-3.5 shrink-0 text-slate-500" />
              <span className="truncate font-mono text-[11px] text-slate-300">{fileName || basename(selected)}</span>
              {dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-accent" title="Unsaved changes" />}
              <div className="ml-auto flex items-center gap-2">
                {saving && <Loader2 className="h-3.5 w-3.5 animate-spin text-slate-500" />}
                <button
                  onClick={() => void save()}
                  disabled={!dirty || saving}
                  className="flex items-center gap-1.5 rounded-lg border border-ink-700 px-2.5 py-1 text-[12px] text-slate-300 transition hover:border-ink-600 disabled:cursor-default disabled:opacity-40"
                >
                  <Save className="h-3.5 w-3.5" /> Save
                </button>
              </div>
            </div>
          )}
        </>
      )}

      {/* Editor region: the CodeMirror element stays mounted (hidden) so its view
          persists. The overlays are scoped to THIS region (not the whole pane) so
          they never cover the directory list above — which must stay clickable. */}
      <div className="relative min-h-0 flex-1">
        <div ref={editorEl} className={cn('h-full w-full overflow-hidden', editorVisible ? 'block' : 'hidden')} />
        {imageMode && selected && (
          <div className="absolute inset-0 flex items-center justify-center overflow-auto p-4">
            <img
              key={selected}
              src={api.fileRawUrl({ host: hostArg, path: selected })}
              alt={basename(selected)}
              onError={() => setToast('Failed to load image')}
              className="max-h-full max-w-full object-contain"
            />
          </div>
        )}
        {!session && <Overlay text="Open a session to browse its files." />}
        {session && !selected && !readLoading && <Overlay text="Select a file to view or edit." />}
        {readLoading && <Overlay text="Loading…" spin />}
        {readError && <Overlay text={readError} error />}
      </div>
    </div>
  );
}

function Overlay({ text, spin, error }: { text: string; spin?: boolean; error?: boolean }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center px-6 text-center text-[12px]">
      <div className={cn('flex items-center gap-2', error ? 'text-rose-400' : 'text-slate-600')}>
        {spin && <Loader2 className="h-3.5 w-3.5 animate-spin" />}
        {error && <AlertCircle className="h-3.5 w-3.5 shrink-0" />}
        <span>{text}</span>
      </div>
    </div>
  );
}
