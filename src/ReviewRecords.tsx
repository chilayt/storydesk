import React, { useEffect, useState } from 'react';
import type { Job, AppContext, Proposal } from './domain';
import { dateText, fieldLabels, humanValue, layerLabels, statusLabels, valueText } from './domain';
import { Badge, Empty, Icon, Markdown, Modal } from './components';
import { JobDiagnostic } from './JobDiagnostic';

const short = (s?: string) => s ? s.slice(0, 8) : '作者裁定';
const fieldName = (s: string) => fieldLabels[s] || s.replace(/^base\./, '');
export const proposalDocument = (ctx: AppContext, p: Proposal) => ctx.work.jobs.find(j => j.id === p.jobId)?.documentId || p.fact.source_document_id;
export function inChapter(ctx: AppContext, id: string | null | undefined, chapter: string) {
  if (!chapter) return true;
  if (chapter === '__other__') return !ctx.work.documents.some(d => d.id === id && ['chapter','draft'].includes(d.kind));
  return id === chapter;
}
function groups(ctx: AppContext, rows: any[], idOf: (r: any) => string | null | undefined) {
  const map = new Map<string, any[]>();
  for (const r of rows) { const id = idOf(r) || '__other__'; if (!map.has(id)) map.set(id, []); map.get(id)!.push(r); }
  return [...map].map(([id, items]) => ({ id, items, doc: ctx.work.documents.find(d => d.id === id) })).sort((a,b) => (a.doc?.chapter || Infinity) - (b.doc?.chapter || Infinity) || String(a.doc?.title || '').localeCompare(String(b.doc?.title || '')));
}
export function SourceSnapshot({ source, onClose }: { source: any; onClose: () => void }) {
  return <Modal title="原确认稿 · 只读" subtitle={`${source.title} · 版本 ${short(source.sourceHash)}，不会用当前稿件替代这份证据。`} onClose={onClose} wide><div className="notice">{source.authorRuling ? '这是作者裁定，没有对应的正文原句。' : '这里展示归档或核对时保存的版本，修改正文请返回正文编辑页。'}</div>{source.quote && <blockquote>{source.quote}</blockquote>}<div className="review-source"><Markdown text={source.text || ''}/></div><div className="modal-footer"><button onClick={onClose}>关闭原确认稿</button></div></Modal>;
}

