import React, { useEffect, useState } from 'react';
import type { AppContext, ChapterReview, Proposal, SourceDocument } from './domain';
import { fieldLabels, humanValue, layerLabels, statusLabels } from './domain';
import { Badge, Empty, Evidence, Modal } from './components';
import { ProposalReview } from './ProposalReview';
import { SourceSnapshot } from './ReviewRecords';

const names = { event: '事件', hook: '伏笔', withdraw_event: '旧版事件待撤回' };
const stages = { introduced: '已埋设', progressing: '推进中', paid_off: '已回收' };

export function PlotReview({ ctx, initialChapter }: { ctx: AppContext; initialChapter?: string }) {
  const jobs = ctx.work.jobs.filter(job => job.mode === 'prose');
  const chapters = ctx.work.documents.filter(doc => jobs.some(job => job.documentId === doc.id))
    .sort((a, b) => (b.chapter || 0) - (a.chapter || 0));
  const [chapter, setChapter] = useState(initialChapter || chapters[0]?.id || '');
  const [showHistory, setShowHistory] = useState(false);
  const [editing, setEditing] = useState<ChapterReview>();
  const [factReview, setFactReview] = useState<Proposal>();
  const doc = chapters.find(row => row.id === chapter) || chapters[0];
  useEffect(() => { if (initialChapter) setChapter(initialChapter); }, [initialChapter]);
  if (!doc) return <Empty title="确认章节后开始核对" action={<button onClick={() => ctx.navigate({ page: 'reader' })}>打开正文</button>}/>;
  const currentJobs = jobs.filter(job => job.documentId === doc.id && job.sourceHash === doc.hash);
  const relevantJobs = jobs.filter(job => job.documentId === doc.id && (showHistory || job.sourceHash === doc.hash));
  const chapterItems = (ctx.work.chapterReviews || []).filter(row => relevantJobs.some(job => job.id === row.jobId));
  const items = chapterItems.filter(row => showHistory ? row.status !== 'pending' : row.status === 'pending');
  const facts = ctx.work.proposals.filter(p => relevantJobs.some(job => job.id === p.jobId) &&
    (showHistory ? p.status !== 'pending' : p.status === 'pending'));
  const eventItems = chapterItems.filter(item => item.kind !== 'hook' && (items.includes(item) || !showHistory && item.status === 'accepted' &&
    (facts.some(p => p.eventId === item.eventId) || items.some(row => row.eventId === item.eventId))));
  const rendered = new Set(eventItems.filter(row => row.kind === 'event').map(row => row.eventId));
  const pendingPrerequisite = (id: string) => ctx.work.chapterReviews?.some(r => r.eventId === id && r.kind === 'event' && r.status === 'pending');
  function itemCard(item: ChapterReview) {
    return <div key={item.id} className="proposal-card panel">
      <div><Badge>{names[item.kind]}</Badge><strong>{item.result?.title || item.title}</strong></div>
      <p>{item.result?.summary || item.event?.summary || item.summary}</p>
      {item.status === 'pending' ? <button onClick={() => setEditing(item)}>核对{item.kind === 'hook' ? '伏笔' : '事件'}</button>
        : <small>{item.status === 'accepted' ? '已写回' : item.status === 'obsolete' ? '旧版本' : '已退回'}</small>}
    </div>;
  }
  function factCard(proposal: Proposal) {
    const fact = proposal.fact;
    const person = ctx.work.characters.find(c => c.id === fact.entity_id)?.name || fact.entity_id.replace(/^name:/, '');
    return <div key={proposal.id} className="proposal-card panel">
      <div><Badge>{proposal.operation === 'withdraw' ? '撤回旧资料' : fact.field === 'relationship' ? '关系' : '人物资料'}</Badge>
        <strong>{person} · {fieldLabels[fact.field] || fact.field}</strong></div>
      <p>{humanValue(fact, ctx.work.characters)}</p>
      {proposal.status === 'pending' ? <button disabled={pendingPrerequisite(proposal.eventId)} onClick={() => setFactReview(proposal)}>核对{fact.field === 'relationship' ? '关系' : '人物资料'}</button>
        : ['accepted', 'rejected'].includes(proposal.status) && currentJobs.some(job => job.id === proposal.jobId) &&
          !!ctx.work.events.find(event => event.id === proposal.eventId && !event.withdrawn)
          ? <button onClick={() => setFactReview(proposal)}>重新核对</button> : <small>{proposal.status === 'accepted' ? '已处理' : '历史记录'}</small>}
    </div>;
  }
  const individual = items.filter(row => row.kind === 'hook' && !rendered.has(row.eventId));
  return <>
    <div className="review-chapter-filter panel">
      <label>核对章节<select value={doc.id} onChange={e => { setChapter(e.target.value); setShowHistory(false); }}>
        {chapters.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
      </select></label>
      <div className="actions">
        <button aria-pressed={!showHistory} onClick={() => setShowHistory(false)}>待核对</button>
        <button aria-pressed={showHistory} onClick={() => setShowHistory(true)}>处理记录</button>
        {!!doc.chapter && <button disabled={!currentJobs.some(job => ['completed', 'partial'].includes(job.status))}
          onClick={() => ctx.navigate({ page: 'cowriting', newChapterNumber: doc.chapter! + 1 })}>创作下一章</button>}
      </div>
    </div>
    {!showHistory && currentJobs.some(job => ['queued', 'running', 'applying', 'waiting_config', 'failed', 'interrupted', 'cancelled', 'stale'].includes(job.status)) &&
      <div className="notice" role="status">{currentJobs.map(job => statusLabels[job.status] || job.status).join(' · ')}
        {' '} <button onClick={() => ctx.navigate({ page: 'updates', tab: 'jobs' })}>查看分析任务</button>
      </div>}
    {items.length + facts.length > 0 ? <div className="proposal-list">
      {eventItems.map(row => <section className="review-chapter-group" key={row.id}>
        {itemCard(row)}
        {row.status === 'pending' && row.kind === 'event' && <small className="muted">保存事件后可核对关联的人物、关系与伏笔。</small>}
        {facts.filter(p => p.eventId === row.eventId && rendered.has(p.eventId)).map(factCard)}
        {items.filter(hook => hook.kind === 'hook' && hook.eventId === row.eventId && rendered.has(hook.eventId)).map(hook => pendingPrerequisite(hook.eventId)
          ? <p key={hook.id} className="small-text">关联伏笔 · {hook.title}</p> : itemCard(hook))}
      </section>)}
      {facts.filter(p => !rendered.has(p.eventId)).map(factCard)}
      {individual.filter(row => !pendingPrerequisite(row.eventId)).map(itemCard)}
    </div> : <Empty title={showHistory ? '本章暂无处理记录' : currentJobs.every(job => job.status === 'completed') && currentJobs.length ? '本章没有待核对变化' : '暂无当前版本的核对项'}/>}
    {editing && <ChapterReviewDialog key={editing.id} ctx={ctx} doc={doc} item={editing} onClose={() => setEditing(undefined)}/>}
    {factReview && <ProposalReview ctx={ctx} proposal={factReview} reconsider={factReview.status !== 'pending'} onClose={() => setFactReview(undefined)}/>}
  </>;
}

function ChapterReviewDialog({ ctx, doc, item, onClose }: { ctx: AppContext; doc: SourceDocument; item: ChapterReview; onClose: () => void }) {
  const [title, setTitle] = useState(item.title);
  const [summary, setSummary] = useState(item.event?.summary || item.summary || '');
  const [time, setTime] = useState(item.event?.story_time || '');
  const [layer, setLayer] = useState(item.event?.editorial_layer || 'occurred');
  const [stage, setStage] = useState(item.hookStatus || 'introduced');
  const hooks = ctx.work.records.filter(row => row.kind === 'hook' && !(row as any).damaged);
  const [hookId, setHookId] = useState(hooks.some(h => h.id === item.hookId) ? item.hookId! : '');
  const hook = hooks.find(h => h.id === hookId);
  const evidenceMissing = item.kind !== 'withdraw_event' && item.evidence?.evidence_match?.status !== 'matched';
  const [evidence, setEvidence] = useState('');
  const [source, setSource] = useState<any>();
  const [busy, setBusy] = useState(false);
  const job = ctx.work.jobs.find(row => row.id === item.jobId);
  async function submit(accept: boolean) {
    setBusy(true);
    const result = await ctx.act(() => ctx.call('decideChapterReview', { id: item.id, expectedRevision: item.revision,
      accept, title, summary, storyTime: time, layer, hookId, hookRevision: hook?.revision, hookStatus: stage,
      evidenceQuote: evidenceMissing ? evidence : undefined }), accept ? '作者裁定已写回本地资料' : '已保留原资料');
    setBusy(false);
    if (result) onClose();
  }
  return <>
    <Modal title={item.kind === 'withdraw_event' ? '核对旧版事件撤回' : '核对' + names[item.kind]} subtitle={doc.title} wide onClose={onClose}>
      {item.kind === 'withdraw_event' ? <p>旧版事件「{item.title}」缺少新版依据。确认撤回后，其历史仍可查阅。</p> : <>
        {item.kind === 'event' ? <div className="form-grid">
          <label>事件性质<select value={layer} onChange={e => setLayer(e.target.value as typeof layer)}>{['occurred','plan','belief'].map(key =>
            <option key={key} value={key}>{layerLabels[key]}</option>)}</select></label>
          <label>故事时间<input value={time} onChange={e => setTime(e.target.value)} maxLength={100}/></label>
        </div> : <div className="form-grid">
          <label>伏笔归属<select value={hookId} onChange={e => setHookId(e.target.value)}>
            <option value="">新建伏笔</option>{hooks.map(row => <option key={row.id} value={row.id}>{row.title}</option>)}
          </select></label>
          <label>伏笔进展<select value={stage} onChange={e => setStage(e.target.value)}>{Object.entries(stages).map(([value,text]) =>
            <option key={value} value={value}>{text}</option>)}</select></label>
        </div>}
        {hook && <div className="notice">现有伏笔为「{hook.title}」 · {stages[hook.status as keyof typeof stages] || hook.status}<p>{hook.body.slice(-350)}</p></div>}
        <label>{item.kind === 'hook' ? '伏笔标题' : '事件标题'}<input readOnly={!!hook} value={hook?.title || title} onChange={e => setTitle(e.target.value)} maxLength={120}/></label>
        <label>{item.kind === 'hook' ? '本章的伏笔变化' : '事件摘要'}<textarea value={summary} onChange={e => setSummary(e.target.value)} rows={5} maxLength={1500}/></label>
        {evidenceMissing ? <label>从确认稿补选连续原句<textarea value={evidence} onChange={e => setEvidence(e.target.value)} rows={4} maxLength={3000}/></label>
          : <Evidence quote={item.evidence?.evidence || ''} chapter={doc.chapter}/>}
        {!!job && <button onClick={async () => { const r = await ctx.act(() => ctx.call('approvedSource', { approvalId: (job as any).approvalId })); if (r) setSource(r); }}>查看确认稿</button>}
        {item.kind === 'hook' && stage === 'paid_off' && !hookId && <p className="small-text" role="status">请选择被回收的既有伏笔。</p>}
      </>}
      <div className="modal-footer">
        <button disabled={busy} onClick={onClose}>暂缓</button>
        <button disabled={busy} onClick={() => void submit(false)}>保留原资料</button>
        <button className="primary" disabled={busy || item.kind !== 'withdraw_event' && (!title.trim() || !summary.trim() || evidenceMissing && !evidence.trim() ||
          item.kind === 'hook' && stage === 'paid_off' && !hookId)} onClick={() => void submit(true)}>确认并写回</button>
      </div>
    </Modal>
    {source && <SourceSnapshot source={source} onClose={() => setSource(undefined)}/>}
  </>;
}

export function VolumeOutlineReview({ ctx, doc, onClose }: { ctx: AppContext; doc: SourceDocument; onClose: () => void }) {
  const previous = [...ctx.work.approvals].reverse().find(a => a.documentId === doc.id && a.purpose === 'volume_outline');
  const [from, setFrom] = useState(previous?.fromChapter || '');
  const [to, setTo] = useState(previous?.toChapter || '');
  const [busy, setBusy] = useState(false);
  return <Modal title="确定卷纲" subtitle={doc.title} onClose={onClose}>
    <p>选择这份卷纲覆盖的章号。创作这些章节时会使用你确认的版本。</p>
    <div className="form-grid">
      <label>起始章号<input type="number" min="1" max="99999" value={from} onChange={e => setFrom(e.target.value)}/></label>
      <label>结束章号<input type="number" min="1" max="99999" value={to} onChange={e => setTo(e.target.value)}/></label>
    </div>
    <div className="modal-footer">
      <button onClick={onClose}>取消</button>
      <button className="primary" disabled={busy || !from || !to || Number(to) < Number(from)} onClick={async () => {
        setBusy(true);
        const result = await ctx.act(() => ctx.call('confirmVolumeOutline', { documentId: doc.id, expectedHash: doc.hash,
          fromChapter: Number(from), toChapter: Number(to) }), '卷纲已定，将用于适用章节的创作');
        setBusy(false);
        if (result) onClose();
      }}>确认此版卷纲</button>
    </div>
  </Modal>;
}
