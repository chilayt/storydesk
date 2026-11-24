import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fixture, modelFetch, configure, confirmFirst, waitJob, chapterText } from './helpers.mjs';
import { Workspace } from '../core/workspace.mjs';
import { hash } from '../core/io.mjs';

test('导入区分文件、确认、草稿和群像候选；不修改源资料', async t => {
  const f = await fixture('import'); t.after(f.close);
  assert.equal(f.workspace.summary().stats.chapters, 2);
  assert.equal(f.workspace.summary().stats.confirmed, 0);
  assert.equal(f.workspace.project.characters.find(c => c.name === '陆迟').status, 'candidate');
  assert.equal(await f.read('05-剧本/正文/第01章_渡口.md'), chapterText);
  assert.equal(f.workspace.project.characters.filter(c => c.status === 'registered').length, 2);
  assert.equal(f.workspace.index.search(f.workspace.project.id, '阿青').length > 0, true);
});
test('保存保留BOM、CRLF和历史；拒绝覆盖外部修改', async t => {
  const f = await fixture('save'); t.after(f.close);
  const d = f.workspace.documents.find(d => d.chapter === 1);
  await f.write(d.path, '\uFEFF' + chapterText.replaceAll('\n', '\r\n'));
  await f.workspace.refresh(); const opened = await f.workspace.readDocument(d.id);
  const result = await f.workspace.saveDocument({ documentId: d.id, expectedHash: opened.hash, text: opened.text + '\n补记。\n' });
  const bytes = await fs.readFile(path.join(f.root, d.path));
  assert.deepEqual([...bytes.subarray(0, 3)], [239, 187, 191]);
  assert.equal(bytes.toString('utf8').includes('\r\n补记。\r\n'), true);
  await f.write(d.path, '外部人工修改，不得覆盖。');
  await assert.rejects(f.workspace.saveDocument({ documentId: d.id, expectedHash: result.document.hash, text: '旧编辑器的文本' }), e => e.code === 'CONFLICT');
  assert.equal(await f.read(d.path), '外部人工修改，不得覆盖。');
});
test('人工确认基座与动态变化分开；重启后仍从人物原档恢复', async t => {
  const f = await fixture('baseline'); let ws = f.workspace; t.after(async () => ws.close());
  const c = ws.project.characters.find(c => c.name === '阿青'); const d = ws.doc(c.primarySourceId);
  await ws.approveBaseline({ characterId: c.id, expectedSourceHash: d.hash, fields: [{ field: '初始居处', value: '南村' }], appliesAt: '第一章开始前' });
  const original = await f.read(d.path); assert.ok(original.includes('## 三、剧情进展')); assert.ok(original.includes('已确认初始基座'));
  await ws.close(); ws = new Workspace(f.root); await ws.init();
  const detail = await ws.getCharacter(c.id); assert.equal(detail.baseline.fields[0].value, '南村'); assert.equal(detail.baseline.appliesAt, '第一章开始前');
});
test('确认与模拟模型归档：关系、道具、试练落盘；未来与基座待审', async t => {
  const f = await fixture('analysis', { fetcher: modelFetch() }); t.after(f.close); const ws = f.workspace;
  await configure(ws); const { job } = await confirmFirst(ws); const finished = await waitJob(ws, job.id);
  assert.equal(finished.status, 'partial', finished.error); assert.equal(finished.applied, 3); assert.equal(finished.pending, 2);
  const aq = ws.project.characters.find(c => c.name === '阿青'), sz = ws.project.characters.find(c => c.name === '沈舟');
  const a = await ws.getCharacter(aq.id), s = await ws.getCharacter(sz.id);
  assert.equal(a.current.location, undefined); assert.equal(s.skills[0].value.stage, '开始修习'); assert.equal(ws.relationships().length, 1);
  assert.equal((await f.read('01-人物/人物分档/沈舟.md')).includes('程序归档'), true);
  assert.equal((await f.read('05-剧本/剧情推进.md')).includes('事件索引'), true);
  assert.equal((await f.read(`_创作管理/人物进展/${sz.id}.md`)).includes('开始修习'), true);
  const again = await confirmFirst(ws); assert.equal(again.job.id, job.id); assert.equal(ws.events.length, 1);
});
test('计划定案不会污染当前状态；未知人物保留为待审', async t => {
  const f = await fixture('plan', { fetcher: modelFetch(({ aq }) => [{ title: '计划去北城', facts: [{ entity_id: aq.id, field: 'location', value: '北城', layer: 'occurred', certainty: 'explicit', evidence: '阿青说：“明日去北城。”' }, { entity_id: 'name:陌客', field: 'identity', value: '行商', layer: 'occurred', certainty: 'explicit', evidence: '阿青在渡口遇见沈舟。' }] }]) }); t.after(f.close); const ws = f.workspace;
  await configure(ws); const d = ws.documents.find(d => d.chapter === 1); const { job } = await ws.confirmRevision({ documentId: d.id, sourceHash: d.hash, kind: 'plan' });
  const finished = await waitJob(ws, job.id); assert.notEqual(finished.status, 'failed', finished.error);
  const aq = ws.project.characters.find(c => c.name === '阿青'); assert.equal((await ws.getCharacter(aq.id)).current.location, undefined);
  assert.equal(ws.project.proposals.some(p => p.fact.entity_id === 'name:陌客'), true);
});
test('伪造证据转待核对，不能进入人物正式状态', async t => {
  const f = await fixture('evidence', { fetcher: modelFetch(({ aq }) => [{ title: '不存在的事', facts: [{ entity_id: aq.id, field: 'location', value: '山顶', layer: 'occurred', certainty: 'explicit', evidence: '阿青已经登上山顶。' }] }]) }); t.after(f.close); const ws = f.workspace;
  await configure(ws); const { job } = await confirmFirst(ws); const finished = await waitJob(ws, job.id);
  assert.equal(finished.status, 'partial'); assert.equal(ws.visibleFacts().length,0);assert.equal(ws.project.proposals.length,1);assert.equal(ws.project.proposals[0].fact.evidence,'');assert.ok(ws.project.proposals[0].fact.review_reasons.some(r=>r.includes('定位')));
});
test('人工保护不会被新剧情自动覆盖', async t => {
  const f = await fixture('lock', { fetcher: modelFetch() }); t.after(f.close); const ws = f.workspace;
  const sz = ws.project.characters.find(c => c.name === '沈舟'); await ws.setLock({ entityId: sz.id, field: 'skill', active: true });
  await configure(ws); const { job } = await confirmFirst(ws); await waitJob(ws, job.id);
  assert.equal((await ws.getCharacter(sz.id)).skills.length, 0);
  assert.ok(ws.project.proposals.find(p => p.fact.field === 'skill').fact.review_reasons.includes('字段受到人工保护'));
});
test('人工修改仅最新状态不泄漏到旧章；按章保留关系方向', async t => {
  const f = await fixture('horizon'); t.after(f.close); const ws = f.workspace;
  const aq = ws.project.characters.find(c => c.name === '阿青');
  await ws.updateField({ entityId: aq.id, field: 'location', value: '北城', chapter: 2, expectedRevision: aq.revision });
  assert.equal((await ws.getCharacter(aq.id, 1)).current.location, undefined);
  assert.equal((await ws.getCharacter(aq.id, 2)).current.location.value, '北城');
  await ws.updateField({ entityId: aq.id, field: 'location', value: '东城', chapter: null });
  assert.equal((await ws.getCharacter(aq.id)).current.location.value, '东城');
  assert.equal((await ws.getCharacter(aq.id, 2)).current.location.value, '北城');
});
test('撤销批次保留不相关设置，不受索引元数据更新影响', async t => {
  const f = await fixture('undo'); t.after(f.close); const ws = f.workspace; const d = ws.documents.find(d => d.chapter === 1);
  await ws.saveDocument({ documentId: d.id, expectedHash: d.hash, text: chapterText + '\n作者补记。\n' });
  const saved = (await ws.store.history()).find(h => h.label === '保存文档');
  await ws.rememberReader({ documentId: d.id, fontSize: 23, offset: 100, theme: 'paper' });
  await ws.undoBatch(saved.id); assert.equal(await f.read(d.path), chapterText); assert.equal(ws.project.reader.fontSize, 23);
  const current = await ws.readDocument(d.id); await ws.saveDocument({ documentId: d.id, expectedHash: current.hash, text: chapterText + '\n新修改。\n' });
  const latest = (await ws.store.history()).find(h => h.label === '保存文档');
  await f.write(d.path, '后来的人工稿。');
  await assert.rejects(ws.undoBatch(latest.id), e => e.code === 'CONFLICT'); assert.equal(await f.read(d.path), '后来的人工稿。');
});
test('删除缓存后可重建；作品数据隔离', async t => {
  const a = await fixture('isolation-a'), b = await fixture('isolation-b'); let ws = a.workspace;
  t.after(async () => { await ws.close(); await b.close(); });
  assert.notEqual(a.workspace.project.id, b.workspace.project.id);
  assert.equal(a.workspace.index.search(b.workspace.project.id, '阿青').length, 0);
  const ids = a.workspace.project.characters.map(c => c.id); await ws.close();
  await fs.unlink(path.join(a.root, '_创作管理/缓存/index.sqlite'));
  ws = new Workspace(a.root); await ws.init(); assert.deepEqual(ws.project.characters.map(c => c.id), ids); assert.ok(ws.index.search(ws.project.id, '沈舟').length);
});
