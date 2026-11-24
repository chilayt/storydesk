import React, { useEffect, useRef, useState } from 'react';
import { bookCitationKey, type AppContext, type BookReviewReturn } from './domain';
import { Badge, Empty, Modal } from './components';
import { ManuscriptDifference } from './ManuscriptHistory';
import { BookSemanticReview } from './BookSemanticReview';
import './book-review.css';

export type Evidence = { documentId: string; chapter: number; title: string; sourceHash: string; start: number; line: number; quote: string };
type Issue = { id: string; category: 'timeline' | 'hook'; title: string; detail: string; evidence: Evidence[];
  status: 'pending' | 'confirmed' | 'kept' | 'written'; registryDocumentId?: string; change?: Evidence & { replacement: string } };
type Chapter = { id: string; chapter: number; title: string; status: 'queued' | 'read' | 'unread'; confirmed?: boolean; error?: string;
  timeline?: { label: string; kind: 'heading' | 'mention'; evidence: Evidence }[];
  events?: { id: string; title: string; time: string; evidence: Evidence | null; stale: boolean }[];
  clues?: { key: string; cue: string; evidence: Evidence }[];
  hooks?: { hookId: string; title: string; status: string; eventId: string; evidence: Evidence | null }[] };
type Report = { id: string; status: 'running' | 'paused' | 'partial' | 'complete' | 'failed'; active: boolean; outdated: boolean;
  changedDocumentIds: string[]; chapters: Chapter[]; issues: Issue[]; error?: string; needsRescan?: boolean;
  links?: { key: string; mentions: { evidence: Evidence; cue: string; date?: string; dateEvidence?: Evidence }[] }[];
  hooks: { id: string; title: string; status: string; introducedChapter?: number; paidOffChapter?: number }[] };
type Preview = { source: Evidence; before: string; after: string; exact: boolean; current: boolean };
const decisionNames = { pending: '待核对', confirmed: '已确认问题', kept: '已保留原文', written: '已写回' };
const hookStages: Record<string, string> = { planned: '已计划', introduced: '已埋设', progressing: '推进中', paid_off: '已回收' };

