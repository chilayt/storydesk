import test from 'node:test';
import assert from 'node:assert/strict';
import { requestStructured, listModels } from '../core/analysis.mjs';
import { classifyProviderError, parseRetryAfter, redactProviderMessage, assertProviderReady, clearProviderCooldowns } from '../core/provider-errors.mjs';
import { choosePresetModel } from '../src/domain.ts';
const profile={baseUrl:'http://127.0.0.1:9997/v1',model:'glm-5.3-flash',maxOutputTokens:256};
const messages=[{role:'system',content:'返回JSON。'},{role:'user',content:'连接测试。'}];
const json=(data,status=200,headers={})=>new Response(JSON.stringify(data),{status,headers:{'content-type':'application/json',...headers}});
test('付费DeepSeek的Global策略错误保留具体原因，不误报为429或余额不足',async()=>{
  clearProviderCooldowns();let calls=0;
  await assert.rejects(requestStructured(profile,'test-key',messages,{fetcher:async()=>{calls++;return json({error:{type:'server_error',message:'Upstream request failed: This Go model requires Global regions. Select Global in your workspace Privacy settings.'}},400);}}),e=>e.code==='AI_HTTP'&&e.details.httpStatus===400&&e.details.kind==='privacy_regions'&&e.message.includes('Global'));
  assert.equal(calls,1);
});
test('明确429只请求一次并遵守Retry-After，同一免费上游等待不会阻断付费模型',async()=>{
  clearProviderCooldowns();let calls=0;
  const fetcher=async(_u,req)=>{calls++;const m=JSON.parse(req.body).model;return m.startsWith('opencode-zen-free/')?json({error:{type:'rate_limit_error',message:'OpenCode Zen Free: Free usage limit reached.'}},429,{'retry-after':'3600'}):json({choices:[{message:{content:'{"events":[]}'}}]});};
  await assert.rejects(requestStructured({...profile,model:'opencode-zen-free/a-free'},'',messages,{fetcher}),e=>e.details.kind==='free_quota'&&e.details.retryAfterSeconds===3600);
  await assert.rejects(requestStructured({...profile,model:'opencode-zen-free/b-free'},'',messages,{fetcher}),e=>e.details.cached&&e.details.requestSent===false&&e.details.model==='opencode-zen-free/b-free');
  assert.equal(calls,1);const ok=await requestStructured(profile,'',messages,{fetcher});assert.deepEqual(ok.data.events,[]);assert.equal(calls,2);clearProviderCooldowns();
});
test('通用429不能仅凭状态码判断余额，保留等待信息且不立即连发重试',async()=>{
  clearProviderCooldowns();let calls=0;
  await assert.rejects(requestStructured(profile,'',messages,{fetcher:async()=>{calls++;return json({error:{message:'Too many requests',type:'rate_limit_error'}},429,{'retry-after':'2'});}}),e=>e.details.kind==='rate_limit'&&e.details.retrySource==='server');
  assert.equal(calls,1);assertProviderReady(profile.baseUrl+'/chat/completions',profile.model,Date.now()+3000);clearProviderCooldowns();
});
test('Retry-After日期按服务端时钟计算，非法时间不伪造恢复时刻',()=>{
  assert.equal(parseRetryAfter('Sun, 01 Nov 2026 12:00:00 GMT','Sun, 01 Nov 2026 11:30:00 GMT',Date.parse('2026-11-01T03:00:00Z')),1800);
  assert.equal(parseRetryAfter('not-a-date',null),null);assert.equal(parseRetryAfter('0',null),0);
});
test('错误与持久化诊断不会泄露已有密钥或Bearer凭证',()=>{
  const key='secret-test-key-123456789';const safe=redactProviderMessage(`rejected ${key}; Authorization: Bearer token-123456789`,key);assert.ok(!safe.includes(key));assert.ok(!safe.includes('token-123456789'));
});
test('客户端要求与认证失败、余额不足、区域限制分别分类',()=>{
  assert.equal(classifyProviderError(429,'Free models work in OpenCode').kind,'client_policy');assert.equal(classifyProviderError(401,'bad key').kind,'permission');assert.equal(classifyProviderError(429,'insufficient_quota').kind,'balance');
});
test('工作台发送真实自身标识，不再添加伪装工作目录；同一会话沿用显式session',async()=>{
  let body,headers;await requestStructured({...profile,model:'opencode-zen-free/a-free',baseUrl:'https://opencode.ai/zen/v1',sessionId:'real-conversation'},'',messages,{fetcher:async(_u,req)=>{body=JSON.parse(req.body);headers=req.headers;return json({choices:[{message:{content:'{"events":[]}'}}]});}});
  assert.ok(headers['User-Agent'].startsWith('YaochuanStoryDesk/'));assert.equal(headers['x-opencode-session'],'real-conversation');assert.deepEqual(body.messages,messages);
});
test('模型列表无价格或空价格不能标为免费，免费价格也不代表生成权限',async()=>{
  const r=await listModels(profile,'',async()=>json({data:[{id:'unknown'},{id:'null-cost',cost:{input:null,output:null}},{id:'free',cost:{text:{input:{price:0},output:{price:0}}}},{id:'paid',cost:{input:0.15,output:0.5}}]}));assert.deepEqual(r.free,['free']);assert.equal(r.models.length,4);
});
test('Go入口优先已验证付费GLM，同时保留作者已经选择的有效付费模型',()=>{
  const models=['beam-free','deepseek-v4.1-flash','glm-5.3-flash'];assert.equal(choosePresetModel(models,'opencode-zen-free/a-free','opencode'),'glm-5.3-flash');assert.equal(choosePresetModel(models,'beam-free','opencode'),'glm-5.3-flash');assert.equal(choosePresetModel(models,'deepseek-v4.1-flash','opencode'),'deepseek-v4.1-flash');assert.equal(choosePresetModel(['a','b'],'b','magpie'),'b');
});
