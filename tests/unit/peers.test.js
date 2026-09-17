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
