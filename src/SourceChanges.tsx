import { useState } from 'react';
import type { AppContext, SourceDocument } from './domain';
import { dateText } from './domain';
import { Badge, Empty, Icon, Markdown } from './components';
import './source-changes.css';

interface SourceWarning {
  path: string; title?: string; kind?: string; detected_at: string;
  reason?: string; missing?: boolean; canRestore?: boolean;
}

function HistoricalSource({ ctx, documentId, moveId }: { ctx: AppContext; documentId: string; moveId?: string }) {
  const [document, setDocument] = useState<SourceDocument | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  async function load(open: boolean) {
    if (!open || document || loading) return;
    setLoading(true);
    setError('');
    try { setDocument(await ctx.call('readSourceHistory', { documentId, moveId })); }
    catch (e: any) { setError(e.message); }
    finally { setLoading(false); }
  }
  return <details className="source-snapshot" onToggle={e => load(e.currentTarget.open)}>
    <summary>查看历史出处</summary>
    {loading && <p role="status">正在读取登记版本…</p>}
    {error && <p className="notice" role="alert">{error}</p>}
    {document && <>
      {document.archivePath && <small className="source-path">归档文件 · {document.archivePath}</small>}
      {document.archiveAvailable && <button className="text-button" onClick={() => ctx.act(() => ctx.call('openSource', { documentId }))}>
        打开归档文件<Icon name="arrow" size={14}/>
      </button>}
      {document.snapshotAvailable
        ? <div className="source-snapshot-text"><Markdown text={document.text || ''}/></div>
        : <p className="muted">{document.archiveAvailable ? '登记版本可通过归档文件查阅。' : '现存记录保留了原路径与处置依据。'}</p>}
    </>}
  </details>;
}

function MissingSource({ ctx, id, warning }: { ctx: AppContext; id: string; warning: SourceWarning }) {
  const [action, setAction] = useState<'move' | 'retire' | null>(null);
  const [target, setTarget] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  async function pick(mode: 'move' | 'retire') {
    setBusy(true);
    try {
      const selected = await ctx.call('pickMaterial', { map: warning.kind === 'attachment' });
      if (selected) { setAction(mode); setTarget(selected); }
    } catch (e: any) { ctx.notify(e.message, true); }
    finally { setBusy(false); }
  }
  async function resolve() {
    if (!action || (action === 'move' && !target)) return;
    setBusy(true);
    try {
      await ctx.act(() => ctx.call('resolveMissingSource', {
        documentId: id, action, reason, ...(action === 'move' ? { to: target } : { archivePath: target })
      }), action === 'move' ? '已接到新路径' : '已登记退役，历史出处可查');
    } finally { setBusy(false); }
  }
  return <article className="source-review-row">
    <h3>{warning.title || warning.path}</h3>
    <small className="source-path">{warning.path}</small>
    <div className="source-review-actions">
      <button disabled={busy} onClick={() => pick('move')}>选择新路径</button>
      <button disabled={busy} onClick={() => { setAction('retire'); setTarget(''); }}>登记退役</button>
      {warning.canRestore && <button disabled={busy} onClick={() => ctx.act(() => ctx.call('restoreMissingDocument', { documentId: id }), '已从登记快照恢复原路径')}>恢复原位</button>}
    </div>
    {action && <div className="source-review-form">
      {action === 'move' ? <small className="source-path">新路径 · {target}</small> : <>
        <label>退役缘由（可选）<input value={reason} maxLength={320} onChange={e => setReason(e.target.value)} /></label>
        <small className="source-path">{target ? '归档文件 · ' + target : '历史出处沿用原路径和登记版本。'}</small>
        <button disabled={busy} onClick={() => pick('retire')}>选择归档文件</button>
        {target && <button disabled={busy} className="text-button" onClick={() => setTarget('')}>清除归档选择</button>}
      </>}
      <div className="source-review-actions">
        <button className="primary" disabled={busy} onClick={resolve}>{action === 'move' ? '确认接到新路径' : '确认退役'}</button>
        <button disabled={busy} onClick={() => setAction(null)}>取消</button>
      </div>
    </div>}
    {warning.canRestore && <HistoricalSource ctx={ctx} documentId={id}/>}
  </article>;
}

