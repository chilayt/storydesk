import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, configure, confirmFirst, waitJob, modelFetch, chapterText } from './helpers.mjs';
import { Workspace } from '../core/workspace.mjs';

async function setup(t, name, { lockHolder = false } = {}) {
  let empty = false, requests = 0;
  const fetcher = async (...args) => { requests++; return empty ? new Response(JSON.stringify({ choices: [{ message: { content: '{"events":[]}' } }], usage: { total_tokens: 10 } })) : modelFetch()(...args); };
  const f = await fixture(name, { fetcher }); t.after(f.close); await configure(f.workspace);
  const ws = f.workspace, sz = ws.project.characters.find(c => c.name === '沈舟');
  if (lockHolder) await ws.setLock({ entityId: sz.id, field: 'item_holder', active: true });
  const first = await confirmFirst(ws); await waitJob(ws, first.job.id);
  return { ...f, ws, sz, first, emptyNext() { empty = true; }, requests: () => requests };
}
async function nextVersion(f) {
  const d = f.ws.documents.find(d => d.chapter === 1);
  await f.ws.saveDocument({ documentId: d.id, expectedHash: d.hash, text: chapterText + '\n作者修改后的本章结尾。\n' });
  f.emptyNext(); const next = await confirmFirst(f.ws); await waitJob(f.ws, next.job.id); return next;
}

test('改章后旧待核对项自动转历史，新版撤回旧事实的建议仍保持当前可处理', async t => {
  const f = await setup(t, 'review-lifecycle'); const old = f.ws.project.proposals.map(p => p.id); assert.equal(old.length, 2);
  const next = await nextVersion(f);
  assert.ok(old.every(id => f.ws.project.proposals.find(p => p.id === id).status === 'obsolete'));
  const oldJob = f.ws.project.jobs.find(j => j.id === f.first.job.id); assert.equal(oldJob.status, 'superseded'); assert.equal(oldJob.pending, 0); assert.equal(oldJob.obsoletePending, 2);
  const pending = f.ws.project.proposals.filter(p => p.status === 'pending'); assert.equal(pending.length, 3);
  assert.ok(pending.every(p => p.jobId === next.job.id && p.operation === 'withdraw' && p.fact.source_hash === f.first.approval.sourceHash));
  assert.equal(f.ws.summary().stats.pending, 3);
  await assert.rejects(f.ws.restartJob({ jobId: f.first.job.id }), e => e.code === 'STALE_REVIEW');
  await assert.rejects(f.ws.resolveProposal({ proposalId: old[0], resolution: 'accept' }), e => e.code === 'STALE_REVIEW');
  assert.equal((await f.ws.reviewHistory()).filter(r => r.status === 'obsolete').length, 2);
});

test('拒绝新版的撤回建议会保留旧事实，不再把旧事实误标为拒绝', async t => {
  const f = await setup(t, 'review-retain'); await nextVersion(f);
  const p = f.ws.project.proposals.find(p => p.status === 'pending' && p.operation === 'withdraw');
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'reject' });
  assert.equal(f.ws.events.flatMap(e => e.facts).find(fact => fact.id === p.fact.id).status, 'accepted');
  assert.equal(f.ws.project.proposals.find(q => q.id === p.id).status, 'rejected');
  assert.equal((await f.ws.reviewRecord({ recordId: `proposal:${p.id}` })).current, true);
});

test('新版等待撤回的自动事实仍可在原章节已处理记录中查看和单条撤回', async t => {
  const f = await setup(t, 'review-automatic-withdrawal');
  const skill = f.ws.events.flatMap(e => e.facts).find(fact => fact.field === 'skill');
  await nextVersion(f);
  const row = (await f.ws.reviewHistory()).find(r => r.recordId === `fact:${skill.id}`);
  assert.ok(row); assert.equal(row.kind, 'automatic'); assert.equal(row.current, false);
  const detail = await f.ws.reviewRecord({ recordId: row.recordId }); assert.equal(detail.canWithdraw, true);
  await f.ws.withdrawReviewedItem({ recordId: row.recordId, expectedDigest: detail.digest });
  assert.equal(f.ws.project.proposals.find(p => p.operation === 'withdraw' && p.fact.id === skill.id).status, 'obsolete');
  assert.equal(f.ws.events.flatMap(e => e.facts).find(fact => fact.id === skill.id).status, 'withdrawn');
  assert.ok(f.ws.events.flatMap(e => e.facts).some(fact => fact.field === 'relationship' && fact.status === 'accepted'));
});

