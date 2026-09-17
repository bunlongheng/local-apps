// Unit: lib/auth-gate.js - the trust-loopback control-API auth policy.
const { test } = require('node:test');
const assert = require('node:assert');
const { decide, isLoopback, tokenOk } = require('../../lib/auth-gate');

test('isLoopback recognises the loopback forms', () => {
  assert.ok(isLoopback('127.0.0.1'));
  assert.ok(isLoopback('::1'));
  assert.ok(isLoopback('::ffff:127.0.0.1'));
  assert.ok(!isLoopback('1.2.3.4'));
  assert.ok(!isLoopback('255.255.255.255'));
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
  assert.deepEqual(decide({ remoteAddress: '1.2.3.4', method: 'GET', path: '/api/status', token: null, configuredToken: '' }), { allow: true });
  assert.deepEqual(decide({ remoteAddress: '1.2.3.4', method: 'GET', path: '/api/machines', token: null, configuredToken: '' }), { allow: true });
});

test('off-box mutations are DENIED when no token is configured (fail closed)', () => {
  for (const method of ['POST', 'PUT', 'DELETE']) {
    const d = decide({ remoteAddress: '1.2.3.4', method, path: '/api/start/x', token: null, configuredToken: '' });
    assert.equal(d.allow, false);
    assert.equal(d.status, 401);
  }
});

test('off-box sensitive GETs (logs) are DENIED without a token', () => {
  for (const path of ['/api/log/bheng', '/api/log/x']) {
    const d = decide({ remoteAddress: '1.2.3.4', method: 'GET', path, token: null, configuredToken: '' });
    assert.equal(d.allow, false);
    assert.equal(d.status, 401);
  }
});

test('off-box with the correct token is allowed; wrong/absent token is denied', () => {
  const cfg = 'sekret-token-123';
  assert.deepEqual(decide({ remoteAddress: '1.2.3.4', method: 'POST', path: '/api/start/x', token: cfg, configuredToken: cfg }), { allow: true });
  assert.equal(decide({ remoteAddress: '1.2.3.4', method: 'POST', path: '/api/start/x', token: 'wrong', configuredToken: cfg }).allow, false);
  assert.equal(decide({ remoteAddress: '1.2.3.4', method: 'GET', path: '/api/log/x', token: null, configuredToken: cfg }).allow, false);
});

test('tokenOk is false unless both are set and equal', () => {
  assert.ok(!tokenOk('', ''));
  assert.ok(!tokenOk('abc', ''));
  assert.ok(!tokenOk('', 'abc'));
  assert.ok(!tokenOk('abc', 'abcd'));
  assert.ok(!tokenOk('abcx', 'abcy'));
  assert.ok(tokenOk('match-me', 'match-me'));
});

test('loopback trust needs a known Host: DNS rebinding gets 421', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'GET', path: '/api/status', token: null, configuredToken: '' };
  assert.deepEqual(decide({ ...base, host: 'localhost:9875' }), { allow: true });
  assert.deepEqual(decide({ ...base, host: 'local-apps.localhost' }), { allow: true });
  assert.deepEqual(decide({ ...base, host: '1.2.3.4:9875', allowedHosts: ['1.2.3.4'] }), { allow: true });
  assert.equal(decide({ ...base, host: 'attacker.example' }).status, 421);
  assert.equal(decide({ ...base, host: '' }).status, 421);
});

test('cross-site Origin on a mutation is refused even from loopback (CSRF)', () => {
  const base = { remoteAddress: '127.0.0.1', method: 'POST', path: '/api/start/x', token: null, configuredToken: '', host: 'localhost:9875' };
  assert.equal(decide({ ...base, origin: 'https://evil.example' }).status, 403);
  assert.deepEqual(decide({ ...base, origin: 'http://localhost:9875' }), { allow: true });
  assert.deepEqual(decide({ ...base, origin: undefined }), { allow: true }, 'CLI callers send no Origin');
  assert.deepEqual(decide({ ...base, method: 'GET', path: '/api/status', origin: 'https://evil.example' }), { allow: true }, 'reads are not CSRF-able');
});

test('registry and per-machine reads are sensitive off-box, plain status is not', () => {
  const off = (p) => decide({ remoteAddress: '1.2.3.4', method: 'GET', path: p, token: null, configuredToken: '' });
  for (const p of ['/api/log/x', '/api/capabilities', '/api/tab-colors', '/api/consistency', '/api/app-profiles', '/api/icon-sync', '/api/all-apps', '/api/machines/m1/apps']) assert.equal(off(p).status, 401, p);
  for (const p of ['/api/status', '/api/apps', '/api/apps/x', '/api/machines', '/api/qr', '/']) assert.deepEqual(off(p), { allow: true }, p);
});

test('a LAN caller arriving through the loopback reverse proxy is off-box, not localhost', () => {
  const { effectiveAddress } = require('../../lib/auth-gate');
  assert.equal(effectiveAddress('127.0.0.1', '1.2.3.4'), '1.2.3.4');
  assert.equal(effectiveAddress('127.0.0.1', '1.2.3.4, 10.9.9.9'), '1.2.3.4', 'first hop is the client');
  assert.equal(effectiveAddress('1.2.3.4', '127.0.0.1'), '1.2.3.4', 'a non-loopback socket ignores XFF entirely');
  assert.equal(effectiveAddress('127.0.0.1', undefined), '127.0.0.1');
  const viaCaddy = { remoteAddress: '127.0.0.1', forwardedFor: '1.2.3.4', method: 'POST', path: '/api/start/x', token: null, configuredToken: '', host: 'local-apps.localhost' };
  assert.equal(decide(viaCaddy).status, 401, 'proxied LAN mutation is denied without the token');
  assert.deepEqual(decide({ ...viaCaddy, method: 'GET', path: '/api/status' }), { allow: true });
  assert.deepEqual(decide({ ...viaCaddy, forwardedFor: '127.0.0.1' }), { allow: true }, 'the proxy forwarding a loopback client keeps loopback trust');
});
