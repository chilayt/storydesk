import React, { useEffect, useRef, useState } from 'react';
import type { AppContext } from './domain';
import { dateText } from './domain';
import { Markdown } from './components';
import type { TrialSummary } from './writing-domain';

function TrialColumn({ ctx, id, side, original, disabled, onReview, onQuote }:
  { ctx: AppContext; id: string; side: string; original: string; disabled: boolean;
    onReview: (id: string) => void; onQuote: (text: string) => void }) {
  const [proposal, setProposal] = useState<any>(null);
  const [rows, setRows] = useState<any[]>([]);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const last = useRef({ proposal, rows, dirty }); last.current = { proposal, rows, dirty };
  const saving = useRef<Promise<void> | null>(null);
  async function saveCurrent() {
    if (saving.current) await saving.current;
    const state = last.current;
    if (!state.dirty || !state.proposal || state.proposal.status !== 'pending') return;
    const pending = ctx.call('saveRevisionDraft', { id: state.proposal.id, proposalHash: state.proposal.proposalHash,
      edits: state.rows.map(e => ({ id: e.id, after: e.after, selected: e.selected })) }).then(saved => {
        if (last.current.proposal?.id === saved.id) {
          last.current = { proposal: saved, rows: saved.edits, dirty: false };
          setProposal(saved); setRows(saved.edits); setDirty(false);
        }
      });
    saving.current = pending;
    try { await pending; } finally { if (saving.current === pending) saving.current = null; }
  }
  const saveRef = useRef(saveCurrent); saveRef.current = saveCurrent;
  useEffect(() => {
    let live = true;
    if (id !== 'original') ctx.call('getRevision', { id }).then(result => {
      if (live) { setProposal(result); setRows(result.edits); }
    }).catch(e => { if (live) setError((e as Error).message); });
    const unsubscribe = window.storyDesk.onFlush(() => saveRef.current());
    return () => { live = false; unsubscribe(); void saveRef.current().catch(() => {}); };
  }, [id]);
  async function save() {
    setBusy(true); setError('');
    try { await saveCurrent(); } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  if (id === 'original') return <section className="trial-column" aria-label={`${side}当前原稿`}><h3>当前原稿</h3>
    <p className="studio-muted">试写分别基于保存版本；采用前会再次核对。</p><div className="trial-original"><Markdown text={original}/></div></section>;
  return <section className="trial-column" aria-label={`${side}候选稿`}>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {!proposal && !error && <p role="status">正在读取试写…</p>}
    {proposal && <><h3>{proposal.variantLabel || '创作候选稿'}</h3><p className="studio-muted">{dateText(proposal.created_at)} ·
      {proposal.stale ? proposal.staleReason || '原稿已有新版本，仅供对照' : proposal.status === 'applied' ? '已采用，保留历史' : '候选稿，尚未写入正文'}</p>
      <div className="trial-edits">{rows.map((row, index) => <section className="trial-edit" key={row.id}>
        <p className="studio-muted">{rows.length > 1 ? `修改 ${index + 1} · ` : ''}{row.rule}</p>
        <details className="trial-before"><summary>对应原文</summary><pre>{row.before || '章末新增文字'}</pre></details>
        <textarea aria-label={`${side}试写文本${rows.length > 1 ? index + 1 : ''}`} value={row.after} maxLength={12000}
          rows={Math.max(6, Math.min(20, row.after.split('\n').length + 3))} disabled={disabled || busy || proposal.status !== 'pending'}
          onChange={e => { const edited = rows.map(r => r.id === row.id ? { ...r, after: e.target.value } : r);
            last.current = { proposal, rows: edited, dirty: true }; setRows(edited); setDirty(true); }}
          onSelect={e => { const el = e.currentTarget; if (el.selectionEnd > el.selectionStart) el.dataset.quote = el.value.slice(el.selectionStart, el.selectionEnd); }}/>
        <div className="studio-actions"><button onClick={e => { const textarea = e.currentTarget.parentElement?.previousElementSibling as HTMLTextAreaElement;
          const quote = textarea?.dataset.quote; if (quote) onQuote(quote); }}>所选文字带回对话</button>
          <small className="studio-muted">{row.after.length} 字符</small></div>
        {row.reason && <p>{row.reason}</p>}
      </section>)}</div>
      <div className="studio-actions"><button disabled={disabled || busy || !dirty || proposal.status !== 'pending'} onClick={save}>
        {busy ? '正在保存…' : dirty ? '保存候选修改' : '候选已保存'}</button>
        <button className="primary" disabled={disabled || busy || proposal.stale || proposal.status !== 'pending'}
          onClick={async () => { setBusy(true); try { await saveCurrent(); onReview(id); } catch (e) { setError((e as Error).message); } finally { setBusy(false); } }}>审核此稿</button></div>
    </>}
  </section>;
}

export function TrialCompare({ ctx, revisions, original, disabled, onReview, onQuote, onTryAgain }:
  { ctx: AppContext; revisions: TrialSummary[]; original: string; disabled: boolean;
    onReview: (id: string) => void; onQuote: (text: string) => void; onTryAgain: () => void }) {
  const [left, setLeft] = useState(revisions.length > 1 ? revisions.at(-2)!.id : 'original');
  const [right, setRight] = useState(revisions.at(-1)?.id || 'original');
  const [error, setError] = useState('');
  const [switching, setSwitching] = useState(false);
  async function change(side: 'left' | 'right', id: string) {
    setSwitching(true);
    try { await window.storyDesk.flushNow(); (side === 'left' ? setLeft : setRight)(id); }
    catch (e) { setError((e as Error).message); } finally { setSwitching(false); }
  }
  if (!revisions.length) return <div className="studio-empty"><h2>保留原稿，另试一种写法</h2><p>在左侧填写已经定好的情节，生成候选稿后，可以在这里比较与手改。</p>
    <button onClick={onTryAgain}>准备一份试写要求</button></div>;
  return <section className="trial-compare" aria-label="试写比较">
    <div className="studio-section-heading"><div><h2>试写比较</h2><p>各稿独立保存；审核采用后才会修改正文。</p></div><button disabled={disabled} onClick={onTryAgain}>再试一种</button></div>
    {error && <p className="notice danger" role="alert">{error}</p>}
    <div className="trial-selectors">{(['left', 'right'] as const).map(side => <label key={side}>{side === 'left' ? '左侧版本' : '右侧版本'}
      <select aria-label={side === 'left' ? '左侧版本' : '右侧版本'} value={side === 'left' ? left : right} disabled={disabled || switching}
        onChange={e => void change(side, e.target.value)}><option value="original">当前原稿</option>
        {revisions.map(row => <option key={row.id} value={row.id}>{row.title}{row.stale ? ' · 旧稿' : ''}{row.status === 'applied' ? ' · 已采用' : ''}</option>)}</select></label>)}</div>
    <div className="trial-columns"><TrialColumn key={`left-${left}`} ctx={ctx} id={left} side="左侧" original={original} disabled={disabled || switching} onReview={onReview} onQuote={onQuote}/>
      <TrialColumn key={`right-${right}`} ctx={ctx} id={right} side="右侧" original={original} disabled={disabled || switching} onReview={onReview} onQuote={onQuote}/></div>
  </section>;
}
