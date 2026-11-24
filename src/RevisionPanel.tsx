import React, { useEffect, useMemo, useState } from 'react';
import type { AppContext, SourceDocument } from './domain';
import { Modal, Badge, Markdown, Icon } from './components';
import { MemoryEditor } from './MemoryEditor';
import { MemoryTrace } from './MemoryTrace';

const intersects = (a: { start: number; end: number }, b: { start: number; end: number }) =>
  a.start < b.end && b.start < a.end || a.start === b.start && (a.end > a.start || b.end > b.start);

export function RevisionPanel({ctx,document:doc,report,initialId,onApplied,onClose}:{ctx:AppContext;document:SourceDocument;report?:any;initialId?:string;onApplied?:(result:any)=>void;onClose:()=>void}){
  const [proposal,setProposal]=useState<any>(null);const [rows,setRows]=useState<any[]>([]);const [busy,setBusy]=useState(false);const [taskId,setTaskId]=useState('');const [progress,setProgress]=useState('');const [error,setError]=useState('');const [preview,setPreview]=useState(false);const [reviewed,setReviewed]=useState(false);
  function accept(p:any){
    setProposal(p);setRows(p.edits.map((row:any) => ({ ...row, selected: row.selected && !p.edits.some((other:any) =>
      row.id !== other.id && other.selected && intersects(row, other)) })));setReviewed(false);
  }
  function selectEdit(id: string, checked: boolean) {
    const edit = rows.find(row => row.id === id);
    setRows(previous => previous.map(row => row.id === id ? { ...row, selected: checked } :
      checked && intersects(row, edit) ? { ...row, selected: false } : row));
    setReviewed(false);
  }
  useEffect(()=>{if(initialId)ctx.call('getRevision',{id:initialId}).then(accept).catch(e=>setError(e.message));},[initialId]);
  useEffect(()=>window.storyDesk.subscribe(e=>{if(e.type==='revision-progress'){setTaskId(e.id);setProgress(`${Math.round(e.completed/e.total*100)}%`);}}),[]);
  const [remember,setRemember]=useState<any>(null);
  const [candidateCheck, setCandidateCheck] = useState<{ key: string; report: any } | null>(null);
  const selected=rows.filter(e=>e.selected);
  const coWriting = proposal?.origin === 'cowriting';
  const checkKey = JSON.stringify([proposal?.id, selected.map(e => ({ id: e.id, after: e.after }))]);
  const untouchedCandidate = proposal?.edits.every((original: any) =>
    rows.some(row => row.id === original.id && row.selected && row.after === original.suggested_after));
  const visibleCheck = candidateCheck?.key === checkKey ? candidateCheck.report : untouchedCandidate ? proposal?.candidateCheck : null;
  const repairText = {
    passed: 'Agent 已按硬线返修，复检通过。',
    improved: 'Agent 已返修一次。剩余硬线可在报告内查看。',
    unresolved: '已保留机检结果更好的候选。请核对剩余硬线。',
    incomplete: '自动返修未完成。当前候选及检查结果可继续查看。',
  }[visibleCheck?.repair as string];
  const finalText=useMemo(()=>{let text=proposal?.sourceText||doc.text||'';for(const e of [...selected].sort((a,b)=>b.start-a.start))text=text.slice(0,e.start)+e.after+text.slice(e.end);return text;},[rows,doc.text,proposal?.sourceText]);
  async function generate(){setBusy(true);setError('');setProgress('正在读取本章与关联资料');try{accept(await ctx.call('generateRevision',{documentId:doc.id,sourceHash:doc.hash,checkId:report?.id}));await ctx.refresh();}catch(e:any){setError(e.message);}finally{setBusy(false);setTaskId('');}}
  async function save(){if(!proposal)return;const r=await ctx.act(()=>ctx.call('saveRevisionDraft',{id:proposal.id,proposalHash:proposal.proposalHash,edits:rows.map(e=>({id:e.id,after:e.after,selected:e.selected}))}),'建议草稿已保存，原文尚未改动');if(r){setProposal(r);setRows(r.edits);}return r;}
  async function apply(){setBusy(true);try{const r=await ctx.act(()=>ctx.call('applyRevision',{id:proposal.id,proposalHash:proposal.proposalHash,sourceHash:doc.hash,edits:selected.map(e=>({id:e.id,after:e.after}))}),doc.kind === 'draft' ? '所选修改已写入本章草稿' : '所选修改已写入本地正文，请重新检查');if(r){onApplied?.(r);onClose();}}finally{setBusy(false);}}
  async function close(){if(busy)return;if(proposal&&proposal.status==='pending'&&!proposal.stale){const r=await save();if(!r)return;}onClose();}
  async function checkCandidate() {
    if (!proposal || !selected.length) return;
    setBusy(true); setError('');
    try {
      const result = await ctx.call('previewWritingRevision', { id: proposal.id, proposalHash: proposal.proposalHash,
        edits: selected.map(e => ({ id: e.id, after: e.after })) });
      setCandidateCheck({ key: checkKey, report: result });
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if(remember)return <MemoryEditor ctx={ctx} initial={remember} onClose={()=>setRemember(null)}/>;
  const pending = proposal?.status === 'pending';
  const footer = <>
    {pending && <label className="check-label"><input type="checkbox" checked={reviewed} onChange={e=>setReviewed(e.target.checked)}/>{coWriting ? '我已核对所选文字，同意写入本章的当前编辑版本' : '我已核对所选修改，不改变已确认的剧情与人物关系，同意写入本地正文'}</label>}
    <div className="modal-footer"><button disabled={busy} onClick={close}>{pending ? '保存建议并关闭' : '关闭'}</button>{pending && <>
      <button disabled={busy || proposal.stale} onClick={save}>保存建议草稿</button>
      <button className="primary" disabled={busy || proposal.stale || !reviewed || !selected.length} onClick={apply}>确认所选修改并写入</button>
    </>}</div>
  </>;
  return <Modal title={coWriting ? '创作候选稿' : 'AI 一键修订 · 作者审核'} subtitle={coWriting ? '检查和编辑所选文字，再决定是否写入本章。' : '读取上下文、人物档案与关系，提出最小修改。'} wide onClose={close} footer={footer}>
    <div className="confirm-summary"><h3>{doc.title}</h3><Badge>{proposal?`${rows.length} 项建议`:'尚未生成'}</Badge></div>
    {!coWriting && <div className="notice">会参考本章、前章结尾、后章开头、截至本章的人物资料和关系、文风规则及作者用词裁定。无法靠措辞解决的承接或剧情问题会单列说明。</div>}
    {error&&<div className="notice danger">{error}</div>}
    {!proposal && initialId && !error && <p role="status">正在读取候选稿…</p>}
    {!proposal&&!initialId&&<div className="revision-start"><p>生成建议会使用作品设置中的模型与预算。生成后可以逐项勾选、手动改写，或保留原句。</p><button className="primary" disabled={busy||!report||!ctx.work.writingModel.enabled} onClick={generate}><Icon name="edit"/>{busy?`AI 正在分析 · ${progress}`:'生成修订建议'}</button>{busy&&taskId&&<button onClick={()=>ctx.call('cancelRevision',{id:taskId})}>取消分析</button>}</div>}
    {proposal&&<>{proposal.stale&&<div className="notice danger">{proposal.staleReason || '正文已有新版本，此建议保留供参考。请关闭后重新检查、生成，当前建议不能覆盖新稿。'}</div>}{proposal.status==='applied'&&<div className="notice">此批建议已应用，可在版本与恢复中查看原稿。</div>}
      <MemoryTrace ctx={ctx} run={ctx.work.memoryRuns?.find(r=>r.id===proposal.memoryRunId)} compact/>
      <div className="list-toolbar"><span>{selected.length} / {rows.length} 项已选</span><div className="actions">{rows.length > 1 && <>
        <button onClick={()=>{setRows(rows.map(e=>({...e,selected:!rows.some(other => other.id !== e.id && intersects(e, other))})));setReviewed(false);}}>全选无冲突</button>
        <button onClick={()=>{setRows(rows.map(e=>({...e,selected:false})));setReviewed(false);}}>全不选</button>
      </>}<button onClick={()=>setPreview(!preview)}>{preview?'返回逐项审核':'预览修改后的全文'}</button></div></div>
      {proposal.contextSummary&&<p className="muted small-text">参考人物：{proposal.contextSummary.characters.join('、')||'未匹配'}；关系 {proposal.contextSummary.relationships} 条；前章 {proposal.contextSummary.previous||'无'}；后章 {proposal.contextSummary.next||'无'}。</p>}
      {preview?<div className="revision-preview"><Markdown text={finalText}/></div>:rows.map((e,i)=><section className={`revision-edit panel ${e.selected?'':'excluded'}`} key={e.id}><div className="panel-heading"><label className="check-label"><input type="checkbox" checked={e.selected} onChange={v=>selectEdit(e.id,v.target.checked)}/>修改 {i+1} · {e.rule}{rows.some(other => other.id !== e.id && intersects(e, other)) && " · 重叠建议"}</label><Badge>{e.risk}</Badge></div><p>{e.reason}</p><div className="diff-columns"><div><h4>当前原文</h4><pre>{coWriting && !e.before ? '章末新增' : e.before}</pre></div><div><h4>建议文本 · 可直接手动修改</h4><textarea aria-label={`修改${i+1}的建议文本`} rows={Math.max(4,Math.min(14,e.after.split('\n').length+2))} value={e.after} onChange={v=>{setRows(rows.map((r,j)=>i===j?{...r,after:v.target.value}:r));setReviewed(false);}}/></div></div>{e.after!==(e.suggested_after||e.after)&&<button onClick={()=>setRemember({kind:'correction',status:'candidate',origin:'revision',title:`${e.rule}的改写案例`.slice(0,90),content:e.reason.slice(0,1600),tasks:['revision'],source:{reference:`修订建议 ${proposal.id}；作者手动改写，适用规则仍需核对`,quote:''},scope:{kind:'document',documentId:doc.id},example:{before:e.before.slice(0,1800),suggested:(e.suggested_after||'').slice(0,1800),after:e.after.slice(0,1800)}})}>保存为待核对的纠错案例</button>}</section>)}
      {!rows.length&&<div className="notice">AI 未提出可定位的文字修改。请查看下方未解决事项；这不代表检查已通过。</div>}{!!proposal.notes?.length&&<section className="panel"><h3>仍需作者处理</h3><ul>{proposal.notes.map((n:string,i:number)=><li key={i}>{n}</li>)}</ul></section>}
      {coWriting && proposal.status === 'pending' && <section className="panel">
        <div className="panel-heading"><h3>候选稿机检</h3>{visibleCheck
          ? <Badge status={visibleCheck.status}/>
          : <button disabled={busy || proposal.stale || !selected.length} onClick={checkCandidate}><Icon name="shield"/>检查候选稿</button>}</div>
        {repairText && <p className="small-text muted">{repairText}</p>}
        {visibleCheck && <details><summary>{proposal.candidateCheck === visibleCheck ? '生成后自动机检' : '修改后机检'} · {visibleCheck.findings?.length || 0} 条提示</summary>
          {!!visibleCheck.findings?.length && <ul>{visibleCheck.findings.map((item: any) => <li key={item.id}>
            {item.line && <strong>第 {item.line} 行 · </strong>}{item.term || item.quote || item.message}
          </li>)}</ul>}
          <pre>{visibleCheck.output.split('\n').filter((line: string) => !line.startsWith('STORYDESK_GATE_JSON:')).join('\n')}</pre>
        </details>}
        <small>成稿确认时按保存后的正文版本重新检查。</small>
      </section>}
    </>}
  </Modal>;
}
