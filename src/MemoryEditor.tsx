import React, { useState } from 'react';
import type { AppContext } from './domain';
import { Modal } from './components';

export const memoryKinds: Record<string, string> = { principle: '协作原则', preference: '写作偏好', task: '任务约定', correction: '纠错案例' };
export const memoryStates: Record<string, string> = { candidate: '待核对', confirmed: '已确认', disabled: '已停用', superseded: '已被替代' };
export function memoryScope(m: any, ctx: AppContext) {
  const s = m.scope || {};
  const name = s.kind === 'character' ? (s.characterIds || []).map((id: string) => ctx.work.characters.find(c => c.id === id)?.name || '已移除人物').join('、') : s.kind === 'document' || s.kind === 'scene' ? `${ctx.work.documents.find(d => d.id === s.documentId)?.title || '已移除文档'}${s.sceneId ? ` · ${ctx.work.scenes.find(v => v.id === s.sceneId)?.name || '已变场景'}` : ''}` : '本作品';
  return `${name}${s.fromChapter || s.toChapter ? ` · 第${s.fromChapter || 1}—${s.toChapter || '最新'}章` : ''}${m.lifetime === 'once' ? ' · 仅下一次适用任务' : ''}`;
}
export function MemoryEditor({ ctx, initial, onClose, onSaved }: { ctx: AppContext; initial?: any; onClose: () => void; onSaved?: () => void }) {
  const [row, setRow] = useState<any>(() => ({ title: '', topic: '', kind: 'preference', status: 'candidate', origin: 'manual', content: '', exceptions: '', tasks: ['revision'], lifetime: 'persistent', source: { reference: '作者在记忆中心填写', quote: '' }, example: { before: '', suggested: '', after: '' }, ...initial, scope: { kind: 'work', characterIds: [], documentId: null, sceneId: null, fromChapter: null, toChapter: null, ...initial?.scope } }));
  const [ack, setAck] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const change = (key: string, value: any) => { setRow((r: any) => ({ ...r, [key]: value })); setAck(false); };
  const scope = (key: string, value: any) => change('scope', { ...row.scope, [key]: value });
  async function save() {
    setBusy(true); setError('');
    try {
      await ctx.call('saveMemory', { ...row, topic: row.topic || row.title, expectedHash: initial?._hash, expectedRevision: initial?.revision, authorConfirmed: ack, replacesHash: ctx.work.memories?.find(m => m.id === row.replacesId)?._hash });
      await ctx.refresh(); ctx.notify(row.status === 'confirmed' ? '已保存为适用任务可读取的记忆' : '记忆已保存，尚未启用'); onSaved?.(); onClose();
    } catch (e: any) { setError(e.message); } finally { setBusy(false); }
  }
  return <Modal title={initial?.id ? '编辑记忆与规则' : '新增记忆与规则'} subtitle="记录你的明确要求。推断出的偏好先留待核对；小说中的人物说法不能成为作者要求。" wide onClose={() => { if (!busy) onClose(); }}>
    <div className="memory-form-grid">
      <label>标题<input aria-label="记忆标题" maxLength={90} value={row.title} onChange={e => change('title', e.target.value)}/></label>
      <label>规则主题<input aria-label="规则主题" placeholder="如：修订尺度；相同主题会检查冲突" maxLength={90} value={row.topic} onChange={e => change('topic', e.target.value)}/></label>
      <label>类型<select aria-label="记忆类型" value={row.kind} onChange={e => change('kind', e.target.value)}>{Object.entries(memoryKinds).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></label>
      <label>状态<select aria-label="记忆状态" value={row.status} onChange={e => change('status', e.target.value)}>{['candidate', 'confirmed', 'disabled'].map(k => <option key={k} value={k}>{memoryStates[k]}</option>)}</select></label>
    </div>
    <label>希望 AI 记住的内容<textarea aria-label="记忆内容" rows={4} maxLength={1600} value={row.content} onChange={e => change('content', e.target.value)}/></label>
    <label>例外与边界<textarea aria-label="记忆例外" rows={2} maxLength={600} placeholder="如：本场为冲突高潮，可在作者确认后加快节奏。" value={row.exceptions} onChange={e => change('exceptions', e.target.value)}/></label>
    <div className="memory-form-grid">
      <label>适用范围<select aria-label="记忆适用范围" value={row.scope.kind} onChange={e => change('scope', { ...row.scope, kind: e.target.value, characterIds: [], documentId: null, sceneId: null })}><option value="work">本作品</option><option value="character">指定人物</option><option value="document">指定文档</option><option value="scene">指定场景</option></select></label>
      <label>有效期<select aria-label="记忆有效期" value={row.lifetime} onChange={e => change('lifetime', e.target.value)}><option value="persistent">持续适用，直至修改或停用</option><option value="once">仅下一次适用的 AI 任务</option></select></label>
      <label>起始章（可留空）<input aria-label="记忆起始章" type="number" min="1" value={row.scope.fromChapter ?? ''} onChange={e => scope('fromChapter', e.target.value ? Number(e.target.value) : null)}/></label>
      <label>结束章（可留空）<input aria-label="记忆结束章" type="number" min="1" value={row.scope.toChapter ?? ''} onChange={e => scope('toChapter', e.target.value ? Number(e.target.value) : null)}/></label>
    </div>
    {row.scope.kind === 'character' && <fieldset className="memory-choices"><legend>指定人物（可多选）</legend>{ctx.work.characters.map(c => <label className="check-label" key={c.id}><input type="checkbox" checked={row.scope.characterIds.includes(c.id)} onChange={e => scope('characterIds', e.target.checked ? [...row.scope.characterIds, c.id] : row.scope.characterIds.filter((id: string) => id !== c.id))}/>{c.name}</label>)}</fieldset>}
    {['document', 'scene'].includes(row.scope.kind) && <label>指定文档<select aria-label="记忆文档" value={row.scope.documentId || ''} onChange={e => change('scope', { ...row.scope, documentId: e.target.value, sceneId: null })}><option value="">请选择</option>{ctx.work.documents.filter(d => ['chapter', 'draft', 'plan'].includes(d.kind)).map(d => <option key={d.id} value={d.id}>{d.title}</option>)}</select></label>}
    {row.scope.kind === 'scene' && <label>指定场景<select aria-label="记忆场景" value={row.scope.sceneId || ''} onChange={e => scope('sceneId', e.target.value)}><option value="">请选择</option>{ctx.work.scenes.filter(s => s.documentId === row.scope.documentId).map(s => <option value={s.id} key={s.id}>{s.name}</option>)}</select></label>}
    <fieldset className="memory-choices"><legend>哪些 AI 任务可读取</legend>{[['revision', 'AI 修订'], ['extraction', '剧情归档'], ['obligation','场景核对'], ['cowriting','创作空间']].map(([k, v]) => <label className="check-label" key={k}><input type="checkbox" checked={row.tasks.includes(k)} onChange={e => change('tasks', e.target.checked ? [...row.tasks, k] : row.tasks.filter((t: string) => t !== k))}/>{v}</label>)}</fieldset>
    <label>来源说明<input aria-label="记忆来源说明" maxLength={500} value={row.source.reference} onChange={e => change('source', { ...row.source, reference: e.target.value })}/></label>
    <label>作者原话或确认依据（可选）<textarea aria-label="记忆来源原话" rows={2} maxLength={1000} value={row.source.quote} onChange={e => change('source', { ...row.source, quote: e.target.value })}/></label>
    <details open={row.kind === 'correction'}><summary>修改案例：原文、AI建议与作者改写</summary>{[['before', '原文'], ['suggested', 'AI 建议'], ['after', '作者改写']].map(([k, v]) => <label key={k}>{v}<textarea aria-label={`记忆案例${v}`} rows={2} maxLength={1800} value={row.example[k]} onChange={e => change('example', { ...row.example, [k]: e.target.value })}/></label>)}</details>
    {!initial?.id && <label>替代已有条目（可选）<select aria-label="替代已有记忆" value={row.replacesId || ''} onChange={e => change('replacesId', e.target.value)}><option value="">不替代</option>{ctx.work.memories?.filter(m => !m.damaged && m.status !== 'superseded').map(m => <option value={m.id} key={m.id}>{m.title}</option>)}</select></label>}
    <div className="notice">记忆只作为 AI 的参考，不会自动成为机检规则，也不能覆盖原文证据、人物基座或用词放行裁定。本轮按作品保存，不会自动读取其他聊天。</div>
    {row.status === 'confirmed' && <label className="check-label"><input type="checkbox" checked={ack} onChange={e => setAck(e.target.checked)}/>我确认这是作者要求，同意在上述范围内供 AI 读取</label>}
    {error && <div className="notice danger" role="alert">{error}</div>}
    <div className="modal-footer"><button disabled={busy} onClick={onClose}>取消</button><button className="primary" disabled={busy || !row.title.trim() || !row.content.trim() || !row.tasks.length || row.status === 'confirmed' && !ack} onClick={save}>{busy ? '正在落盘…' : '保存记忆'}</button></div>
  </Modal>;
}
