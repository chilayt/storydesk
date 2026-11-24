import React, { useEffect, useRef } from 'react';
import MarkdownIt from 'markdown-it';
import DOMPurify from 'dompurify';
import { statusLabels } from './domain';

const paths: Record<string, string> = {
  home: 'M3 10 12 3l9 7v10a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z',
  file: 'M6 3h8l4 4v14H6zM14 3v5h4M9 12h6m-6 4h6',
  book: 'M12 6c-3-3-7-3-10-2v15c3-1 7-1 10 2 3-3 7-3 10-2V4c-3-1-7-1-10 2Zm0 0v15',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2m20 0v-2a4 4 0 0 0-3-3.9M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm8-7.8a4 4 0 0 1 0 7.6',
  world: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM3 12h18M12 3c5 5 5 13 0 18-5-5-5-13 0-18Z',
  plot: 'M4 3v14a3 3 0 0 0 3 3h14M8 12l4-4 4 3 5-7',
  map: 'm3 6 6-3 6 3 6-3v15l-6 3-6-3-6 3Zm6-3v15m6-12v15',
  folder: 'M3 7V5a2 2 0 0 1 2-2h5l2 3h7a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z',
  upload: 'M12 16V3m-5 5 5-5 5 5M4 16v4a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-4',
  check: 'm5 12 4 4L19 6',
  inbox: 'M4 3h16l2 13v5H2v-5Zm-2 13h6l2 3h4l2-3h6',
  settings: 'm9 3-1 3-3 1-2 5 2 5 3 1 1 3h6l1-3 3-1 2-5-2-5-3-1-1-3ZM12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6Z',
  search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0Z',
  arrow: 'M5 12h14m-6-6 6 6-6 6',
  chevron: 'm9 5 7 7-7 7',
  plus: 'M12 5v14M5 12h14',
  edit: 'm16 3 5 5-12 12-6 1 1-6Zm-2 2 5 5',
  save: 'M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h12l4 4v12a2 2 0 0 1-2 2ZM7 3v6h10V3M7 21v-8h10v8',
  close: 'm6 6 12 12M6 18 18 6',
  undo: 'M9 6 3 12l6 6m-6-6h12a5 5 0 0 1 5 5v2',
  refresh: 'M20 7a9 9 0 0 0-15-1L2 9m0-6v6h6M4 17a9 9 0 0 0 15 1l3-3m0 6v-6h-6',
  link: 'm10 13 4-4m-6 7-2 2a4 4 0 0 1-6-6l5-5a4 4 0 0 1 6 0m2 1 2-2a4 4 0 0 1 6 6l-5 5a4 4 0 0 1-6 0',
  clock: 'M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0ZM12 7v5l3 2',
  shield: 'm12 3 9 4v5c0 5-9 10-9 10S3 17 3 12V7Zm-4 9 3 3 5-6',
  download: 'M12 3v12m-5-5 5 5 5-5M4 16v5h16v-5',
  dots: 'M5 11v2m7-2v2m7-2v2',
  stop: 'M7 7h10v10H7z',
  branch: 'M6 4v16m0-10h5a6 6 0 0 0 6-6m-3 3 3-3 3 3',
  send: 'M12 20V4m-6 6 6-6 6 6',
  mic: 'M12 3a3 3 0 0 1 3 3v6a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3ZM5 11v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6',
  copy: 'M8 8h12v12H8zm-4 8V4h12',
  key: 'M14 5a5 5 0 1 1-1 8L7 19H3v-4l6-6a5 5 0 0 1 5-4Z',
  info: 'M12 11v6m0-10v1M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z'
};
export function Icon({ name, size = 18 }: { name: string; size?: number }) { return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={paths[name] || paths.book}/></svg>; }
export function Badge({ status, children }: { status?: string; children?: React.ReactNode }) { return <span className={`badge badge-${status || 'neutral'}`}>{children || statusLabels[status || ''] || status}</span>; }
export function Empty({ title = '这里还没有内容', detail, action }: { title?: string; detail?: string; action?: React.ReactNode }) { return <div className="empty-state"><div className="empty-icon"><Icon name="book" size={28}/></div><h3>{title}</h3>{detail && <p>{detail}</p>}{action}</div>; }
export function Modal({ title, subtitle, children, onClose, wide = false, footer }: { title: string; subtitle?: string; children: React.ReactNode; onClose: () => void; wide?: boolean; footer?: React.ReactNode }) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null; dialogRef.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeRef.current();
      if (e.key === 'Tab') { const items = dialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]),input,textarea,select,[tabindex="0"]'); if (!items?.length) return; const first = items[0], last = items[items.length - 1]; if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); } else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); } }
    };
    document.addEventListener('keydown', key); return () => { document.removeEventListener('keydown', key); previous?.focus(); };
  }, []);
  return <div className="modal-backdrop"><div className={`modal ${wide ? 'wide' : ''}${footer ? ' modal-with-footer' : ''}`} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={dialogRef}><div className="modal-title"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close"/></button></div>{footer ? <><div className="modal-body">{children}</div><footer className="modal-fixed-footer">{footer}</footer></> : children}</div></div>;
}
const md = new MarkdownIt({ html: false, linkify: false, breaks: false, typographer: false });
md.core.ruler.push('source_lines', state => {
  for (const token of state.tokens) {
    if (token.nesting !== 1 || !token.map) continue;
    token.attrSet('data-source-start', String(token.map[0] + 1));
    token.attrSet('data-source-end', String(token.map[1]));
  }
});
export function Markdown({ text, quote, sourceLine, onLink }: { text: string; quote?: string; sourceLine?: number; onLink?: (href: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if ((!quote && !sourceLine) || !ref.current) return;
    const clean = quote?.replace(/[*_`]/g, '').slice(0, 80);
    const atLine = [...ref.current.querySelectorAll<HTMLElement>('[data-source-start]')].filter(p =>
      sourceLine && Number(p.dataset.sourceStart) <= sourceLine && Number(p.dataset.sourceEnd) >= sourceLine).at(-1);
    const block = atLine || (clean && [...ref.current.querySelectorAll('p,li,blockquote')].find(p => p.textContent?.includes(clean)));
    if (block) { block.classList.add('evidence-highlight'); block.scrollIntoView({ block: 'center', behavior: 'smooth' }); return () => block.classList.remove('evidence-highlight'); }
  }, [quote, sourceLine, text]);
  return <div className="markdown" ref={ref} onClick={e => { const a = (e.target as HTMLElement).closest('a'); if (a) { e.preventDefault(); onLink?.(a.getAttribute('href') || ''); } }} dangerouslySetInnerHTML={{ __html: DOMPurify.sanitize(md.render(text), { FORBID_TAGS: ['img', 'iframe', 'object', 'form'], FORBID_ATTR: ['style'] }) }}/>;
}
export function SectionTitle({ title, caption, actions }: { title: string; caption?: string; actions?: React.ReactNode }) { return <div className="section-title"><div><h2>{title}</h2>{caption && <p>{caption}</p>}</div><div className="actions">{actions}</div></div>; }
export function Evidence({ quote, chapter, onOpen, stale }: { quote: string; chapter?: number | null; onOpen?: () => void; stale?: boolean }) { return <div className={`evidence ${stale ? 'stale' : ''}`}><p>“{quote}”</p><button className="text-button" disabled={!onOpen} onClick={onOpen}>{chapter ? `第${chapter}章` : '来源原文'} · 查看依据 <Icon name="arrow" size={14}/></button>{stale && <Badge>源稿已修订</Badge>}</div>; }
