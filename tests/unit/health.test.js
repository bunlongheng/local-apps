// Unit: lib/health.js success path and the downSince reset on recovery.
const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const makeHealth = require('../../lib/health');

test('tcpCheck is true for 2xx, false for 5xx, refused and timeout; checkSingle resets downSince on recovery', async () => {
  const srv = http.createServer((q, r) => { if (q.url === '/ok') return r.end('ok'); if (q.url === '/hang') return; r.statusCode = 500; r.end(); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r)); const base = `http://127.0.0.1:${srv.address().port}`;
  const events = []; const h = makeHealth({ broadcast: (e) => events.push(e), timeoutMs: 100 });
  assert.equal(await h.tcpCheck(base + '/ok'), true);
  assert.equal(await h.tcpCheck(base + '/err'), false);
  assert.equal(await h.tcpCheck('http://127.0.0.1:1/'), false, 'refused');
  assert.equal(await h.tcpCheck(base + '/hang'), false, 'a server that never answers is down after the timeout');
  const s = h.getState('a'); s.status = 'down'; s.downSince = 1; s.restartAttempts = 3;
  await h.checkSingle({ id: 'a', healthUrl: base + '/ok' });
  assert.equal(s.status, 'up'); assert.equal(s.downSince, null); assert.equal(s.restartAttempts, 0);
  assert.deepEqual(events.at(-1), { type: 'update', id: 'a', status: 'up' });
  srv.closeAllConnections?.(); srv.close();
});

test('tcpCheck probes with HEAD and falls back to GET only on 405/501', async () => {
  const seen = [];
  const srv = http.createServer((q, r) => { seen.push(q.method); if (q.method === 'HEAD') { r.statusCode = 405; return r.end(); } r.end('ok'); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  const h = makeHealth({ broadcast: () => {} });
  assert.equal(await h.tcpCheck(`http://127.0.0.1:${srv.address().port}/`), true);
  assert.deepEqual(seen, ['HEAD', 'GET']);
  srv.closeAllConnections?.(); srv.close();
});

test('processCheck finds a running process by its command line and not after it exits', async () => {
  const { spawn } = require('node:child_process');
  const marker = `zzz-marker-${process.pid}`;
  // The marker rides in the script text so it is part of the command line pgrep -f sees.
  const child = spawn(process.execPath, ['-e', `setInterval(() => {}, 1000) // ${marker}`], { stdio: 'ignore' });
  const h = makeHealth({ broadcast: () => {} });
  // Bounded poll, not a fixed sleep: a loaded runner must not flake the only real-process test.
  const until = async (want) => { for (let i = 0; i < 100; i++) { if (await h.processCheck(marker) === want) return true; await new Promise(r => setTimeout(r, 50)); } return false; };
  assert.ok(await until(true), 'seen while running');
  child.kill('SIGKILL'); await new Promise(r => child.on('exit', r));
  assert.ok(await until(false), 'gone after exit');
});
