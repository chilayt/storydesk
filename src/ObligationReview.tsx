import React, { useState } from 'react';
import type { AppContext } from './domain';
import { Modal } from './components';
export function ObligationReview({ ctx, report, result, onClose, onSaved }: { ctx: AppContext; report: any; result: any; onClose: () => void; onSaved: (r: any) => void }) {
  const [decision, setDecision] = useState(result.verdict === 'satisfied' ? 'satisfied' : 'waive'), [reason, setReason] = useState(''), [quote, setQuote] = useState(result.evidence?.[0]?.evidence || '');
  const [source, setSource] = useState<any>(null), [query, setQuery] = useState(''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  async function save() { setBusy(true); setError(''); try { const r = await ctx.call('reviewObligation', { reportId: report.id, expectedHash: report._hash, itemId: result.item.id, decision, reason, evidenceQuote: quote }); await ctx.refresh(); onSaved(r); onClose(); } catch (e: any) { setError(e.message); } finally { setBusy(false); } }
  return <Modal title="作者逐项对账" subtitle={result.item.title} wide onClose={onClose}>
    <p>{result.item.description}</p><div className="notice">处理只绑定这张义务卡和当前稿件版本。放宽本项不会修改长期规则，也不会放宽原文完整性或文风门禁。</div>
    <label>作者处理<select aria-label="义务处理方式" value={decision} onChange={e => setDecision(e.target.value)}><option value="satisfied">确认已满足（语义项需原文依据）</option><option value="waive">本版放宽 / 不再要求此项</option><option value="pending">撤回处理，继续待核对</option></select></label>
    {decision === 'satisfied' && result.item.method === 'semantic' && <><label>本场连续原句<textarea aria-label="义务确认原句" rows={4} maxLength={3000} value={quote} onChange={e => setQuote(e.target.value)}/></label><button onClick={async () => { try { setSource(await ctx.call('obligationEvidence', { reportId: report.id })); } catch (e: any) { setError(e.message); } }}>从本场原文选择依据</button>{source && <div className="obligation-source"><input aria-label="筛选本场原句" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索本场段落"/>{source.spans.filter((s: any) => !query || s.text.includes(query)).slice(0, 35).map((s: any) => <button className="obligation-quote" key={s.id} onClick={() => setQuote(s.text)}>{s.text}</button>)}</div>}</>}
    <label>作者理由<textarea aria-label="义务作者理由" maxLength={1200} rows={3} value={reason} onChange={e => setReason(e.target.value)}/></label>
    {error && <div className="notice danger" role="alert">{error}</div>}<div className="modal-footer"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !reason.trim()} onClick={save}>保存本版裁定</button></div>
  </Modal>;
}
