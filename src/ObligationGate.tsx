import React, { useEffect, useState } from 'react';
import type { AppContext } from './domain';
export function ObligationGate({ ctx, documentId, sceneId, onState, onOpen }: { ctx: AppContext; documentId: string; sceneId: string; onState: (passed: boolean) => void; onOpen: () => void }) {
  const [gate, setGate] = useState<any>(null), [error, setError] = useState('');
  useEffect(() => { let active = true; onState(false); ctx.call('obligationGate', { documentId, sceneId: sceneId || null }).then(r => { if (active) { setGate(r); setError(''); onState(r.passed); } }).catch(e => { if (active) { setError(e.message); onState(false); } }); return () => { active = false; }; }, [documentId, sceneId, ctx.work.obligationCards, ctx.work.obligationChecks]);
  return <div className={`notice ${gate?.passed ? '' : 'warning'}`}><strong>场景义务核对</strong>{error ? <p>{error}</p> : !gate ? <p>正在核对义务卡和版本…</p> : <><p>{gate.cards.length ? gate.passed ? `${gate.cards.length}张正式义务卡的必需项已处理。` : '仍有义务需要检查或作者处理。' : '本范围尚无已确认义务卡，按原有门禁核对。'}</p>{gate.cards.filter((c:any)=>c.passed&&!c.required).map((c:any)=><p key={c.id}>{c.title}：{c.reason}</p>)}{gate.cards.filter((c: any) => !c.passed).map((c: any) => <p key={c.id}>{c.title}：{c.reason}</p>)}{gate.drafts.length > 0 && <p>{gate.drafts.length}张草稿或外部未登记义务卡尚未纳入；请核对是否需要启用。</p>}</>}<button onClick={onOpen}>打开场景与核对</button></div>;
}
