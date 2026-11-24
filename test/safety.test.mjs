import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { FileStore, hash } from '../core/io.mjs';
import { fixture } from './helpers.mjs';
import { integrity, runGate, findPython } from '../core/gate.mjs';
import { splitSource, buildPrompt, endpointFor, validateExtraction } from '../core/analysis.mjs';
import { chapterNumber } from '../core/catalog.mjs';

test('路径穿越、绝对路径与受保护目录被拒绝', async t => {
  const f = await fixture('paths'); t.after(f.close);
  for (const p of ['../outside.md', 'C:/Windows/file.md', '.git/config', '资料/../../other.md']) await assert.rejects(f.workspace.store.resolve(p), e => e.code === 'PATH');
});
test('多文件写入中断自动恢复；第三版本保留且阻止覆盖', async t => {
  const f = await fixture('recover'); const store = f.workspace.store; t.after(f.close);
  await f.write('资料/甲.md', '原甲'); await f.write('资料/乙.md', '原乙');
  const changes = [{ path: '资料/甲.md', expectedHash: hash('原甲'), text: '新甲' }, { path: '资料/乙.md', expectedHash: hash('原乙'), text: '新乙' }];
  await assert.rejects(store.batch('模拟中断', changes, { afterWrite: i => { if (i === 0) throw new Error('断电模拟'); } }), e => e.code === 'RECOVERY_REQUIRED');
  await f.write('资料/甲.md', '外部第三版'); const conflicts = await store.recover(); assert.equal(conflicts.length, 1); assert.equal(await f.read('资料/甲.md'), '外部第三版'); assert.equal(await f.read('资料/乙.md'), '原乙');
  await f.write('资料/甲.md', '新甲'); assert.equal((await store.recover()).length, 0); assert.equal(await f.read('资料/乙.md'), '新乙');
});
test('损坏的恢复快照不会覆盖当前文件',async t=>{
  const f=await fixture('damaged-snapshot');t.after(f.close);const s=f.workspace.store;
  await f.write('资料/原件.md','原件');const record=await s.batch('保存测试',[{path:'资料/原件.md',expectedHash:hash('原件'),text:'修改件'}]);
  await f.write(`_创作管理/历史/${record.id}/0.before`,'损坏内容');
  await assert.rejects(s.restore(record.id),e=>e.code==='DAMAGED_SNAPSHOT');assert.equal(await f.read('资料/原件.md'),'修改件');
});
test('数据完整性四检优先，续接参数缺失不能假绿', async t => {
  assert.ok(integrity('他说"好"。', 'chinese').includes('存在ASCII直引号')); assert.ok(integrity('&#x4FE1;').length); assert.ok(integrity('“未闭合', 'chinese').length); assert.ok(integrity('”方向反了“', 'chinese').length);
  assert.equal(integrity('阿青说：“去渡口。”').length, 0);
  const f = await fixture('gate'); t.after(f.close); const d = f.workspace.documents.find(d => d.chapter === 1);
  const r = await runGate(f.workspace.store, d, { enabled: true, script: '_tools/不存在.py' }, { continuation: true }); assert.equal(r.status, 'incomplete');
  const missing = await runGate(f.workspace.store, d, { enabled: true, script: '_tools/不存在.py' }); assert.equal(missing.status, 'incomplete');
});
test('真实Python子进程：独立场允许无承接，空成功输出不能假绿',async t=>{
  const python=await findPython();if(!python){t.skip('本机无可用Python');return;}
  const f=await fixture('python-gate');t.after(f.close);const d=f.workspace.documents.find(d=>d.chapter===1);
  await f.write('_tools/gate.py','print("硬线全过 —— 但【承接对账未执行】。")\n');
  const independent=await runGate(f.workspace.store,d,{enabled:true,script:'_tools/gate.py',python});assert.equal(independent.status,'passed');
  await f.write('_tools/gate.py','print("success")\n');
  const empty=await runGate(f.workspace.store,d,{enabled:true,script:'_tools/gate.py',python});assert.equal(empty.status,'incomplete');
});
test('公开版接受直引号，作品启用中文引号检查后须重新检查', async t => {
  const f = await fixture('public-quotation-style', { externalGate: false });
  t.after(f.close);
  const work = f.workspace;
  const draft = await work.createChapterDraft({
    chapter: 12, title: '收音', importedText: '# 收音\n\n她问："Can you hear me?"',
  });
  const check = await work.checksFor({ documentId: draft.id });
  assert.equal(check.status, 'not_required');
  const review = await work.checkManuscript({ documentId: draft.id, sourceHash: draft.hash, useAI: false });
  assert.deepEqual(review.issues, []);

  await f.write('00-项目导航/稿件核对.json', JSON.stringify({ quotationStyle: 'chinese' }));
  await assert.rejects(work.confirmRevision({ documentId: draft.id, sourceHash: draft.hash }), { code: 'NEEDS_GATE' });
  const strictReview = await work.checkManuscript({ documentId: draft.id, sourceHash: draft.hash, useAI: false });
  assert.equal(strictReview.gate.status, 'failed');
  assert.ok(strictReview.issues.some(issue => issue.message === 'ASCII 直引号'));
});
test('段落分批无丢字；中文章号、短词与输入上限', () => {
  const source = '段落正文。\n\n'.repeat(4000); const chunks = splitSource(source); assert.equal(chunks.map(c => c.text).join(''), source); assert.ok(chunks.every(c => c.text.length <= 9500));
  assert.equal(chapterNumber('第十七章_明日'), 17); assert.equal(chapterNumber('第一百零二章'), 102);
  assert.throws(() => buildPrompt('字'.repeat(22000), [], []), e => e.code === 'INPUT_LIMIT');
  assert.throws(() => endpointFor('http://remote.example/v1'), e => e.code === 'AI_CONFIG');
  assert.equal(endpointFor('http://127.0.0.1:1234/v1'), 'http://127.0.0.1:1234/v1/chat/completions');
});
test('代词、误判、练成阶段和新身份不能凭模型置信度自动入档', () => {
  const text = '阿青把功法册给了沈舟。她以为自己练成了。沈舟开始试练。';
  const snapshot = { document: { id:'d',hash:'h',chapter:1 }, text, characters:[{id:'a',name:'阿青',aliases:[],status:'registered'},{id:'b',name:'沈舟',aliases:[],status:'registered'}], locks:[] };
  const result = validateExtraction([{title:'试练',facts:[{entity_id:'a',field:'skill',value:{skillName:'听潮诀',stage:'练成某层'},layer:'occurred',certainty:'explicit',evidence:'她以为自己练成了。'},{entity_id:'b',field:'skill',value:{skillName:'听潮诀',stage:'练成某层'},layer:'occurred',certainty:'explicit',evidence:'沈舟开始试练。'}]}],snapshot);
  assert.ok(result[0].facts.every(f=>f.status==='pending'));
});
