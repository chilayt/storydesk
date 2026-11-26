import { useState } from 'react';
import type { BookDecision, BookDecisionProposal, BookDecisionStatus, BookDesignItem } from './writing-domain';
import { Icon, Modal } from './components';

const labels = { work: '全书大纲', volume: '卷纲', chapter: '章纲', character: '人物档案', setting: '世界设定' };
const topics = { premise: '核心构想', character: '人物选择', relationship: '人物关系', plot: '故事走向',
  setting: '世界约束', volume: '分卷任务', chapter: '章节任务' };
const states = { exploring: '待探索', tentative: '暂定', confirmed: '已确认' };
export type DecisionInput = { title: string; text: string; status: BookDecisionStatus; dependsOn: string[] };

export function BookDesignProgress({ decisions, disabled, onSave, onOpen }: {
  decisions: BookDecision[]; disabled: boolean;
  onSave: (decision: BookDecision, input: DecisionInput) => Promise<boolean>;
  onOpen: (id: string) => void;
}) {
  const [selected, setSelected] = useState<BookDecision>();
  const affected = decisions.filter(row => row.review.length);
  return <div aria-label="新书设计进度">
    <ul className="book-guide-progress">
      {Object.entries(topics).map(([topic, label]) => {
        const current = decisions.filter(row => row.topic === topic);
        const counts = Object.entries(states).flatMap(([state, name]) => {
          const count = current.filter(row => row.status === state).length;
          return count ? [`${name} ${count}`] : [];
        });
        return <li key={topic}>{label}<small>{counts.join(' · ') || states.exploring}</small></li>;
      })}
    </ul>
    {!!affected.length && <p role="status">{affected.length} 项构思受变更影响</p>}
    {!!decisions.length && <div className="book-decision-list">
      {decisions.map(row => <div className="book-design-row book-decision-row" key={row.id}>
        <Icon name={row.review.length ? 'info' : 'file'} size={16}/>
        <div>
          <strong>{row.title}</strong>
          <small>{topics[row.topic]} · {states[row.status]}{row.review.length ? ' · 待复核' : ''}</small>
          {!!row.review.length && <p>因「{row.review.map(item => item.title).join('、')}」变化，需核对{row.documents.length ? '关联资料' : '这项构思'}。</p>}
          {!!row.documents.length && <div className="book-decision-links">{row.documents.map(doc => <button key={doc.id}
            className="text-button" onClick={() => onOpen(doc.id)}>{doc.title}</button>)}</div>}
        </div>
        <button disabled={disabled} onClick={() => setSelected(row)}>{row.review.length ? '复核构思' : '调整构思'}</button>
      </div>)}
    </div>}
    {selected && <BookDecisionEditor item={selected} decisions={decisions} onClose={() => setSelected(undefined)}
      onSave={input => onSave(selected, input)}/>}
  </div>;
}

export function BookDecisionProposals({ items, decisions, disabled, onSave }: {
  items: BookDecisionProposal[]; decisions: BookDecision[]; disabled: boolean;
  onSave: (id: string, input: DecisionInput) => Promise<boolean>;
}) {
  const [selected, setSelected] = useState<BookDecisionProposal>();
  return <div className="book-design-card" aria-label="本轮构思候选">
    {items.map(item => {
      const saved = decisions.find(row => row.id === item.savedId);
      return <div className="book-design-row" key={item.id}>
        <Icon name="edit" size={17}/>
        <div><strong>{item.title}</strong><small>{topics[item.topic]} · {states[saved?.status ?? 'exploring']}</small></div>
        {item.savedId ? <small>已记录</small> : <button disabled={disabled} onClick={() => setSelected(item)}>核对构思</button>}
      </div>;
    })}
    {selected && <BookDecisionEditor item={selected} decisions={decisions} onClose={() => setSelected(undefined)}
      onSave={input => onSave(selected.id, input)}/>}
  </div>;
}

