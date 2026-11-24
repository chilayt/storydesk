import { AppError, hash } from './io.mjs';

export function validateMemlayer(input = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new AppError('VALIDATION', 'Memlayer 设置格式无效');
  const baseUrl = String(input.baseUrl || 'http://127.0.0.1:8770').trim();
  const sharedProject = String(input.sharedProject || '').trim();
  let url;
  try { url = new URL(baseUrl); } catch { throw new AppError('VALIDATION', 'Memlayer 地址格式无效'); }
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/') {
    throw new AppError('VALIDATION', 'Memlayer 地址须为本机 HTTP 服务，例如 http://127.0.0.1:8770');
  }
  if (sharedProject && !/^shared_[a-zA-Z0-9_-]{1,70}$/.test(sharedProject)) {
    throw new AppError('VALIDATION', '共享记忆须填写以 shared_ 开头的独立命名空间');
  }
  return { enabled: input.enabled === true, baseUrl: url.origin, sharedProject };
}

async function boundedJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Memlayer 返回空结果');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > 256_000) throw new Error('Memlayer 返回过多资料');
      chunks.push(Buffer.from(value));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } finally { await reader.cancel().catch(() => {}); }
}

function keywords(value) {
  const words = String(value || '').toLowerCase().match(/\p{Script=Han}{2,}|[a-z0-9_-]{3,}/gu) || [];
  return new Set(words.flatMap(word => /^\p{Script=Han}/u.test(word) ?
    Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)) : [word]));
}

export async function recallMemlayer(settings, workId, signal, fetcher = fetch, request = '', semanticRequest = request) {
  if (!settings?.enabled) return { status: 'disabled', items: [], signature: 'disabled' };
  const config = validateMemlayer(settings);
  if (!/^work_[a-zA-Z0-9_-]{1,80}$/.test(workId)) throw new AppError('VALIDATION', '作品 ID 无法绑定记忆');
  const projects = [workId, ...(config.sharedProject ? [config.sharedProject] : [])];
  const query = String(request || '').trim();
  const terms = keywords(query);
  // No retrievable question means no injection: unrelated facts must never be
  // pushed into the model just because they happen to be the most recent ones.
  if (!terms.size) return { status: 'empty', items: [], available: 0, signature: hash(Buffer.from('no-query')) };
  const settled = await Promise.allSettled(projects.map(async project => {
    const url = new URL(config.baseUrl + '/v1/facts');
    // Pass the real query so the engine ranks by relevance (term overlap, then
    // recency as a tie-break). Without q the engine returns the newest rows and
    // an older relevant fact can never be reached by local re-scoring.
    url.search = new URLSearchParams({ project, q: query.slice(0, 500), semantic_q: String(semanticRequest || '').trim().slice(0, 500),
      mode: 'current', confirmed_only: 'true', include_inferred: 'false', limit: '20' });
    const signals = [AbortSignal.timeout(2200), ...(signal ? [signal] : [])];
    const response = await fetcher(url, { redirect: 'error', signal: AbortSignal.any(signals), headers: { Accept: 'application/json' } });
    if (!response.ok) throw new Error('Memlayer 请求失败');
    const data = await boundedJson(response);
    if (data?.ok !== true || !Array.isArray(data.facts)) throw new Error('Memlayer 返回格式不兼容');
    const facts = data.facts.filter(f => f?.project === project && f.status === 'current' && f.confirmed === true &&
      ['self', 'relayed'].includes(f.perspective) && typeof f.id === 'string' && typeof f.text === 'string' && f.text.trim());
    const ranked = facts.filter(f => f.match === 'local-semantic' || [...keywords(f.text)].some(word => terms.has(word)));
    const items = ranked.slice(0, 3).map(f => ({
        id: f.id.slice(0, 110), scope: project === workId ? '本作品' : '作者共享', text: f.text.slice(0, f.tags?.includes('author-exceptions') ? 3600 : 240),
        evidence: Array.isArray(f.source_ids) ? f.source_ids.filter(v => typeof v === 'string').slice(0, 2).map(v => v.slice(0, 100)) : [],
        ...(f.subject === 'author-note' && f.perspective === 'self' && Array.isArray(f.tags) && f.tags.includes('human-approved')
          ? { kind: 'author-preference' } : {}),
        ...(f.match === 'local-semantic' ? { match: 'local-semantic' } : {}),
    }));
    return { items, available: ranked.length };
  }));
  signal?.throwIfAborted();
  const items = settled.flatMap(r => r.status === 'fulfilled' ? r.value.items : []);
  const available = settled.reduce((n, r) => n + (r.status === 'fulfilled' ? r.value.available : 0), 0);
  const failures = settled.filter(r => r.status === 'rejected').length;
  const status = failures === projects.length ? 'unavailable' : failures ? 'partial' : items.length ? 'ready' : 'empty';
  return { status, items, available, signature: hash(Buffer.from(JSON.stringify({ status, items }))) };
}


