import { AppError, hash, stamp } from './io.mjs';

export const RESEARCH_MCP_URL = 'https://mcp.exa.ai/mcp?tools=web_search_exa';
const SEARCH_LIMIT = 6;
const workResults = new WeakMap();
const searching = new WeakSet();

export function publicSourceUrl(value) {
  if (typeof value !== 'string' || value.length > 2048 || /[\s<>"\\\u0000-\u001f]/u.test(value)) return null;
  try {
    const url = new URL(value);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password ||
      !url.hostname.includes('.') || /(?:\.local|\.localhost|\.internal)$/i.test(url.hostname) ||
      /^\d+\.\d+\.\d+\.\d+$/.test(url.hostname)) return null;
    return url.href.length <= 2048 ? url.href : null;
  } catch { return null; }
}

function searchPacket(text, contentType) {
  try {
    if (!contentType.includes('text/event-stream')) return JSON.parse(text);
    for (const event of text.split(/\r?\n\r?\n/)) {
      const data = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      if (!data) continue;
      const packet = JSON.parse(data);
      if (packet.id === 1) return packet;
    }
  } catch { /* Format errors use a stable message in the workspace. */ }
  throw new AppError('RESEARCH_FORMAT', '搜索服务返回的内容无法读取，请重试。');
}

const flatText = value => value.replace(/\s+/gu, ' ').trim();

function searchResults(result, query, focusTerm) {
  if (!Array.isArray(result?.content)) throw new AppError('RESEARCH_FORMAT', '搜索服务未返回可读取的结果，请重试。');
  const retrievedAt = stamp();
  const sources = new Map();
  let foundHeaders = false;
  const blocks = result.content.filter(row => row?.type === 'text' && typeof row.text === 'string');
  for (const { text } of blocks) {
    const headings = [...text.matchAll(/^Title:[ \t]*([^\r\n]+)\r?\nURL:[ \t]*([^\r\n]+)\r?$/gm)];
    if (headings.length) foundHeaders = true;
    for (const [index, match] of headings.entries()) {
      const title = flatText(match[1]).slice(0, 180);
      const url = publicSourceUrl(match[2].trim());
      if (!title || !url || sources.has(url)) continue;
      const segment = text.slice(match.index + match[0].length, headings[index + 1]?.index ?? text.length);
      const published = /^Published:[ \t]*(\d{4}-\d{2}-\d{2})/m.exec(segment)?.[1] || null;
      const highlight = /^(?:Highlights|Text|Snippet|Description):[ \t]*([\s\S]*)$/m.exec(segment)?.[1] || '';
      const snippet = flatText(highlight.replace(/^\s*#{1,6} [^\n]+\n/, ''));
      const hit = focusTerm ? snippet.indexOf(focusTerm) : 0;
      if (hit < 0) continue;
      const excerptStart = Math.max(0, Math.min(hit - 140, snippet.length - 360));
      const excerpt = snippet.slice(excerptStart, excerptStart + 360);
      sources.set(url, { id: hash(JSON.stringify([url, title, query, retrievedAt, excerpt])), type: 'web',
        title, url, domain: new URL(url).hostname, excerpt, query, published, retrievedAt,
        ...(focusTerm ? { wordingTerm: focusTerm } : {}) });
      if (sources.size === SEARCH_LIMIT) return [...sources.values()];
    }
  }
  if (!foundHeaders && blocks.length && !blocks.every(({ text }) => /^\s*(?:no (?:search )?results(?: found)?\b|未找到|没有找到)/i.test(text))) {
    throw new AppError('RESEARCH_FORMAT', '搜索结果中没有可识别的出处，请重试。');
  }
  return [...sources.values()];
}

export async function searchResearchWeb(value, fetcher = fetch, focusTerm) {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > 220 || /[\u0000-\u001f]/u.test(value.trim())) {
    throw new AppError('VALIDATION', '请填写 1–220 个字符的搜索词。');
  }
  const query = value.trim();
  const body = JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'web_search_exa', arguments: {
    query, numResults: focusTerm ? 12 : SEARCH_LIMIT,
    objective: focusTerm
      ? 'Find actual examples of the exact Chinese word or phrase in quotes. Return original wording and the cited work and its period. Do not return pages that merely mention the era.'
      : 'Find primary or attributable sources relevant to this query. Prefer archives, research institutions, original documents and official sources when relevant.',
  } } });
  let response, raw;
  for (let attempt = 0; attempt < 2; attempt++) {
    const signal = AbortSignal.timeout(14000);
    try {
      response = await fetcher(RESEARCH_MCP_URL, { method: 'POST', headers: {
        accept: 'application/json, text/event-stream', 'content-type': 'application/json',
      }, body, redirect: 'error', signal });
      if (attempt === 0 && [502, 503, 504].includes(response.status)) {
        await response.body?.cancel().catch(() => {});
        continue;
      }
      raw = await response.text();
      break;
    } catch {
      if (attempt === 0) continue;
      throw signal.aborted ? new AppError('RESEARCH_TIMEOUT', '搜索服务响应超时，可重试查证。')
        : new AppError('RESEARCH_NETWORK', '未能连接搜索服务，请检查网络后重试。');
    }
  }
  const rateLimited = () => new AppError('RESEARCH_LIMIT', '搜索服务暂时限流，请稍后再试。');
  if (response.status === 429) throw rateLimited();
  if (!response.ok) throw new AppError('RESEARCH_SERVICE', `搜索服务暂时不可用（HTTP ${response.status}），可重试查证。`);
  if (raw.length > 300000) throw new AppError('RESEARCH_FORMAT', '搜索结果超过大小限制，请缩小查询范围。');
  const packet = searchPacket(raw, response.headers.get('content-type') || '');
  if (packet?.jsonrpc !== '2.0' || packet.id !== 1) throw new AppError('RESEARCH_FORMAT', '搜索服务返回的结果不完整，请重试。');
  if (packet.error || packet.result?.isError) {
    if (/\b429\b|rate limit|quota/i.test(raw)) throw rateLimited();
    throw new AppError('RESEARCH_SERVICE', '搜索服务未完成本次请求，可重试查证。');
  }
  return { query, results: searchResults(packet.result, query, focusTerm) };
}

export async function searchForWork(workspace, query, focusTerm) {
  if (searching.has(workspace)) throw new AppError('BUSY', '正在搜索，请稍候。');
  searching.add(workspace);
  try {
    const response = await searchResearchWeb(query, workspace.fetcher, focusTerm);
    const results = workResults.get(workspace) || new Map();
    for (const row of response.results) results.set(row.id, row);
    while (results.size > 48) results.delete(results.keys().next().value);
    workResults.set(workspace, results);
    return response;
  } finally { searching.delete(workspace); }
}

export function selectedWebSources(workspace, ids = []) {
  if (!Array.isArray(ids) || ids.length > 4) throw new AppError('VALIDATION', '每份候选最多可选 4 条网络出处。');
  const cache = workResults.get(workspace);
  return [...new Set(ids)].map(id => {
    const source = cache?.get(id);
    if (!source) throw new AppError('CONFLICT', '所选出处已过期，请重新搜索后选择。');
    return source;
  });
}

export function citedWebSources(workspace, message) {
  const links = new Set(message.split(/\s+/u).filter(part => /^https?:\/\//.test(part)));
  if (!links.size) return [];
  const matches = new Map();
  for (const source of [...(workResults.get(workspace)?.values() || [])].reverse()) {
    if (links.has(source.url) && !matches.has(source.url)) matches.set(source.url, source);
    if (matches.size >= 4) break;
  }
  return [...matches.values()];
}
