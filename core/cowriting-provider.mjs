import { stream } from '@earendil-works/pi-ai/api/openai-completions';
import { endpointFor, isOpencodeBase } from './analysis.mjs';
import { AppError } from './io.mjs';
import { providerFailure } from './provider-errors.mjs';
import { checkGoBilling, isGoBase } from './model-connections.mjs';
import { watchWritingStream, writingPacketFailure } from './cowriting-stream.mjs';

async function jsonCompletionStream(response, go, key) {
  let data;
  try { data = JSON.parse(await response.text()); } catch { data = null; }
  if (data?.error) throw writingPacketFailure(data.error, key);
  if (go) checkGoBilling(data?.usage);
  const choice = data?.choices?.[0];
  if (!choice?.message || !choice.finish_reason) throw new AppError('AI_FORMAT', '模型服务未返回完整回复');
  const delta = { ...choice.message };
  if (Array.isArray(delta.tool_calls)) delta.tool_calls = delta.tool_calls.map((call, index) => ({ ...call, index }));
  const packet = { id: data.id, model: data.model, usage: data.usage, choices: [{ index: 0, delta, finish_reason: choice.finish_reason }] };
  return new Response('data: ' + JSON.stringify(packet) + '\n\ndata: [DONE]\n\n',
    { status: response.status, headers: { 'content-type': 'text/event-stream' } });
}

export function writingProvider({ profile, key, sessionId, fetcher = fetch, signal, beforeSend, onPhase, withImages = false }) {
  const endpoint = endpointFor(profile.baseUrl);
  const go = isGoBase(profile.baseUrl);
  const model = {
    id: profile.model, name: profile.model, api: 'openai-completions', provider: 'storydesk',
    baseUrl: endpoint.slice(0, -'/chat/completions'.length),
    input: withImages ? ['text', 'image'] : ['text'], reasoning: false, contextWindow: 0, maxTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false, supportsStrictMode: false },
  };
  let lastError = null, requests = 0;
  function fail(error) {
    if (lastError || signal.aborted) return;
    lastError = error instanceof AppError || /^NET_[A-Z_]+$/u.test(error?.code || '') ? error
      : new AppError('AI_NETWORK', '与模型服务的连接中断');
  }
  async function scopedFetch(input, init) {
    try {
      const request = new Request(input, init);
      if (request.url !== endpoint || request.method !== 'POST') throw new AppError('AI_CONFIG', '共写请求与所选模型地址不一致');
      signal.throwIfAborted();
      const body = await request.text();
      const { tools } = JSON.parse(body);
      if (!requests) await beforeSend();
      signal.throwIfAborted();
      requests++;
      let phase = 'waiting';
      onPhase(phase);
      const headers = { 'Content-Type': 'application/json', 'User-Agent': 'YaochuanStoryDesk/1' };
      if (key) headers.Authorization = 'Bearer ' + key;
      if (isOpencodeBase(endpoint)) headers['x-opencode-session'] = sessionId;
      // The workspace cancellation signal is the actual transport signal.
      const response = await fetcher(endpoint, { method: 'POST', headers, body, signal, redirect: 'error', streamResponse: true });
      if (!response.ok) throw await providerFailure(response, { endpoint, model: profile.model, key, action: '共写请求' });
      const eventStream = /application\/json/i.test(response.headers.get('content-type') || '')
        ? await jsonCompletionStream(response, go, key) : response;
      return watchWritingStream(eventStream, { signal, fail, go, key, declaredTools: tools, onOutput(next) {
        if (next === 'output' || (phase === 'visible' && next === 'reasoning') || phase === next) return;
        phase = next;
        onPhase(phase);
      } });
    } catch (error) {
      fail(error);
      throw error;
    }
  }
  return {
    model,
    get error() { return lastError; },
    get requests() { return requests; },
    streamFn: (selected, context, options) => stream(selected, context, {
      ...options, apiKey: key || 'storydesk-local', fetch: scopedFetch, cacheRetention: 'none',
      signal, maxTokens: undefined, maxRetries: 0,
    }),
  };
}
