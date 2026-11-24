import { AppError } from './io.mjs';

export const GO_BASE = 'https://opencode.ai/inference/go/openai/v1';
export const GO_CATALOG = 'https://opencode.ai/inference/go/v1/models';
// The desktop network bridge bounds request bodies independently of model token budgets.
export const MODEL_REQUEST_BODY_LIMIT = 150_000;
export const WRITING_OUTPUT_LIMIT = 131_072;

export function isGoBase(value) {
  try {
    const url = new URL(value);
    return url.origin === 'https://opencode.ai' && !url.username && !url.password && !url.search && !url.hash &&
      /^\/(?:zen\/go\/v1|inference\/go\/(?:openai\/)?v1)(?:\/chat\/completions)?\/?$/.test(url.pathname);
  } catch { return false; }
}

export function isLocalModelUrl(url) {
  return url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname) &&
    url.port !== '3425' && !url.username && !url.password && !url.search && !url.hash;
}

export function connectionBase(value) {
  if (!value) return '';
  if (isGoBase(value)) return GO_BASE;
  let url;
  try { url = new URL(value); } catch { /* Invalid input gets the same configuration error. */ }
  if (url && !url.username && !url.password && !url.search && !url.hash &&
      (isLocalModelUrl(url) || url.protocol === 'https:')) {
    const pathname = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return url.origin + pathname;
  }
  throw new AppError('AI_CONFIG', '云端服务请用 HTTPS，本机服务可用 HTTP。地址中请勿填写密钥或查询参数。');
}

// Local providers are available to existing offline workspaces. Cloud targets
// must be explicitly approved in this installation and matched by full URL.
export function permitsModelRequest(url, method, configured) {
  if (isLocalModelUrl(url)) return (method === 'POST' && url.pathname.endsWith('/chat/completions')) ||
    (method === 'GET' && url.pathname.endsWith('/models'));
  if (!configured) return false;
  if (isGoBase(configured) && method === 'GET' && url.href === GO_CATALOG) return true;
  const suffix = method === 'GET' ? '/models' : method === 'POST' ? '/chat/completions' : '';
  return !!suffix && url.href === configured + suffix;
}

export function checkGoBilling(usage) {
  const source = usage?.opencode?.billing_source;
  if (source && !['go', 'go-plus', 'go-teams'].includes(source)) {
    throw new AppError('AI_BILLING', '服务返回了订阅以外的计费来源，请关闭 OpenCode 控制台的 Extra Usage 并核对所选模型');
  }
}

export function writingModel(settings, presets) {
  const preferGemma = presets.some(model => model.id === 'Gemma4') || isGoBase(settings.ai.baseUrl);
  const key = settings.writingModel ?? (preferGemma ? 'Gemma4' : 'analysis');
  if (key === 'analysis') return { ...settings.ai, key };
  const preset = presets.find(model => model.id === key);
  return { ...settings.ai, enabled: !!preset?.available, key, model: preset?.model || '', baseUrl: preset?.baseUrl || '',
    title: preset?.title || (key === 'Gemma4' ? 'Gemma 4 Vain' : undefined) };
}
