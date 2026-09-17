// e2e: the positive path. Register a throwaway app on a free port, read it back, change it,
// delete it - and the machine endpoints answer with the documented shapes.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const net = require('node:net');
const { api, serverUp } = require('./helpers');

const ID = 'zzz-e2e-lifecycle';
function freePort() { return new Promise((r) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => r(p)); }); }); }

before(async () => { if (!await serverUp()) throw new Error('local-apps server not reachable - start it first'); await api('DELETE', `/api/apps/${ID}`); });
after(async () => { await api('DELETE', `/api/apps/${ID}`); });

test('POST -> GET -> PUT -> DELETE round-trips an app', async () => {
  const port = await freePort();
  const created = await api('POST', '/api/apps', { id: ID, name: 'E2E Lifecycle', localPath: '/tmp/zzz-e2e', localUrl: `http://localhost:${port}`, healthUrl: `http://localhost:${port}`, tabColor: '#123456', prodUrl2: 'https://two.example.com' });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  assert.equal(created.json.assignedPort, port);

  const got = await api('GET', `/api/apps/${ID}`);
  assert.equal(got.status, 200); assert.equal(got.json.name, 'E2E Lifecycle'); assert.equal(got.json.tabColor, '#123456'); assert.equal(got.json.prodUrl2, 'https://two.example.com');

  const status = await api('GET', '/api/status');
  assert.ok(status.json.apps.some(a => a.id === ID), 'the new app is in /api/status');

  const put = await api('PUT', `/api/apps/${ID}`, { name: 'E2E Renamed' });
  assert.equal(put.status, 200); assert.equal((await api('GET', `/api/apps/${ID}`)).json.name, 'E2E Renamed');

  const del = await api('DELETE', `/api/apps/${ID}`);
  assert.equal(del.status, 200);
  assert.equal((await api('GET', `/api/apps/${ID}`)).status, 404);
});

test('GET /api/machine and /api/machines answer with their shapes', async () => {
  const me = await api('GET', '/api/machine');
  assert.equal(me.status, 200); assert.ok(['hub', 'agent'].includes(me.json.role)); assert.equal(typeof me.json.hostname, 'string'); assert.equal(typeof me.json.appCount, 'number');
  const list = await api('GET', '/api/machines');
  assert.equal(list.status, 200); assert.ok(Array.isArray(list.json));
  assert.equal((await api('GET', '/api/machines/zzz-no-such-machine/status')).status, 404);
});
