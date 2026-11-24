import React, { useEffect, useState } from 'react';
import type { AppContext, Navigation } from './domain';
import { dateText } from './domain';
import { Badge, Empty, Icon, Modal } from './components';
import { ObligationCardEditor, obligationMethods } from './ObligationCardEditor';
import { ObligationReview } from './ObligationReview';
import { MemoryTrace } from './MemoryTrace';
import { ManagedReview } from './ManagedReview';

const states: Record<string, string> = { draft: '草稿', confirmed: '已确认', disabled: '已停用' };
const verdicts: Record<string, string> = { satisfied: '找到满足依据', unsatisfied: '未满足 / 未找到依据', needs_author: '需要作者判断', incomplete: '检查未完成' };
export default function Obligations({ ctx, nav }: { ctx: AppContext; nav: Navigation }) {
  const [documentId, setDocumentId] = useState(nav.documentId || ctx.work.obligationCards?.find(c=>c.id===nav.cardId)?.documentId || ctx.work.documents.find(d => d.kind === 'chapter')?.id || ''), [cardId, setCardId] = useState(nav.cardId || '');
  const [editor, setEditor] = useState<any>(null), [report, setReport] = useState<any>(null), [review, setReview] = useState<any>(null), [pack, setPack] = useState<any>(null), [managed, setManaged] = useState('');
  const [busy, setBusy] = useState(false), [progress, setProgress] = useState(''), [taskId, setTaskId] = useState(''), [error, setError] = useState('');
  const cards = (ctx.work.obligationCards || []).filter(c => c.documentId === documentId), card = cards.find(c => c.id === cardId) || cards[0];
  const doc = ctx.work.documents.find(d => d.id === documentId);
  const checks = (ctx.work.obligationChecks || []).filter(r => r.cardId === card?.id&&!r.unreviewedExternal).sort((a, b) => b.created_at.localeCompare(a.created_at)), last = checks[0];
  useEffect(() => { if (!busy) { if (last) ctx.call('getObligationReport', { id: last.id }).then(setReport).catch(e => setError(e.message)); else setReport(null); } }, [card?.id, last?._hash, busy]);
  useEffect(() => window.storyDesk.subscribe(e => { if (e.type === 'obligation-progress') { setTaskId(e.id); setProgress(`${e.completed}/${e.total} 个分段`); } }), []);
  async function run(useAI: boolean, resume = false) {
    if (!card || !doc) return; setBusy(true); setError(''); setTaskId(''); setProgress('正在固定本场版本');
    try { const r = await ctx.call('checkObligations', { cardId: card.id, sourceHash: doc.hash, useAI, reportId: resume ? report?.id : null }); setReport(r); await ctx.refresh(); }
    catch (e: any) { setError(e.message); } finally { setBusy(false); setTaskId(''); }
  }
  const pending = report?.results?.filter((x: any) => x.item.severity === 'required' && !x.resolved) || [];
  return <div className="obligations-page"><div className="page-heading"><div><h1>场景与核对</h1><p>本场约定逐项留痕；机检保证没有漏查，语义满足由作者裁定。</p></div><button className="primary" disabled={!doc} onClick={() => setEditor({})}><Icon name="plus"/>新建义务卡</button></div>
    <div className="notice">义务卡确认前是计划；核对报告不写入人物事实。只有你确认并启用的卡片参与成稿前核对。</div>
    <label>选择稿件<select aria-label="义务稿件筛选" value={documentId} onChange={e => { setDocumentId(e.target.value); setCardId(''); setReport(null); setError(''); }}>{ctx.work.documents.filter(d => ['chapter', 'draft'].includes(d.kind)).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>
    <div className="obligation-layout"><aside className="obligation-list">{cards.map(c => <button className={c.id === card?.id ? 'active' : ''} key={c.id} onClick={() => { setCardId(c.id); setError(''); }}><strong>{c.title}</strong><small>{states[c.status] || '待恢复'} · {c.sceneId ? ctx.work.scenes.find(s => s.id === c.sceneId)?.name || '失效场景' : '整份稿件'} · {c.items?.length || 0}项</small></button>)}{!cards.length && <p className="muted">本稿件尚无义务卡。</p>}</aside>
      <div className="obligation-main">{!card ? <Empty title="把本场必须交代的内容列成清单" detail="可先批量粘贴已确认的分场要求，再选择哪些适合机检、哪些需要语义核对。"/> : <>
        <section className="panel"><div className="panel-heading"><div><h2>{card.title}</h2><p className="muted small-text">第{card.revision}版 · {states[card.status]} · {card.source}</p></div><button disabled={busy || card.damaged || card.externalPending || card.unreviewedExternal} onClick={() => setEditor(card)}>编辑义务卡</button></div>
          {(card.damaged || card.externalPending || card.unreviewedExternal) && <div className="notice danger">卡片有外部修改、来源未登记或记录损坏，不能作为正式核对依据。<button onClick={() => setManaged(`_创作管理/场景义务/${card.id}.md`)}>核对本地义务卡</button></div>}
          <div className="obligation-context"><p><strong>本场目标：</strong>{card.goal || '未另写'}</p><p><strong>入场：</strong>{card.opening || '未另写'}</p><p><strong>结束：</strong>{card.closing || '未另写'}</p></div>
          <details><summary>查看 {card.items?.length || 0} 项作者约定</summary>{card.items?.map((i: any) => <div className="memory-trace-item" key={i.id}><strong>{i.title}</strong><p>{i.description}</p><small>{obligationMethods[i.method]} · {i.severity === 'required' ? '确认前需处理' : '仅提醒'}</small>{i.terms?.length > 0 && <p>{i.terms.join(' / ')}</p>}</div>)}</details>
          <div className="actions"><button disabled={busy} onClick={async () => { const r = await ctx.act(() => ctx.call('obligationContext', { cardId: card.id })); if (r) setPack(r); }}>查看本场上下文包</button><button onClick={() => ctx.navigate({ page: 'reader', documentId })}>打开正文</button></div>
        </section>
        {card.status !== 'confirmed' ? <div className="notice">这张卡尚未纳入成稿核对。编辑并确认后，可以开始逐项检查。</div> : <section className="panel"><h3>核对当前稿件版本</h3><p>机检直接核对词句和称呼；语义初核检查每项、每个分段，找到的依据交你确认。未返回、错引或未查完都不算通过。</p><div className="actions"><button disabled={busy} onClick={() => run(false)}>运行机检 / 人工对账</button><button className="primary" disabled={busy || !ctx.work.writingModel.enabled} onClick={() => run(true)}>AI 逐项核对</button>{report && !report.stale && report.parts.some((p: any) => p.status !== 'done') && <button disabled={busy || !ctx.work.writingModel.enabled} onClick={() => run(true, true)}>继续未完成分段</button>}{busy && taskId && <button onClick={() => ctx.call('cancelObligationCheck', { id: taskId })}>取消核对</button>}</div>{busy && <p role="status">正在核对 · {progress}</p>}{!ctx.work.writingModel.enabled && <p className="muted small-text">模型未启用，仍可运行机检并人工逐项处理。</p>}</section>}
        {error && <div className="notice danger" role="alert">{error}</div>}
        {report && <section className="obligation-report"><div className="panel-heading"><div><h2>逐项对账</h2><p className="muted small-text">{dateText(report.created_at)} · 稿件 {report.sourceHash.slice(0, 10)} · 义务卡 {report.cardHash.slice(0, 10)}</p></div><Badge status={report.stale || pending.length ? 'pending' : 'accepted'}>{report.stale ? '报告已失效' : pending.length ? `${pending.length}项必需义务待处理` : '必需义务已处理'}</Badge></div>
          {report.stale && <div className="notice danger">{report.staleReason}。旧报告保留供对照，不能用来确认新稿。</div>}
          {report.error && <div className="notice warning">{report.error}。已完成的检查和依据保留；可继续未完成分段，或人工逐项对账。</div>}
          <div className="notice">机检 {report.mechanical.length} 项；语义覆盖 {report.coverage.checked}/{report.coverage.expected} 个“义务 × 文本分段”记录，{report.coverage.complete ? '完整' : '尚未完整'}。{!pending.length && !report.coverage.complete ? '必需项由作者处理完毕；AI覆盖仍未完成。' : ''}</div>
          <MemoryTrace ctx={ctx} run={ctx.work.memoryRuns?.find(r => r.id === report.memoryRunId)} compact/>
          <button disabled={busy || report.stale || !report.results.some((x: any) => x.item.method === 'semantic' && x.verdict === 'satisfied' && x.complete && !x.resolved)} onClick={async () => { const r = await ctx.act(() => ctx.call('acceptObligationEvidence', { reportId: report.id, expectedHash: report._hash }), '已记录作者对满足项的核对'); if (r) setReport(r); }}>我已逐项核对，接受有依据的满足项</button>
          {report.results.map((r: any, n: number) => <section className={`panel obligation-result ${r.resolved ? 'resolved' : ''}`} key={r.item.id} data-obligation-id={r.item.id}><div className="panel-heading"><h3>{n + 1}. {r.item.title}</h3><Badge status={r.resolved ? 'accepted' : 'pending'}>{r.resolved ? r.review?.decision === 'waive' ? '作者本版放宽' : '已处理' : verdicts[r.verdict] || r.verdict}</Badge></div><p>{r.item.description}</p><small>{obligationMethods[r.item.method]} · {r.item.severity === 'required' ? '确认前需处理' : '仅提醒'}</small><p>{r.reason}</p>{r.evidence.map((e: any, i: number) => <button className="obligation-quote" key={i} onClick={() => ctx.navigate({ page: 'reader', documentId, quote: e.evidence })}>{e.evidence}</button>)}{r.evidenceIssues?.map((e: any, i: number) => <div className="notice warning" key={i}><strong>模型引用未定位</strong><p>{e.reported}</p><small>{e.reason}</small></div>)}{r.review && <div className="notice"><p>作者：{r.review.reason}</p>{r.review.evidence?.map((e: any, i: number) => <blockquote key={i}>{e.evidence}</blockquote>)}</div>}<button disabled={busy || report.stale} onClick={() => setReview(r)}>作者逐项处理</button></section>)}
          {report.parts.some((p: any) => p.status !== 'done') && <details><summary>查看未完成覆盖</summary>{report.parts.filter((p: any) => p.status !== 'done').map((p: any) => <p className="muted small-text" key={p.id}>原文范围 {p.start}—{p.end}，{p.itemIds.length}项；{p.errors?.join('；') || '尚未完整返回'}</p>)}</details>}
          <p className="muted small-text">本卡使用最新创建的报告作为确认依据。重新检查会生成新报告；旧报告和作者处理保留在本地历史中。</p>
        </section>}
      </>}</div>
    </div>
    {editor && <ObligationCardEditor ctx={ctx} documentId={documentId} initial={editor.id ? editor : undefined} onClose={() => setEditor(null)} onSaved={id => setCardId(id)}/>}
    {review && <ObligationReview ctx={ctx} report={report} result={review} onClose={() => setReview(null)} onSaved={setReport}/>}
    {managed && <ManagedReview ctx={ctx} path={managed} onClose={() => setManaged('')}/>}
    {pack && <Modal title="本场上下文包" subtitle="可带到现有创作工具中；包含义务卡与有范围的参考，不生成正文。" wide onClose={() => setPack(null)}><p className="muted small-text">参考人物：{pack.characters.join('、') || '尚未匹配'}。生成此包不调用模型；未确认记忆不载入。</p><textarea className="obligation-pack" aria-label="本场上下文包内容" readOnly rows={18} value={pack.text}/><div className="modal-footer"><button onClick={() => setPack(null)}>关闭</button><button onClick={async () => { try { await navigator.clipboard.writeText(pack.text); ctx.notify('已复制本场上下文包'); } catch { ctx.notify('可选中文本后使用 Ctrl+C 复制', true); } }}>复制上下文包</button></div></Modal>}
  </div>;
}
