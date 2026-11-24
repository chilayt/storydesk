import React from 'react';
import type { AppContext } from './domain';
import { dateText } from './domain';
import { memoryScope } from './MemoryEditor';

export function MemoryTrace({ ctx, run, compact = false }: { ctx: AppContext; run: any; compact?: boolean }) {
  if (!run) return null;
  return <details className="memory-trace panel" open={!compact}>
    <summary>{run.requests?.length ? `本次 AI 请求读取 ${run.selected.length} 条记忆` : `已准备 ${run.selected.length} 条记忆，尚未发出请求`} · {dateText(run.created_at)}</summary>
    <p className="muted small-text">{({revision:'AI 修订',extraction:'剧情归档',obligation:'场景核对'} as Record<string,string>)[run.task]||run.task} · {ctx.work.documents.find(d => d.id === run.documentId)?.title || '源文档已移除'} · 请求尝试 {run.requests?.length || 0} 次 · 原稿版本 {run.sourceHash?.slice(0, 10)} · {({ prepared: '已准备', requested: '已请求', completed: '已完成', partial: '部分完成', failed: '任务失败', cancelled: '已取消', stale: '来源已变', interrupted: '已中断', incomplete:'核对未完成' } as Record<string, string>)[run.status] || run.status}</p>
    {!run.selected.length && <p>本任务未加载个人记忆，仍执行原有证据与审核规则。</p>}
    {run.selected.map((m: any) => <div className="memory-trace-item" key={m.id}><strong>{m.title} · 第 {m.revision} 版</strong><p>{m.content}</p><small>{memoryScope(m, ctx)}</small>{m.exceptions && <p>例外：{m.exceptions}</p>}<p className="muted small-text">来源：{m.source?.reference}{ctx.work.memories?.find(v => v.id === m.id)?._hash !== m.hash ? ' · 此后已修改，以上保留当时内容' : ''}</p></div>)}
    {!!run.excluded?.length && <details><summary>{run.excluded.length} 条未加载：查看原因</summary><ul>{run.excluded.map((m: any) => <li key={m.id}>{m.title}：{m.reason}</li>)}</ul></details>}
    <p className="muted small-text">记录的是请求采用的记忆快照；模型是否遵守仍需核对。未记录密钥或推理正文。</p>
  </details>;
}