export function CurrentArchiveJobs({ ctx, chapter, onProposals, onHistory }: { ctx: AppContext; chapter: string; onProposals: (id: string) => void; onHistory: () => void }) {
  const current = ctx.work.jobs.filter(j => j.versionState === 'current' && j.status !== 'completed' && inChapter(ctx, j.documentId, chapter));
  const canRetry = (job: Job) => ['waiting_config', 'failed', 'interrupted', 'cancelled', 'stale'].includes(job.status);
  const ready = current.filter(job => canRetry(job) && (ctx.work.writingModel.enabled || job.rawResultAvailable));
  const document = ctx.work.documents.find(d => d.id === chapter);
  const hasWork = current.some(job => job.status !== 'partial');
  const needsConfirmation = document && ['chapter', 'draft'].includes(document.kind) && document.status !== 'confirmed';
  const retry = (jobId: string, forceAnalysis = false) => ctx.act(() => ctx.call('restartJob', { jobId, forceAnalysis }), '已登记重试');
  return <>
    <div className="list-toolbar">
      <p className="muted">版本确认后才会登记归档任务。已完成及旧版本可在章节历史回看。</p>
      <div className="actions">
        {ready.length > 0 && <button onClick={async () => { for (const job of ready) await retry(job.id); }}>
          <Icon name="refresh"/>{ready.length === 1 ? '启动待分析任务' : '启动待分析任务（' + ready.length + '）'}
        </button>}
        {current.length > 0 && <button className="text-button" onClick={onHistory}>章节归档历史</button>}
      </div>
    </div>
    {hasWork && !ctx.work.writingModel.enabled && <div className="notice">尚未启用后台模型。
      <button className="text-button" onClick={() => ctx.navigate({ page: 'settings' })}>打开作品设置</button></div>}
    {current.length ? groups(ctx, current, j => j.documentId).map(g => <section className="review-chapter-group" key={g.id}>
      <h2>{g.doc?.title || '其他资料'} <small>{g.items.length} 个当前任务</small></h2>
      <div className="job-list">{(g.items as Job[]).map(job => <section className="job-card panel" key={job.id}>
        <div className="panel-heading"><div><h3>{job.mode === 'prose' ? '成稿归档' : job.mode === 'plan' ? '设计归档' : '基座整理'}</h3>
          <small>{dateText(job.created_at)} · 当前版 {short(job.sourceHash)}</small></div>
          {job.status === 'partial' ? <Badge>分析完成 · 待核对</Badge> : <Badge status={job.status}/>}
        </div>
        <div className="job-progress"><div style={{ width: (job.totalChunks ? job.completedChunks / job.totalChunks * 100 : 0) + '%' }}/></div>
        <div className="job-meta"><span>片段 {job.completedChunks || 0} / {job.totalChunks || '待分批'}</span>
          <span>自动归档 {job.applied || 0} 项</span><span>待核对 {job.pending || 0} 项</span>
          {!!job.usage && <span>{job.usage.total_tokens?.toLocaleString()} Token{job.usage.estimated ? '（估算）' : ''}</span>}</div>
        <JobDiagnostic ctx={ctx} job={job}/>
        <div className="actions">
          {canRetry(job) && <button disabled={!ctx.work.writingModel.enabled && !job.rawResultAvailable} onClick={() => void retry(job.id)}>
            <Icon name="refresh"/>{job.rawResultAvailable ? '复用结果并继续核对' : '重新运行'}</button>}
          {canRetry(job) && job.rawResultAvailable && <button disabled={!ctx.work.writingModel.enabled} onClick={() => void retry(job.id, true)}>重新调用模型分析</button>}
          {['queued', 'running', 'waiting_config'].includes(job.status) && <button onClick={() =>
            ctx.act(() => ctx.call('cancelJob', { jobId: job.id }), '任务已取消')}>取消任务</button>}
          {!!job.pending && <button className="primary" onClick={() => onProposals(job.documentId)}>处理本章待核对项<Icon name="arrow" size={14}/></button>}
        </div>
      </section>)}</div>
    </section>) : <Empty title={document ? '本章没有待处理的归档任务' : '当前没有待处理的归档任务'}
      detail={needsConfirmation ? '本章当前版本尚未确认。核对稿件并确认后，归档任务会出现在这里。'
        : '已完成和旧版本可在章节归档历史中查看。'}
      action={needsConfirmation ? <button onClick={() => ctx.navigate({ page: 'manuscript', documentId: document.id })}>打开本章稿件核对</button>
        : <button onClick={onHistory}>查看章节归档历史</button>}/>}
  </>;
}

export function PendingReviews({ ctx, chapter, onOpen }: { ctx: AppContext; chapter: string; onOpen: (p: Proposal) => void }) {
  const pending = ctx.work.proposals.filter(p=>p.status==='pending'&&inChapter(ctx,proposalDocument(ctx,p),chapter));
  return pending.length?<>{groups(ctx,pending,p=>proposalDocument(ctx,p)).map(g=><section className="review-chapter-group" key={g.id}><h2>{g.doc?.title || '其他资料'} <small>{g.items.length} 项待核对</small></h2><div className="proposal-list">{g.items.map((p: Proposal)=><button className="proposal-card panel" key={p.id} onClick={()=>onOpen(p)}><div><Badge>{p.operation==='withdraw'?'新版请求撤回旧事实':p.fact.layer==='baseline'||p.fact.field.startsWith('base.')?'基座变更':'资料核对'}</Badge><strong>{ctx.work.characters.find(c=>c.id===p.fact.entity_id)?.name || p.fact.entity_id.replace(/^name:/,'')} · {fieldName(p.fact.field)}</strong></div><p>{humanValue(p.fact,ctx.work.characters)}</p><small>{p.fact.review_reasons.join('；')}</small><span className="proposal-open">查看差异<Icon name="arrow" size={14}/></span></button>)}</div></section>)}</>:<Empty title="当前没有待核对变化" detail="旧版未处理项已转入章节归档历史；已接受、拒绝或更正的内容在已处理记录中。"/>;
}

