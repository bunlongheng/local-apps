// Unit: public/app.js in jsdom - the 3 behaviours round 9 changed: off-box viewers see no controls,
// a silent SSE stream reconnects after 60s, and keyboardControls promotes rows but never overlays.
// Timers and the clock are the window's own, replaced with a fake before app.js is evaluated, so
// the test drives every interval deterministically.
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..', '..');
const APP_JS = fs.readFileSync(path.join(ROOT, 'public', 'app.js'), 'utf8');
const INDEX = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const APPS = [{ id: 'alpha', name: 'Alpha', status: 'up', localUrl: 'http://localhost:4000', launchAgent: 'com.t.alpha', hostname: 'm4' }];

function fakeClock(w) {
  let now = 1_000_000, seq = 0; const timers = new Map();
  const add = (fn, ms, repeat) => { const id = ++seq; timers.set(id, { fn, at: now + (ms || 0), ms: ms || 0, repeat }); return id; };
  w.setTimeout = (fn, ms) => add(fn, ms, false); w.setInterval = (fn, ms) => add(fn, ms, true);
  w.clearTimeout = w.clearInterval = (id) => timers.delete(id);
  w.Date.now = () => now;
  return {
    // Advance the clock, running every due timer in order (intervals re-arm).
    tick(ms) {
      const end = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        const [id, t] = due; now = t.at;
        if (t.repeat) t.at += t.ms; else timers.delete(id);
        t.fn();
      }
      now = end;
    },
  };
}

function boot({ status }) {
  const dom = new JSDOM(INDEX, { url: 'http://localhost:9875/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const clock = fakeClock(w);
  const sources = [];
  w.EventSource = class { constructor(url) { this.url = url; this.closed = false; sources.push(this); } close() { this.closed = true; } };
  const routes = { '/api/status': status, '/api/favicons': {}, '/api/machines': [] };
  w.fetch = (p) => Promise.resolve({ ok: p in routes, status: p in routes ? 200 : 404, headers: { get: () => 'application/json' }, json: () => Promise.resolve(routes[p]) });
  w.eval(APP_JS);
  const settle = () => new Promise((r) => setTimeout(r, 10));   // real timer: let the fetch promises resolve
  return { w, clock, sources, settle, root: () => w.document.getElementById('root'), close: () => w.close() };
}

test('an off-box viewer gets no toggle, start/stop or delete controls; on the box they render', async () => {
  const off = boot({ status: { apps: APPS, viewer: 'offbox', machineRole: 'agent', lanIp: '10.0.0.5' } });
  await off.settle();
  assert.ok(off.root().querySelector('tr[data-act="open"]'), 'the app row rendered');
  off.root().querySelector('tr[data-act="open"]').click(); await off.settle();
  assert.ok(off.root().querySelector('[role="dialog"]'), 'modal opened');
  assert.equal(off.root().querySelector('[data-act="toggle"]'), null, 'no toggle off-box');
  assert.equal(off.root().querySelector('[data-act="delete"]'), null, 'no delete off-box');
  assert.equal(off.root().querySelector('[data-act="start"], [data-act="stop"]'), null, 'no start/stop off-box');
  assert.match(off.root().textContent, /read-only off-box/);
  off.close();
  const on = boot({ status: { apps: APPS, viewer: 'loopback', machineRole: 'agent', lanIp: '10.0.0.5' } });
  await on.settle();
  on.root().querySelector('tr[data-act="open"]').click(); await on.settle();
  assert.ok(on.root().querySelector('[data-act="toggle"][role="switch"]'), 'toggle renders on the box');
  assert.ok(on.root().querySelector('[data-act="delete"]'), 'delete renders on the box');
  assert.ok(on.root().querySelector('[data-act="stop"]'), 'stop renders on the box for an up app');
  on.close();
});

test('a silent SSE stream is closed and reopened after 60s without a heartbeat; a live one is left alone', async () => {
  const t = boot({ status: { apps: APPS, viewer: 'loopback', machineRole: 'agent', lanIp: '10.0.0.5' } });
  await t.settle();
  t.clock.tick(3000);                                   // connectSSE is scheduled 3s after boot
  assert.equal(t.sources.length, 1); const first = t.sources[0];
  first.onopen();
  t.clock.tick(45000);                                  // 3 watchdog ticks, all within the 60s budget
  assert.equal(first.closed, false); assert.equal(t.sources.length, 1);
  first.onmessage({ data: JSON.stringify({ type: 'update', id: 'alpha', status: 'down' }) });   // any frame resets the budget
  t.clock.tick(45000);
  assert.equal(first.closed, false, 'a stream that sent a frame 45s ago is alive');
  t.clock.tick(30000);                                  // now 75s since the last frame
  assert.equal(first.closed, true, 'silent for over 60s: closed');
  assert.equal(t.sources.length, 2, 'and reopened');
  t.close();
});

test('keyboardControls promotes rows and chips to role=button, never the overlay or the dialog', async () => {
  const t = boot({ status: { apps: APPS, viewer: 'loopback', machineRole: 'agent', lanIp: '10.0.0.5' } });
  await t.settle();
  const row = t.root().querySelector('tr[data-act="open"]');
  assert.equal(row.getAttribute('role'), 'button'); assert.equal(row.tabIndex, 0);
  row.click(); await t.settle();
  const overlay = t.root().querySelector('[data-act="overlay-modal"]');
  assert.ok(overlay); assert.equal(overlay.getAttribute('role'), null, 'backdrop is not a button'); assert.equal(overlay.hasAttribute('tabindex'), false);
  assert.equal(t.root().querySelector('[role="dialog"]').getAttribute('tabindex'), null);
  t.close();
});