test('重新核对时更正所属人物会同时刷新原人物和新人物的本地档案', async t => {
  const f = await setup(t, 'review-reassign', { lockHolder: true });
  const p = f.ws.project.proposals.find(p => p.fact.field === 'item_holder');
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'accept' });
  const aq = f.ws.project.characters.find(c => c.name === '阿青');
  const revision = f.ws.project.proposals.find(q => q.id === p.id).revision;
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'edit', value: '作者重新核对的书册', entityId: aq.id, reconsider: true, expectedRevision: revision });
  assert.equal((await f.ws.getCharacter(f.sz.id)).current.item_holder, undefined);
  assert.equal((await f.ws.getCharacter(aq.id)).current.item_holder.value, '作者重新核对的书册');
  assert.ok(!(await f.read('01-人物/人物分档/沈舟.md')).includes('《听潮诀》功法册'));
  assert.ok((await f.read('01-人物/人物分档/阿青.md')).includes('作者重新核对的书册'));
});

test('本版已接受项可以再次编辑或撤回，其他同事件事实和原正文保留', async t => {
  const f = await setup(t, 'review-reconsider', { lockHolder: true });
  const p = f.ws.project.proposals.find(p => p.fact.field === 'item_holder');
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'accept' });
  let current = f.ws.project.proposals.find(q => q.id === p.id);
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'edit', value: '作者复核后的持有物', reconsider: true, expectedRevision: current.revision });
  assert.equal((await f.ws.getCharacter(f.sz.id)).current.item_holder.value, '作者复核后的持有物');
  current = f.ws.project.proposals.find(q => q.id === p.id); assert.equal(current.decisionHistory.length, 2); assert.ok(current.originalFact);
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'reject', reconsider: true, expectedRevision: current.revision });
  assert.equal((await f.ws.getCharacter(f.sz.id)).current.item_holder, undefined);
  assert.ok(f.ws.events.flatMap(e => e.facts).some(fact => fact.field === 'skill' && fact.status === 'accepted'));
  assert.equal(await f.read(f.ws.documents.find(d => d.chapter === 1).path), chapterText);
  assert.equal((await f.ws.reviewRecord({ recordId: `proposal:${p.id}` })).history.length, 3);
});

test('本版已拒绝项可重新核对，过期窗口不能重复覆盖新裁定', async t => {
  const f = await setup(t, 'review-rejected'); const p = f.ws.project.proposals.find(p => p.fact.field === 'location');
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'reject' }); const revision = f.ws.project.proposals.find(q => q.id === p.id).revision;
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'plan', reconsider: true, expectedRevision: revision });
  assert.equal(f.ws.project.proposals.find(q => q.id === p.id).status, 'accepted');
  await assert.rejects(f.ws.resolveProposal({ proposalId: p.id, resolution: 'reject', reconsider: true, expectedRevision: revision }), e => e.code === 'CONFLICT');
});

test('旧版已处理项可查原确认稿，并以新作者裁定更正当前档案而不冒充新版证据', async t => {
  const f = await setup(t, 'review-historical', { lockHolder: true }); const p = f.ws.project.proposals.find(p => p.fact.field === 'item_holder');
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'accept' }); await nextVersion(f);
  const recordId = `proposal:${p.id}`, detail = await f.ws.reviewRecord({ recordId }); assert.equal(detail.current, false); assert.equal(detail.canReconsider, false); assert.equal(detail.canCorrect, true);
  const original = await f.ws.reviewSource({ recordId }); assert.equal(original.text, chapterText);
  await f.ws.correctReviewedItem({ recordId, expectedCurrentDigest: detail.currentDigest, value: '重新裁定的持有物', reason: '当时选错，现重新核对' });
  assert.equal((await f.ws.getCharacter(f.sz.id)).current.item_holder.value, '重新裁定的持有物');
  assert.notEqual((await f.ws.getCharacter(f.sz.id, 1)).current.item_holder?.value, '重新裁定的持有物');
  const correction = (await f.ws.reviewHistory()).find(r => r.kind === 'correction'); assert.ok(correction); assert.equal(correction.documentId, f.first.approval.documentId); assert.equal(correction.current, true);
  assert.equal((await f.ws.reviewSource({ recordId: correction.recordId })).authorRuling, true);
  assert.equal((await f.ws.reviewRecord({ recordId })).history.at(-1).action, 'correct_current');
  assert.equal(f.ws.project.proposals.find(q => q.id === p.id).status, 'accepted'); assert.equal(f.requests(), 2);
  assert.ok((await f.read(f.ws.documents.find(d => d.chapter === 1).path)).includes('作者修改后的本章结尾'));
});

