import React, { useEffect, useState } from 'react';
import { bookCitationKey, dateText, type AppContext, type BookReviewReturn } from './domain';
import type { Evidence } from './BookReview';
import { Badge } from './components';

type ReadSource = Evidence & { id: string; variant: 'current' | 'historical'; endLine: number; lineCut?: boolean;
  versionState?: 'current' | 'historical' | 'changed' | 'unavailable' };
type Opinion = { suggestion?: string; boundary?: string; verified?: ReadSource[]; sources: ReadSource[]; model?: string;
  registration?: { path: string; sourceHash: string }; registrationCurrent?: boolean; stale?: boolean; createdAt?: string; sentAt?: string };
type Item = Opinion & { id: string; title: string; status: keyof typeof labels; missing: string[];
  error?: string; validation?: string[]; attempted?: boolean; received?: boolean; previousCandidate?: Opinion };
type Run = { id: string; reportId: string; createdAt: string; finishedAt?: string; active: boolean; items: Item[]; error?: string };
type History = NonNullable<BookReviewReturn['history']>;
type HistoryEntry = { id: string; reportId: string; createdAt: string; count: number; candidates: number; failed: number };
type OpenSource = (source: Evidence, button: HTMLButtonElement) => void;
const labels = { queued: '待取证', ready: '已取证', running: '等待模型', pending: '待核对',
  candidate: '候选意见', failed: '复核失败', interrupted: '复核中断' };
const versionLabels = { current: '现行正文', historical: '历史稿', changed: '旧版原文 · 现行已更新', unavailable: '旧版原文 · 现行不可读' };

function Source({ row, onSource }: { row: ReadSource; onSource: OpenSource }) {
  return <div className="book-review-citation">
    <div className="book-review-row"><button className="text-button" data-book-citation={bookCitationKey(row)} onClick={event => onSource(row, event.currentTarget)}>
      第{row.chapter}章 · 第{row.line}{row.endLine > row.line ? `–${row.endLine}` : ''}行</button>
      <small>{versionLabels[row.versionState || row.variant]} · <code title={row.sourceHash}>{row.sourceHash.slice(0, 12)}</code>{row.lineCut && ' · 部分行'}</small></div>
    <blockquote>{row.quote}</blockquote>
  </div>;
}

function OpinionContent({ record, onSource }: { record: Opinion; onSource: OpenSource }) {
  return <>
    {record.stale && <p className="notice warning">有依据已换版或不可读。以下为当时的引文与结论，使用前请复核现行版本。</p>}
    {record.suggestion && <><strong>原文可支持的建议</strong><p>{record.suggestion}</p></>}
    {record.boundary && <><strong>结论边界</strong><p>{record.boundary}</p></>}
    {record.verified?.map(row => <Source key={row.id} row={row} onSource={onSource}/>)}
  </>;
}

