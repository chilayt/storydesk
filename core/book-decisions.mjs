import { AppError, stamp, uid } from './io.mjs';

const topics = ['premise', 'character', 'relationship', 'plot', 'setting', 'volume', 'chapter'];
const statuses = new Set(['exploring', 'tentative', 'confirmed']);
const text = (value, limit) => typeof value === 'string' && value.length <= limit && !value.includes('\0') ? value.trim() : '';
const ids = limit => ({ type: 'array', maxItems: limit, items: { type: 'string', maxLength: 100 } });

export const bookDecisionParameters = {
  type: 'object', properties: {
    items: { type: 'array', minItems: 1, maxItems: 6, items: {
      type: 'object', properties: {
        topic: { type: 'string', enum: topics },
        title: { type: 'string', maxLength: 80 },
        text: { type: 'string', maxLength: 1000, description: '一条可单独核对的构思。未获作者选定的内容请明确说明是备选。' },
        quote: { type: 'string', maxLength: 250, description: '与本项直接相关的作者原话。照录，不要改写。' },
        replaces: { type: 'string', maxLength: 100, description: '修改已有决定时填写其 ID。保留同一条目的身份。' },
        dependsOn: { ...ids(12), description: '本项成立所依赖的现行决定 ID。提及或同属一个人物并不等于依赖。' },
        documents: { ...ids(12), description: '与本项直接相关的已登记卷纲、章纲或档案 ID。' },
      }, required: ['topic', 'title', 'text', 'quote'], additionalProperties: false,
    } },
  }, required: ['items'], additionalProperties: false,
};

export function prepareBookDecisions(workspace, rows, authors) {
  if (!Array.isArray(rows) || !rows.length || rows.length > 6) throw new AppError('VALIDATION', '每轮可整理 1–6 项构思。');
  const existing = new Map((workspace.project.bookDecisions || []).map(row => [row.id, row]));
  const seen = new Set();
  return rows.map(row => {
    const title = text(row?.title, 80), content = text(row?.text, 1000), quote = text(row?.quote, 250);
    if (!topics.includes(row?.topic) || !title || !content || quote.length < 2 || !authors.some(message => message.includes(quote))) {
      throw new AppError('EVIDENCE', '请提供具体构思和对应的作者原话。');
    }
    const previous = row.replaces ? existing.get(row.replaces) : undefined;
    if (row.replaces && (!previous || previous.topic !== row.topic || seen.has(previous.id))) {
      throw new AppError('CONFLICT', '请在本书现行决定中选定一项更新。');
    }
    if (previous) seen.add(previous.id);
    if (row.dependsOn !== undefined && !Array.isArray(row.dependsOn) ||
        row.documents !== undefined && !Array.isArray(row.documents)) throw new AppError('VALIDATION', '引用须使用本书登记的 ID 列表。');
    const dependencies = [...new Set(row.dependsOn ?? previous?.dependencies.map(item => item.id) ?? [])];
    const documents = [...new Set(row.documents ?? previous?.documents ?? [])];
    if (dependencies.length > 12 || dependencies.some(id => !existing.has(id) || id === previous?.id) ||
      documents.length > 12 || documents.some(id => !workspace.documents.some(doc => doc.id === id && ['plan', 'character', 'setting'].includes(doc.kind)))) {
      throw new AppError('VALIDATION', '引用须来自本书现行构思或已登记资料。');
    }
    const dependencyVersions = Object.fromEntries(dependencies.map(id => [id, existing.get(id).revision]));
    return { id: uid('decision_proposal'), topic: row.topic, title, text: content, quote, dependsOn: dependencies, documents, dependencyVersions,
      ...(previous ? { replaces: previous.id, expectedVersion: previous.version ?? previous.revision } : {}) };
  });
}

export function bookDecisionView(workspace) {
  const rows = workspace.project.bookDecisions || [];
  const byId = new Map(rows.map(row => [row.id, row]));
  const causes = new Map();
  function outdated(row) {
    if (causes.has(row.id)) return causes.get(row.id);
    const result = new Set();
    causes.set(row.id, result);
    for (const link of row.dependencies) {
      const source = byId.get(link.id);
      if (!source) continue;
      if (source.revision !== link.revision) result.add(source.id);
      for (const id of outdated(source)) result.add(id);
    }
    return result;
  }
  return rows.map(row => ({
    id: row.id, topic: row.topic, title: row.title, text: row.text, status: row.status, revision: row.revision, version: row.version ?? row.revision,
    documents: row.documents.flatMap(id => workspace.documents.filter(doc => doc.id === id).map(doc => ({ id: doc.id, title: doc.title }))),
    dependsOn: row.dependencies.map(link => ({ id: link.id, title: byId.get(link.id)?.title })),
    review: [...outdated(row)].map(id => ({ id, title: byId.get(id).title, text: byId.get(id).text })),
    ...(row.previous ? { previous: row.previous } : {}),
  }));
}

export function updateBookDecision(project, proposal, input) {
  const content = text(input.text, 1000), title = text(input.title ?? proposal.title, 80);
  const { status } = input;
  if (!statuses.has(status) || !content || !title) throw new AppError('VALIDATION', '请填写构思内容并选择状态。');
  const rows = project.bookDecisions ||= [];
  const previous = rows.find(row => row.id === proposal.replaces);
  if (proposal.replaces && (!previous || (previous.version ?? previous.revision) !== proposal.expectedVersion)) {
    throw new AppError('CONFLICT', '构思已有另一次裁定，请按现行内容重新核对。');
  }
  const dependencies = input.dependsOn ?? proposal.dependsOn;
  if (!Array.isArray(dependencies) || dependencies.length > 12 || new Set(dependencies).size !== dependencies.length) {
    throw new AppError('VALIDATION', '请核对所依赖的构思。');
  }
  const byId = new Map(rows.map(row => [row.id, row]));
  if (dependencies.some(id => Object.hasOwn(proposal.dependencyVersions || {}, id) &&
      byId.get(id)?.revision !== proposal.dependencyVersions[id])) {
    throw new AppError('CONFLICT', '所依赖的构思已有改动，请基于现行决定重新整理。');
  }
  const lineage = new Set(dependencies);
  for (const id of lineage) {
    if (!byId.has(id) || id === previous?.id) throw new AppError('CONFLICT', '构思不能循环依赖或依赖其他作品。');
    for (const link of byId.get(id).dependencies) lineage.add(link.id);
  }
  const changed = previous && (previous.text !== content || previous.status !== status ||
    previous.dependencies.length !== dependencies.length || previous.dependencies.some(link => !dependencies.includes(link.id)));
  const row = { id: previous?.id || uid('decision'), topic: proposal.topic, title, text: content, status,
    revision: previous ? previous.revision + Number(changed) : 1,
    version: previous ? (previous.version ?? previous.revision) + 1 : 1,
    dependencies: dependencies.map(id => ({ id, revision: byId.get(id).revision })), documents: proposal.documents,
    quote: proposal.quote, updated_at: stamp(),
    ...(changed ? { previous: { text: previous.text, status: previous.status, revision: previous.revision } } :
      previous?.previous ? { previous: previous.previous } : {}),
  };
  if (previous) rows[rows.indexOf(previous)] = row;
  else rows.push(row);
  return row;
}
