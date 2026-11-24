
import assert from 'node:assert/strict';
import test from 'node:test';
import { connectionBase, permitsModelRequest, GO_BASE, GO_CATALOG } from '../core/model-connections.mjs';

test('统一接受 HTTPS 和本机兼容连接，并标准化完整接口地址', () => {
  assert.equal(connectionBase('https://models.example/api/v1/chat/completions/'), 'https://models.example/api/v1');
  assert.equal(connectionBase('http://127.0.0.1:7788/v1'), 'http://127.0.0.1:7788/v1');
  for (const bad of ['http://models.example', 'https://user:pass@models.example', 'https://models.example/?key=a', 'file:///x']) {
    assert.throws(() => connectionBase(bad));
  }
});

test('未经授权的云端地址、不同主机和不同路径均不通过网络边界', () => {
  const base = 'https://models.example/v1';
  const endpoint = new URL(base + '/chat/completions');
  assert.equal(permitsModelRequest(endpoint, 'POST', ''), false);
  assert.equal(permitsModelRequest(endpoint, 'POST', base), true);
  assert.equal(permitsModelRequest(new URL('https://other.example/v1/chat/completions'), 'POST', base), false);
  assert.equal(permitsModelRequest(new URL('https://models.example/other/chat/completions'), 'POST', base), false);
  assert.equal(permitsModelRequest(new URL(GO_CATALOG), 'GET', GO_BASE), true);
  assert.equal(permitsModelRequest(new URL(GO_CATALOG), 'GET', base), false);
});
