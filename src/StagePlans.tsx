import { useState } from 'react';
import type { AppContext, StageNode, StagePlan } from './domain';
import { Badge, Icon, Markdown } from './components';
import type { StagePlanProposal } from './writing-domain';

const labels: Record<StagePlan['nodes'][number]['state'], string> = {
  completed: '已完成', pending: '未完成', changed: '有变化', conflict: '内容冲突', review: '待核对',
};

export function StagePlanCard({ proposal, disabled, onSave, onOpen }: {
  proposal: StagePlanProposal; disabled: boolean; onSave: () => Promise<boolean>; onOpen: () => void;
}) {
  const [saving, setSaving] = useState(false);
  async function save() {
    setSaving(true);
    try { if (await onSave()) onOpen(); } finally { setSaving(false); }
  }
  return <section className="stage-plan-card" aria-label="阶段计划建议">
    <div className="studio-section-heading">
      <div><h3>{proposal.title}</h3>
        <small>第 {proposal.details.fromChapter}–{proposal.details.toChapter} 章 · {proposal.details.milestones.length} 个节点</small></div>
      {proposal.recordId ? <button onClick={onOpen}>查看剧情线</button> :
        <button className="primary" disabled={disabled || saving} onClick={() => void save()}>{saving ? '正在保存…' : '保存到阶段计划'}</button>}
    </div>
    <details>
      <summary>查看阶段说明与节点</summary>
      <div className="stage-plan-card-content">
        {proposal.details.milestones.length > 0 && <ol>{proposal.details.milestones.map(node => <li key={node.id}>
          <strong>{node.chapter ? `第 ${node.chapter} 章 · ` : ''}{node.title}</strong>
          {node.note && <p>{node.note}</p>}
        </li>)}</ol>}
        <Markdown text={proposal.body}/>
      </div>
    </details>
  </section>;
}

export function StageFields({ ctx, value, onChange }: {
  ctx: AppContext; value: Record<string, any>; onChange: (value: Record<string, any>) => void;
}) {
  const rows: StageNode[] = value.milestones || [];
  const chapter = (value: string) => value ? Number(value) : null;
  const events = ctx.work.events.filter(event => !event.stale && !event.damaged &&
    (event.editorial_status === 'accepted' && event.editorial_layer === 'occurred' ||
      event.facts.some(fact => fact.status === 'accepted' && fact.layer === 'occurred')));
  const update = (id: string, patch: Partial<StageNode>) => onChange({
    ...value, milestones: rows.map(row => row.id === id ? { ...row, ...patch } : row)
  });
  return <section className="stage-fields" aria-label="阶段计划">
    <div className="panel-heading"><h4>阶段计划</h4><button type="button" disabled={rows.length >= 30}
      onClick={() => onChange({ ...value, milestones: [...rows, { id: crypto.randomUUID(), title: '', chapter: null }] })}><Icon name="plus" size={13}/>增加节点</button></div>
    <div className="form-grid">
      <label>阶段起始章<input type="number" min={1} value={value.fromChapter ?? ''}
        onChange={e => onChange({ ...value, fromChapter: chapter(e.target.value) })}/></label>
      <label>阶段结束章<input type="number" min={1} value={value.toChapter ?? ''}
        onChange={e => onChange({ ...value, toChapter: chapter(e.target.value) })}/></label>
    </div>
    {rows.map((row, index) => <section className="stage-node" key={row.id} aria-label={'阶段节点 ' + (index + 1)}>
      <div className="form-grid">
        <label>节点内容<input maxLength={120} value={row.title} onChange={e => update(row.id, { title: e.target.value })}/></label>
        <label>原计划章号<input type="number" min={1} value={row.chapter ?? ''} onChange={e => update(row.id, { chapter: chapter(e.target.value) })}/></label>
        <label>实际事件<select value={row.eventId || ''} onChange={e => update(row.id, { eventId: e.target.value, decision: 'pending' })}>
          <option value="">按节点标题寻找已确认事件</option>
          {row.eventId && !events.some(event => event.id === row.eventId) && <option value={row.eventId}>原关联事件待复核</option>}
          {events.map(event => <option key={event.id} value={event.id}>{event.source_chapter ? '第' + event.source_chapter + '章 · ' : ''}{event.title}</option>)}
        </select></label>
        <label>作者裁定<select value={row.decision || 'pending'} onChange={e => update(row.id, { decision: e.target.value as StageNode['decision'] })}>
          <option value="pending">按实际进展核对</option><option value="conflict">标记内容冲突</option>
          <option value="adopted" disabled={!row.eventId}>采用实际变化</option></select></label>
        <label className="full-width">调整后的安排或说明<textarea rows={2} maxLength={500} value={row.note || ''}
          onChange={e => update(row.id, { note: e.target.value })}/></label>
      </div>
      <button className="text-button" type="button" onClick={() => onChange({ ...value, milestones: rows.filter(item => item.id !== row.id) })}>移除此节点</button>
    </section>)}
  </section>;
}

