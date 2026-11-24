import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import { hash } from '../core/io.mjs';
import { LOCATION_MAP_INDEX } from '../core/location-maps.mjs';
import { manifestIsStale } from '../core/writing-manifest.mjs';
import { findWritingSetting } from '../core/world-context.mjs';
import { configure, fixture } from './helpers.mjs';
import { mapConfig, seedLocationMaps } from './location-map-fixture.mjs';

const openReply = (message, reason) => Response.json({
  id: 'location-reply', model: 'fixture-model', choices: [{ message: { role: 'assistant', ...message }, finish_reason: reason }],
  usage: { prompt_tokens: 200, completion_tokens: 20, total_tokens: 220 }
});

test('new chapter uses its work map index in the actual Pi tool loop and the writing evidence view', async t => {
  const seen = [];
  const f = await fixture('location-writing', { fetcher: async (_url, request) => {
    const input = JSON.parse(request.body);
    seen.push(input);
    const lookup = input.messages.find(message => message.role === 'tool');
    if (!lookup) return openReply({ content: null, tool_calls: [{ id: 'call_place', type: 'function',
      function: { name: 'find_setting', arguments: JSON.stringify({ query: '白沙西门到西田庄' }) } }] }, 'tool_calls');
    assert.match(lookup.content, /从西门出城/u);
    assert.match(lookup.content, /向西十里到庄门/u);
    assert.match(lookup.content, /城图\.html/u);
    return openReply({ content: '可以沿城门与田庄的现行资料讨论这段行程。' }, 'stop');
  } });
  const ws = f.workspace;
  t.after(f.close);
  await seedLocationMaps(f);
  await ws.refresh();
  await configure(ws);
  const documentId = 'outline_chapter_3';
  const view = await ws.getCowriting({ documentId });
  const words = '新章想讨论从方宅去西田庄。';
  const prepared = await ws.getWritingContext({ documentId, message: words });
  assert.equal(prepared.sections.filter(section => section.kind === 'map').length, 2);
  assert.ok(prepared.sections.some(section => section.kind === 'location' && /经中堂进寝门/.test(section.excerpt)));
  const run = await ws.sendCowriting({ documentId, sourceHash: view.sourceHash, message: words, mode: 'discuss' });
  assert.equal(run.status, 'completed', run.error);
  assert.equal(seen.length, 2);
  const initial = JSON.stringify(seen[0].messages.find(message => message.role === 'user').content);
  assert.match(initial, /locationContext/u);
  assert.match(initial, /从前院经中堂进寝门/u);
  assert.doesNotMatch(JSON.stringify(seen), /MAP_BYTES_MUST_STAY_LOCAL|早版采用不同走法|未选择的旧地物说明/u);
  assert.equal(run.manifest.sections.filter(section => section.kind === 'map').length, 3);
  assert.ok(run.manifest.sections.some(section => section.kind === 'map' && section.path === mapConfig.places[0].map.path && section.documentId));

});

test('current map paths are isolated per work and never select an older attachment when the selected map is missing', async t => {
  const f = await fixture('location-current-map');
  t.after(f.close);
  const other = await fixture('location-other-work');
  t.after(other.close);
  await seedLocationMaps(f);
  const place = mapConfig.places[1];
  await f.write('04-空间/宅图旧版.html', '<title>另一个地图版本</title>');
  const ws = f.workspace;
  await ws.refresh();
  const map = ws.summary().locationMaps.find(row => row.id === place.id).map;
  assert.equal(await ws.registeredSourcePath(map.documentId), path.join(f.root, place.map.path));
  assert.equal(other.workspace.summary().locationMaps.length, 0);
  const doc = ws.documents.find(d => d.chapter === 2);
  const context = await ws.getWritingContext({ documentId: doc.id, message: '在方宅讨论走位。' });
  assert.equal(await manifestIsStale(ws, context), false);
  await fs.unlink(path.join(f.root, place.map.path));
  await ws.refresh();
  assert.equal(ws.summary().locationMaps.find(row => row.id === place.id).map.documentId, null);
  assert.equal(await manifestIsStale(ws, context), true);
  const lookup = async term => findWritingSetting(ws, term, async (file, expected) => {
    const bytes = await ws.store.read(file);
    return bytes && hash(bytes) === expected ? bytes.toString('utf8') : null;
  }, 2);
  const missing = (await lookup('方宅')).matches[0];
  assert.equal(missing.map.available, false);
  assert.equal(missing.map.path, place.map.path);
  assert.ok(missing.settings[0].excerpt.includes('寝门'));
  assert.ok(!(await lookup('方宅旧规制')).matches.some(row => row.path === mapConfig.historicalPaths[0]));
  await f.write(LOCATION_MAP_INDEX, '{"version":1,"places":[{"id":"invalid","name":"跨目录","map":{"path":"../其他.html"}}]}');
  await ws.refresh();
  assert.match(ws.summary().locationMapIssue, /地点地图清单待核对/u);
  assert.equal(ws.summary().locationMaps.length, 0);
});
