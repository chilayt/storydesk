// Reading indexes describe what the current text contains; they never approve a chapter or establish canon.
const ACTION = /(?:正|便|却|已|又|才|忽|仍|也|遂|缓缓|轻轻|随即|一边)?(?:说|说道|问|答|笑|道[：:，]|抬|低|看|望|走|到|来|离开|坐|站|立|伸|接|推|拉|转|点头|摇头|垂|睁|闭|起身|跨|停|提|捧|扶|抱|穿|披|端|跪|躺|靠|俯|皱|拢|挽|听|翻|侧|掀|将|把|从|在|正坐|正站)/;
export function indexAppearances(documents, character, cutoff = null, confirmed = []) {
  const names = [character.name, ...(character.aliases || [])].filter(Boolean).sort((a, b) => b.length - a.length);
  const found = [];
  for (const d of documents.filter(d => d.kind === 'chapter' && !d.error && (cutoff === null || d.chapter <= cutoff)).sort((a, b) => a.chapter - b.chapter)) {
    const manual = confirmed.filter(f => f.source_document_id === d.id && f.source_hash === d.hash);
    // A correction to mention/memory suppresses the automatic onscreen classification for this chapter.
    if (manual.length) { found.push(...manual); continue; }
    let quoted = false, paragraphStart = 0, matched = null;
    for (let i = 0; i < d.text.length && !matched; i++) {
      const ch = d.text[i]; if (ch === '\n') paragraphStart = i + 1;
      if (ch === '“' || ch === '「' || ch === '『') { quoted = true; continue; }
      if (ch === '”' || ch === '」' || ch === '』') { quoted = false; continue; }
      if (quoted || d.text[paragraphStart] === '#') continue;
      const name = names.find(n => d.text.startsWith(n, i)); if (!name) continue;
      const before = d.text.slice(Math.max(paragraphStart, i - 35), i);
      const after = d.text.slice(i + name.length, Math.min(d.text.indexOf('\n', i) < 0 ? d.text.length : d.text.indexOf('\n', i), i + name.length + 36));
      if (/回忆|忆起|想起|当年|昔年|曾经|那一年|听说|听闻|未见|不见|没见|不在|提起|提及|想到|念起/.test(before + after.slice(0, 8))) continue;
      if (/^[的之]|[“”]/.test(after.slice(0, 2))) continue;
      const action = after.slice(0, 20).search(ACTION); if (action < 0) continue;
      if (/[。！？；]/.test(after.slice(0, action)) || names.some(n => after.slice(0, action).includes(n))) continue;
      const lineEnd = d.text.indexOf('\n', i), end = Math.min(lineEnd < 0 ? d.text.length : lineEnd, i + 220);
      const start = Math.max(paragraphStart, i - 30), evidence = d.text.slice(start, end).trim();
      matched = { id: `appearance-index:${d.id}:${character.id}:${i}`, entity_id: character.id, field: 'appearance', value: { type: 'onscreen', displayName: name }, layer: 'occurred', source_document_id: d.id, source_hash: d.hash, source_chapter: d.chapter, evidence, start: d.text.indexOf(evidence, start), status: 'indexed', review_reasons: [], automatic: true };
    }
    if (matched) found.push(matched);
  }
  return found.sort((a, b) => (a.source_chapter || 0) - (b.source_chapter || 0) || (a.start || 0) - (b.start || 0));
}