export default function BookReview({ ctx, returnTo }: { ctx: AppContext; returnTo?: BookReviewReturn }) {
  const [report, setReport] = useState<Report | null>();
  const [tab, setTab] = useState<BookReviewReturn['tab']>(returnTo?.tab || 'issues');
  const [handled, setHandled] = useState(returnTo?.handled || false);
  const [history, setHistory] = useState(returnTo?.history);
  const root = useRef<HTMLElement>(null);
  const citationButton = useRef<HTMLButtonElement | null>(null);
  const returnDetails = useRef(returnTo?.openDetails);
  const restored = useRef(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [preview, setPreview] = useState<Preview>();
  const [edit, setEdit] = useState<{ issue: Issue; index: number; replacement: string }>();
  const [restart, setRestart] = useState(false);
  const call = ctx.call;
  useEffect(() => {
    if (!root.current || !returnTo?.citation || restored.current) return;
    const section = root.current, { citation, detail } = returnTo;
    let frame = 0;
    function restore() {
      const target = [...section.querySelectorAll<HTMLButtonElement>('[data-book-citation]')].find(button =>
        button.dataset.bookCitation === citation &&
        button.closest<HTMLDetailsElement>('[data-book-detail]')?.dataset.bookDetail === detail);
      if (target && !target.closest('details:not([open])')) {
        observer.disconnect();
        restored.current = true;
        frame = requestAnimationFrame(() => {
          target.focus({ preventScroll: true });
          target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
        });
      }
    }
    const observer = new MutationObserver(restore);
    observer.observe(section, { childList: true, subtree: true, attributes: true, attributeFilter: ['open'] });
    restore();
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [returnTo]);
  useEffect(() => {
    let live = true;
    async function load() {
      try {
        const result = await call('getBookReview');
        if (live) setReport(result);
      } catch (error) { if (live) setError((error as Error).message); }
    }
    void load();
    const timer = report?.active ? setInterval(() => void load(), 650) : undefined;
    return () => { live = false; clearInterval(timer); };
  }, [call, report?.active, ctx.work.id, ctx.work.documents, ctx.work.records, ctx.work.events]);

  async function action(method: string, args: object = {}) {
    setBusy(true); setError('');
    try {
      const result = await call(method, args);
      if (result !== true) setReport(result);
      return true;
    } catch (error) { setError((error as Error).message); return false; }
    finally { setBusy(false); }
  }

  async function cite(source: Evidence, button: HTMLButtonElement) {
    setError('');
    citationButton.current = button;
    try { setPreview({ ...await call('previewBookEvidence', source), source }); }
    catch (error) { setError((error as Error).message); }
  }

  async function write() {
    if (!report || !edit) return;
    if (await action('decideBookReview', { reportId: report.id, issueId: edit.issue.id, action: 'write',
      evidenceIndex: edit.index, replacement: edit.replacement, confirmed: true })) {
      setEdit(undefined);
      await ctx.refresh();
      ctx.notify('已写回原稿，前后文字保存在全书核对记录。');
    }
  }

  const ready = !!report && !report.active;
  const read = report?.chapters.filter(chapter => chapter.status === 'read') || [];
  const open = report?.issues.filter(issue => issue.status === 'pending').length || 0;
  const resumable = !!report && !report.outdated && !report.needsRescan && ['paused', 'partial'].includes(report.status);
  const notice = error && <p className="notice danger" role="alert">{error}</p>;
  const detail = (key: string) => ({ 'data-book-detail': key, open: returnDetails.current?.includes(key) || undefined });
  const chapterHashes = new Map(ctx.work.documents.map(doc => [doc.id, doc.hash]));
  const sourceButton = (source: Evidence, label = `定位原文 · 第${source.chapter}章第${source.line}行`) => <>
    <button className="text-button" data-book-citation={bookCitationKey(source)} onClick={event => void cite(source, event.currentTarget)}>{label}</button>
    {chapterHashes.get(source.documentId) !== source.sourceHash && <small>旧版原文</small>}
  </>;
  const decisions = (issue: Issue, result: string) => void action('decideBookReview', { reportId: report?.id, issueId: issue.id, action: result });

  return <section ref={root} className="book-review" aria-label="全书核对任务">
    <div className="studio-section-heading book-review-heading"><div><h2>全书核对</h2>
      <p>逐章读取现行正文，对照明确日期、已登记事件和伏笔。正文措辞提取的线索供作者核对。</p></div>
      {report?.active ? <button disabled={busy} onClick={() => void action('stopBookReview')}>暂停核对</button>
        : <button className="primary" disabled={busy || report === undefined} onClick={() => report && !resumable ? setRestart(true)
          : void action('startBookReview', { resume: resumable })}>{resumable ? '继续核对' : report ? '重新核对' : '开始核对'}</button>}
    </div>
    {!edit && !restart && notice}
    {report === undefined && !error && <p role="status">正在读取全书核对记录…</p>}
    {report === null && <Empty title="还没有全书核对报告" detail="扫描在本机运行。报告保存每章读取状态和版本，以及可定位的疑点。"/>}
    {report && <>
      <p className="muted" role="status">{report.active ? '正在逐章读取' : { running: '正在准备', paused: '已暂停', partial: '部分章节待读取',
        complete: '逐章读取完成', failed: '本轮未完成' }[report.status]} · 已读 {read.length}/{report.chapters.length} 章
        {read.length > 0 && ` · 当前版本已确认 ${read.filter(chapter => chapter.confirmed).length} 章`}</p>
      {report.error && <p className="notice warning">{report.error}</p>}
      {report.outdated && <p className="notice warning">有正文或登记资料已更新。旧出处仍可回看，涉及已更新原文的写回会暂停。</p>}
      {report.needsRescan && <p className="notice warning">本报告使用旧日期规则。可回看原有记录，重新核对后将按场次关联日期。</p>}
      {report.active && <progress aria-label="逐章读取进度" max={report.chapters.length} value={read.length}/>}
      <div className="book-review-tabs" role="group" aria-label="全书核对报告视图">
        <button aria-pressed={tab === 'issues'} onClick={() => setTab('issues')}>疑点 · {open}</button>
        <button aria-pressed={tab === 'timeline'} onClick={() => setTab('timeline')}>时间线</button>
        <button aria-pressed={tab === 'hooks'} onClick={() => setTab('hooks')}>伏笔线索</button>
        <button aria-pressed={tab === 'semantic'} onClick={() => setTab('semantic')}>语义复核</button>
      </div>
      {tab === 'semantic' && <BookSemanticReview key={report.id} ctx={ctx} reportId={report.id} disabled={report.active} needsRescan={report.needsRescan}
        sourceCount={report.issues.length + (report.links?.length || 0)} onSource={cite} openDetails={returnDetails.current}
        history={history} onHistory={setHistory}/>}
      {tab === 'issues' && <>
        {!ready && <p className="muted">本轮逐章读取后会汇总跨章疑点。</p>}
        {ready && <><label className="check-label"><input type="checkbox" checked={handled} onChange={event => setHandled(event.target.checked)}/>显示已处理</label>
          {!report.issues.length && <p className="muted">本轮未找出符合当前规则的疑点。可在时间线和伏笔线索中查看原文摘录。</p>}
          {report.issues.filter(issue => handled || ['pending', 'confirmed'].includes(issue.status)).map(issue => <details key={issue.id} className="book-review-entry" {...detail(`issue:${issue.id}`)}>
            <summary><strong>{issue.title}</strong><Badge>{decisionNames[issue.status]}</Badge></summary>
            <p>{issue.detail}</p>
            {issue.registryDocumentId && <button className="text-button"
              onClick={() => ctx.navigate({ page: 'plot', tab: 'review', documentId: issue.registryDocumentId })}>查看事件核对</button>}
            {issue.evidence.map((source, index) => <div className="book-review-citation" key={`${source.documentId}-${source.start}-${index}`}>
              <blockquote>{source.quote}</blockquote>
              <div className="studio-actions">{sourceButton(source)}
                {issue.status === 'confirmed' && !report.needsRescan && !report.changedDocumentIds.includes(source.documentId) &&
                  ctx.work.documents.some(doc => doc.id === source.documentId && doc.hash === source.sourceHash && !doc.readOnly) &&
                  <button disabled={busy || issue.evidence.some(item => !ctx.work.documents.some(doc => doc.id === item.documentId && doc.hash === item.sourceHash))}
                    onClick={() => setEdit({ issue, index, replacement: source.quote })}>拟修改此处</button>}</div>
            </div>)}
            {issue.change && <ManuscriptDifference before={issue.change.quote} after={issue.change.replacement}/>}
            {!report.needsRescan && issue.status !== 'written' && <div className="studio-actions">
              {issue.status === 'pending' ? <><button disabled={busy} onClick={() => decisions(issue, 'confirm')}>确认有问题</button>
                <button disabled={busy} onClick={() => decisions(issue, 'keep')}>保留原文</button></>
                : <button className="text-button" disabled={busy} onClick={() => decisions(issue, 'reopen')}>撤回裁定</button>}
            </div>}
          </details>)}
        </>}
      </>}
      {tab === 'hooks' && <p className="muted">{report.hooks.length ? `现有工作台伏笔登记 ${report.hooks.length} 条。` : '目前没有工作台伏笔登记。'}逐章条目中的约定、悬念与同名照应供作者裁定。</p>}
      {tab === 'hooks' && !!report.links?.length && <details className="book-review-entry" {...detail('links')}>
        <summary><strong>跨章同名线索</strong><small>{report.links.length} 组</small></summary>
        <p className="muted">按相同名称对照不同章节。场次日期来自所在场次的标题，正文提及的日期可在时间线查阅。</p>
        {report.links.map(link => <details className="book-review-entry" key={link.key} {...detail(`link:${link.key}`)}>
          <summary><strong>{link.key}</strong><small>{link.mentions.length} 章</small></summary>
          {link.mentions.map(row => <div className="book-review-citation" key={`${row.evidence.documentId}-${row.evidence.start}`}>
            <blockquote>{row.evidence.quote}</blockquote><div className="studio-actions">{sourceButton(row.evidence)}
              {row.dateEvidence && sourceButton(row.dateEvidence, `日期原句 · ${row.date}`)}</div>
          </div>)}
        </details>)}
      </details>}
      {(tab === 'timeline' || tab === 'hooks') && report.chapters.map(chapter => <details className="book-review-entry" key={`${tab}-${chapter.id}`} {...detail(`${tab}:${chapter.id}`)}>
        <summary><strong>{chapter.title}</strong><small>{chapter.status === 'unread' ? '读取失败' : chapter.status === 'queued' ? '待读取' : tab === 'timeline' ?
          `${chapter.timeline?.length || 0} 处日期 · ${chapter.events?.length || 0} 件事件` : `${chapter.clues?.length || 0} 处线索 · ${chapter.hooks?.length || 0} 条登记`}</small></summary>
        {chapter.error && <p className="notice warning">{chapter.error}</p>}
        {chapter.status === 'read' && (tab === 'timeline' ? <>
          {(chapter.timeline || []).map(row => <div className="book-review-row" key={`${row.evidence.start}-${row.label}`}>
            <span>{row.label} · {row.kind === 'heading' ? '场次标题' : '正文提及'}</span>{sourceButton(row.evidence)}</div>)}
          {(chapter.events || []).map(row => <div className="book-review-row" key={row.id}><span>{row.title} · {row.time || '故事时间待定'}</span>
            {row.evidence ? sourceButton(row.evidence) : <small>出处待核对</small>}</div>)}
        </> : <>
          {(chapter.clues || []).map(row => <div className="book-review-row" key={`${row.evidence.start}-${row.key}-${row.cue}`}>
            <span>{row.key || row.evidence.quote.slice(0, 42)} · {row.cue || '同名提及'}</span>{sourceButton(row.evidence)}</div>)}
          {(chapter.hooks || []).map((row, index) => <div className="book-review-row" key={`${row.hookId}-${index}`}>
            <span>{row.title} · {hookStages[row.status] || '待核对'} · {read.flatMap(ch => ch.events || []).find(event => event.id === row.eventId)?.time || '事件日期待定'}</span>
            {row.evidence ? sourceButton(row.evidence) : <small>出处待核对</small>}</div>)}
        </>)}
      </details>)}
    </>}
    {preview && <Modal title={`第${preview.source.chapter}章 · 第${preview.source.line}行`} subtitle={preview.source.title} onClose={() => setPreview(undefined)} wide>
      <p className="muted">{preview.current ? '当前原文' : preview.exact ? '核对时的保存版本' : '核对时登记的摘录'}</p>
      <pre className="book-review-preview">{preview.before}<mark className="evidence-highlight">{preview.source.quote}</mark>{preview.after}</pre>
      {(preview.current || ctx.work.documents.some(doc => doc.id === preview.source.documentId)) && <div className="modal-footer"><button onClick={() => {
        const source = preview.source;
        const button = citationButton.current;
        const openDetails = [...(root.current?.querySelectorAll<HTMLDetailsElement>('details[open][data-book-detail]') || [])]
          .map(element => element.dataset.bookDetail!);
        setPreview(undefined);
        ctx.navigate({ page: 'reader', documentId: source.documentId, bookReviewReturn: { tab, handled, history, openDetails,
          detail: button?.closest<HTMLDetailsElement>('[data-book-detail]')?.dataset.bookDetail, citation: button?.dataset.bookCitation },
          ...(preview.current ? { sourceHash: source.sourceHash,
          sourceLine: source.line, quote: source.quote.replace(/^\s*#{1,5}\s+/u, '') } : {}) });
      }}>{preview.current ? '打开本章正文' : '查看现行正文'}</button></div>}
    </Modal>}
    {edit && <Modal title="核对并写回原稿" subtitle={`第${edit.issue.evidence[edit.index].chapter}章 · 第${edit.issue.evidence[edit.index].line}行`}
      onClose={() => { if (!busy) setEdit(undefined); }} wide>
      {notice}
      <ManuscriptDifference before={edit.issue.evidence[edit.index].quote} after={edit.replacement}/>
      <label>替换文字<textarea rows={4} value={edit.replacement} maxLength={1500} onChange={event => setEdit({ ...edit, replacement: event.target.value })}/></label>
      <div className="modal-footer"><button disabled={busy} onClick={() => setEdit(undefined)}>返回</button>
        <button className="primary" disabled={busy || !edit.replacement.trim() || edit.replacement.trim() === edit.issue.evidence[edit.index].quote.trim()}
          onClick={() => void write()}>确认并写回</button></div>
    </Modal>}
    {restart && <Modal title="重新核对全书" onClose={() => setRestart(false)}>
      {notice}<p>将按现行正文重新核对。上一轮报告会保存在本地历史中。</p>
      <div className="modal-footer"><button disabled={busy} onClick={() => setRestart(false)}>返回</button>
        <button className="primary" disabled={busy} onClick={async () => { if (await action('startBookReview')) { setHistory(undefined); setRestart(false); } }}>开始新一轮</button></div>
    </Modal>}
  </section>;
}