// ---------------------------------------------------------------------------
// Author-facing candidate flow. Chat never becomes a confirmed fact on its own:
// the author picks an original message, edits the candidate, chooses the scope
// (this work or the explicit shared namespace) and approves or rejects it.
// ---------------------------------------------------------------------------
const SUBJECT = 'author-note';
const SCOPES = ['work', 'shared'];

function projectsFor(config, workId) {
  const map = new Map([['work', workId]]);
  if (config.sharedProject) map.set('shared', config.sharedProject);
  return map;
}

function scopeLabel(scope) {
  return scope === 'shared' ? '作者共享' : '本作品';
}

async function bridge(settings, path, { method = 'GET', body, signal, fetcher = fetch } = {}) {
  const config = validateMemlayer(settings);
  if (!config.enabled) throw new AppError('VALIDATION', '共享记忆尚未启用');
  const url = new URL(config.baseUrl + path);
  const signals = [AbortSignal.timeout(4000), ...(signal ? [signal] : [])];
  const response = await fetcher(url, {
    method,
    redirect: 'error',
    signal: AbortSignal.any(signals),
    headers: body === undefined ? { Accept: 'application/json' } : { Accept: 'application/json', 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await boundedJson(response);
  if (!response.ok || data?.ok !== true) throw new AppError('MEMORY', data?.error?.message || 'Memlayer 请求失败');
  return data;
}

export async function memlayerHealth(settings, signal, fetcher = fetch) {
  const config = validateMemlayer(settings);
  if (!config.enabled) return { enabled: false, status: 'disabled', available: 0 };
  try {
    const data = await bridge(settings, '/health', { signal, fetcher });
    if (typeof data.version !== 'string' || !Number.isInteger(data.writerQueue)) throw new Error('本机服务的 Memlayer 接口不兼容');
    if (data.status === 'busy-lock-held') throw new Error('Memlayer 正在处理请求，请稍后重试');
    return { enabled: true, status: 'ready', version: data.version };
  } catch (error) {
    return { enabled: true, status: 'unavailable', available: 0, message: error?.message || '共享记忆暂不可用' };
  }
}

export function memlayerScopes(settings, workId) {
  if (!/^work_[a-zA-Z0-9_-]{1,80}$/.test(String(workId || ''))) throw new AppError('VALIDATION', '作品 ID 无法绑定记忆');
  const config = validateMemlayer(settings);
  const projects = projectsFor(config, workId);
  return [...projects].map(([scope, project]) => ({ scope, project, label: scopeLabel(scope) }));
}

function resolveScope(settings, workId, scope) {
  if (!SCOPES.includes(scope)) throw new AppError('VALIDATION', '请选择本作品或作者共享');
  const selected = memlayerScopes(settings, workId).find(item => item.scope === scope);
  if (!selected) throw new AppError('VALIDATION', '共享记忆须先在设置中填写作者共享命名空间');
  return selected;
}

export async function listMemlayerCandidates(settings, { workId, scope = 'work', status = 'pending' }, signal, fetcher = fetch) {
  if (!['pending', 'approved', 'rejected', 'all'].includes(status)) throw new AppError('VALIDATION', '候选状态无效');
  const { project } = resolveScope(settings, workId, scope);
  const params = new URLSearchParams({ project });
  if (status !== 'all') params.set('status', status);
  const data = await bridge(settings, '/v1/candidates?' + params, { signal, fetcher });
  const rows = (Array.isArray(data.candidates) ? data.candidates : []).filter(row => row.project === project && row.subject === SUBJECT);
  return rows.filter(row => status === 'all' || row.status === status).map(row => ({
    id: String(row.id || ''), scope, scopeLabel: scopeLabel(scope), status: row.status,
    text: String(row.text || ''), hash: String(row.content_hash || ''), factId: row.fact_id || null,
    source: String(row.source_event_id || ''), createdAt: row.created_at || null,
    suggestedFactId: row.suggested_fact_id || null, suggestedAction: row.suggested_action || null,
    reviewNote: row.review_note || '',
  }));
}

export async function proposeMemlayerCandidate(settings, { workId, scope, text, sourceId, suggestedFactId, suggestedAction }, signal, fetcher = fetch) {
  const { project } = resolveScope(settings, workId, scope);
  const source = String(sourceId || '').trim();
  if (!source) throw new AppError('VALIDATION', '请选择一条原话作为来源');
  if (source.length > 512 || /[\r\n\0]/u.test(source)) throw new AppError('VALIDATION', '来源标识格式有误');
  const value = String(text || '').trim();
  if (!value) throw new AppError('VALIDATION', '请填写要记住的原话');
  if (value.length > 2000) throw new AppError('VALIDATION', '记忆原文过长，请精简到 2000 字以内');
  const data = await bridge(settings, '/v1/candidates', {
    method: 'POST', signal, fetcher,
    body: { project, subject: SUBJECT, source_event_id: source, perspective: 'self', text: value,
      ...(suggestedFactId ? { suggested_fact_id: suggestedFactId, ...(suggestedAction ? { suggested_action: suggestedAction } : {}) } : {}) },
  });
  const row = data.result?.candidate || {};
  return { id: row.id, scope, scopeLabel: scopeLabel(scope), status: row.status, text: row.text, hash: row.content_hash, source: row.source_event_id, duplicate: !!data.result?.duplicate };
}

export async function reviewMemlayerCandidate(settings, { workId, scope, decision, id, hash, supersedesFactId, reason }, signal, fetcher = fetch) {
  if (!['approve', 'reject', 'approve-replacement', 'approve-exception'].includes(decision)) throw new AppError('VALIDATION', '请选择确认或拒绝');
  const updatesExisting = decision === 'approve-replacement' || decision === 'approve-exception';
  if (reason && (decision !== 'reject' || !['only_once', 'scope_too_broad', 'already_exists'].includes(reason))) {
    throw new AppError('VALIDATION', '候选拒绝原因无效');
  }
  if (updatesExisting && !supersedesFactId) throw new AppError('VALIDATION', '请选择待替换的旧记忆');
  const { project } = resolveScope(settings, workId, scope);
  if (!id || !hash) throw new AppError('VALIDATION', '候选或版本编号缺失，请刷新后重试');
  const data = await bridge(settings, '/v1/candidates/' + decision, {
    method: 'POST', signal, fetcher,
    body: { project, subject: SUBJECT, candidate_id: id, expected_hash: hash,
      ...(updatesExisting ? { supersedes_fact_id: supersedesFactId } : {}),
      ...(reason ? { note: reason } : {}) },
  });
  const result = data.result || {};
  return { scope, scopeLabel: scopeLabel(scope), status: result.candidate?.status, factId: result.fact_id || result.candidate?.fact_id || null, duplicate: !!result.duplicate };
}

export async function retractMemlayerFact(settings, { workId, scope, factId, reason }, signal, fetcher = fetch) {
  const { project } = resolveScope(settings, workId, scope);
  const id = String(factId || '').trim();
  if (!id) throw new AppError('VALIDATION', '请选择要撤回的记忆');
  const data = await bridge(settings, '/v1/facts/retract', {
    method: 'POST', signal, fetcher, body: { project, fact_id: id, reason: String(reason || '作者撤回').slice(0, 200) },
  });
  return { scope, scopeLabel: scopeLabel(scope), factId: id, retracted: !!data.result?.retracted };
}

export async function listMemlayerFacts(settings, { workId, scope = 'work', offset = 0, search = '', countOnly = false, authorNotesOnly = false }, signal, fetcher = fetch) {
  const { project } = resolveScope(settings, workId, scope);
  if (!Number.isSafeInteger(offset) || offset < 0) throw new AppError('VALIDATION', '记忆页码无效');
  const limit = countOnly ? 1 : 20;
  const params = new URLSearchParams({
    project, mode: 'current', confirmed_only: 'true', include_inferred: 'false', limit, offset,
  });
  if (authorNotesOnly) params.set('subject', SUBJECT);
  if (search) params.set('filter', String(search).trim().slice(0, 200));
  const data = await bridge(settings, '/v1/facts?' + params, { signal, fetcher });
  if (!Array.isArray(data.facts) || !Number.isSafeInteger(data.total)) {
    throw new AppError('MEMORY', '本机 Memlayer 尚未载入新版，请退出后重新打开创作台');
  }
  const facts = data.facts
    .filter(row => row?.project === project && row.status === 'current' && row.confirmed === true)
    .map(row => ({ id: row.id, scope, scopeLabel: scopeLabel(scope), text: row.text,
      source: (row.source_ids || []).join('、'), validFrom: row.valid_from }));
  return { facts, total: data.total, offset, limit };
}

export async function findMemlayerReviewMatches(settings, workId, query, signal, fetcher = fetch) {
  const { project } = resolveScope(settings, workId, 'work');
  const q = String(query || '').trim().slice(0, 240);
  if (!q) return [];
  const params = new URLSearchParams({ project, subject: SUBJECT, mode: 'current', confirmed_only: 'true',
    include_inferred: 'false', limit: '8', q, semantic_q: q });
  const data = await bridge(settings, '/v1/facts?' + params, { signal, fetcher });
  return (Array.isArray(data.facts) ? data.facts : []).filter(row => row.project === project && row.subject === SUBJECT &&
    row.status === 'current' && row.confirmed && row.tags?.includes('human-approved'))
    .map(row => ({ id: row.id, text: row.text }));
}
