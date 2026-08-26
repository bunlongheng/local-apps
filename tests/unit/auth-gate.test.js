// Unit: lib/auth-gate.js - the trust-loopback control-API auth policy.
const { test } = require('node:test');
const assert = require('node:assert');
const { decide, isLoopback, tokenOk } = require('../../lib/auth-gate');

test('isLoopback recognises the loopback forms', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('::1'));
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('10.0.0.20'));
  assert.ok(!isLoopback('100.64.0.1'));
  assert.ok(!isLoopback(''));
});

test('loopback callers are fully trusted for any method/path, no token needed', () => {
  for (const method of ['GET', 'POST', 'PUT', 'DELETE']) {
    for (const path of ['/api/status', '/api/apps', '/api/shell/zshrc', '/api/start/x']) {
      assert.deepEqual(decide({ remoteAddress: '127.0.0.1', method, path, token: null, configuredToken: '' }), { allow: true });
    }
  }
});

test('off-box may read non-sensitive GETs (the LAN/iPad status view)', () => {
  assert.deepEqual(decide({ remoteAddress: '10.0.0.9', method: 'GET', path: '/api/status', token: null, configuredToken: '' }), { allow: true });
  assert.deepEqual(decide({ remoteAddress: '10.0.0.9', method: 'GET', path: '/api/machines', token: null, configuredToken: '' }), { allow: true });
});

test('off-box mutations are DENIED when no token is configured (fail closed)', () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const d = decide({ remoteAddress: '10.0.0.9', method, path: '/api/start/x', token: null, configuredToken: '' });
    assert.equal(d.allow, false);
    assert.equal(d.status, 401);
  }
});

test('off-box sensitive GETs (logs) are DENIED without a token', () => {
  for (const path of ['/api/log/bheng', '/api/log/x']) {
    const d = decide({ remoteAddress: '10.0.0.9', method: 'GET', path, token: null, configuredToken: '' });
    assert.equal(d.allow, false);
    assert.equal(d.status, 401);
  }
});

test('off-box with the correct token is allowed; wrong/absent token is denied', () => {
  const cfg = 'sekret-token-123';
  assert.deepEqual(decide({ remoteAddress: '10.0.0.9', method: 'POST', path: '/api/start/x', token: cfg, configuredToken: cfg }), { allow: true });
  assert.equal(decide({ remoteAddress: '10.0.0.9', method: 'POST', path: '/api/start/x', token: 'wrong', configuredToken: cfg }).allow, false);
  assert.equal(decide({ remoteAddress: '10.0.0.9', method: 'GET', path: '/api/log/x', token: null, configuredToken: cfg }).allow, false);
});

test('tokenOk is false unless both are set and equal', () => {
  assert.ok(!tokenOk('', ''));
  assert.ok(!tokenOk('abc', ''));
  assert.ok(!tokenOk('', 'abc'));
  assert.ok(!tokenOk('abc', 'abcd'));
  assert.ok(!tokenOk('abcx', 'abcy'));
  assert.ok(tokenOk('match-me', 'match-me'));
});
