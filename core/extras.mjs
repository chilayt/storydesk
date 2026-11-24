import fs from 'node:fs/promises';
import { AppError, hash, uid, stamp, encode, decode } from './io.mjs';
import { managedBlock, parseRecord, replaceRecordHeader, recordMarkdown, WORLD_SOURCE_KINDS, withSettingMetadata } from './catalog.mjs';
import { validateMemory, memoryConflicts, memoryBody } from './memory.mjs';
import {validateObligationCard,cardBody} from './obligations.mjs';
import { researchChapterRange, researchScopeLabel } from './research.mjs';

const copy = v => structuredClone(v);
export const extraMethods = {
  async restoreMissingDocument({ documentId }) {
    const record = this.project.missingDocuments?.[documentId];
    if (!record?.snapshot) throw new AppError('NOT_FOUND', '没有可用于恢复的登记快照');
    const bytes = await this.store.read(record.snapshot);
    if (!bytes || hash(bytes) !== record.hash) throw new AppError('DAMAGED_DATA', '源文档登记快照缺失或损坏');
    const next = copy(this.project); next.documents[record.path] = record;
    delete next.missingDocuments[documentId]; delete next.externalChanges[documentId];
    return this.commit('恢复被移除的源文档', [{ path: record.path, expectedHash: null, bytes }], next);
  },
  async managedDiff({ path: relative }) {
    if (!/^_创作管理\/(?:事件\/|资料\/|记忆\/|场景义务\/|义务核对\/|人物进展\/|关系\/|事件索引\.md)/.test(relative)) throw new AppError('PATH', '该路径不属于可核对的管理文档');
    const b = await this.store.read(relative);
    const head = this.project.managedHeads?.[relative], before = head ? await this.store.read(head.snapshot) : null;
    if (!b && !head) throw new AppError('NOT_FOUND', '文件已移除且没有登记版本');
    return { path: relative, hash: b ? hash(b) : null, before: before?.toString('utf8') || '暂无登记版本', current: b ? decode(b).text : '文件已移除，仅可恢复登记版本', missing: !b, memory: relative.startsWith('_创作管理/记忆/'), obligation:relative.startsWith('_创作管理/场景义务/'),obligationReport:relative.startsWith('_创作管理/义务核对/'), canonical: /^_创作管理\/(事件|资料|记忆|场景义务|义务核对)\//.test(relative), protected: !!this.project.protectedFiles?.[relative] };
  },
  async acknowledgeManaged({ path: relative, expectedHash, mode }) {
    const diff = await this.managedDiff({ path: relative }); if (diff.hash !== expectedHash) throw new AppError('CONFLICT', '文件再次改变，请重新比较');
    const next = copy(this.project); next.managedHeads ||= {}; next.protectedFiles ||= {};
    if (diff.missing) {
      if (mode !== 'restore') throw new AppError('VALIDATION', '文件已移除，请选择恢复登记版本');
      const previous = this.project.managedHeads?.[relative], prior = previous && await this.store.read(previous.snapshot);
      if (!prior || hash(prior) !== previous.hash) throw new AppError('DAMAGED_DATA', '登记快照不可用');
      delete next.externalChanges[`managed:${relative}`];
      return this.commit('恢复被移除的管理记录', [{ path: relative, expectedHash: null, bytes: prior }], next, { allowManagedEdits: [relative] });
    }
    const bytes = await this.store.read(relative), snapshot = `_创作管理/历史/记录版本/${diff.hash}.md`;
    if (!await this.store.read(snapshot)) { const target = await this.store.resolve(snapshot); await fs.mkdir((await import('node:path')).default.dirname(target), { recursive: true }); await fs.writeFile(target, bytes, { flag: 'wx' }); }
    next.managedHeads[relative] = { hash: diff.hash, snapshot }; delete next.externalChanges[`managed:${relative}`];
    if (diff.canonical) {
      if (mode === 'restore') {
        const previous = this.project.managedHeads?.[relative]; if (!previous) throw new AppError('NOT_FOUND', '没有可恢复的登记版本');
        const prior = await this.store.read(previous.snapshot); if (!prior || hash(prior) !== previous.hash) throw new AppError('DAMAGED_DATA', '登记快照不可用');
        return this.commit('作者恢复登记记录版本', [{ path: relative, expectedHash: diff.hash, bytes: prior }], next, { allowManagedEdits: [relative] });
      }
      if (mode !== 'adopt') throw new AppError('VALIDATION', '结构化记录需明确确认采用外部内容');
      if(diff.obligationReport)throw new AppError('VALIDATION','外部核对报告不能直接采用为通过依据；请恢复登记版本或重新检查');
      const record = parseRecord(diff.current);
      if (record.work_id !== next.id || !relative.endsWith(`/${record.id}.md`)) throw new AppError('VALIDATION', '作品或记录ID不匹配');
      if(diff.obligation){const data=validateObligationCard({...record,status:'draft'},this,record);const prior=this.obligationCards.find(c=>c.id===record.id);const adopted={...data,id:record.id,work_id:next.id,revision:(prior?.revision||0)+1,created_at:prior?.created_at||stamp(),updated_at:stamp(),updated_by:'作者核对外部修改'};return this.commit('作者采用外部义务卡为草稿',[{path:relative,expectedHash:diff.hash,text:recordMarkdown(adopted,cardBody(adopted))}],next,{allowManagedEdits:[relative]});}
      if (diff.memory) {
        const data = validateMemory({ ...record, authorConfirmed: true }, this);
        if (data.status === 'superseded') throw new AppError('VALIDATION', '请在记忆中心明确设置替代关系');
        const conflicts = memoryConflicts({ ...data, id: record.id }, this.memories);
        if (conflicts.length) throw new AppError('MEMORY_CONFLICT', '外部记忆与已有同主题规则冲突，请先改为待核对或调整范围');
        const prior = this.memories.find(m => m.id === record.id);
        const adopted = { ...data, id: record.id, work_id: next.id, revision: (prior?.revision || record.revision || 0) + 1, created_at: prior?.created_at || stamp(), updated_at: stamp(), updated_by: '作者核对外部修改', confirmed_at: data.status === 'confirmed' ? stamp() : null };
        return this.commit('作者核对外部记忆', [{ path: relative, expectedHash: diff.hash, text: recordMarkdown(adopted, memoryBody(adopted)) }], next, { allowManagedEdits: [relative] });
      }
      if (relative.includes('/事件/')) for (const fact of record.facts || []) {
        this.character(fact.entity_id);
        next.locks.push({ id: uid('lock'), entityId: fact.entity_id, field: fact.field, active: true, reason: '作者核对外部记录修改', created_at: stamp() });
      }
      if (relative.includes('/事件/') && !next.approvals.some(a => a.id === record.approval_id && a.status === 'active')) { record.approval_id ||= uid('approval'); next.approvals.push({ id: record.approval_id, kind: 'ruling', status: 'active', author: '作者', scope: 'external_record', confirmed_at: stamp() }); }
      next.externalReviews ||= []; next.externalReviews.push({ id: uid('review'), path: relative, hash: diff.hash, author: '作者', confirmed_at: stamp() });
      return this.commit('作者确认外部管理记录', [{ path: relative, expectedHash: diff.hash, bytes: encode(replaceRecordHeader(diff.current, record), decode(bytes)) }], next, { allowManagedEdits: [relative] });
    }
    if (mode === 'protect') { next.protectedFiles[relative] = true; return this.commit('保留人工派生视图并暂停自动更新', [], next); }
    if (mode !== 'regenerate') throw new AppError('VALIDATION', '请选择保留人工版本或重新生成');
    delete next.protectedFiles[relative]; const previous = this.project; this.project = next; let projections;
    try { projections = await this.projectionChanges(new Set(next.characters.filter(c => c.status !== 'merged').map(c => c.id)), this.events, null, { skipOriginals: true }); } finally { this.project = previous; }
    const target = projections.find(p => p.path === relative); if (!target) throw new AppError('VALIDATION', '没有可用于生成该视图的正式资料');
    return this.commit('作者允许重建派生视图', [target], next, { allowManagedEdits: [relative] });
  },
  async confirmAppearance({ entityId, documentId, sourceHash, quote, type = 'onscreen' }) {
    const c = this.character(entityId), d = await this.snapshotDocument(this.doc(documentId));
    if (!['chapter', 'draft'].includes(d.kind) || d.hash !== sourceHash) throw new AppError('CONFLICT', '章节版本已经改变，请重新核对');
    if (!['onscreen', 'mention', 'memory'].includes(type) || typeof quote !== 'string' || quote.length < 2 || quote.length > 3000 || !d.text.includes(quote)) throw new AppError('EVIDENCE', '请填写当前章节中的连续原句并选择出场类型');
    if (this.visibleFacts().some(f => f.entity_id === entityId && f.field === 'appearance' && f.source_hash === d.hash && f.value?.type === type && f.evidence === quote)) return { status: 'unchanged' };
    const fact = { id: uid('fact'), entity_id: entityId, field: 'appearance', value: { type, displayName: c.name }, layer: 'occurred', source_document_id: d.id, source_hash: d.hash, source_chapter: d.chapter, evidence: quote, start: d.text.indexOf(quote), end: d.text.indexOf(quote) + quote.length, status: 'accepted', review_reasons: [] };
    const previous=this.visibleFacts().filter(f=>f.entity_id===entityId&&f.field==='appearance'&&f.source_document_id===d.id&&f.source_hash===d.hash&&f.evidence===quote).at(-1);
    if(previous)fact.supersedes_fact_id=previous.id;
    const event = { id: uid('event'), work_id: this.project.id, title: `${c.name} · 出场核对`, summary: `${c.name}在第${d.chapter || '待定'}章${({ onscreen: '正面出场', mention: '被提及', memory: '出现在回忆' })[type]}`, source_document_id: d.id, source_hash: d.hash, source_chapter: d.chapter, approval_id: uid('approval'), facts: [fact], revision: 1, created_at: stamp() };
    const next = copy(this.project); next.approvals.push({ id: event.approval_id, kind: 'ruling', author: '作者', documentId, sourceHash, confirmed_at: stamp(), status: 'active', scope: 'appearance_only' });
    return this.commit('作者核对人物出场', [{ path: `_创作管理/事件/${event.id}.md`, expectedHash: null, text: this.eventMarkdown(event) }, ...await this.projectionChanges(new Set([entityId]), [...this.events, event])], next);
  },
  async updateSettingMeta({ documentId, expectedHash, category, nature, scope, summary, confirmed = false, researchRange }) {
    const d = await this.snapshotDocument(this.doc(documentId));
    if (!WORLD_SOURCE_KINDS.has(d.kind) && d.kind !== 'plan') throw new AppError('VALIDATION', '该文档不属于设定资料');
    if (d.hash !== expectedHash) throw new AppError('CONFLICT', '设定原文已改变，请重新核对');
    if (!['unclassified', 'historical', 'fiction', 'character_claim'].includes(nature)) throw new AppError('VALIDATION', '请选择设定性质');
    const metadata = { id: uid('setting'), work_id: this.project.id, documentId, category: String(category || '其他设定').slice(0, 100), nature, scope: String(scope || '本作品').slice(0, 1000), summary: String(summary || '').slice(0, 3000), author: '作者', confirmed, updated_at: stamp() };
    const research = this.project.settingMeta?.[d.id]?.research;
    if (research) {
      const range = researchChapterRange(researchRange ?? research);
      if (nature === 'unclassified' && confirmed) throw new AppError('VALIDATION', '请选择已确认设定的性质。');
      metadata.research = { ...research, ...range };
      metadata.scope = researchScopeLabel(range);
    }
    const bytes = encode(withSettingMetadata(d.text, metadata), d); const next = copy(this.project);
    next.settingMeta ||= {}; next.settingMeta[d.id] = metadata;
    if (confirmed) next.approvals.push({ id: uid('approval'), documentId: d.id, sourceHash: hash(bytes), kind: 'ruling', author: '作者', confirmed_at: stamp(), status: 'active' });
    delete next.externalChanges[d.id];
    return this.commit('保存设定性质与作者确认', [{ path: d.path, expectedHash: d.hash, bytes }], next);
  },
  async mergeCharacters({ sourceId, targetId, keepTargetBaseline = false }) {
    if (sourceId === targetId) throw new AppError('VALIDATION', '请选择另一个人物');
    const source = this.character(sourceId), target = this.character(targetId);
    if (source.status === 'merged' || target.status === 'merged') throw new AppError('VALIDATION', '人物已被合并，请刷新');
    if (this.baselines[sourceId] && this.baselines[targetId] && !keepTargetBaseline) throw new AppError('BASELINE_CONFLICT', '两人均有已确认基座，请先明确选择保留目标人物基座');
    const next = copy(this.project), a = next.characters.find(c => c.id === sourceId), b = next.characters.find(c => c.id === targetId);
    a.status = 'merged'; a.redirectTo = targetId;
    b.status = 'registered';
    b.aliases = [...new Set([...b.aliases, ...a.aliases, a.name])].filter(n => n !== b.name);
    b.sourceIds = [...new Set([...b.sourceIds, ...a.sourceIds])]; b.sourceEvidence.push(...a.sourceEvidence); b.revision++;
    if (!b.primarySourceId && a.primarySourceId) b.primarySourceId = a.primarySourceId;
    next.character_redirects ||= {}; next.character_redirects[sourceId] = targetId;
    next.identity_decisions ||= []; next.identity_decisions.push({ id: uid('identity'), sourceId, targetId, author: '作者', confirmed_at: stamp() });
    const changes = [];
    if (this.baselines[sourceId] && !this.baselines[targetId]) {
      const d = await this.snapshotDocument(this.doc(source.primarySourceId));
      const base = { ...copy(this.baselines[sourceId]), characterId: targetId, sourceIdentity: sourceId };
      const content = `## 已确认初始基座\n\n\`\`\`json\n${JSON.stringify(base, null, 2)}\n\`\`\`\n\n${base.fields.map(f => `### ${f.field}\n\n${f.value}`).join('\n\n')}`;
      changes.push({ path: d.path, expectedHash: d.hash, bytes: encode(managedBlock(d.text, `baseline-${targetId}`, content), d) });
      b.primarySourceId = source.primarySourceId;
    }
    const updatedEvents = new Map();
    for (const e of this.events.filter(e => !e.damaged && e.facts.some(f => f.entity_id === sourceId || f.value?.otherId === sourceId))) {
      const updated = copy(e); updated.revision++;
      for (const f of updated.facts) { if (f.entity_id === sourceId) f.entity_id = targetId; if (f.value?.otherId === sourceId) f.value.otherId = targetId; if (f.field === 'relationship' && f.entity_id === f.value?.otherId) { f.status = 'withdrawn'; f.withdrawn_reason = '作者确认双方为同一人物，原关系保留历史'; } }
      updatedEvents.set(e.id, updated);
      const p = `_创作管理/事件/${e.id}.md`, bytes = await this.store.read(p);
      changes.push({ path: p, expectedHash: hash(bytes), text: this.eventMarkdown(updated, decode(bytes).text) });
    }
    for (const p of next.proposals) { if (p.fact.entity_id === sourceId) p.fact.entity_id = targetId; if (p.fact.value?.otherId === sourceId) p.fact.value.otherId = targetId; }
    for (const lock of next.locks) if (lock.entityId === sourceId) lock.entityId = targetId;
    const oldProject = this.project; this.project = next;
    try {
      const projections = await this.projectionChanges(new Set([targetId]), this.events.map(e => updatedEvents.get(e.id) || e), null, { skipOriginals: true });
      const progress = projections.find(p => p.path === `_创作管理/人物进展/${targetId}.md`)?.text || '';
      changes.push(...projections);
      const originalIds = new Set([source.primarySourceId, b.primarySourceId].filter(Boolean));
      for (const docId of originalIds) {
        const d = await this.snapshotDocument(this.doc(docId));
        if (next.externalChanges[docId]) throw new AppError('CONFLICT', '人物原档有外部修改，请先核对后合并');
        const index = changes.findIndex(p => p.path === d.path); const pending = index >= 0 ? changes[index] : null;
        let text = pending?.bytes ? decode(pending.bytes).text : d.text;
        if (docId === source.primarySourceId) text = managedBlock(text, `progress-${sourceId}`, `## 身份合并记录\n\n作者已确认本档与「${target.name}」为同一人物。现行进展见：_创作管理/人物进展/${targetId}.md。原版本保留于历史快照。`);
        if (docId === b.primarySourceId) text = managedBlock(text, `progress-${targetId}`, `## 程序归档 · 已确认变化\n\n${progress}`);
        const edit = { path: d.path, expectedHash: d.hash, bytes: encode(text, d) };
        if (index >= 0) changes[index] = edit; else changes.push(edit);
      }
    } finally { this.project = oldProject; }
    return this.commit('作者确认人物同一身份', changes, next);
  }
};
