// Unit: public/app.js in jsdom - the dashboard's behaviour: off-box viewers see no controls, a silent
// SSE stream reconnects after 60s, keyboardControls promotes rows but never overlays, clicks send the
// matching requests, SSE frames re-render, the palette and modal tabs work, peers are read-only.
// public/app.js is evaluated inside the jsdom window, so it is outside the coverage gate by design.
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

function boot({ status, machines = [], peerStatus = null }) {
  const dom = new JSDOM(INDEX, { url: 'http://localhost:9875/', runScripts: 'outside-only', pretendToBeVisual: true });
  const w = dom.window;
  const clock = fakeClock(w);
  const sources = [];
  w.EventSource = class { constructor(url) { this.url = url; this.closed = false; sources.push(this); } close() { this.closed = true; } };
  const routes = { '/api/status': status, '/api/favicons': {}, '/api/machines': machines, '/api/log/alpha': { lines: ['ready on 4000'] }, '/api/qr': { url: 'http://10.0.0.5:9875', dataUrl: 'data:image/png;base64,AA==' } };
  if (peerStatus) for (const m of machines) routes[`/api/machines/${m.id}/status`] = peerStatus;
  const requests = [];   // every non-GET call the dashboard makes: { method, path }
  w.fetch = (p, opts) => {
    const method = (opts && opts.method) || 'GET';
    if (method !== 'GET') { requests.push({ method, path: p }); return Promise.resolve({ ok: true, status: 200, headers: { get: () => 'application/json' }, json: () => Promise.resolve(p.endsWith('/toggle') ? { id: 'alpha', disabled: true } : { ok: true }) }); }
    return Promise.resolve({ ok: p in routes, status: p in routes ? 200 : 404, headers: { get: () => 'application/json' }, json: () => Promise.resolve(routes[p]) });
  };
  w.confirm = () => true;
  w.eval(APP_JS);
  const settle = () => new Promise((r) => setTimeout(r, 10));   // real timer: let the fetch promises resolve
  return { w, clock, sources, requests, settle, root: () => w.document.getElementById('root'), close: () => w.close() };
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

const ON = { apps: APPS, viewer: 'loopback', machineRole: 'agent', lanIp: '10.0.0.5' };
const key = (w, k, extra) => w.document.dispatchEvent(new w.KeyboardEvent('keydown', Object.assign({ key: k, bubbles: true, cancelable: true }, extra || {})));

test('clicking stop, toggle and delete sends the matching request and the row follows the answer', async () => {
  const t = boot({ status: ON });
  await t.settle();
  t.root().querySelector('tr[data-act="open"]').click(); await t.settle();
  t.root().querySelector('[data-act="stop"]').click(); await t.settle();
  assert.deepEqual(t.requests.at(-1), { method: 'POST', path: '/api/stop/alpha' });
  assert.equal(t.root().querySelector('tr[data-act="open"] .dot').classList.contains('down'), true, 'row dot flips to down after stop');
  t.root().querySelector('[data-act="toggle"]').click(); await t.settle();
  assert.deepEqual(t.requests.at(-1), { method: 'POST', path: '/api/apps/alpha/toggle' });
  assert.equal(t.root().querySelector('[data-act="toggle"]').getAttribute('aria-checked'), 'false', 'switch reflects disabled=true from the answer');
  t.root().querySelector('[data-act="delete"]').click(); await t.settle();
  assert.deepEqual(t.requests.at(-1), { method: 'DELETE', path: '/api/apps/alpha' });
  t.close();
});

test('an SSE update frame re-renders the row; a removed frame drops it; an alert frame toasts', async () => {
  const t = boot({ status: ON });
  await t.settle(); t.clock.tick(3000); const es = t.sources[0]; es.onopen();
  assert.equal(t.root().querySelector('tr[data-act="open"] .dot').classList.contains('up'), true);
  es.onmessage({ data: JSON.stringify({ type: 'update', id: 'alpha', status: 'down' }) });
  assert.equal(t.root().querySelector('tr[data-act="open"] .dot').classList.contains('down'), true);
  es.onmessage({ data: JSON.stringify({ type: 'alert', id: 'alpha', name: 'Alpha' }) });
  assert.match(t.root().textContent, /Alpha went down/);
  es.onmessage({ data: JSON.stringify({ type: 'update', id: 'alpha', status: 'removed' }) });
  assert.equal(t.root().querySelector('tr[data-act="open"]'), null, 'row gone');
  t.close();
});

test('the palette opens on Cmd+K, filters as you type, arrows move the active option and Enter opens the modal', async () => {
  const t = boot({ status: { ...ON, apps: [...APPS, { id: 'beta', name: 'Beta', status: 'down', localUrl: 'http://localhost:4001', hostname: 'm4' }] } });
  await t.settle();
  key(t.w, 'k', { metaKey: true });
  const input = t.w.document.getElementById('cmdk-input'); assert.ok(input, 'palette mounted'); assert.equal(input.getAttribute('role'), 'combobox');
  assert.equal(t.w.document.querySelectorAll('[role="option"]').length, 2);
  input.value = 'bet'; input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  const opts = t.w.document.querySelectorAll('[role="option"]');
  assert.equal(opts.length, 1); assert.match(opts[0].textContent, /Beta/); assert.equal(input.getAttribute('aria-activedescendant'), 'cmdk-opt-0');
  input.value = ''; input.dispatchEvent(new t.w.Event('input', { bubbles: true }));
  key(t.w, 'ArrowDown'); assert.equal(input.getAttribute('aria-activedescendant'), 'cmdk-opt-1');
  key(t.w, 'Enter'); await t.settle();
  assert.equal(t.w.document.getElementById('cmdk-input'), null, 'palette closed');
  assert.equal(t.root().querySelector('[role="dialog"]').getAttribute('aria-label'), 'Beta', 'modal opened on the highlighted app');
  key(t.w, 'Escape'); assert.equal(t.root().querySelector('[role="dialog"]'), null, 'Escape closes the modal');
  t.close();
});

test('modal tabs switch the active pane; a discovered peer renders a machine tab whose apps are read-only', async () => {
  const t = boot({ status: ON, machines: [{ id: 'peer-1', hostname: 'peer-1', ip: '10.0.0.7', model: 'MacBook' }], peerStatus: { apps: [{ id: 'remote-a', name: 'Remote A', status: 'up', localUrl: 'http://localhost:5000' }], machineModel: 'MacBook', lanIp: '10.0.0.7' } });
  await t.settle();
  t.root().querySelector('tr[data-act="open"]').click(); await t.settle();
  assert.equal(t.root().querySelector('[data-act="tab"].active').getAttribute('data-tab'), 'info');
  t.root().querySelector('[data-act="tab"][data-tab="about"]').click(); await t.settle();
  assert.equal(t.root().querySelector('[data-act="tab"].active').getAttribute('data-tab'), 'about');
  key(t.w, 'Escape');
  const tabs = t.root().querySelectorAll('[data-act="machine"]');
  assert.equal(tabs.length, 2, 'local + 1 peer');
  tabs[1].click(); await t.settle();
  assert.match(t.root().querySelector('tr[data-act="open"]').textContent, /Remote A/);
  t.root().querySelector('tr[data-act="open"]').click(); await t.settle();
  assert.equal(t.root().querySelector('[data-act="toggle"]'), null); assert.match(t.root().textContent, /read-only on a peer/);
  t.close();
});

test('QR overlay, help dialog, copy buttons and the log tail of a down app', async () => {
  const t = boot({ status: { ...ON, apps: [{ ...APPS[0], status: 'down', logPath: '/tmp/alpha.log' }] } });
  const copied = [];
  Object.defineProperty(t.w.navigator, 'clipboard', { value: { writeText: (x) => { copied.push(x); return Promise.resolve(); } } });
  await t.settle();
  t.root().querySelector('[data-act="qr"]').click(); await t.settle();
  const qr = t.root().querySelector('.qr-pop'); assert.ok(qr, 'QR pop rendered'); assert.equal(qr.querySelector('img').getAttribute('src'), 'data:image/png;base64,AA=='); assert.match(qr.textContent, /10\.0\.0\.5:9875/);
  t.root().querySelector('[data-act="help"]').click(); await t.settle();
  const help = t.root().querySelector('[role="dialog"][aria-label="AI Instruction"]'); assert.ok(help, 'help dialog');
  help.querySelector('[data-act="copy"]').click(); await t.settle();
  assert.equal(copied.length, 1); assert.match(copied[0], /local-apps|api/i); assert.match(t.root().textContent, /Copied/);
  t.root().querySelector('[data-act="help-close"]').click(); await t.settle();
  assert.equal(t.root().querySelector('[aria-label="AI Instruction"]'), null);
  t.root().querySelector('tr[data-act="open"]').click(); await t.settle();
  assert.match(t.w.document.getElementById('logBody').textContent, /ready on 4000/, 'a down app opens with its log tail');
  t.root().querySelector('.copy-btn[data-act="copy"]').click(); await t.settle();
  assert.equal(copied.at(-1), 'http://alpha.localhost', 'first info row is the Caddy host');
  t.close();
});
