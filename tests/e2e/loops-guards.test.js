// e2e: the dangerous loop-control endpoints. Every case here is designed to be
// REJECTED by a guard before any destructive action runs, so no real Claude
// session is SIGTERM'd and no launchd agent is booted in/out.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { api, serverUp } = require('./helpers');

before(async () => {
  if (!await serverUp()) {
    throw new Error('local-apps server not reachable on 9876 - start it first (npm run dev)');
  }
});

test('GET /api/loops returns {loops,count}', async () => {
  const { status, json } = await api('GET', '/api/loops');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json.loops));
  assert.equal(json.count, json.loops.length);
});

test('kill session with bogus pid -> 404 (never running)', async () => {
  const { status, json } = await api('POST', '/api/loops/kill', { kind: 'session', pid: 999999 });
  assert.equal(status, 404);
  assert.match(json.error, /not running/);
});

test('kill session with alive-but-unowned pid 1 -> 403 (not a Claude session)', async () => {
  // pid 1 (launchd) is alive but not in the session registry. The guard must
  // reject it BEFORE calling process.kill, so init is never signalled.
  const { status, json } = await api('POST', '/api/loops/kill', { kind: 'session', pid: 1 });
  assert.equal(status, 403);
  assert.match(json.error, /not a registered Claude session/);
});

test('kill launchd with unknown label -> 403 (allowlist)', async () => {
  const { status, json } = await api('POST', '/api/loops/kill', { kind: 'launchd', label: 'com.local-apps.bogus-not-real', action: 'stop' });
  assert.equal(status, 403);
  assert.match(json.error, /unknown launchd label/);
});

test('kill with bad kind -> 400', async () => {
  const { status, json } = await api('POST', '/api/loops/kill', { kind: 'banana' });
  assert.equal(status, 400);
  assert.match(json.error, /kind must be/);
});

test('interval on unknown label -> 403 (allowlist)', async () => {
  const { status, json } = await api('POST', '/api/loops/interval', { label: 'com.local-apps.bogus-not-real', seconds: 600 });
  assert.equal(status, 403);
  assert.match(json.error, /unknown launchd label/);
});

test('interval below floor -> 400 (no plist write)', async () => {
  // 5s < 60s floor. Guard rejects before reading/writing the real plist, so
  // the example label's StartInterval is left untouched.
  const { status, json } = await api('POST', '/api/loops/interval', { label: 'com.local-apps.example', seconds: 5 });
  assert.equal(status, 400);
  assert.match(json.error, /60-86400/);
});

test('interval above ceiling -> 400 (no plist write)', async () => {
  const { status, json } = await api('POST', '/api/loops/interval', { label: 'com.local-apps.example', seconds: 999999 });
  assert.equal(status, 400);
  assert.match(json.error, /60-86400/);
});
