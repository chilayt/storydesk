import { AppError, atomicJson, hash, stamp, uid } from './io.mjs';
import { planningSource, planningTarget } from './planning.mjs';

const kinds = new Set(['next', 'stage', 'volume', 'work', 'chapter']);
const validId = /^creative_[a-zA-Z0-9_-]{1,100}$/;
const taskPath = id => {
  if (typeof id !== 'string' || !validId.test(id)) throw new AppError('VALIDATION', '创作任务 ID 无效');
  return `_创作管理/创作任务/${id}.json`;
};
const text = (value, max, label) => {
  if (typeof value !== 'string' || value.length > max || value.includes('\0')) throw new AppError('VALIDATION', `${label}内容无效或过长`);
  return value;
};

export async function taskSource(workspace, documentId) {
  const target = planningTarget(documentId);
  if (target) return planningSource(workspace, documentId, target);
  const source = await workspace.readDocument(documentId);
  if (!['chapter', 'draft'].includes(source.kind) || !Number.isInteger(source.chapter)) {
    throw new AppError('VALIDATION', '请选择正文、稿件或大纲作为任务目标');
  }
  return source;
}

export async function readCreativeTask(workspace, id) {
  const path = taskPath(id), entry = workspace.project.creativeTasks?.find(t => t.id === id);
  if (!entry) throw new AppError('NOT_FOUND', '此作品中没有这项创作任务');
  const bytes = await workspace.store.read(path);
  if (!bytes || hash(bytes) !== entry.hash) throw new AppError('CONFLICT', '创作任务记录有外部修改，请保留文件并检查');
  let record;
  try { record = JSON.parse(bytes.toString('utf8')); } catch { throw new AppError('DAMAGED_DATA', '创作任务记录无法解析'); }
  if (record.schema !== 1 || record.workId !== workspace.project.id || record.id !== id || !kinds.has(record.kind)) {
    throw new AppError('DAMAGED_DATA', '创作任务与当前作品不一致');
  }
  return { ...record, taskHash: hash(bytes), filePath: path };
}

export function creativeTaskStamp(task) {
  return hash(Buffer.from(JSON.stringify([task.goal, task.notes, task.referenceIds, task.annotations, task.status])));
}

export async function requireCreativeTask(workspace, taskId, documentId, sceneId = null, { allowArchived = false } = {}) {
  if (!taskId) return null;
  const task = await readCreativeTask(workspace, taskId);
  if (task.documentId !== documentId || task.sceneId !== sceneId || task.status === 'deleted' || task.status === 'archived' && !allowArchived) {
    throw new AppError('CONFLICT', '任务目标或状态已改变，请重新打开任务');
  }
  return task;
}

export function selectedAnnotations(task, source, ids) {
  if (!Array.isArray(ids) || !ids.length || ids.length > 12 || new Set(ids).size !== ids.length) {
    throw new AppError('VALIDATION', '请选择 1–12 条批注');
  }
  const rows = ids.map(id => task.annotations.find(a => a.id === id));
  if (rows.some(a => !a || a.sourceHash !== source.hash || source.text.slice(a.start, a.end) !== a.quote)) {
    throw new AppError('CONFLICT', '批注引用的正文已改变，请重新选段批注');
  }
  const ordered = rows.slice().sort((a, b) => a.start - b.start);
  if (ordered.some((a, i) => i && a.start < ordered[i - 1].end)) throw new AppError('VALIDATION', '所选批注范围重叠，请分批处理');
  if (rows.reduce((sum, a) => sum + a.quote.length + a.note.length, 0) > 6200) {
    throw new AppError('INPUT_LIMIT', '批注总量过大，请分批提交');
  }
  return rows;
}