test('撤回历史已入档项会刷新投影并关闭对此事实的重复撤回请求', async t => {
  const f = await setup(t, 'review-withdraw', { lockHolder: true }); const p = f.ws.project.proposals.find(p => p.fact.field === 'item_holder');
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'accept' }); await nextVersion(f);
  const recordId = `proposal:${p.id}`, detail = await f.ws.reviewRecord({ recordId }); assert.equal(detail.canWithdraw, true);
  await f.ws.withdrawReviewedItem({ recordId, expectedDigest: detail.digest, reason: '误点接受' });
  assert.equal(f.ws.project.proposals.find(q => q.id === p.id).status, 'revoked');
  assert.equal(f.ws.project.proposals.find(q => q.operation === 'withdraw' && q.fact.id === p.fact.id).status, 'obsolete');
  assert.equal((await f.ws.getCharacter(f.sz.id)).current.item_holder, undefined);
  assert.equal((await f.ws.reviewRecord({ recordId })).history.at(-1).action, 'withdraw_applied');
});

test('自动归档项也可查与更正；并发人工修改后旧窗口不得覆盖', async t => {
  const f = await setup(t, 'review-automatic'); const record = (await f.ws.reviewHistory()).find(r => r.kind === 'automatic' && r.fact.field === 'item_holder'); assert.ok(record);
  const detail = await f.ws.reviewRecord({ recordId: record.recordId });
  await f.ws.updateField({ entityId: f.sz.id, field: 'item_holder', value: '后来人工修改的内容' });
  await assert.rejects(f.ws.correctReviewedItem({ recordId: record.recordId, expectedCurrentDigest: detail.currentDigest, value: '旧窗口内容' }), e => e.code === 'CONFLICT');
  assert.equal((await f.ws.getCharacter(f.sz.id)).current.item_holder.value, '后来人工修改的内容');
});

test('武学更正显示真实当前值，重复更正不会残留两套能力或篡改旧章视图', async t => {
  const f = await setup(t, 'review-skill-current'); const skill = f.ws.events.flatMap(e => e.facts).find(f => f.field === 'skill');
  const recordId = `fact:${skill.id}`; let record = await f.ws.reviewRecord({ recordId });
  assert.equal(record.currentValue.skillName, '听潮诀');
  await f.ws.correctReviewedItem({ recordId, expectedCurrentDigest: record.currentDigest, value: { skillName: '听潮法', stage: '试练', level: '尚未练成' } });
  record = await f.ws.reviewRecord({ recordId }); assert.equal(record.currentValue.skillName, '听潮法');
  await f.ws.correctReviewedItem({ recordId, expectedCurrentDigest: record.currentDigest, value: { skillName: '听潮心法', stage: '练成', level: '第一层' } });
  record = await f.ws.reviewRecord({ recordId }); assert.equal(record.currentValue.skillName, '听潮心法');
  const current = await f.ws.getCharacter(f.sz.id), historic = await f.ws.getCharacter(f.sz.id, 1);
  assert.equal(current.skills.length, 1); assert.equal(current.skills[0].value.skillName, '听潮心法');
  assert.equal(historic.skills.length, 1); assert.equal(historic.skills[0].value.skillName, '听潮诀');
  assert.ok((await f.read('01-人物/人物分档/沈舟.md')).includes('听潮心法'));
});

test('同一关系反复更正类型和情感时显示最新内容，不留下失效关系边', async t => {
  const f = await setup(t, 'review-relationship-current'), relation = f.ws.events.flatMap(e => e.facts).find(f => f.field === 'relationship');
  const recordId = `fact:${relation.id}`; let record = await f.ws.reviewRecord({ recordId }); assert.equal(record.currentValue.type, '相识');
  await f.ws.correctReviewedItem({ recordId, expectedCurrentDigest: record.currentDigest, value: { ...relation.value, type: '旧友', attitude: '互相信任' } });
  record = await f.ws.reviewRecord({ recordId }); assert.equal(record.currentValue.type, '旧友');
  await f.ws.correctReviewedItem({ recordId, expectedCurrentDigest: record.currentDigest, value: { ...relation.value, type: '同伴', attitude: '信任但有所保留' } });
  const edges = f.ws.relationships(); assert.equal(edges.length, 1); assert.equal(edges[0].type, '同伴');
  record = await f.ws.reviewRecord({ recordId }); assert.equal(record.currentValue.attitude, '信任但有所保留');
});

