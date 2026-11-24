import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { listModels, requestStructured } from '../core/analysis.mjs';
import { connectionBase, GO_BASE, GO_CATALOG } from '../core/model-connections.mjs';
import { fixture } from './helpers.mjs';

test('OpenCode uses the Go catalog and lists text models covered by the subscription', async () => {
  assert.equal(connectionBase('https://opencode.ai/zen/go/v1'), GO_BASE);
  assert.equal(connectionBase('https://opencode.ai/zen/v1'), 'https://opencode.ai/zen/v1');
  assert.throws(() => connectionBase('http://127.0.0.1:3425/v1'), { code: 'AI_CONFIG' });
  const reply = await listModels({ baseUrl: GO_BASE }, 'fixture-key', async (url, request) => {
    assert.equal(url, GO_CATALOG);
    assert.equal(request.method, 'GET');
    assert.equal(request.headers.Authorization, 'Bearer fixture-key');
    return Response.json({ data: [
      { id: 'covered', modalities: { output: ['text'] }, go: { monthly_usage: { 'go-plus': 60 } } },
      { id: 'free', modalities: { output: ['text'] }, go: { monthly_usage: null } },
      { id: 'image-only', modalities: { output: ['image/png'] }, go: { monthly_usage: { go: 20 } } },
    ] });
  });
  assert.deepEqual(reply.models, ['covered']);
  await assert.rejects(requestStructured({ baseUrl: GO_BASE, model: 'covered' }, 'fixture-key', [], {
    fetcher: async () => Response.json({ choices: [{ message: { content: '{}' } }], usage: { opencode: { billing_source: 'balance' } } }),
  }), { code: 'AI_BILLING' });
});

test('an existing library adds read-only sources once and keeps its identity, approvals and Go model', async t => {
  const f = await fixture('existing-library');
  const original = f.workspace.summary();
  f.workspace.project.settings.ai = { ...f.workspace.project.settings.ai, enabled: true,
    baseUrl: 'https://opencode.ai/zen/go/v1', model: 'fixture-go' };
  await f.workspace.persist();
  await f.close();
  await f.write('novel-kb/00-索引/README.md', '# 资料索引\n');
  const chapterPath = '_已解析/章节201-300/第二百六十四章 见面.md';
  const chapterText = '# 第二百六十四章 见面\n\n阿明来到桥边。\n';
  await f.write(chapterPath, chapterText);
  await f.write('novel-kb/01-实体/人物/P001-阿明.md', '---\nid: P001\n---\n# 阿明\n');
  await f.write('novel-kb/01-实体/人物/_模板-人物卡.md', '# 样例\n');
  await f.write('novel-kb/03-剧情/第一卷大纲.md', '# 第一卷大纲\n');
  const localPresets = [{ id: 'Gemma4', model: 'gemma4-vain-26b', baseUrl: 'http://127.0.0.1:8090/v1', available: true }];
  const ws = new Workspace(f.root, { localPresets });
  t.after(() => ws.close());
  const work = await ws.init();
  assert.equal(work.id, original.id);
  assert.equal(work.settings.ai.baseUrl, GO_BASE);
  assert.equal(work.settings.ai.model, 'fixture-go');
  assert.equal(work.writingModel.model, 'gemma4-vain-26b');
  assert.ok(original.documents.every(doc => work.documents.some(d => d.id === doc.id)));
  assert.deepEqual(work.approvals, original.approvals);
  assert.ok(work.characters.some(c => c.name === '阿明'));
  assert.ok(!work.characters.some(c => c.name === '样例'));
  const chapter = work.documents.find(d => d.path === chapterPath);
  assert.equal(chapter.chapter, 264);
  assert.equal(chapter.readOnly, true);
  assert.ok(work.documents.some(d => d.kind === 'plan' && d.title === '第一卷大纲'));
  assert.equal((await ws.readDocument(chapter.id)).text, chapterText);
  await assert.rejects(ws.saveDocument({ documentId: chapter.id, expectedHash: chapter.hash, text: '覆盖' }), { code: 'READ_ONLY' });
  assert.equal(await f.read(chapterPath), chapterText);
  const sourceCount = work.sources.length;
  await ws.close();
  const reopened = new Workspace(f.root, { localPresets });
  t.after(() => reopened.close());
  const again = await reopened.init();
  assert.equal(again.sources.length, sourceCount);
  assert.equal(again.documents.find(d => d.path === chapterPath).id, chapter.id);
});
