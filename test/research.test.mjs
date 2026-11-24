import assert from 'node:assert/strict';
import test from 'node:test';
import { Workspace } from '../core/workspace.mjs';
import { hash } from '../core/io.mjs';
import { RESEARCH_MCP_URL, searchResearchWeb } from '../core/research-search.mjs';
import { findWritingSetting } from '../core/world-context.mjs';
import { fixture } from './helpers.mjs';

const citationUrl = 'https://archives.example.org/dunhuang/catalogue';
const title = '西门过所';
const adoptedText = '城外西渡须由掌关人验印，识印人不得替外客担保。';

function searchResponse() {
  const text = [
    `Title: 敦煌文书公开集录\nURL: ${citationUrl}\nPublished: 2020-08-28\nHighlights:\n记录有关关津文书的线索。`,
    `Title: 重复\nURL: ${citationUrl}\nHighlights:\n重复摘录。`,
    'Title: 非公共链接\nURL: https://127.0.0.1/private\nHighlights:\n应过滤。',
  ].join('\n\n');
  const packet = { jsonrpc: '2.0', id: 1, result: { content: [{ type: 'text', text }] } };
  return new Response(`event: message\ndata: ${JSON.stringify(packet)}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
}

test('web research extracts real attributed results, filters unsafe URLs and reports provider limits', async () => {
  const reply = await searchResearchWeb('  唐代敦煌关津文书  ', async (url, options) => {
    assert.equal(url, RESEARCH_MCP_URL);
    const request = JSON.parse(options.body);
    assert.equal(request.method, 'tools/call');
    assert.equal(request.params.name, 'web_search_exa');
    assert.equal(request.params.arguments.query, '唐代敦煌关津文书');
    assert.equal(options.headers.authorization, undefined);
    return searchResponse();
  });
  assert.equal(reply.results.length, 1);
  assert.equal(reply.results[0].url, citationUrl);
  assert.equal(reply.results[0].published, '2020-08-28');
  assert.match(reply.results[0].excerpt, /关津文书/);
  await assert.rejects(searchResearchWeb('唐代过所', async () => new Response('', { status: 429 })), { code: 'RESEARCH_LIMIT' });
  let attempts = 0;
  const recovered = await searchResearchWeb('唐代过所', async () => ++attempts === 1 ? new Response('', { status: 503 }) : searchResponse());
  assert.equal(recovered.results.length, 1);
  assert.equal(attempts, 2);
  await assert.rejects(searchResearchWeb('唐代过所', async () => new Response('<p>unexpected</p>')), { code: 'RESEARCH_FORMAT' });
});

test('only an explicitly adopted candidate enters versioned Markdown and scoped writing context', async t => {
  const f = await fixture('research-roundtrip', { fetcher: async () => searchResponse() });
  const a = await fixture('research-other');
  t.after(() => a.close());
  let ws = f.workspace;
  t.after(() => ws.close());
  const { results } = await ws.searchResearch({ query: '唐代关津' });
  await assert.rejects(a.workspace.createResearchCandidate({ sourceIds: [results[0].id] }), { code: 'CONFLICT' });
  const candidate = await ws.createResearchCandidate({ sourceIds: [results[0].id] });
  const edits = { title, body: adoptedText, category: '城防与关津', nature: 'fiction', fromChapter: 3, toChapter: 4 };
  const args = { documentId: 'outline_chapter_3', message: '讨论西门过所。' };
  const pending = await ws.saveResearchCandidate({ id: candidate.id, expectedHash: candidate.hash, fields: edits });
  const before = await ws.getWritingContext(args);
  assert.equal(before.sections.some(row => row.kind === 'research'), false);
  assert.equal(ws.project.approvals.length, 0);
  await assert.rejects(ws.saveResearchCandidate({ id: pending.id, expectedHash: candidate.hash, action: 'adopt', confirmed: true }), { code: 'CONFLICT' });
  await assert.rejects(ws.saveResearchCandidate({ id: pending.id, expectedHash: pending.hash, action: 'adopt' }), { code: 'VALIDATION' });
  const accepted = await ws.saveResearchCandidate({ id: pending.id, expectedHash: pending.hash, action: 'adopt', confirmed: true });
  const doc = ws.doc(accepted.documentId);
  const file = await f.read(doc.path);
  assert.ok(file.includes(adoptedText));
  assert.ok(file.includes(citationUrl));
  assert.equal(doc.kind, 'setting');
  assert.equal(ws.project.approvals.find(row => row.id === accepted.approvalId).sourceHash, hash(Buffer.from(file)));
  const approved = await ws.getWritingContext(args);
  const section = approved.sections.find(row => row.kind === 'research');
  assert.equal(section.documentId, accepted.documentId);
  assert.match(section.status, /作者已确认 · 架空设定/);
  assert.ok(section.excerpt.includes(adoptedText) && section.excerpt.includes(citationUrl));
  assert.notEqual(approved.signature, before.signature);
  for (const chapter of [2, 5]) {
    const ctx = await ws.getWritingContext({ ...args, documentId: `outline_chapter_${chapter}` });
    assert.equal(ctx.sections.some(row => row.kind === 'research'), false);
  }
  await assert.rejects(ws.saveResearchCandidate({ id: pending.id, expectedHash: pending.hash, action: 'adopt', confirmed: true }), { code: 'CONFLICT' });
  await ws.close();
  ws = new Workspace(f.root);
  await ws.init();
  assert.equal((await ws.getResearchCandidate({ id: pending.id })).documentId, doc.id);
  assert.equal((await ws.getWritingContext(args)).sections.find(row => row.kind === 'research').documentId, doc.id);
  const latest = file.replace('验印', '验照');
  await f.write(doc.path, latest);
  assert.equal((await ws.getWritingContext(args)).sections.some(row => row.kind === 'research'), false, 'checks disk before background refresh');
  await ws.refresh();
  assert.equal((await findWritingSetting(ws, title, path => f.read(path), 3)).matches.length, 0, 'stale research cannot be fetched by name');
  await ws.updateSettingMeta({ documentId: doc.id, expectedHash: ws.doc(doc.id).hash, category: '城防与关津',
    nature: 'fiction', scope: '第3–4章', confirmed: true });
  assert.match((await ws.getWritingContext(args)).sections.find(row => row.kind === 'research').excerpt, /验照/);
  assert.equal((await ws.getWritingContext({ documentId: 'outline_chapter_2', message: '讨论西门过所。' })).sections
    .some(row => row.kind === 'research'), false);
});
