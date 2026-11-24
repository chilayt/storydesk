import React,{useEffect,useState} from 'react';import type {AppContext,Fact} from './domain';
export function EvidenceRepair({ctx,fact,proposalId,quote,onQuote}:{ctx:AppContext;fact:Fact;proposalId:string;quote:string;onQuote:(v:string)=>void}){
  const [source,setSource]=useState<any>(null),[query,setQuery]=useState(''),[error,setError]=useState('');
  useEffect(()=>{let live=true;ctx.call('proposalEvidence',{proposalId}).then(s=>{if(live)setSource(s);}).catch(e=>{if(live)setError(e.message);});return()=>{live=false;};},[proposalId]);
  return <section className="evidence-repair panel"><h3>补选真实原句</h3><div className="notice danger">这条引用尚未在确认范围内定位，不能直接归档。下面的模型引文供对照；只有补选的实际原句才会成为正式依据。</div>
    <label>模型给出的引文（未核实）<pre className="model-quote">{fact.reported_evidence||'模型未提供原句'}</pre></label>
    {error&&<div className="notice danger">{error}</div>}{source&&<><p className="small-text muted">来源：{source.title} · 仅显示已确认范围</p><label>在源文段落中查找<input placeholder="输入人物名或原文关键词" value={query} onChange={e=>setQuery(e.target.value)}/></label><div className="evidence-options">{source.spans.filter((s:any)=>!query||s.text.includes(query)).map((s:any)=><button key={s.id} onClick={()=>onQuote(s.text)}><strong>[{s.id}]</strong> {s.text.slice(0,180)}{s.text.length>180?'…':''}</button>)}</div><details><summary>展开本次确认范围原文</summary><pre className="full-report">{source.text}</pre></details></>}
    <label>实际原句 · 可从上方选择或手动粘贴<textarea aria-label="补选的实际原句" rows={5} value={quote} onChange={e=>onQuote(e.target.value)}/></label><small>保存时再次校验版本和范围。改写、拼接、补字或确认范围之外的内容仍不能通过。</small>
  </section>;
}
