import React from 'react';import type {AppContext,Job} from './domain';
import {MemoryTrace} from './MemoryTrace';
import {ProviderDiagnostic} from './ProviderDiagnostic';
export function JobDiagnostic({ctx,job:j}:{ctx:AppContext;job:Job}){
  const sourceIssue=j.errorCode==='EVIDENCE'||j.diagnostics?.stage==='evidence';const s=j.evidenceSummary;
  return <>{ctx.work.memoryRuns?.filter(r=>r.taskId===j.id).map(r=><MemoryTrace key={r.id} ctx={ctx} run={r} compact/>)}{j.rawResultAvailable&&<p className="muted small-text">模型返回已保存于本机{j.reusedChunks?` · 已复用 ${j.reusedChunks} 个分段，无需重复请求这些内容`:''}</p>}
    {!!s?.unlocated&&<div className="notice">证据核对：{s.unlocated} 条引文尚未定位，涉及 {s.blockedEvents} 个事件。这些事件整组转入待核对，其他有依据的独立事件继续处理。当前自动归档 {j.applied||0} 项。</div>}
    {!!s?.formatting&&<p className="muted small-text">已将 {s.formatting} 条空格、换行或引号格式差异还原为实际原句。</p>}
    {j.error&&<div className="job-error"><p>{j.error}</p>{j.diagnostics?.stage==='http'?<ProviderDiagnostic diagnostics={j.diagnostics}/>:sourceIssue?<><strong>证据核对问题</strong><p>模型已返回内容，但引文没有在对应的确认版本中定位。这与API连接、输出额度不同。</p>{!j.rawResultAvailable&&<p>此旧版任务未保存模型原始返回。请在新版重新运行一次；之后会保留返回并按项核对。</p>}</>:j.diagnostics?.responseKeys?.length?<details><summary>查看返回格式诊断</summary><p>错误类型：{j.errorCode}；停止原因：{j.diagnostics.finishReason||'未提供'}；内容格式：{j.diagnostics.contentType||'未提供'}；返回字段：{j.diagnostics.responseKeys.join('、')}</p><small>不保存密钥与模型推理正文。</small></details>:null}
    {j.errorCode?.startsWith('AI_')?<button className="text-button" onClick={()=>ctx.navigate({page:'settings'})}>调整模型与输出上限</button>:<button className="text-button" onClick={()=>ctx.navigate({page:'reader',documentId:j.documentId})}>打开源稿核对</button>}</div>}
  </>;
}
