// Unit: lib/http-app.js - the node:http router that replaced express. Boots a real
// listener on an ephemeral port and drives it over HTTP; no server.js involved.
const { test, before, after } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const http = require('node:http');
const raw = (p, headers) => new Promise((resolve, reject) => http.get(base + p, { headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => resolve({ headers: r.headers, body: Buffer.concat(c) })); }).on('error', reject));
const { createApp, jsonBody, serveStatic } = require('../../lib/http-app');

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'http-app-'));
fs.writeFileSync(path.join(root, 'index.html'), '<h1>hi</h1>');
fs.writeFileSync(path.join(root, 'big.js'), 'x'.repeat(5000));
let server, base;
before(async () => {
  const app = createApp();
  app.use(jsonBody());
  app.get('/api/apps/:id', (req, res) => res.json({ id: req.params.id }));
  app.post('/api/echo', (req, res) => res.json(req.body));
  app.get('/api/boom', () => { throw new Error('kaboom'); });
  app.use(serveStatic(root));
  app.use((err, req, res, _next) => res.status(500).json({ error: err.message }));
  await new Promise(r => { server = app.listen(0, '127.0.0.1', r); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); fs.rmSync(root, { recursive: true, force: true }); });

test('a malformed percent-escape is a 400, not a crash', async () => {
  for (const p of ['/%', '/%ZZ', '/api/apps/%E0%A4%A']) {
    const r = await fetch(base + p);
    assert.equal(r.status, 400, p);
  }
  assert.equal((await fetch(base + '/api/apps/ok')).status, 200, 'server still alive after the bad requests');
});

test(':param routing decodes the segment and unmatched paths fall through to 404', async () => {
  assert.deepEqual(await (await fetch(base + '/api/apps/my%20app')).json(), { id: 'my app' });
  const r = await fetch(base + '/nope');
  assert.equal(r.status, 404);
  assert.match(await r.text(), /^Cannot GET \/nope/);
});

test('HEAD is answered by the GET handler with no body', async () => {
  const r = await fetch(base + '/api/apps/x', { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal((await r.text()).length, 0);
});

test('JSON bodies: parsed, malformed is 400, oversize is 413', async () => {
  const ok = await fetch(base + '/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":1}' });
  assert.deepEqual(await ok.json(), { a: 1 });
  const bad = await fetch(base + '/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{nope' });
  assert.equal(bad.status, 400);
  const huge = await fetch(base + '/api/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ x: 'y'.repeat(101 * 1024) }) });
  assert.equal(huge.status, 413);
});

test('static: index.html for /, traversal falls through, gzip only when accepted', async () => {
  assert.equal(await (await fetch(base + '/')).text(), '<h1>hi</h1>');
  assert.equal((await fetch(base + '/../package.json')).status, 404);
  assert.equal((await fetch(base + '/%2e%2e/package.json')).status, 404);
  const plain = await fetch(base + '/big.js', { headers: { 'accept-encoding': 'identity' } });
  assert.equal(plain.headers.get('content-encoding'), null);
  assert.equal((await plain.text()).length, 5000);
  const gz = await raw('/big.js', { 'accept-encoding': 'gzip' });   // fetch() would transparently gunzip
  assert.equal(gz.headers['content-encoding'], 'gzip');
  assert.equal(zlib.gunzipSync(gz.body).toString().length, 5000);
});

test('a throwing handler reaches the 4-arg error middleware', async () => {
  const r = await fetch(base + '/api/boom');
  assert.equal(r.status, 500);
  assert.deepEqual(await r.json(), { error: 'kaboom' });
});

test('static: If-Modified-Since at or after the mtime gets 304, older gets 200', async () => {
  const first = await fetch(base + '/big.js');
  const lm = first.headers.get('last-modified');
  const same = await fetch(base + '/big.js', { headers: { 'if-modified-since': lm } });
  assert.equal(same.status, 304);
  const older = await fetch(base + '/big.js', { headers: { 'if-modified-since': new Date(Date.parse(lm) - 60000).toUTCString() } });
  assert.equal(older.status, 200);
});