export function StageProgress({ ctx, chapter, disabled, onDiscuss, onPlan }: {
  ctx: AppContext; chapter: number | null; disabled: boolean; onDiscuss: () => void; onPlan?: () => void;
}) {
  const [saving, setSaving] = useState('');
  const plans = (ctx.work.stagePlans || []).filter(plan => chapter === null ||
    plan.fromChapter <= chapter && chapter <= plan.toChapter);
  const open = () => ctx.navigate({ page: 'plot', tab: 'plot_arc' });
  async function adopt(plan: StagePlan, node: StagePlan['nodes'][number]) {
    const record = ctx.work.records.find(item => item.id === plan.id);
    if (!record || !node.event) return;
    const actual = node.event;
    const rows: StageNode[] = record.details?.milestones || [];
    setSaving(node.id);
    try {
      await ctx.act(() => ctx.call('saveRecord', {
        id: record.id, kind: record.kind, title: record.title, body: record.body, status: record.status,
        participants: record.participants, expectedRevision: record.revision,
        details: { ...record.details, milestones: rows.map(row => row.id === node.id ?
          { ...row, eventId: actual.id, title: actual.title, chapter: actual.chapter, decision: 'adopted' } : row) }
      }), '已按确认事件更新阶段节点');
    } finally { setSaving(''); }
  }
  return <section className="stage-progress" aria-label="阶段计划进展">
    <div className="studio-section-heading"><h2>阶段计划</h2><div className="studio-actions">
      {onPlan && <button disabled={disabled} onClick={onPlan}>讨论阶段剧情</button>}<button onClick={open}>管理阶段计划</button></div></div>
    {!plans.length && <p className="studio-muted">可以先和 Agent 讨论阶段目标和节点，再保存为剧情线。</p>}
    {plans.length > 0 && <button onClick={onDiscuss} disabled={disabled}>准备阶段核对要求</button>}
    {plans.map(plan => <section className="stage-plan" key={plan.id}>
      <h3>{plan.title}</h3><small>第 {plan.fromChapter}–{plan.toChapter} 章</small>
      {plan.description && <p>{plan.description}</p>}
      {plan.nodes.map(node => <div className="stage-node" key={node.id}>
        <div className="studio-section-heading"><strong>{node.title}</strong><Badge>{labels[node.state]}</Badge></div>
        {node.chapter && <p>计划第 {node.chapter} 章</p>}
        {node.event && <p>已确认 · 第 {node.event.chapter} 章 · {node.event.title}{node.event.summary ? ' · ' + node.event.summary : ''}</p>}
        {node.note && <p>{node.note}</p>}
        <div className="studio-actions">
          {node.event?.documentId && <button onClick={() => ctx.navigate({ page: 'reader', documentId: node.event!.documentId })}>阅读关联正文</button>}
          {node.event && ['changed', 'conflict'].includes(node.state) && <button disabled={disabled || !!saving}
            onClick={() => void adopt(plan, node)}>采用实际节点</button>}
        </div>
      </div>)}
    </section>)}
  </section>;
}
