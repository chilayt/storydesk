import React from 'react';
import { dateText } from './domain';

export const manuscriptScopes = { revision: '仅本次版本', document: '本章及后续修订', work: '全作品及后续章节' };
export type ManuscriptScope = keyof typeof manuscriptScopes;
export type ReviewUndo = { id: string; type: 'edit' | 'keep' | 'wording' | 'legacy' };
export type LegacySave = { id: string; at: string; label: string; canUndo: boolean; restored: boolean };
export type SaveDiff = { before: string; after: string; line: number; truncated: boolean; canUndo: boolean };
export type ManuscriptJournal = {
  currentHash: string;
  entries: { id: string; kind: 'edit' | 'keep'; at: string; line: number | null; sourceHash: string;
    before: string; after?: string; message: string; reversedAt?: string; canUndo: boolean }[];
  wordings: { id: string; term: string; scope: ManuscriptScope; effective: boolean; active: boolean; superseded?: boolean;
    confirmed_at: string; revoked_at?: string; reason: string; usage?: string; documentPath: string }[];
  legacy: LegacySave[];
};

export function ManuscriptDifference({ before, after }: { before: string; after: string }) {
  return <div className="diff-columns manuscript-difference">
    <div><h4>修改前</h4><pre>{before || '（此处为空）'}</pre></div>
    <div><h4>修改后</h4><pre>{after || '（此处为空）'}</pre></div>
  </div>;
}

export function ManuscriptHistory({ journal, busy, onUndo, onDiff }:
  { journal: ManuscriptJournal; busy: boolean; onUndo: (entry: ReviewUndo) => void; onDiff: (entry: LegacySave) => void }) {
  const rows = [
    ...journal.entries.map(row => ({
      ...row, type: row.kind, title: row.before || row.message,
      status: row.reversedAt ? '已撤回' : row.kind === 'edit' ? '已修改' : '已确认无问题',
    })),
    ...journal.wordings.filter(row => !row.superseded).map(row => ({ ...row, type: 'wording' as const, at: row.confirmed_at, title: row.term,
      status: row.active === false ? '已撤销' : row.effective ? '已放行' : '旧版本放行' })),
  ].sort((a, b) => b.at.localeCompare(a.at));
  const superseded = journal.wordings.filter(row => row.superseded);
  return <section className="manuscript-history" aria-label="已处理记录">
    {!rows.length && !journal.legacy.length && <p className="muted">这份稿件还没有已处理记录。</p>}
    {rows.map(row => <details className="manuscript-history-entry" key={row.id}>
      <summary><span>{row.status}</span><strong>{row.title}</strong><small>{dateText(row.at)}</small></summary>
      {row.type === 'wording' ? <div className="manuscript-history-detail">
        <p>{manuscriptScopes[row.scope]}{row.usage ? ` · ${row.usage}` : ''}</p>
        {row.reason && <p>{row.reason}</p>}
        {row.scope === 'work' && <small className="muted">{row.documentPath}</small>}
        {row.active !== false && <button disabled={busy} className="text-button" onClick={() => onUndo(row)}>撤销放行</button>}
      </div> : <div className="manuscript-history-detail">
        {row.line && <small className="muted">处理时 · 第 {row.line} 行</small>}
        {row.type === 'edit' ? <ManuscriptDifference before={row.before} after={row.after || ''}/> : <>
          {row.before && <blockquote>{row.before}</blockquote>}<p>{row.message}</p>
          {row.sourceHash !== journal.currentHash && <small className="muted">原段和核对依据保持时，后续复检沿用这条确认。</small>}
        </>}
        {row.canUndo && <button disabled={busy} className="text-button" onClick={() => onUndo(row)}>
          {row.type === 'edit' ? '撤回这条修改' : '撤回确认'}
        </button>}
        {row.type === 'edit' && !row.canUndo && !row.reversedAt && <p className="muted">原段已有改动，可用上面的差异对照恢复所需文字。</p>}
      </div>}
    </details>)}
    {!!superseded.length && <details className="manuscript-legacy">
      <summary>已被本章或全作品裁定接续的旧版放行 · {superseded.length}</summary>
      {superseded.map(row => <div key={row.id} className="manuscript-legacy-row">
        <span>{row.term} · {dateText(row.confirmed_at)}{row.reason && ` · ${row.reason}`}</span>
        {row.active !== false && <button className="text-button" disabled={busy} onClick={() => onUndo({ id: row.id, type: 'wording' })}>撤销旧版放行</button>}
      </div>)}
    </details>}
    {!!journal.legacy.length && <details className="manuscript-legacy">
      <summary>较早的稿件保存 · {journal.legacy.length}</summary>
      <p className="muted">早期版本按一次保存记录，可查看当时写入的差异。</p>
      {journal.legacy.map(row => <div className="manuscript-legacy-row" key={row.id}>
        <span>{row.label} · {dateText(row.at)}{row.restored ? ' · 已恢复' : ''}</span>
        <button className="text-button" disabled={busy} onClick={() => onDiff(row)}>查看差异</button>
      </div>)}
    </details>}
  </section>;
}
