import { AppError } from './io.mjs';
const cooldowns = new Map();
const freeModel = model => /opencode-zen-free\//i.test(model) || /-free$/i.test(model) || model === 'big-pickle';
const cacheKey = (endpoint, model) => `${endpoint}|${model}`;
const knownFree=(endpoint,model)=>/^opencode-zen-free\//i.test(model)||(/https:\/\/(?:www\.)?opencode\.ai\//i.test(endpoint)&&freeModel(model));
export function redactProviderMessage(message, key = '') {
  let text = String(message ?? '');
  if (key.length >= 6) text = text.split(key).join('[已隐藏密钥]');
  return text.replace(/Bearer\s+[^\s"'<>]+/gi, 'Bearer [已隐藏密钥]').replace(/(?:sk-|sk_|key-)[A-Za-z0-9_-]{12,}/g, '[已隐藏密钥]').slice(0, 1800);
}
export function parseRetryAfter(value, dateHeader, now = Date.now()) {
  if (!value) return null;
  let seconds;
  if (/^\d+(?:\.\d+)?$/.test(value.trim())) seconds = Math.ceil(Number(value));
  else { const target = Date.parse(value), server = Date.parse(dateHeader || ''); if (!Number.isFinite(target)) return null; seconds = Math.ceil((target - (Number.isFinite(server) ? server : now)) / 1000); }
  return Number.isFinite(seconds) && seconds >= 0 && seconds <= 366 * 86400 ? seconds : null;
}
export function classifyProviderError(status, message, type = '', code = '') {
  const s = `${message} ${type} ${code}`;
  if (/requires?\s+Global\s+regions?|select\s+Global|workspace.*Privacy|privacy.*regions?/i.test(s)) return { kind: 'privacy_regions', summary: '该模型被工作区的区域隐私策略拦截', action: '请在 OpenCode 工作区 Settings → Privacy → Regions 核对 Global 是否允许；工作台不会自动修改账号隐私设置。' };
  if (/free\s+(?:usage\s+)?limit|FreeUsageLimit|free.*(?:quota|用量|额度).*(?:exceed|reached|超|耗尽)/i.test(s)) return { kind: 'free_quota', summary: '当前免费通道的用量或调用限制已触发', action: '请按服务端等待时间暂停该免费通道；模型列表可读取，不代表生成请求可用。付费额度与免费通道限制应分别核对。' };
  if (/free models? (?:only )?work in OpenCode|only.*(?:OpenCode|coding agent)|unsupported client|user.?agent|MissingSessionID|session.*(?:missing|required)/i.test(s)) return { kind: 'client_policy', summary: '服务端对客户端或会话有额外要求', action: '请使用该服务支持的调用通道；不要把权限或客户端限制当成余额不足。' };
  if (/insufficient[_\s-]?(?:quota|credit|balance)|balance.*(?:insufficient|low)|credits?.*(?:exhausted|insufficient)|余额不足/i.test(s)) return { kind: 'balance', summary: '服务端报告余额或账户额度限制', action: '请核对当前接口对应的计费账户和额度，订阅额度与按量余额可能属于不同通道。' };
  if (status === 401 || status === 403) return { kind: 'permission', summary: '服务端拒绝当前认证或模型权限', action: '请核对密钥所属服务、工作区和模型访问权限。' };
  if (status === 429) return { kind: 'rate_limit', summary: '服务端限流或通道限额', action: '429 本身不能证明余额不足。请结合下面的服务端原因和等待时间判断，不要连续点击测试。' };
  if (status >= 500) return { kind: 'upstream', summary: '上游服务暂时失败', action: '请保留当前任务，稍后重试；正式资料未因连接测试改变。' };
  return { kind: 'request_rejected', summary: '服务端拒绝本次请求', action: '请对照具体原因核对地址、模型及账户策略。' };
}
export async function providerFailure(response, { endpoint, model = '', key = '', action = '模型请求', now = Date.now() } = {}) {
  let data; try { data = JSON.parse(await response.text()); } catch { data = null; }
  const message = redactProviderMessage(typeof data?.error === 'string' ? data.error : data?.error?.message || data?.message || data?.detail || '', key);
  const type = redactProviderMessage(data?.error?.type, key), code = redactProviderMessage(data?.error?.code, key);
  const category = classifyProviderError(response.status, message, type, code);
  const retryAfterSeconds = parseRetryAfter(response.headers.get('retry-after'), response.headers.get('date'), now);
  const localPause = response.status === 429 && retryAfterSeconds == null ? 60 : null;
  const retryAt = retryAfterSeconds != null ? new Date(now + retryAfterSeconds * 1000).toISOString() : localPause ? new Date(now + localPause * 1000).toISOString() : null;
  const details = { stage: 'http', httpStatus: response.status, ...category, providerMessage: message, providerType: type, providerCode: code, endpoint, model, receivedAt: new Date(now).toISOString(), retryAfterSeconds, retryAt, retrySource: retryAfterSeconds != null ? 'server' : localPause ? 'local_pause' : null, requestId: redactProviderMessage(response.headers.get('x-request-id'), key), responseKeys: data && typeof data === 'object' ? Object.keys(data).slice(0, 16) : [], requestSent: true };
  const error = new AppError('AI_HTTP', `${action}失败（HTTP ${response.status}）：${category.summary}${message ? `。${message}` : ''}`, details);
  if (response.status === 429 && retryAt) { if (cooldowns.size >= 128) cooldowns.delete(cooldowns.keys().next().value); const k=category.kind==='free_quota'&&knownFree(endpoint,model)?cacheKey(endpoint,'@free-models'):cacheKey(endpoint,model);cooldowns.set(k, { error, until: Date.parse(retryAt) }); }
  return error;
}
export function assertProviderReady(endpoint, model = '', now = Date.now()) {
  const exact=cacheKey(endpoint,model),pool=knownFree(endpoint,model)?cacheKey(endpoint,'@free-models'):null,k=cooldowns.has(exact)?exact:pool,entry=k?cooldowns.get(k):null;
  if (!entry) return;
  if (entry.until <= now) { cooldowns.delete(k); return; }
  throw new AppError('AI_HTTP', entry.error.message, { ...entry.error.details, cached: true, requestSent: false,limitedModel:entry.error.details.model,model, retryAfterSeconds: entry.error.details.retrySource === 'server' ? Math.ceil((entry.until - now) / 1000) : null });
}
export const clearProviderCooldowns = () => cooldowns.clear();
