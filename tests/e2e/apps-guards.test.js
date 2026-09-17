// e2e: app registry endpoints. Read-only smoke checks plus mutation guards that
// reject bad input. The mutation cases use ids that do not exist, so nothing in
// apps.config.json is created, changed, or deleted.
const { test, before } = require('node:test');
const assert = require('node:assert');
const { api, serverUp } = require('./helpers');

const MISSING = 'zzz-not-a-real-app-xyz';

before(async () => {
  if (!await serverUp()) {
    throw new Error('local-apps server not reachable on 9875 - start it first (npm run dev)');
  }
});

test('GET /api/apps returns an array of apps', async () => {
  const { status, json } = await api('GET', '/api/apps');
  assert.equal(status, 200);
  assert.ok(Array.isArray(json));
  assert.ok(json.length > 0, 'expected at least one curated app');
  assert.ok(json.every(a => typeof a.id === 'string'));
});

test('GET /api/status returns per-app state', async () => {
  const { status, json } = await api('GET', '/api/status');
  assert.equal(status, 200);
  assert.ok(json && typeof json === 'object');
});

test('GET /api/apps/:id unknown -> 404', async () => {
  const { status, json } = await api('GET', `/api/apps/${MISSING}`);
  assert.equal(status, 404);
  assert.match(json.error, /not found/);
});

test('toggle unknown app -> 404 (no state change)', async () => {
  const { status, json } = await api('POST', `/api/apps/${MISSING}/toggle`);
  assert.equal(status, 404);
  assert.match(json.error, /not found/);
});

test('PUT unknown app -> 404', async () => {
  const { status, json } = await api('PUT', `/api/apps/${MISSING}`, { name: 'Nope' });
  assert.equal(status, 404);
  assert.match(json.error, /not found/);
});

test('DELETE unknown app -> 404 (nothing removed)', async () => {
  const { status, json } = await api('DELETE', `/api/apps/${MISSING}`);
  assert.equal(status, 404);
  assert.match(json.error, /not found/);
});

test('create app with no id -> 400', async () => {
  const { status, json } = await api('POST', '/api/apps', { name: 'No Id' });
  assert.equal(status, 400);
  assert.match(json.error, /id is required/);
});

test('create app with invalid id -> 400 (no app created)', async () => {
  const { status, json } = await api('POST', '/api/apps', { id: 'Bad ID With Spaces!' });
  assert.equal(status, 400);
  assert.match(json.error, /lowercase alphanumeric/);
});

test('create app with shell-metachar localPath -> 400 (no plist injection)', async () => {
  const { status, json } = await api('POST', '/api/apps', { id: 'guard-evil-path', localPath: '/tmp/x";touch /tmp/pwned;"' });
  assert.equal(status, 400);
  assert.match(json.error, /localPath/);
});

test('create app with injected startCommand -> 400 (no command injection)', async () => {
  const { status, json } = await api('POST', '/api/apps', { id: 'guard-evil-cmd', localPath: '/tmp/ok', startCommand: 'npm run dev; rm -rf /' });
  assert.equal(status, 400);
  assert.match(json.error, /startCommand/);
});