export function SourceChanges({ ctx, onManaged }: { ctx: AppContext; onManaged: (path: string) => void }) {
  const warnings = Object.entries(ctx.work.externalChanges) as [string, SourceWarning][];
  const missing = warnings.filter(([, warning]) => warning.missing);
  const changed = warnings.filter(([, warning]) => !warning.missing);
  const moves = ctx.work.sourceHistory?.moves || [];
  const retired = Object.values(ctx.work.sourceHistory?.retired || {});
  return <div className="source-changes">
    {(ctx.work.sourceRouteIssues || []).map((issue, i) => <p className="notice" role="alert" key={i}>{issue}</p>)}
    {!!(moves.length + retired.length) && <details className="panel source-history">
      <summary>来源去向 <small>搬迁 {moves.length} · 退役 {retired.length}</small></summary>
      {moves.slice().reverse().map(move => {
        const current = ctx.work.documents.find(doc => doc.id === move.documentId);
        return <article className="source-review-row" key={move.id}>
          <h3>{move.title} <Badge>已搬迁</Badge></h3>
          <small className="source-path">原路径 · {move.from}</small>
          <small className="source-path">迁入 · {move.to}</small>
          <p>{move.reason} · {dateText(move.at)}</p>
          {move.evidencePath && <small className="source-path">依据 · {move.evidencePath}</small>}
          {current && <button className="text-button" onClick={() => current.kind === 'attachment'
            ? ctx.act(() => ctx.call('openSource', { documentId: current.id }))
            : ctx.navigate({ page: 'reader', documentId: current.id })}>打开当前文件<Icon name="arrow" size={14}/></button>}
          {move.snapshot && <HistoricalSource ctx={ctx} documentId={move.documentId} moveId={move.id}/>}
        </article>;
      })}
      {retired.slice().reverse().map(doc => <article className="source-review-row" key={doc.id}>
        <h3>{doc.title} <Badge>已退役</Badge></h3>
        <small className="source-path">原路径 · {doc.path}</small>
        <p>{doc.reason} · {dateText(doc.at)}</p>
        {doc.evidencePath && <small className="source-path">依据 · {doc.evidencePath}</small>}
        {(doc.snapshot || doc.archivePath) && <HistoricalSource ctx={ctx} documentId={doc.id}/>}
      </article>)}
    </details>}
    {missing.length > 0 && <section className="panel source-missing">
      <h2>找不到的登记文件 <small>{missing.length}</small></h2>
      {missing.map(([id, warning]) => <MissingSource ctx={ctx} id={id} warning={warning} key={id}/>)}
    </section>}
    {changed.length > 0 && <section aria-label="内容变更">
      <h2>内容变更 <small>{changed.length}</small></h2>
      {changed.map(([id, warning]) => <section className="panel external-card" key={id}>
        <div><h3>{ctx.work.documents.find(doc => doc.id === id)?.title || warning.path}</h3>
          <p>{warning.reason || '程序发现源文件发生外部变化，已暂停相关自动写回。'}</p>
          <small className="source-path">{warning.path} · {dateText(warning.detected_at)}</small>
        </div>
        <button onClick={() => id.startsWith('managed:')
          ? onManaged(warning.path)
          : ctx.navigate({ page: 'reader', documentId: id })}>查看并核对原文<Icon name="arrow" size={14}/></button>
      </section>)}
    </section>}
    {!warnings.length && !ctx.work.sourceRouteIssues?.length && <Empty title="当前没有来源提醒" detail="登记文件的去向和版本可在此核对。"/>}
  </div>;
}
