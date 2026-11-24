import React, { useState } from 'react';
import { dateText } from './domain';
import type { CreativeTask, WritingScope } from './writing-domain';

export const writingScopes: { id: WritingScope; label: string; description: string }[] = [
  { id: 'next', label: '构思新章', description: '讨论目标、分场和章纲' },
  { id: 'stage', label: '阶段规划', description: '讨论一段跨章剧情，整理阶段目标和节点' },
  { id: 'draft', label: '草稿章节', description: '起草、修改与发布前核对' },
  { id: 'volume', label: '分卷规划', description: '安排阶段目标与章节' },
  { id: 'work', label: '梳理全书', description: '梳理主线、结构与主题' },
  { id: 'chapter', label: '正式正文', description: '阅读、修订已入正文的章节' },
];

export function CreativeTasks({ tasks, task, disabled, onOpen, onCreate, onSave, onClose, scopeLabel }:
  { tasks: CreativeTask[]; task: CreativeTask | null; disabled: boolean; onOpen: (id: string) => Promise<void>;
    scopeLabel: (task: CreativeTask) => string;
    onCreate: (goal: string) => Promise<void>; onSave: (patch: object) => Promise<void>; onClose: () => void }) {
  const [goal, setGoal] = useState('');
  const [showArchived, setShowArchived] = useState(false);
  const [notes, setNotes] = useState(task?.notes || '');
  const [taskGoal, setTaskGoal] = useState(task?.goal || '');
  const [title, setTitle] = useState(task?.title || '');
  const [saving, setSaving] = useState(false);
  async function save() { setSaving(true); try { await onSave({ title, goal: taskGoal, notes }); } finally { setSaving(false); } }
  return <section className="creative-task-panel" aria-label="创作任务管理">
    <div className="studio-section-heading"><div><h2>创作任务</h2><p>每项任务保留对话、批注、试写和资料选择。</p></div><button onClick={onClose}>收起任务</button></div>
    <div className="creative-task-columns"><div>
      <label htmlFor="creative-task-goal">新任务的目标</label><textarea id="creative-task-goal" value={goal} maxLength={2500} rows={2}
        onChange={e => setGoal(e.target.value)} placeholder="例如：讨论下一章的冲突，先确定章末推进。"/>
      <button className="primary" disabled={disabled} onClick={async () => { setSaving(true); try { await onCreate(goal); setGoal(''); } finally { setSaving(false); } }}>
        {saving ? '正在保存…' : '按当前范围新建任务'}</button>
      {task && <div className="creative-task-editor"><p className="studio-path">{task.filePath}</p><label htmlFor="creative-task-title">当前任务名称</label>
        <input id="creative-task-title" maxLength={100} value={title} onChange={e => setTitle(e.target.value)}/>
        <label htmlFor="creative-current-goal">任务目标</label><textarea id="creative-current-goal" value={taskGoal} maxLength={2500} rows={2} onChange={e => setTaskGoal(e.target.value)}/>
        <label htmlFor="creative-task-notes">未决问题与备注</label><textarea id="creative-task-notes" value={notes} maxLength={4000} rows={3} onChange={e => setNotes(e.target.value)}/>
        <div className="studio-actions"><button disabled={disabled || saving || !title.trim()} onClick={save}>保存任务约定</button>
          <button disabled={disabled || saving} onClick={() => void onSave({ status: task.status === 'active' ? 'archived' : 'active' })}>{task.status === 'active' ? '归档此任务' : '恢复此任务'}</button></div>
      </div>}
    </div><div className="creative-task-history"><div className="studio-section-heading"><h3>继续已有任务</h3><label className="studio-check">
      <input type="checkbox" checked={showArchived} onChange={e => setShowArchived(e.target.checked)}/>包含归档</label></div>
      {!tasks.some(row => row.status === 'active' || showArchived && row.status === 'archived') && <p className="studio-muted">还没有任务。先选择上方创作范围，再填写目标。</p>}
      {tasks.filter(row => row.status === 'active' || showArchived && row.status === 'archived').map(row => <button key={row.id} className={`creative-task-row ${row.id === task?.id ? 'selected' : ''}`}
        disabled={disabled} onClick={() => void onOpen(row.id)}><span><strong>{row.title}</strong>
          <small>{scopeLabel(row)} · {dateText(row.updated_at)}{row.status === 'archived' ? ' · 已归档' : ''}</small></span><span>继续</span></button>)}
    </div></div>
  </section>;
}
