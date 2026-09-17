// Unit: public/sw.js - the fetch handler never touches /api/ (live state, an infinite SSE stream),
// caches same-origin 200s, and answers a real 503 when offline with nothing cached.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { Response } = globalThis;
const SW = path.join(__dirname, '..', '..', 'public', 'sw.js');
const SRC = fs.readFileSync(SW, 'utf8');
// A vm.Script with the real filename so V8 attributes sw.js to its file and it counts toward the gate.
const runSw = (ctx) => new vm.Script(SRC, { filename: SW }).runInNewContext(ctx);   // the fetch Response class Node ships; named so eslint's node env sees it

function boot({ online = true, cached = null } = {}) {
  const listeners = {}, puts = [];
  const self = { addEventListener: (n, fn) => { listeners[n] = fn; }, skipWaiting: () => {}, clients: { claim: () => {} }, location: { origin: 'http://localhost:9875' } };
  const caches = { open: async () => ({ put: async (req) => puts.push(req.url) }), match: async () => cached, keys: async () => ['app-cache-v1', 'app-cache-v3'], delete: async () => true };
  const fetch = async () => { if (!online) throw new Error('offline'); return new Response('page', { status: 200 }); };
  const ctx = { self, caches, fetch, Response, URL, Promise, console };
  runSw(ctx);
  const dispatch = (method, url) => {
    let answered = null;
    listeners.fetch({ request: { method, url }, respondWith: (p) => { answered = p; } });
    return answered;
  };
  return { listeners, puts, dispatch };
}

test('GET /api/* and non-GET requests are left to the network untouched', () => {
  const t = boot();
  assert.equal(t.dispatch('GET', 'http://localhost:9875/api/events'), null);
  assert.equal(t.dispatch('GET', 'http://localhost:9875/api/status'), null);
  assert.equal(t.dispatch('POST', 'http://localhost:9875/api/apps'), null);
});

test('a same-origin 200 is served from the network and copied into the cache', async () => {
  const t = boot();
  const res = await t.dispatch('GET', 'http://localhost:9875/app.js');
  assert.equal(res.status, 200); assert.equal(await res.text(), 'page');
  await new Promise(r => setImmediate(r));
  assert.deepEqual(t.puts, ['http://localhost:9875/app.js']);
});

test('offline: a cached copy wins, otherwise a real 503 (never undefined)', async () => {
  const hit = new Response('cached', { status: 200 });
  assert.equal(await boot({ online: false, cached: hit }).dispatch('GET', 'http://localhost:9875/'), hit);
  const res = await boot({ online: false }).dispatch('GET', 'http://localhost:9875/');
  assert.equal(res.status, 503); assert.equal(await res.text(), 'offline');
});

test('activate drops every cache but the current one', async () => {
  const t = boot(); const deleted = [];
  const caches = { keys: async () => ['app-cache-v1', 'app-cache-v3'], delete: async (k) => deleted.push(k) };
  const self2 = { addEventListener: (n, fn) => { t.listeners[n] = fn; }, skipWaiting: () => {}, clients: { claim: () => {} }, location: { origin: 'x' } };
  runSw({ self: self2, caches, fetch: async () => {}, Response, URL, Promise, console });
  let done; t.listeners.activate({ waitUntil: (p) => { done = p; } }); await done;
  assert.deepEqual(deleted, ['app-cache-v1']);
});