export const creativeTaskMethods = {
  async setWritingRecovery({ documentId, text: draftText, baseHash }) {
    await taskSource(this, documentId);
    if (typeof baseHash !== 'string' || !/^[a-f0-9]{64}$/.test(baseHash)) throw new AppError('VALIDATION', '恢复草稿版本无效');
    text(draftText, 1000000, '恢复草稿');
    await atomicJson(await this.store.resolve(`_创作管理/草稿恢复/${documentId}.json`),
      { text: draftText, baseHash, saved_at: stamp(), workId: this.project.id });
    return true;
  },
  async listCreativeTasks() {
    return (this.project.creativeTasks || []).map(({ hash: _hash, ...entry }) => ({ ...entry, filePath: taskPath(entry.id) }))
      .sort((a, b) => b.updated_at.localeCompare(a.updated_at));
  },
  async getCreativeTask({ id }) { return readCreativeTask(this, id); },
  async createCreativeTask({ kind, documentId, sceneId = null, title = '', goal = '', purpose = 'writing' }) {
    if (!kinds.has(kind)) throw new AppError('VALIDATION', '创作任务类型无效');
    if (!['writing', 'character', 'book'].includes(purpose) || purpose === 'book' && kind !== 'work') {
      throw new AppError('VALIDATION', '创作任务用途无效');
    }
    text(title, 100, '任务标题'); text(goal, 2500, '任务目标');
    const source = await taskSource(this, documentId), planning = planningTarget(documentId);
    if (kind === 'chapter' ? !!planning : !planning || planning.type !== ({ next: 'chapter', stage: 'stage', volume: 'volume', work: 'work' })[kind]) {
      throw new AppError('VALIDATION', '任务类型与目标不符');
    }
    if (sceneId && sceneId !== 'whole' && !this.project.scenes.some(s => s.id === sceneId && s.documentId === documentId && s.sourceHash === source.hash)) {
      throw new AppError('SCENE', '任务场景已过期或不存在');
    }
    if (planning && sceneId) throw new AppError('VALIDATION', '大纲任务不使用场景范围');
    const record = { schema: 1, id: uid('creative'), workId: this.project.id, kind, documentId, sceneId,
      title: title.trim() || source.title, goal: goal.trim(), notes: '', phase: 'plan', status: 'active',
      annotations: [], referenceIds: [], created_at: stamp(), updated_at: stamp(), ...(purpose !== 'writing' ? { purpose } : {}) };
    const body = JSON.stringify(record, null, 2), next = structuredClone(this.project);
    next.creativeTasks ||= [];
    next.creativeTasks.push({ id: record.id, title: record.title, kind, documentId, sceneId, status: record.status,
      updated_at: record.updated_at, hash: hash(Buffer.from(body)), ...(record.purpose ? { purpose: record.purpose } : {}) });
    await this.commit('创建创作任务', [{ path: taskPath(record.id), expectedHash: null, text: body }], next);
    return readCreativeTask(this, record.id);
  },
  async saveCreativeTask({ id, expectedHash, title, goal, notes, phase, status, annotations, referenceIds, recoveryDraft }) {
    const record = await readCreativeTask(this, id);
    if (record.taskHash !== expectedHash) throw new AppError('CONFLICT', '任务已有新版本，请重新打开');
    if (this.controllers.has(`cowrite_${record.documentId}.${record.sceneId || 'ending'}.${id}`)) {
      throw new AppError('BUSY', '请先结束或停止当前任务的生成');
    }
    if (title !== undefined) { record.title = text(title, 100, '任务标题').trim(); if (!record.title) throw new AppError('VALIDATION', '请填写任务标题'); }
    if (goal !== undefined) record.goal = text(goal, 2500, '任务目标');
    if (notes !== undefined) record.notes = text(notes, 4000, '未决问题与任务备注');
    if (phase !== undefined) {
      if (!['plan', 'edit', 'review'].includes(phase)) throw new AppError('VALIDATION', '任务阶段无效');
      record.phase = phase;
    }
    if (status !== undefined) {
      if (!['active', 'archived', 'deleted'].includes(status)) throw new AppError('VALIDATION', '任务状态无效');
      record.status = status;
    }
    if (referenceIds !== undefined) {
      if (!Array.isArray(referenceIds) || referenceIds.length > 4 || new Set(referenceIds).size !== referenceIds.length ||
        referenceIds.some(id => !record.referenceIds.includes(id) && !this.documents.some(d => d.id === id && !d.error && !d.generated &&
          !this.project.hiddenChapterMaterials?.includes(d.id) &&
          ['plan', 'character', 'setting', 'rule', 'organization', 'location', 'item', 'reference', 'plot', 'family'].includes(d.kind)))) {
        throw new AppError('VALIDATION', '最多补充四份当前作品的文字资料');
      }
      record.referenceIds = referenceIds;
    }
    if (annotations !== undefined) {
      if (!Array.isArray(annotations) || annotations.length > 40 || new Set(annotations.map(a => a?.id)).size !== annotations.length) {
        throw new AppError('VALIDATION', '批注列表无效或超过 40 条');
      }
      const source = await taskSource(this, record.documentId);
      if (source.planning) throw new AppError('VALIDATION', '正文批注请在章节任务中添加');
      record.annotations = annotations.map(a => {
        const old = record.annotations.find(row => row.id === a.id);
        const quote = text(a.quote, 2500, '引用原文'), note = text(a.note, 800, '批注');
        if (!quote || !note.trim() || !Number.isInteger(a.start) || !Number.isInteger(a.end) || a.start < 0 || a.end <= a.start ||
          a.quote !== source.text.slice(a.start, a.end) || a.sourceHash !== source.hash) {
          if (!old || old.start !== a.start || old.end !== a.end || old.quote !== a.quote || old.sourceHash !== a.sourceHash || old.note !== note) {
            throw new AppError('CONFLICT', '批注必须对应当前保存版本中的准确选段');
          }
        }
        return { id: old?.id || uid('annotation'), start: a.start, end: a.end, quote, note,
          sourceHash: a.sourceHash, created_at: old?.created_at || stamp() };
      });
    }
    if (recoveryDraft !== undefined) {
      if (recoveryDraft === null) delete record.recoveryDraft;
      else {
        if (typeof recoveryDraft.sourceHash !== 'string' || !/^[a-f0-9]{64}$/.test(recoveryDraft.sourceHash)) throw new AppError('VALIDATION', '草稿基准版本无效');
        record.recoveryDraft = { sourceHash: recoveryDraft.sourceHash, text: text(recoveryDraft.text, 1000000, '任务恢复草稿'), saved_at: stamp() };
      }
    }
    const beforeHash = record.taskHash; delete record.taskHash; delete record.filePath;
    record.updated_at = stamp();
    const body = JSON.stringify(record, null, 2), next = structuredClone(this.project);
    Object.assign(next.creativeTasks.find(t => t.id === id), { title: record.title, status: record.status,
      updated_at: record.updated_at, hash: hash(Buffer.from(body)) });
    await this.commit('保存创作任务与批注', [{ path: taskPath(id), expectedHash: beforeHash, text: body }], next);
    return readCreativeTask(this, id);
  },
};