export function BookSemanticReview({ ctx, reportId, disabled, needsRescan, sourceCount, onSource, openDetails, history, onHistory }: {
  ctx: AppContext; reportId: string; disabled: boolean; needsRescan?: boolean; sourceCount: number; onSource: OpenSource;
  openDetails?: string[]; history?: History; onHistory: (value?: History) => void;
}) {
  const [run, setRun] = useState<Run | null>();
  const [archive, setArchive] = useState<Run>();
  const [historyOpen, setHistoryOpen] = useState(!!history || !!openDetails?.includes('semantic-history'));
  const [historyList, setHistoryList] = useState<{ entries: HistoryEntry[]; damaged: number }>();
  const [historyError, setHistoryError] = useState('');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const call = ctx.call;
  const documents = ctx.work.documents, records = ctx.work.events;
  const historyReport = history?.reportId, historyRun = history?.runId;
  useEffect(() => {
    if (disabled || historyRun) return;
    let live = true;
    async function load() {
      try {
        const result = await call('getBookSemanticReview', { reportId });
        if (live) setRun(result);
      } catch (problem) { if (live) setError((problem as Error).message); }
    }
    void load();
    const timer = run?.active ? setInterval(() => void load(), 750) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [disabled, call, reportId, run?.active, documents, records, historyRun]);
  useEffect(() => {
    if (!historyRun) return;
    let live = true;
    setHistoryError('');
    void call('getBookSemanticReview', { reportId: historyReport, runId: historyRun }).then(result => {
      if (!live) return;
      if (result) setArchive(result);
      else setHistoryError('找不到所选的复核记录。');
    }, problem => { if (live) setHistoryError(problem.message); });
    return () => { live = false; };
  }, [call, historyReport, historyRun, documents, records]);
  useEffect(() => {
    if (!historyOpen) return;
    let live = true;
    void call('listBookSemanticHistory', { reportId }).then(result => {
      if (live) setHistoryList(result);
    }, problem => { if (live) setHistoryError(problem.message); });
    return () => { live = false; };
  }, [call, reportId, historyOpen, run?.id, run?.finishedAt]);
  async function start(ids?: string[]) {
    setBusy(true); setError('');
    try { setRun(await call('startBookSemanticReview', { reportId, itemIds: ids })); }
    catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  }
  const visible = historyRun ? archive?.id === historyRun ? archive : undefined : run;
  const finished = visible?.items.filter(row => ['pending', 'candidate', 'failed', 'interrupted'].includes(row.status)).length || 0;
  const detail = (key: string, open = false) => ({ 'data-book-detail': key, open: open || openDetails?.includes(key) || undefined });
  return <section className="book-semantic-review" aria-label="语义复核记录">
    <p className="muted">使用当前作品后台模型，每项送审指定摘录。复核意见供作者核对，写回仍从对应的正文或事件核对入口确认。</p>
    <div className="studio-actions">{historyRun ? <button onClick={() => { setHistoryError(''); onHistory(); }}>返回本轮复核</button>
      : run?.active ? <button onClick={() => void call('stopBookSemanticReview', { reportId }).catch(problem => setError(problem.message))}>停止语义复核</button>
      : <button className="primary" disabled={disabled || needsRescan || busy || !sourceCount || run === undefined} onClick={() => void start()}>
        {run ? '重新复核全部' : `开始复核 ${sourceCount} 项`}</button>}
      {visible && <span className="muted" role="status">{historyRun && `历史记录 · ${dateText(visible.createdAt)} · `}已处理 {finished}/{visible.items.length} 项</span>}</div>
    <details className="book-review-entry" data-book-detail="semantic-history" open={historyOpen} onToggle={event => {
      setHistoryOpen(event.currentTarget.open);
      if (event.currentTarget.open) setHistoryError('');
    }}>
      <summary><strong>复核历史</strong></summary>
      {historyOpen && (!historyList ? <p className="muted" role="status">正在读取复核历史…</p> : <>
        {historyList.damaged > 0 && <p className="notice warning">有 {historyList.damaged} 份历史记录无法读取，原文件已保留。</p>}
        {!historyList.entries.length && <p className="muted">暂无更早的复核记录。</p>}
        {historyList.entries.map(entry => <div className="book-review-row" key={entry.id}>
          <button className="text-button" aria-pressed={entry.id === historyRun} onClick={() => onHistory({ reportId: entry.reportId, runId: entry.id })}>
            查看 {dateText(entry.createdAt)} 的复核</button>
          <small>{entry.reportId === reportId ? '本报告的早期复核' : '此前的全书报告'} · {entry.count} 项 · 当时有据 {entry.candidates} 项{entry.failed ? ` · 失败 ${entry.failed} 项` : ''}</small>
        </div>)}
      </>)}
    </details>
    {(error || historyError || visible?.error) && <p className="notice danger" role="alert">{historyError || error || visible?.error}</p>}
    {historyRun && !visible && !historyError && <p role="status">正在读取所选复核…</p>}
    {visible?.items.map(item => <details className="book-review-entry" key={`${historyRun || 'current'}:${item.id}`} {...detail(`semantic:${item.id}`)}>
      <summary><strong>{item.title}</strong><Badge>{labels[item.status]}</Badge>
        {item.stale && <Badge>依据已过期</Badge>}{item.model && <small>{item.model}</small>}</summary>
      {item.error && <p className="notice warning">{item.error}</p>}
      {!!item.missing.length && <><strong>资料缺口</strong><ul>{item.missing.map(note => <li key={note}>{note}</li>)}</ul></>}
      {!!item.validation?.length && <ul className="muted">{item.validation.map(note => <li key={note}>{note}</li>)}</ul>}
      <OpinionContent record={item} onSource={onSource}/>
      {!!item.sources.length && <details className="book-review-entry" {...detail(`submitted:${item.id}`)}>
        <summary>{item.received ? '本轮提交的版本和摘录' : item.attempted ? '本轮请求的摘录 · 模型完成情况见上' : '已准备的摘录 · 尚未提交'} · {item.sources.length} 段</summary>
        <p className="muted">范围为摘录。涉及的章节只读到所列段落，结论以这些原文为限。</p>
        {item.registration && <p className="studio-path">{item.registrationCurrent === false ? '旧登记版本' : '登记版本'} · {item.registration.path} · <code title={item.registration.sourceHash}>{item.registration.sourceHash.slice(0, 12)}</code></p>}
        {item.sources.map(row => <Source key={row.id} row={row} onSource={onSource}/>)}
      </details>}
      {item.previousCandidate && item.status !== 'candidate' && <details className="book-review-entry" {...detail(`previous:${item.id}`, true)}>
        <summary><strong>上一次有据的结论</strong><small>{dateText(item.previousCandidate.sentAt || item.previousCandidate.createdAt)}</small></summary>
        <OpinionContent record={item.previousCandidate} onSource={onSource}/>
      </details>}
      {!historyRun && !visible.active && ['failed', 'pending', 'interrupted'].includes(item.status) &&
        <button disabled={busy || disabled || needsRescan} onClick={() => void start([item.id])}>重试本项</button>}
    </details>)}
  </section>;
}