export function ArchiveVersions({ ctx, chapter, onRecords, onPending }: { ctx: AppContext; chapter: string; onRecords: (doc: string, hash: string) => void; onPending: (doc: string) => void }) {
  const [source,setSource]=useState<any>(null);
  const map=new Map<string,any>();
  for(const a of ctx.work.approvals.filter(a=>a.documentId&&a.sourceHash&&inChapter(ctx,a.documentId,chapter))){const key=`${a.documentId}:${a.sourceHash}`;if(!map.has(key))map.set(key,{documentId:a.documentId,sourceHash:a.sourceHash,approval:a,jobs:[]});}
  for(const j of ctx.work.jobs.filter(j=>inChapter(ctx,j.documentId,chapter))){const key=`${j.documentId}:${j.sourceHash}`;if(!map.has(key))map.set(key,{documentId:j.documentId,sourceHash:j.sourceHash,jobs:[]});map.get(key).jobs.push(j);}
  const versions=[...map.values()].sort((a,b)=>String(b.approval?.confirmed_at||b.jobs[0]?.created_at).localeCompare(String(a.approval?.confirmed_at||a.jobs[0]?.created_at)));
  return <><div className="notice">每个版本保留原确认稿、任务结果和当时的核对记录。旧版未处理项不会继续混入当前队列。</div>{versions.length?groups(ctx,versions,v=>v.documentId).map(g=><section className="review-chapter-group" key={g.id}><h2>{g.doc?.title || '源稿已移除'}</h2>{g.items.map(v=>{const ids=new Set(v.jobs.map((j:any)=>j.id)),ps=ctx.work.proposals.filter(p=>ids.has(p.jobId));const current=g.doc?.hash===v.sourceHash;return <article className="panel archive-version" key={v.sourceHash} data-archive-version={v.sourceHash}><div className="panel-heading"><div><h3>{current?'当前确认版':'历史确认版'} · {short(v.sourceHash)}</h3><small>{dateText(v.approval?.confirmed_at||v.jobs[0]?.created_at)}</small></div><Badge>{current?'当前稿件':'旧版本'}</Badge></div><div className="job-meta"><span>{v.jobs.length} 个归档任务</span><span>待核对 {ps.filter(p=>p.status==='pending').length} 项</span><span>已处理 {ps.filter(p=>['accepted','rejected','revoked'].includes(p.status)).length} 项</span><span>已失效待核对 {ps.filter(p=>p.status==='obsolete').length} 项</span></div>{v.jobs.map((j:any)=><p className="small-text" key={j.id}>{statusLabels[j.historicalStatus||j.status]||j.historicalStatus||j.status} · 自动归档 {j.applied||0} 项 · {dateText(j.completed_at||j.created_at)}</p>)}<div className="actions"><button onClick={()=>onRecords(v.documentId,v.sourceHash)}>查看此版核对记录</button>{v.approval&&<button onClick={async()=>{const r=await ctx.act(()=>ctx.call('approvedSource',{approvalId:v.approval.id}));if(r)setSource(r);}}>阅读此版确认稿</button>}{current&&ps.some(p=>p.status==='pending')&&<button onClick={()=>onPending(v.documentId)}>处理本章待核对</button>}</div></article>;})}</section>):<Empty title="还没有章节归档历史" detail="确认章节后，这里会按章节和版本保留记录。"/>}{source&&<SourceSnapshot source={source} onClose={()=>setSource(null)}/>}</>;
}