test('已确认基座可从处理记录更正，写回原人物卡并保留旧裁定', async t => {
  const f = await setup(t, 'review-baseline'); const p = f.ws.project.proposals.find(p => p.fact.field.startsWith('base.'));
  const c = f.ws.project.characters.find(c => c.id === p.fact.entity_id), d = f.ws.documents.find(d => d.id === c.primarySourceId);
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'accept', expectedSourceHash: d.hash });
  const recordId = `proposal:${p.id}`, detail = await f.ws.reviewRecord({ recordId }); assert.equal(detail.baseline, true); assert.equal(detail.canWithdraw, false);
  await f.ws.correctReviewedItem({ recordId, expectedCurrentDigest: detail.currentDigest, value: '寻常天赋', reason: '纠正当时选择' });
  assert.equal((await f.ws.getCharacter(c.id)).baseline.fields.find(f => f.field === '天赋').value, '寻常天赋');
  assert.ok((await f.read(d.path)).includes('寻常天赋')); assert.equal(f.ws.project.proposals.find(q => q.id === p.id).status, 'accepted');
  assert.equal((await f.ws.reviewRecord({ recordId })).history.at(-1).action, 'correct_current_baseline');
});

test('基座属性的人物认知更正不会误改真实初始基座', async t => {
  const f = await setup(t, 'review-baseline-belief'); const p = f.ws.project.proposals.find(p => p.fact.field.startsWith('base.'));
  await f.ws.resolveProposal({ proposalId: p.id, resolution: 'belief' });
  const r = await f.ws.reviewRecord({ recordId: `proposal:${p.id}` }); assert.equal(r.baseline, false);
  await f.ws.correctReviewedItem({ recordId: r.recordId, expectedCurrentDigest: r.currentDigest, value: '人物只是自以为天资出众', layer: 'belief' });
  assert.equal(f.ws.baselines[p.fact.entity_id], undefined);
});

test('原确认稿快照缺失时明确报错，不能拿最新版原文替代历史证据', async t => {
  const f = await setup(t, 'review-snapshot'); const p = f.ws.project.proposals[0]; await f.ws.resolveProposal({ proposalId: p.id, resolution: 'reject' }); await nextVersion(f);
  await fs.unlink(path.join(f.root, f.first.approval.snapshot));
  await assert.rejects(f.ws.reviewSource({ recordId: `proposal:${p.id}` }), e => e.code === 'SOURCE');
});

test('外部修改尚未刷新时也拒绝接受旧建议', async t => {
  const f = await setup(t, 'review-external-race'); const p = f.ws.project.proposals[0], d = f.ws.documents.find(d => d.chapter === 1);
  await f.write(d.path, chapterText + '\n外部工具刚改过本章。\n');
  await assert.rejects(f.ws.resolveProposal({ proposalId: p.id, resolution: 'reject' }), e => e.code === 'STALE_REVIEW');
  await f.ws.refresh(); assert.equal(f.ws.project.proposals.find(q => q.id === p.id).status, 'obsolete');
});

test('恢复完全相同的原确认稿可恢复该版未处理项，失效历史仍保留', async t => {
  const f = await setup(t, 'review-restore-version'); const old = f.ws.project.proposals[0];
  const d = f.ws.documents.find(d => d.chapter === 1); await f.ws.saveDocument({ documentId: d.id, expectedHash: d.hash, text: chapterText + '\n临时改稿。\n' });
  assert.equal(f.ws.project.proposals.find(q => q.id === old.id).status, 'obsolete');
  const changed = f.ws.documents.find(d => d.chapter === 1); await f.ws.saveDocument({ documentId: d.id, expectedHash: changed.hash, text: chapterText });
  const restored = f.ws.project.proposals.find(q => q.id === old.id); assert.equal(restored.status, 'pending'); assert.equal(restored.statusHistory.length, 2);
  assert.equal(f.ws.project.jobs.find(j => j.id === f.first.job.id).versionState, 'current');
});
