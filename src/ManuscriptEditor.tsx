import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import CodeMirror from '@uiw/react-codemirror';
import { markdown } from '@codemirror/lang-markdown';
import { HighlightStyle, syntaxHighlighting } from '@codemirror/language';
import { Decoration, EditorView, ViewPlugin, type ViewUpdate } from '@codemirror/view';
import { tags } from '@lezer/highlight';
import type { SourceDocument } from './domain';

export type ManuscriptSelection = { start: number; end: number; text: string };
const normalize = (text: string) => text.replace(/\r\n?/gu, '\n');
const heading = Decoration.line({ class: 'manuscript-heading-line' });
const emphasis = Decoration.mark({ class: 'manuscript-emphasis' });
const changed = Decoration.mark({ class: 'manuscript-agent-edit' });
const changedLine = Decoration.line({ class: 'manuscript-agent-line' });
const hidden = Decoration.replace({});
const markdownTheme = syntaxHighlighting(HighlightStyle.define([
  { tag: [tags.heading, tags.link, tags.url, tags.monospace], color: 'var(--reading-accent)' },
  { tag: [tags.processingInstruction, tags.quote, tags.comment], color: 'var(--reading-muted)' },
  { tag: tags.strong, fontWeight: '650' },
  { tag: tags.emphasis, fontStyle: 'italic' },
]));

function manuscriptDecorations(raw: boolean, prefix: number, marks: NonNullable<SourceDocument['agentEdits']>) {
  function ranges(view: EditorView) {
    const list: ReturnType<Decoration['range']>[] = [];
    if (!raw) {
      const visited = new Set<number>();
      for (const visible of view.visibleRanges) {
        for (let pos = visible.from; pos <= visible.to;) {
          const line = view.state.doc.lineAt(pos);
          pos = line.to + 1;
          if (visited.has(line.from)) continue;
          visited.add(line.from);
          const label = /^(?: {0,3}#{1,6}[ \t]+| {0,3}>[ \t]?)/u.exec(line.text);
          if (label) {
            list.push(hidden.range(line.from, line.from + label[0].length));
            if (label[0].includes('#')) list.push(heading.range(line.from));
          }
          for (const match of line.text.matchAll(/(\*\*|__)([^\s].*?)(\1)/gu)) {
            const start = line.from + match.index, end = start + match[0].length;
            list.push(hidden.range(start, start + 2), emphasis.range(start + 2, end - 2), hidden.range(end - 2, end));
          }
        }
      }
    }
    for (const mark of marks) {
      const from = Math.max(0, mark.from - prefix);
      const to = Math.min(view.state.doc.length, mark.to - prefix);
      if (to > from) list.push(changed.range(from, to));
      else if (to === from && from <= view.state.doc.length) list.push(changedLine.range(view.state.doc.lineAt(from).from));
    }
    return Decoration.set(list, true);
  }
  return ViewPlugin.fromClass(class {
    decorations;
    constructor(view: EditorView) { this.decorations = ranges(view); }
    update(update: ViewUpdate) {
      if (update.docChanged || update.viewportChanged) this.decorations = ranges(update.view);
    }
  }, { decorations: value => value.decorations });
}

export function ManuscriptEditor({ text, onChange, raw, locked, marks, revealHash, onQuote, fontSize, lineHeight }: {
  text: string; onChange: (value: string) => void; raw: boolean; locked: boolean;
  marks: NonNullable<SourceDocument['agentEdits']>; revealHash?: string; onQuote?: (selection: ManuscriptSelection) => void;
  fontSize: number; lineHeight: number;
}) {
  const editor = useRef<EditorView | null>(null);
  const [menu, setMenu] = useState<{ top: number; left: number; selection: ManuscriptSelection; host: HTMLElement } | null>(null);
  const normalized = normalize(text);
  const header = raw ? '' : normalized.match(/^---\n[\s\S]*?\n---\n/u)?.[0] || '';
  const extensions = useMemo(() => [
    EditorView.lineWrapping,
    EditorView.contentAttributes.of({ 'aria-label': raw ? 'Markdown正文编辑器' : '正文编辑区' }),
    ...(raw ? [markdown(), markdownTheme] : []),
    manuscriptDecorations(raw, header.length, marks),
  ], [raw, header.length, marks]);
  useEffect(() => {
    if (!menu) return;
    const dismiss = () => setMenu(null);
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') dismiss(); };
    window.addEventListener('pointerdown', dismiss);
    window.addEventListener('keydown', escape);
    return () => { window.removeEventListener('pointerdown', dismiss); window.removeEventListener('keydown', escape); };
  }, [menu]);
  useEffect(() => {
    if (!revealHash || !marks.length) return;
    const frame = requestAnimationFrame(() => {
      const view = editor.current;
      if (!view) return;
      const position = Math.min(view.state.doc.length, Math.max(0, marks[0].from - header.length));
      view.dispatch({ effects: EditorView.scrollIntoView(position, { y: 'center' }) });
    });
    return () => cancelAnimationFrame(frame);
  }, [revealHash, marks, header.length]);
  return <div className={`manuscript-editor ${raw ? 'manuscript-raw' : ''}`}
    style={{ fontSize, lineHeight }} onContextMenu={event => {
      const state = editor.current?.state;
      const selected = state?.selection.main;
      const host = event.currentTarget.closest<HTMLElement>('.studio-shell');
      if (!onQuote || !host || !state || !selected || selected.empty) return;
      const quote = state.sliceDoc(selected.from, selected.to);
      if (!quote.trim() || quote.length > 2500) return;
      event.preventDefault();
      setMenu({ left: Math.max(6, Math.min(event.clientX, window.innerWidth - 180)),
        top: Math.max(6, Math.min(event.clientY, window.innerHeight - 55)),
        selection: { start: selected.from + header.length, end: selected.to + header.length, text: quote }, host });
    }}>
    <CodeMirror key={raw ? 'source' : 'prose'} value={normalized.slice(header.length)} height="100%"
      theme="none" extensions={extensions} readOnly={locked} editable={!locked}
      onCreateEditor={view => { editor.current = view; }}
      onChange={value => onChange(header + value)}
      basicSetup={{ lineNumbers: raw, foldGutter: raw, highlightActiveLine: raw, autocompletion: false,
        syntaxHighlighting: false, highlightActiveLineGutter: false, highlightSelectionMatches: false, indentOnInput: false }}/>
    {menu && createPortal(<div className="manuscript-selection-menu" style={{ top: menu.top, left: menu.left }} onPointerDown={event => event.stopPropagation()}>
      <button autoFocus onClick={() => { onQuote?.(menu.selection); setMenu(null); }}>引用选段到对话</button>
    </div>, menu.host)}
  </div>;
}