function BookDecisionEditor({ item, decisions, onSave, onClose }: {
  item: BookDecision | BookDecisionProposal; decisions: BookDecision[];
  onSave: (input: DecisionInput) => Promise<boolean>; onClose: () => void;
}) {
  const proposal = 'quote' in item ? item : undefined;
  const old = decisions.find(row => row.id === (proposal?.replaces ?? item.id));
  const [title, setTitle] = useState(item.title);
  const [text, setText] = useState(item.text);
  const [status, setStatus] = useState<BookDecisionStatus>(proposal ? 'exploring' : old?.status ?? 'exploring');
  const [links, setLinks] = useState<string[]>(item.dependsOn.map(row => typeof row === 'string' ? row : row.id));
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { if (await onSave({ title, text, status, dependsOn: links })) onClose(); }
    finally { setSaving(false); }
  }
  return <Modal title="核对新书构思" onClose={() => { if (!saving) onClose(); }} wide>
    {proposal && <p>作者原话「{proposal.quote}」</p>}
    {proposal && old && <p>现行构思（{states[old.status]}）<br/>{old.text}</p>}
    {!!old?.review.length && <div className="book-decision-review">
      <strong>触发复核的变更</strong>
      {old.review.map(row => <p key={row.id}>{row.title}改为「{row.text}」</p>)}
    </div>}
    <label>构思名称<input value={title} maxLength={80} onChange={e => setTitle(e.target.value)}/></label>
    <label>构思内容<textarea rows={5} value={text} maxLength={1000} onChange={e => setText(e.target.value)}/></label>
    <label>构思状态<select value={status} onChange={e => setStatus(e.target.value as BookDecisionStatus)}>
      {Object.entries(states).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></label>
    {decisions.some(row => row.id !== old?.id) && <details open={links.length > 0 || undefined}>
      <summary>本项依赖的构思</summary>
      {decisions.filter(row => row.id !== old?.id).map(row => <label className="check-label" key={row.id}>
        <input type="checkbox" checked={links.includes(row.id)} onChange={e => setLinks(current =>
          e.target.checked ? [...current, row.id] : current.filter(id => id !== row.id))}/>{row.title}</label>)}
    </details>}
    <div className="modal-footer"><button disabled={saving} onClick={onClose}>取消</button>
      <button className="primary" disabled={saving || !title.trim() || !text.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存构思'}</button>
    </div>
  </Modal>;
}

export function BookDesignCard({ items, disabled, onSave, onOpen }: {
  items: BookDesignItem[]; disabled: boolean;
  onSave: (id: string, value: string) => Promise<boolean>;
  onOpen: (path: string) => void;
}) {
  const [selected, setSelected] = useState<BookDesignItem>();
  const [text, setText] = useState('');
  const [saving, setSaving] = useState(false);
  async function save() {
    if (!selected || saving) return;
    setSaving(true);
    try { if (await onSave(selected.id, text)) setSelected(undefined); }
    finally { setSaving(false); }
  }
  return <div className="book-design-card" aria-label="本轮整理的新书设计">
    {items.map(item => <div className="book-design-row" key={item.id}>
      <Icon name={item.kind === 'character' ? 'users' : item.kind === 'setting' ? 'world' : 'file'} size={18}/>
      <div><strong>{item.title}</strong><small>{labels[item.kind]}</small></div>
      <button disabled={disabled && !item.savedAt} onClick={() => {
        if (item.savedAt) onOpen(item.path);
        else { setText(item.text); setSelected(item); }
      }}>{item.savedAt ? '打开资料' : '核对并保存'}</button>
    </div>)}
    {selected && <Modal title={selected.title} subtitle={selected.path} onClose={() => { if (!saving) setSelected(undefined); }} wide>
      <p>作者原话「{selected.quote}」</p>
      {selected.previous && <details><summary>查看当前文件内容</summary><pre className="book-design-original">{selected.previous}</pre></details>}
      <label>设计正文<textarea rows={10} value={text} maxLength={16000} disabled={saving} onChange={e => setText(e.target.value)}/></label>
      <div className="modal-footer">
        <button disabled={saving} onClick={() => setSelected(undefined)}>取消</button>
        <button className="primary" disabled={saving || !text.trim()} onClick={() => void save()}>{saving ? '正在保存…' : '保存到本作品'}</button>
      </div>
    </Modal>}
  </div>;
}