const actions: Record<string,string>={accept:'接受提议',reject:'保留原资料',edit:'修改后接受',belief:'记为人物认知',plan:'记为计划',baseline:'确认基座',reconsider_accept:'重新接受',reconsider_edit:'重新修改',reconsider_reject:'重新核对后撤回',reconsider_belief:'重新记为人物认知',reconsider_plan:'重新记为计划',withdraw_applied:'作者撤回归档',correct_current:'更正当前资料',correct_current_baseline:'更正人物基座'};
function ReviewRecordModal({ctx,recordId,onClose,onReconsider}:{ctx:AppContext;recordId:string;onClose:()=>void;onReconsider:(p:Proposal)=>void}){
  const [record,setRecord]=useState<any>(null),[error,setError]=useState(''),[mode,setMode]=useState('view'),[busy,setBusy]=useState(false),[source,setSource]=useState<any>(null);
  const [edit,setEdit]=useState(''),[structured,setStructured]=useState<any>({}),[layer,setLayer]=useState('ruling'),[reason,setReason]=useState(''),[effective,setEffective]=useState('latest');
  useEffect(()=>{let active=true;ctx.call('reviewRecord',{recordId}).then(r=>{if(active)setRecord(r);}).catch(e=>{if(active)setError(e.message);});return()=>{active=false;};},[recordId]);
  if(!record)return <Modal title="查看核对记录" onClose={onClose}><p>{error||'正在读取本地记录…'}</p></Modal>;
  const r=record,f=r.proposal?.fact||r.fact,name=ctx.work.characters.find(c=>c.id===f.entity_id)?.name||'身份待核对';
  const initial=r.currentValue??f.value, object=initial!==null&&typeof initial==='object';const known=['relationship','skill'].includes(f.field);
  function begin(){setEdit(valueText(initial)||'');setStructured(object?{...initial}:{});setLayer(['plan','belief'].includes(f.layer)?f.layer:'ruling');setMode('edit');}
  async function save(){let value:any=edit;try{if(known)value=structured;else if(object&&!r.baseline)value=JSON.parse(edit);}catch{ctx.notify('结构化内容格式不完整，请核对后保存。',true);return;}setBusy(true);const result=await ctx.act(()=>ctx.call('correctReviewedItem',{recordId,expectedCurrentDigest:r.currentDigest,value,layer,reason,effective}),'作者更正已写回档案，原核对历史保留');setBusy(false);if(result)onClose();}
  return <><Modal title={mode==='edit'?'更正当前档案':mode==='withdraw'?'撤回这一条归档':'查看核对记录'} subtitle={`${r.document?.title||'作者裁定'} · ${r.current?'当前版本／作者裁定':'历史版本'} · ${short(r.sourceHash)}`} onClose={onClose} wide><div className="panel-heading"><h3>{name} · {fieldName(f.field)}</h3><Badge status={r.proposal?.status||r.fact.status}/></div><div className="review-columns"><section><h4>当时保存的提议／裁定</h4><Badge>{layerLabels[f.layer]||f.layer}</Badge><pre>{humanValue(f,ctx.work.characters)}</pre></section><section><h4>当前档案值</h4><pre>{r.currentValue===undefined?'尚无已确认值':humanValue({...f,value:r.currentValue},ctx.work.characters)}</pre></section></div>{!r.current&&<div className="notice">这是旧版本记录。可查看原确认稿；更正会新增作者裁定，保留原历史，不会直接把旧稿建议当作新版事实。</div>}{f.evidence&&<blockquote className="review-proof">{f.evidence}</blockquote>}<button onClick={async()=>{const s=await ctx.act(()=>ctx.call('reviewSource',{recordId}));if(s)setSource(s);}}>查看原确认稿与出处</button>
    {mode==='edit'&&<section className="review-correction"><div className="notice">更正会写回本地档案并保留操作记录，不改正文。{r.baseline?'基座留空表示作者保留待定。':'请选择作用范围；当前档案修正不会回填旧章历史视图。'}</div>{f.field==='relationship'?<div className="form-grid"><label>关系人物<select value={structured.otherId||''} onChange={e=>setStructured({...structured,otherId:e.target.value})}><option value="">请选择人物</option>{ctx.work.characters.filter(c=>c.id!==f.entity_id).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select></label><label>关系类型<input value={structured.type||''} onChange={e=>setStructured({...structured,type:e.target.value})}/></label><label>态度与感情<textarea value={structured.attitude||''} onChange={e=>setStructured({...structured,attitude:e.target.value})}/></label></div>:f.field==='skill'?<div className="form-grid"><label>功法或能力<input value={structured.skillName||''} onChange={e=>setStructured({...structured,skillName:e.target.value})}/></label><label>修习阶段<input value={structured.stage||''} onChange={e=>setStructured({...structured,stage:e.target.value})}/></label><label>层次说明<input value={structured.level||''} onChange={e=>setStructured({...structured,level:e.target.value})}/></label></div>:<label>更正内容<textarea aria-label="更正内容" rows={5} value={edit} onChange={e=>setEdit(e.target.value)}/>{object&&!r.baseline&&<small>这是结构化资料，请保留原有字段名称。</small>}</label>}{!r.baseline&&<div className="form-grid"><label>内容性质<select aria-label="更正内容性质" value={layer} onChange={e=>setLayer(e.target.value)}>{!f.field.startsWith('base.')&&<option value="ruling">作者裁定的状态</option>}<option value="belief">人物认知／误判</option><option value="plan">计划，尚未发生</option></select></label><label>生效范围<select aria-label="更正生效范围" value={effective} onChange={e=>setEffective(e.target.value)}><option value="latest">当前档案，不回填旧章</option>{r.document?.chapter&&<option value="chapter">从当前目录第{r.document.chapter}章起</option>}</select></label></div>}<label>更正原因（选填）<input aria-label="更正原因" value={reason} onChange={e=>setReason(e.target.value)}/></label></section>}
    {mode==='withdraw'&&<div className="notice warning"><p>将撤回上面这一条已入档事实，重新计算相关档案；同一事件的其他事实和正文保留。后续作者更正与其他章节的事实不会被整批撤销。</p><label>撤回原因（选填）<input aria-label="撤回原因" value={reason} onChange={e=>setReason(e.target.value)}/></label></div>}
    {mode==='view'&&<details className="review-decision-history"><summary>查看处理经过与后续更正（{r.history.length}）</summary>{r.history.map((h:any)=><article key={h.id}><strong>{actions[h.action]||h.action}</strong><small>{dateText(h.at)}{h.legacy?' · 早期版本保存的裁定':''}</small>{h.reason&&<p>{h.reason}</p>}{h.before?.fact&&<p>此前：{humanValue(h.before.fact,ctx.work.characters)}</p>}<pre>{h.after?.fact?humanValue(h.after.fact,ctx.work.characters):h.after!==undefined?valueText(h.after):'处理记录'}</pre></article>)}{!r.proposal?.originalFact&&r.proposal&&<small>早期记录未单独保存最初AI提议；这里展示当时保留下来的裁定和原稿快照。</small>}</details>}
    <div className="modal-footer"><button onClick={onClose}>关闭记录</button>{mode==='view'?<>{r.canReconsider&&<button onClick={()=>onReconsider(r.proposal)}>重新核对本版记录</button>}{r.canWithdraw&&<button onClick={()=>setMode('withdraw')}>撤回此条归档</button>}{r.canCorrect&&<button className="primary" onClick={begin}>更正当前档案</button>}</>:<><button disabled={busy} onClick={()=>setMode('view')}>返回记录</button><button className="primary" disabled={busy} onClick={mode==='edit'?save:async()=>{setBusy(true);const result=await ctx.act(()=>ctx.call('withdrawReviewedItem',{recordId,expectedDigest:r.digest,reason}),'此条归档已撤回，记录保留');setBusy(false);if(result)onClose();}}>{busy?'正在保存…':mode==='edit'?'确认写入更正':'确认撤回该条归档'}</button></>}</div></Modal>{source&&<SourceSnapshot source={source} onClose={()=>setSource(null)}/>}</>;
}

export function ReviewHistoryPanel({ctx,chapter,version,onVersion,onReconsider,includeObsolete=false}:{ctx:AppContext;chapter:string;version:string;onVersion:(v:string)=>void;onReconsider:(p:Proposal)=>void;includeObsolete?:boolean}){
  const [records,setRecords]=useState<any[]>([]),[detail,setDetail]=useState<string|null>(null),[kind,setKind]=useState('all'),[showObsolete,setShowObsolete]=useState(includeObsolete),[loading,setLoading]=useState(true);
  useEffect(()=>{let active=true;setLoading(true);ctx.call('reviewHistory').then(r=>{if(active)setRecords(r);}).catch(e=>ctx.notify(e.message,true)).finally(()=>{if(active)setLoading(false);});return()=>{active=false;};},[ctx.work]);
  useEffect(()=>setShowObsolete(includeObsolete),[includeObsolete,version]);
  const scoped=records.filter(r=>inChapter(ctx,r.documentId,chapter));
  const hashes=[...new Set(scoped.map(r=>r.sourceHash).filter(Boolean))] as string[];
  const shown=scoped.filter(r=>(showObsolete||r.status!=='obsolete')&&(!version||version==='current'&&r.current||r.sourceHash===version)&&(kind==='all'||kind==='manual'&&r.kind!=='automatic'||kind==='automatic'&&r.kind==='automatic'));
  return <><div className="notice">已接受、拒绝、自动归档及后续更正均保留。可查看当时确认稿，重新核对当前版记录，或新增作者更正。旧版未处理项只留历史，不混入当前待核对。</div><div className="review-filters"><label>记录版本<select aria-label="记录版本" value={version} onChange={e=>onVersion(e.target.value)}><option value="">全部版本</option><option value="current">当前版本与作者裁定</option>{hashes.map(h=><option key={h} value={h}>确认版 {short(h)}</option>)}</select></label><label>处理来源<select aria-label="处理来源" value={kind} onChange={e=>setKind(e.target.value)}><option value="all">全部记录</option><option value="manual">作者核对与裁定</option><option value="automatic">自动归档</option></select></label><label className="check-label"><input type="checkbox" checked={showObsolete} onChange={e=>setShowObsolete(e.target.checked)}/>显示已失效的待核对历史</label></div>{loading?<p>正在读取本地处理记录…</p>:shown.length?groups(ctx,shown,r=>r.documentId).map(g=><section className="review-chapter-group" key={g.id}><h2>{g.doc?.title||'其他资料'} <small>{g.items.length} 条记录</small></h2><div className="review-record-list">{g.items.map(r=><button className="panel review-record" key={r.recordId} data-review-record={r.recordId} onClick={()=>setDetail(r.recordId)}><div className="panel-heading"><strong>{ctx.work.characters.find(c=>c.id===r.fact.entity_id)?.name||'身份待核对'} · {fieldName(r.fact.field)}</strong><Badge status={r.status}/></div><p>{humanValue(r.fact,ctx.work.characters)}</p><small>{r.kind==='automatic'?'自动归档':r.kind==='correction'?'作者后续更正':r.kind==='author'?'作者裁定':actions[r.resolution]||'作者核对'} · {r.current?'当前版本／作者裁定':'历史版本'} {short(r.sourceHash)} · {dateText(r.reviewed_at)}{r.correctionCount?` · ${r.correctionCount} 次后续更正`:''}</small>{r.obsolete_message&&<p className="muted">{r.obsolete_message}</p>}<span className="proposal-open">查看记录与出处<Icon name="arrow" size={14}/></span></button>)}</div></section>):<Empty title="此范围内还没有处理记录" detail="可切换章节、确认版本或勾选显示已失效的待核对历史。"/>}{detail&&<ReviewRecordModal ctx={ctx} recordId={detail} onClose={()=>setDetail(null)} onReconsider={p=>{setDetail(null);onReconsider(p);}}/>}</>;
}
