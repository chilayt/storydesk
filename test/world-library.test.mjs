import assert from 'node:assert/strict';
import test from 'node:test';
import { hash } from '../core/io.mjs';
import { findWritingSetting, worldContextVersion } from '../core/world-context.mjs';
import { fixture } from './helpers.mjs';

test('已分档的世界资料完整入库，待核对资料可归类且文档ID不变', async t => {
  const f = await fixture('world-library');
  const w = f.workspace;
  t.after(() => f.close());
  w.project.sourceProfiles = ['novel-kb-v1'];
  const setting = '# 官制\n\n## 朝廷\n任官规则。\n\n## 地方\n设城守。\n';
  await f.write('novel-kb/05-设定/官制.md', setting);
  await f.write('novel-kb/05-设定/文风设定.md', '# 文风设定\n\n待作者采用的参考。\n');
  await f.write('novel-kb/01-实体/地点/L011-铜渡.md', '---\n名称: 铜渡\n别名: [旧渡, 铜湾]\n---\n\n# 铜渡\n\n老码头。\n');
  await f.write('novel-kb/01-实体/功法武学/K003-听潮术.md', '# 听潮术\n\n只用于听声。\n');
  await f.write('novel-kb/01-实体/丹药毒物/D101-铜铃汤.md', '# 铜铃汤\n\n用于估验泉水。\n');
  await f.write('novel-kb/07-时间/年表.md', '# 年表\n\n三年初建铜渡。\n');
  const family = '黎族的家谱材料，版本待辨。';
  await f.write('_已解析/许氏家族档案.txt', family);
  await f.write('novel-kb/_待确认-旧设定/旧官制.md', '# 旧官制\n\n已留作参考。\n');
  const preview = await w.previewLibrary({});
  assert.equal(preview.total, 7);
  assert.equal(preview.items.filter(row => row.pending).length, 1);
  assert.equal(preview.collisions.length, 0);
  await w.buildIndependentLibrary({ token: preview.token });
  assert.equal((await w.previewLibrary({})).total, 0);
  assert.equal(await f.read('创作资料库/设定/官制.md'), setting);
  assert.equal(await f.read('novel-kb/05-设定/官制.md'), setting);
  assert.ok(w.documents.some(d => d.kind === 'setting' && d.path === '创作资料库/设定/武学功法/听潮术.md'));
  assert.ok(w.documents.some(d => d.kind === 'item' && d.title === '铜铃汤'));
  assert.ok(w.documents.some(d => d.kind === 'rule' && d.title === '文风设定'));
  assert.ok(!w.documents.some(d => d.title === '旧官制'));
  const candidate = w.documents.find(d => d.kind === 'reference' && d.title === '许氏家族档案');
  assert.ok(candidate);
  await assert.rejects(w.classifyLibraryDocument({ documentId: candidate.id, expectedHash: 'stale-hash', kind: 'family' }), { code: 'CONFLICT' });
  const classified = await w.classifyLibraryDocument({ documentId: candidate.id, expectedHash: candidate.hash, kind: 'family' });
  assert.equal(classified.id, candidate.id);
  assert.equal(classified.path, '创作资料库/家族/许氏家族档案.md');
  assert.equal(classified.hash, candidate.hash);
  assert.equal(await w.store.read(candidate.path), null);
  assert.equal(w.project.libraryOriginals['_已解析/许氏家族档案.txt'][0].path, classified.path);
  assert.equal(await f.read('_已解析/许氏家族档案.txt'), family);
  assert.equal(w.project.approvals.length, 0);
});

test('共写按别名查现行设定、地点资料和作者记录，地图只提供关联名', async t => {
  const f = await fixture('world-context');
  const w = f.workspace;
  t.after(() => f.close());
  await f.write('04-空间/码头.md', '---\n名称: 铜渡\n别名: [旧渡, 铜湾]\n---\n\n# 铜渡\n\n有一座朝西的石桥。\n');
  await f.write('附件/铜渡地图.pdf', '%PDF-1.0 测试占位内容');
  await w.refresh();
  const place = w.documents.find(d => d.kind === 'location');
  assert.deepEqual(place.aliases, ['旧渡', '铜湾']);
  const lookup = (query, chapter) => findWritingSetting(w, query, async (file, expected) => {
    const bytes = await w.store.read(file);
    return bytes && hash(bytes) === expected ? bytes.toString('utf8') : null;
  }, chapter);
  assert.equal((await lookup('旧渡')).matches[0].status, '待核对原档');
  const priorContext = worldContextVersion(w);
  await w.updateSettingMeta({ documentId: place.id, expectedHash: place.hash, category: '地理与空间',
    nature: 'fiction', scope: '铜渡西段', summary: '石桥朝西。', confirmed: true });
  assert.notDeepEqual(worldContextVersion(w), priorContext);
  const current = (await lookup('铜湾')).matches[0];
  assert.equal(current.status, '作者已确认');
  assert.equal(current.scope, '铜渡西段');
  assert.equal(current.authorNote, '石桥朝西。');
  assert.match(current.excerpt, /石桥/);

  const map = await w.registerLocationMap({ relativePath: '附件/铜渡地图.pdf' });
  assert.deepEqual(await w.registerLocationMap({ relativePath: '附件/铜渡地图.pdf' }), map);
  assert.equal(w.doc(map.documentId).kind, 'attachment');
  assert.equal(w.doc(map.documentId).readOnly, true);
  await w.saveRecord({ kind: 'location', title: '铜渡岸线', status: 'active', body: '渡船在北岸靠泊。',
    details: { aliases: '铜渡河岸', attachmentDocIds: [map.documentId], sourceDocIds: [place.id] } });
  const record = (await lookup('铜渡河岸')).matches[0];
  assert.equal(record.title, '铜渡岸线');
  assert.deepEqual(record.maps, ['铜渡地图']);
  assert.doesNotMatch(JSON.stringify(record), /%PDF|测试占位内容/);
  const latestPlace = w.doc(place.id);
  await w.saveDocument({ documentId: place.id, expectedHash: latestPlace.hash, text: latestPlace.text.replace('朝西的石桥', '朝东的石桥') });
  const changed = (await lookup('旧渡')).matches[0];
  assert.equal(changed.status, '待核对原档');
  assert.equal(changed.authorNote, undefined);

  const a = w.project.characters.find(c => c.name === '阿青');
  const b = w.project.characters.find(c => c.name === '沈舟');
  await w.saveRecord({ kind: 'organization', title: '铜渡船行', status: 'active', body: '渡口负责水运的船行。',
    details: { members: [{ characterId: a.id, role: '船工', fromChapter: 1 }, { characterId: b.id, role: '领队', fromChapter: 5 }] } });
  const team = (await lookup('铜渡船行', 3)).matches[0];
  assert.deepEqual(team.members, [{ name: '阿青', role: '船工' }]);
});
