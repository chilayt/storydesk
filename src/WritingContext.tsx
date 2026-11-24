import React, { useState } from 'react';
import type { AppContext } from './domain';
import { documentKindLabel } from './domain';
import { Markdown } from './components';
import { openMaterial } from './WorldSources';
import type { CreativeTask, WritingManifest, WritingMemoryFeedback } from './writing-domain';

const feedbackLabels = { missed: '漏用了记忆', wrong_scope: '记忆用错场合', not_applied: '读到了却没照做' };
function MemoryFeedback({ ctx, manifest, factId = null, disabled }: {
  ctx: AppContext; manifest: WritingManifest; factId?: string | null; disabled: boolean;
}) {
  const previous = manifest.memoryFeedback?.find(row => row.factId === factId);
  const [saved, setSaved] = useState(previous);
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<WritingMemoryFeedback['reason']>(previous?.reason || (factId ? 'wrong_scope' : 'missed'));
  const [note, setNote] = useState(previous?.note || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  return <div>
    {saved && <p className="studio-muted" role="status">已记录 · {feedbackLabels[saved.reason]}</p>}
    {!open ? <button type="button" disabled={disabled} onClick={() => setOpen(true)}>
      {saved ? '修改记忆反馈' : factId ? '反馈这条记忆' : '反馈漏用记忆'}
    </button> : <form className="writing-reference-picker" onSubmit={async event => {
      event.preventDefault();
      setBusy(true); setError('');
      try {
        const rows: WritingMemoryFeedback[] = await ctx.call('saveMemoryFeedback', {
          documentId: manifest.documentId, taskId: manifest.taskId, sceneId: manifest.sceneId || null,
          replyId: manifest.replyId, factId, reason, note,
        });
        setSaved(rows.find(row => row.factId === factId));
        setOpen(false);
      } catch (error) { setError((error as Error).message || '记忆反馈未保存'); }
      finally { setBusy(false); }
    }}>
      {factId && <label>反馈类型
        <select value={reason} disabled={busy} onChange={event => setReason(event.target.value as WritingMemoryFeedback['reason'])}>
          <option value="wrong_scope">{feedbackLabels.wrong_scope}</option><option value="not_applied">{feedbackLabels.not_applied}</option>
        </select>
      </label>}
      <label>{factId ? '补充说明（可选）' : '漏了哪条约定（可选）'}
        <textarea rows={2} maxLength={400} value={note} disabled={busy} onChange={event => setNote(event.target.value)}/>
      </label>
      {error && <p className="notice danger" role="alert">{error}</p>}
      <div className="studio-actions">
        <button type="submit" disabled={busy || disabled}>{busy ? '正在保存…' : '保存记忆反馈'}</button>
        <button type="button" disabled={busy} onClick={() => setOpen(false)}>取消</button>
      </div>
    </form>}
  </div>;
}

export function WritingContext({ ctx, manifest, lastManifest, loading, error, task, disabled, onRefresh, onReferences, initialShowLast = false }:
  { ctx: AppContext; manifest: WritingManifest | null; lastManifest?: WritingManifest; loading: boolean; error: string;
    task: CreativeTask | null; disabled: boolean; onRefresh: () => void; onReferences: (ids: string[]) => Promise<void>; initialShowLast?: boolean }) {
  const [showLast, setShowLast] = useState(initialShowLast);
  const displayed = showLast ? lastManifest : manifest;
  const sources = ctx.work.documents.filter(d => !d.error && !d.generated && !ctx.work.hiddenChapterMaterials?.includes(d.id) &&
    ['plan', 'character', 'setting', 'rule', 'organization', 'location', 'item', 'reference', 'plot', 'family'].includes(d.kind));
  return <section className="writing-context" aria-label="本次依据详情">
    <div className="studio-section-heading"><div><h3>本次依据</h3><p>{displayed?.targetTitle || (loading ? '正在读取当前范围…' : '当前范围')} · {showLast ? '上轮实际读取' : '下轮准备'}</p></div>
      <button disabled={disabled || loading} onClick={onRefresh}>{loading ? '正在读取…' : '刷新依据'}</button></div>
    <div className="studio-actions"><button aria-pressed={!showLast} onClick={() => setShowLast(false)}>下轮准备</button>
      <button aria-pressed={showLast} disabled={!lastManifest} onClick={() => setShowLast(true)}>上轮实际</button></div>
    {error && <p className="notice danger" role="alert">{error}</p>}
    {displayed?.stale && <p className="notice danger">这轮依据已有变化。请刷新后使用当前资料，旧结果保留供对照。</p>}
    {!!displayed?.missing.length && <div className="writing-missing"><strong>资料缺口</strong><ul>{displayed.missing.map(item => <li key={item}>{item}</li>)}</ul></div>}
    {showLast && lastManifest?.replyId && <MemoryFeedback key={lastManifest.replyId} ctx={ctx} manifest={lastManifest} disabled={disabled}/>}
    {displayed?.sections.map(section => <details className="writing-source" key={section.id}>
      <summary><span>{section.title}</span><small>{section.status}</small></summary>
      {section.reason && <p className="studio-muted">{section.reason}</p>}
      <div className="writing-source-content"><Markdown text={section.excerpt} onLink={section.kind === 'research' ? href => {
        void ctx.call('openWebSource', { url: href }).catch(error => ctx.notify(error.message, true));
      } : undefined}/></div>
      {section.path && <p className="studio-path">{section.path}</p>}
      <div className="studio-actions">{section.hash && <small className="studio-muted">版本 {section.hash.slice(0, 10)}</small>}
        {section.documentId && <button onClick={() => {
          const document = ctx.work.documents.find(doc => doc.id === section.documentId);
          if (document) openMaterial(ctx, document);
          else ctx.notify('该轮资料当前不可用，请刷新依据', true);
        }}>{section.kind === 'map' ? '打开地图' : '打开原档'}</button>}</div>
      {showLast && lastManifest?.replyId && section.factId && <MemoryFeedback key={lastManifest.replyId + section.factId}
        ctx={ctx} manifest={lastManifest} factId={section.factId} disabled={disabled}/>}
    </details>)}
    {!displayed && !loading && !error && <p className="studio-muted">选择任务后可读取本次依据。</p>}
    <div className="writing-reference-picker"><label htmlFor="writing-extra-reference">补充资料 · 最多四份</label>
      <select id="writing-extra-reference" value="" disabled={disabled || !task || task.referenceIds.length >= 4}
        onChange={e => { if (e.target.value && task) void onReferences([...task.referenceIds, e.target.value]); }}>
        <option value="">从本作品资料中选择</option>{sources.filter(d => !task?.referenceIds.includes(d.id)).map(d =>
          <option key={d.id} value={d.id}>{documentKindLabel(d)} · {d.title}</option>)}
      </select>
      {!task && <p className="studio-muted">先建立任务，再保存需要反复参考的资料。</p>}
      {task?.referenceIds.map(id => <div className="writing-pinned-source" key={id}><span>{ctx.work.documents.find(d => d.id === id)?.title || '资料已不可用'}</span>
        <button disabled={disabled} onClick={() => void onReferences(task.referenceIds.filter(value => value !== id))}>移除</button></div>)}
    </div>
  </section>;
}
