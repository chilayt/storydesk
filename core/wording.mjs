import { AppError, uid, stamp, hash, encode, decode } from './io.mjs';

const wordingPath = '05-剧本/设定/用词_作者裁定.md';
const legacyWordingPath = '05-剧本/设定/唐代用词_作者裁定.md';

async function wordingDocument(store) {
  const current = await store.read(wordingPath);
  if (current) return { relative: wordingPath, bytes: current };
  const legacy = await store.read(legacyWordingPath);
  return legacy ? { relative: legacyWordingPath, bytes: legacy } : { relative: wordingPath, bytes: null };
}

export function wordingNotices(output) {
  let report;
  const line = String(output).split('\n').find(l => l.startsWith('STORYDESK_GATE_JSON:'));
  try { if (line) report = JSON.parse(line.slice('STORYDESK_GATE_JSON:'.length)); } catch {}
  const raw = report?.tang || String(output).split('\n').filter(l => /[✗⚠○].*唐代用词/.test(l) && !/未完成/.test(l)).map(l => ({ raw: l.trim() }));
  const result = [];
  for (const entry of raw) {
    const text = entry.raw.split('：').slice(1).join('：');
    let depth = 0, part = ''; const parts = [];
    for (const ch of text) { if ('（〔('.includes(ch)) depth++; if ('）〕)'.includes(ch)) depth = Math.max(0, depth - 1); if (ch === '；' && !depth) { if (part) parts.push(part); part = ''; } else part += ch; }
    if (part) parts.push(part);
    for (const p of parts) {
      const term = p.split(/×\d|（唐义|〔/)[0].trim(); if (!term || term.length > 120) continue;
      if (!result.some(r => r.term === term)) result.push({ id: hash(Buffer.from(term)).slice(0, 20), term, raw: p.trim(), severity: 'reminder' });
    }
  }
  return result;
}
export function decorateWording(check, project) {
  const notices = wordingNotices(check.output).map(n => {
    const decision = wordingDecision(project, check, n);
    return { ...n, decision: decision || null, allowed: !!decision?.allow };
  });
  return { ...check, wording: notices, wordingPolicyHash: hash(Buffer.from(JSON.stringify(project.wordingDecisions || []))) };
}
export function wordingDecision(project, source, notice) {
  return (project.wordingDecisions || []).findLast(d => d.active !== false && d.term === notice.term &&
    (!d.usage || d.usage === notice.usage) && (d.scope === 'work' || d.documentId === source.documentId &&
      (d.scope === 'document' || d.sourceHash === source.sourceHash))) || null;
}
export const wordingMethods = {
  async decideWording({ checkId, term, scope = 'revision', allow = true, reason = '' }) {
    const check = this.project.checks.find(c => c.id === checkId); if (!check) throw new AppError('NOT_FOUND', '检查报告不存在');
    const d = await this.snapshotDocument(this.doc(check.documentId)); if (d.hash !== check.sourceHash) throw new AppError('CONFLICT', '稿件已修改，请重跑检查后裁定用词');
    const notice = wordingNotices(check.output).find(n => n.term === term); if (!notice) throw new AppError('VALIDATION', '该用词不在本次检查报告中');
    await this.recordWordingDecision(d, notice, { scope, allow, reason });
    return decorateWording(check, this.project);
  },
  async recordWordingDecision(d, notice, { scope = 'revision', allow = true, reason = '', sources = [] }) {
    const [record] = await this.recordWordingDecisions(d, [{ notice, scope, allow, reason, sources }]);
    return record;
  },
  async recordWordingDecisions(d, choices) {
    const next = structuredClone(this.project); next.wordingDecisions ||= [];
    const records = choices.map(({ notice, scope, allow, reason, sources }) => {
      if (!['revision', 'document', 'work'].includes(scope) || typeof allow !== 'boolean') throw new AppError('VALIDATION', '用词裁定范围无效');
      return { id: uid('wording'), term: notice.term, usage: notice.usage || '', raw: notice.raw,
        scope, allow, documentId: d.id, documentPath: d.path, sourceHash: d.hash, reason: String(reason).slice(0, 1200),
        author: '作者', confirmed_at: stamp(), active: true, sources };
    });
    next.wordingDecisions.push(...records);
    const { relative, bytes: before } = await wordingDocument(this.store);
    const body = '# 用词 · 作者裁定\n\n本表由创作台记录作者确认的用词范围。\n\n' + next.wordingDecisions.map(r => {
      const links = (r.sources || []).map(s => `- 查证出处：${s.title.replace(/[\r\n]/g, ' ')} <${s.url}>\n`).join('');
      return `## ${r.term} · ${r.active === false ? '已撤销' : r.allow ? '作者放行' : '保留提醒'}\n\n- 范围：${({ revision: '本章本次版本全文', document: '本章全文（包含后续修订）', work: '全作品（含后续章节）' })[r.scope]}\n${r.usage ? '- 用法：' + r.usage + '\n' : ''}- 来源：${r.documentPath}\n- 版本：${r.sourceHash}\n- 作者确认：${r.confirmed_at}\n- 依据：${r.raw.replaceAll('\n', ' ')}\n- 理由：${r.reason || '作者裁定'}\n${links}- 记录ID：${r.id}\n`;
    }).join('\n');
    if (before && this.project.externalChanges[this.documents.find(v => v.path === relative)?.id]) throw new AppError('CONFLICT', '用词裁定文档存在外部修改，请先核对');
    await this.commit('作者裁定用词适用范围', [{ path: relative, expectedHash: before ? hash(before) : null, bytes: encode(body, before ? decode(before) : {}) }], next);
    return records;
  },
  async revokeWording({ id }) {
    const next = structuredClone(this.project); const r = next.wordingDecisions?.find(r => r.id === id); if (!r) throw new AppError('NOT_FOUND', '裁定记录不存在');
    r.active = false; r.revoked_at = stamp();
    // Regenerate the same human-readable projection without erasing other active decisions.
    const { relative, bytes } = await wordingDocument(this.store);
    let changes = [];
    if (bytes) { const d = decode(bytes); const marker = `- 记录ID：${id}`; if (!d.text.includes(marker)) throw new AppError('CONFLICT', '规则文档已在外部改变，请先核对'); changes = [{ path: relative, expectedHash: hash(bytes), bytes: encode(d.text.replace(marker, `${marker}\n- 已撤销：${r.revoked_at}`), d) }]; }
    return this.commit('撤销作者用词放行', changes, next);
  }
};
