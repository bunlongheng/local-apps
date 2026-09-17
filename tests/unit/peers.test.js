// Unit: lib/peers.js - the JSON fetch primitive and the bounded subnet sweep.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const { fetchJson, sweepSubnet } = require('../../lib/peers');

test('fetchJson parses JSON, rejects bad JSON, and times out a hung peer', async () => {
  const srv = http.createServer((req, res) => {
    if (req.url === '/ok') return res.end('{"a":1}');
    if (req.url === '/bad') return res.end('nope');
    // /hang: never answer
  });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${srv.address().port}`;
  assert.deepEqual(await fetchJson(`${base}/ok`), { a: 1 });
  await assert.rejects(fetchJson(`${base}/bad`), /invalid JSON/);
  await assert.rejects(fetchJson(`${base}/hang`, 150), /timeout/);
  srv.closeAllConnections?.(); srv.close();
});

test('sweepSubnet probes 253 hosts, skips self, caps concurrency, keeps only hits', async () => {
  let inFlight = 0, peak = 0; const seen = [];
  const probe = async (ip) => {
    inFlight++; peak = Math.max(peak, inFlight); seen.push(ip);
    await new Promise(r => setTimeout(r, 1)); inFlight--;
    return ip.endsWith('.7') ? { ip } : null;
  };
  const found = await sweepSubnet('1.2.3.4', probe, { concurrency: 16 });
  assert.equal(seen.length, 253); assert.ok(!seen.includes('1.2.3.4'));
  assert.ok(peak <= 16, `peak in-flight ${peak}`);
  assert.deepEqual(found, [{ ip: '1.2.3.7' }]);
  assert.deepEqual(await sweepSubnet('N/A', probe), []);
});

test('peerRecord keeps only a plain hostname, sane model and count; anything else falls back', () => {
  const { peerRecord } = require('../../lib/peers');
  assert.deepEqual(peerRecord('1.2.3.4', 9875, { hostname: 'pi5', model: 'Raspberry Pi 5', appCount: 3 }), { id: 'pi5', hostname: 'pi5', ip: '1.2.3.4', port: 9875, model: 'Raspberry Pi 5', appCount: 3 });
  const bad = peerRecord('1.2.3.4', 9875, { hostname: '<img src=x onerror=alert(1)>', model: '<b>x</b>', appCount: 'lots' });
  assert.equal(bad.hostname, '1.2.3.4'); assert.equal(bad.model, 'bxb'); assert.equal(bad.appCount, 0);
  assert.equal(peerRecord('1.2.3.4', 9875, null).hostname, '1.2.3.4');
});

test('appRecord keeps http(s) urls only and bounded plain text', () => {
  const { appRecord } = require('../../lib/peers');
  const r = appRecord({ id: 'x', name: '<b>X</b>', localUrl: 'javascript:alert(1)', prodUrl: 'https://x.example', repo: 'data:text/html,hi', status: 'weird' });
  assert.deepEqual(r, { id: 'x', name: 'bX/b', healthUrl: null, localUrl: null, caddyUrl: null, prodUrl: 'https://x.example', repo: null, icon: null, status: 'down' });
  assert.equal(appRecord({ id: '../etc' }), null);
});
