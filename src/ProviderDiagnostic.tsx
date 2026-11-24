import React from 'react';
import { dateText } from './domain';
export function ProviderDiagnostic({ test, diagnostics, model, baseUrl }: { test?: any; diagnostics?: any; model?: string; baseUrl?: string }) {
  const d = diagnostics || test?.diagnostics;
  if (!test && d?.stage !== 'http') return null;
  const changed = test && model != null && (test.model !== model || test.baseUrl?.replace(/\/$/, '') !== baseUrl?.replace(/\/$/, ''));
  return <section className={`notice provider-diagnostic ${test?.connected&&!changed ? '' : 'warning'}`} aria-label="模型连接诊断">
    <strong>{changed?'先前配置的测试结果':test?.connected ? '当前测试请求成功' : d?.summary || test?.message || '模型连接未完成'}</strong>
    {test && <p>实际测试：{test.model} · {test.baseUrl} · {dateText(test.tested_at)}</p>}
    {!test&&d?.model&&<p>请求模型：{d.model} · {d.endpoint}</p>}
    {changed && <p><strong>这是先前配置的结果。当前地址或模型已变更，请保存后重新测试。</strong></p>}
    <p>HTTP {test?.httpStatus || d?.httpStatus || '未提供'}{test?.billingSource ? ` · 服务端计费通道：${test.billingSource}` : ''}</p>
    {d?.providerMessage && <details open><summary>服务端具体原因</summary><p className="provider-message">{d.providerMessage}</p></details>}
    {d?.action && <p>{d.action}</p>}
    {d?.retryAt && <p>{d.retrySource === 'server' ? '服务端要求的等待时间至' : '服务端未给恢复时间，工作台先暂停连续请求至'}：{new Date(d.retryAt).toLocaleString('zh-CN')}。{d.retrySource === 'server' ? '到时仍需以服务端实际响应为准。' : '这不表示服务端额度届时一定恢复。'}</p>}
    {d?.cached && <p>本次未发送新的模型请求，沿用上次限流等待信息。</p>}
    {d?.requestId && <small>请求编号：{d.requestId}</small>}
    {test?.connected && <p>此测试使用短样例，不包含小说资料；连接成功不代表长稿语义质量已验证。</p>}
  </section>;
}
