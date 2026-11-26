import assert from 'node:assert/strict';
import test from 'node:test';
import { bookDecisionView, prepareBookDecisions, updateBookDecision } from '../core/book-decisions.mjs';

const createWorkspace = () => ({
  project: {},
  documents: [{ id: 'doc_vol', title: '第1卷大纲', kind: 'plan' }, { id: 'doc_chapter', title: '第4章章纲', kind: 'plan' }],
});

const createProposal = (workspace, topic, text, options) =>
  prepareBookDecisions(workspace, [{ topic, title: text, text, quote: text, ...options }], [text])[0];

const save = (workspace, proposal, status = 'confirmed') =>
  updateBookDecision(workspace.project, proposal, { text: proposal.text, status });

test('文件存在不会形成裁定，作者可以在任一议题先探索或暂定', () => {
  const ws = createWorkspace();
  assert.deepEqual(bookDecisionView(ws), []);
  const ending = createProposal(ws, 'chapter', '结尾可能有一场送别');
  assert.equal(ending.status, undefined);
  assert.deepEqual(bookDecisionView(ws), []);
  const candidate = save(ws, ending, 'exploring');
  assert.equal(bookDecisionView(ws)[0].status, 'exploring');
  const tentative = createProposal(ws, 'chapter', '送别场景暂放在旧车站', { replaces: candidate.id });
  save(ws, tentative, 'tentative');
  assert.equal(bookDecisionView(ws)[0].status, 'tentative');
});

test('人物决定变更使关联卷纲、章纲和关系待复核，复核后只解除已处理依赖', () => {
  const ws = createWorkspace();
  const action = save(ws, createProposal(ws, 'character', '当众说明'));
  const volume = save(ws, createProposal(ws, 'volume', '卷末揭晓', { dependsOn: [action.id], documents: ['doc_vol'] }));
  const scene = save(ws, createProposal(ws, 'chapter', '第四章交接', { dependsOn: [volume.id], documents: ['doc_chapter'] }));
  const relation = save(ws, createProposal(ws, 'relationship', '旧同事协作', { dependsOn: [action.id] }));
  save(ws, createProposal(ws, 'plot', '采购议案'));
  const view = () => bookDecisionView(ws);
  const revise = createProposal(ws, 'character', '改为提交书面说明', { replaces: action.id });
  assert.equal(view()[0].text, '当众说明');
  assert.deepEqual(view().filter(row => row.review.length), []);
  save(ws, revise);
  assert.deepEqual(view().filter(row => row.review.length).map(row => row.id), [volume.id, scene.id, relation.id]);
  assert.deepEqual(view().find(row => row.id === scene.id).documents, [{ id: 'doc_chapter', title: '第4章章纲' }]);
  assert.equal(view()[0].previous.text, '当众说明');
  save(ws, createProposal(ws, 'volume', volume.text, { replaces: volume.id }));
  assert.deepEqual(view().filter(row => row.review.length).map(row => row.id), [relation.id]);
});

test('拒绝伪造引据、跨作品联系、循环依赖和上游已变化的旧建议', () => {
  const ws = createWorkspace();
  assert.throws(() => prepareBookDecisions(ws, [{ topic: 'plot', title: '甲乙', text: '甲乙', quote: '伪造' }], ['原话']), { code: 'EVIDENCE' });
  assert.throws(() => createProposal(ws, 'plot', '甲乙', { documents: ['foreign_doc'] }), { code: 'VALIDATION' });
  const parent = save(ws, createProposal(ws, 'plot', '主线故事'));
  const child = save(ws, createProposal(ws, 'chapter', '章节任务', { dependsOn: [parent.id] }));
  const cycle = createProposal(ws, 'plot', '主线更新', { replaces: parent.id, dependsOn: [child.id] });
  assert.throws(() => save(ws, cycle), { code: 'CONFLICT' });
  const stale = createProposal(ws, 'relationship', '两人合谋', { dependsOn: [parent.id] });
  save(ws, createProposal(ws, 'plot', '主线改变', { replaces: parent.id }));
  assert.throws(() => save(ws, stale), { code: 'CONFLICT' });
});
