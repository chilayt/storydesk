import React, { useEffect, useState } from 'react';
import type { AppContext, SourceDocument } from './domain';
import { Icon, Modal } from './components';
import { worldKinds } from './WorldSources';

const categories = ['时代与行政', '姓名与家族', '服饰与民俗', '地理与空间', '货币与交易', '武学体系', '势力与组织', '其他设定'];

export function SettingInfo({ ctx, initialDocumentId, onClose }:
  { ctx: AppContext; initialDocumentId?: string; onClose: () => void }) {
  const docs = ctx.work.documents.filter(d => (worldKinds.includes(d.kind) || d.kind === 'plan') && !d.readOnly);
  const [id, setId] = useState(initialDocumentId || docs[0]?.id || '');
  const [doc, setDoc] = useState<SourceDocument | null>(null);
  const [category, setCategory] = useState('其他设定');
  const [nature, setNature] = useState('unclassified');
  const [scope, setScope] = useState('本作品');
  const [summary, setSummary] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [range, setRange] = useState({ fromChapter: '', toChapter: '' });
  const [saving, setSaving] = useState(false);
  const research = ctx.work.settingMeta?.[id]?.research;

  useEffect(() => {
    if (!id) return;
    let live = true;
    setDoc(null);
    ctx.call('readDocument', { documentId: id }).then(d => {
      if (!live) return;
      const meta = ctx.work.settingMeta?.[id];
      setDoc(d); setCategory(meta?.category || '其他设定'); setNature(meta?.nature || 'unclassified');
      setScope(meta?.scope || '本作品'); setSummary(meta?.summary || ''); setConfirmed(false);
      setRange({ fromChapter: String(meta?.research?.fromChapter ?? ''), toChapter: String(meta?.research?.toChapter ?? '') });
    }).catch(error => ctx.notify(error.message, true));
    return () => { live = false; };
  }, [id]);

  async function save() {
    if (!doc || doc.id !== id || saving) return;
    setSaving(true);
    const researchRange = research ? { fromChapter: range.fromChapter ? Number(range.fromChapter) : null,
      toChapter: range.toChapter ? Number(range.toChapter) : null } : undefined;
    const result = await ctx.act(() => ctx.call('updateSettingMeta', {
      documentId: id, expectedHash: doc.hash, category, nature, scope, summary, confirmed, researchRange,
    }), '设定分类与性质已写回原档');
    setSaving(false);
    if (result) onClose();
  }

  return <Modal title="设定分类与性质" subtitle="历史依据、架空裁定和人物说法分别保存，作者确认绑定当前版本。" onClose={onClose}>
    <label>设定文档<select value={id} disabled={saving} onChange={e => setId(e.target.value)}>
      {docs.map(d => <option key={d.id} value={d.id}>{d.title}</option>)}
    </select></label>
    <div className="form-grid">
      <label>分类<input list="setting-categories" value={category} onChange={e => setCategory(e.target.value)}/>
        <datalist id="setting-categories">{categories.map(value => <option key={value} value={value}/>)}</datalist>
      </label>
      <label>设定性质<select value={nature} onChange={e => setNature(e.target.value)}>
        <option value="unclassified">待分类</option><option value="historical">历史依据</option>
        <option value="fiction">架空裁定</option><option value="character_claim">人物说法</option>
      </select></label>
    </div>
    {research ? <div className="form-grid">
      <label>起始章<input type="number" min={1} max={99999} value={range.fromChapter} placeholder="不限"
        onChange={e => setRange({ ...range, fromChapter: e.target.value })}/></label>
      <label>结束章<input type="number" min={1} max={99999} value={range.toChapter} placeholder="不限"
        onChange={e => setRange({ ...range, toChapter: e.target.value })}/></label>
    </div> : <label>适用范围<input value={scope} onChange={e => setScope(e.target.value)} placeholder="本作品、特定地区、角色或时期"/></label>}
    <label htmlFor="setting-review-note">说明、来源与裁定理由</label>
    <textarea id="setting-review-note" rows={5} value={summary} onChange={e => setSummary(e.target.value)}/>
    <label className="check-label"><input type="checkbox" checked={confirmed}
      onChange={e => setConfirmed(e.target.checked)}/>我已核对当前设定正文，确认这一版本</label>
    <div className="notice">保存会更新设定原档中的分类与核对信息。</div>
    <div className="modal-footer"><button onClick={onClose}>取消</button><button className="primary"
      disabled={!doc || doc.id !== id || saving} onClick={save}><Icon name="save"/>保存设定信息</button></div>
  </Modal>;
}
