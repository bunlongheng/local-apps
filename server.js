const { createApp, jsonBody, serveStatic } = require('./lib/http-app');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
// Async exec for the auto-restart chain. Those commands run inside the health loop and
// block every request, the SSE stream, and the next health tick while they run - L3's
// `npm install` alone is a 60s ceiling. Awaiting instead keeps the loop responsive.
const execAsync = require('util').promisify(require('child_process').exec);
const QRCode = require('qrcode');
const db = require('./db');
const { startCmd, bootoutCmd, killPort } = require('./launchctl-cmds');
const { recordAttempt } = require('./lib/escalation');
const { decide } = require('./lib/tick');
const { runLevel } = require('./lib/chain');
const { isValidId, validateAppFields, xmlEscape } = require('./lib/validate');
const { isChromeExtensionRepo, CHROME_EXT_ERROR } = require('./lib/chrome-ext');
const makeCaddy = require('./lib/caddy');
const makeLaunchd = require('./lib/launchd');
const makeHealth = require('./lib/health');
const { fetchJson, sweepSubnet, peerRecord, appRecord } = require('./lib/peers');

const app = createApp();
// True only when run directly (node server.js), false when require()d by a test - lets the
// test import the configured app without starting the health loops, peer probes, or listener.
const IS_MAIN = require.main === module;
// Failures the chain deliberately tolerates (a bootout on a service that is not loaded,
// a kill on a free port) are logged, never swallowed: LOCAL_APPS_DEBUG=1 prints them.
const dbg = (where, e) => { if (process.env.LOCAL_APPS_DEBUG) console.warn(`  [debug] ${where}: ${e && e.message ? e.message : e}`); };
// App logs live in a per-user directory, never in world-shared /tmp with a guessable name.
const LOG_DIR = process.platform === 'darwin' ? path.join(os.homedir(), 'Library', 'Logs', 'local-apps') : path.join(os.tmpdir(), `local-apps-${process.getuid ? process.getuid() : 'user'}`);
try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) { dbg('logdir', e); }
// Baseline security headers, ported from the former next.config so collapsing to a
// single service (UI + API on :9875) keeps the same posture. HSTS is omitted:
// this is served over plain http on the LAN/tailnet, and forcing HTTPS would break access.
app.use((req, res, next) => {
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data: https:",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "frame-ancestors 'none'",
  ].join('; '));
  next();
});
app.use((req, res, next) => {
  // Cache static files for 1 hour, busted by ?v= timestamp in JS
  if (req.path.match(/\.(ico|png|svg|jpg|css|js|woff2?)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  next();
});
const PORT = 9875;  // serves UI + control API (Next.js removed)
const CHECK_INTERVAL = 30000;

// Machine role: "hub" (full orchestrator + bots) or "agent" (status reporting only)
// Set via: MACHINE_ROLE=agent node server.js  or in machine-role.json
const MACHINE_ROLE = (() => {
  if (process.env.MACHINE_ROLE) return process.env.MACHINE_ROLE;
  const roleFile = path.join(__dirname, 'machine-role.json');
  if (fs.existsSync(roleFile)) {
    try { return JSON.parse(fs.readFileSync(roleFile, 'utf8')).role || 'hub'; } catch (e) { dbg('misc', e); }
  }
  return 'hub';
})();
const IS_HUB = MACHINE_ROLE === 'hub';
const CADDYFILE = process.env.CADDYFILE || '/opt/homebrew/etc/Caddyfile';
const CADDY_ERROR_ROOT = path.dirname(CADDYFILE);
const { addCaddyEntry, removeCaddyEntry, renameCaddyEntry } =
  makeCaddy({ caddyfile: CADDYFILE, errorRoot: CADDY_ERROR_ROOT, getLanIp, exec: execSync });
const NPM_PATH = (() => {
  try { return execSync('which npm', { timeout: 5000 }).toString().trim(); }
  catch { return '/opt/homebrew/bin/npm'; }
})();

app.use(jsonBody());

// --- Optional shared-secret gate ---------------------------------------------
// When LOCAL_APPS_TOKEN is set, every mutating request (POST/PUT/DELETE) and every
// sensitive read route requires a matching `x-local-apps-token` header. Unset -> off-box callers
// may still VIEW non-sensitive status (without paths), but every action and sensitive read is denied. Historically:
// open (unchanged default), so this never breaks an existing single-machine setup; set
// it to lock the LAN/tailnet surface. Sensitive GETs = any log reader (/api/log/*, /api/*/log).
// Trust-loopback auth policy lives in lib/auth-gate.js (pure + unit-tested). See it for the rule.
const { decide: authDecide, isLoopback, effectiveAddress } = require('./lib/auth-gate');
// Off-box viewers (the LAN/tailnet dashboard) get status without filesystem paths or launchd internals.
const OFFBOX_STRIP = ['localPath', 'logPath', 'launchAgentPath', 'launchAgent', 'startCommand', 'processCheck', 'about', 'features', 'architect', 'deploy', 'security', 'performance', 'prompt'];
const clientAddress = (req) => effectiveAddress(req.socket.remoteAddress || '', req.get('x-forwarded-for'));
const forViewer = (req, a) => { if (isLoopback(clientAddress(req))) return a; const o = { ...a }; for (const k of OFFBOX_STRIP) delete o[k]; return o; };
const AUTH_TOKEN = process.env.LOCAL_APPS_TOKEN || '';
app.use((req, res, next) => {
  const d = authDecide({
    remoteAddress: req.socket.remoteAddress || '',
    method: req.method,
    path: req.path,
    token: req.get('x-local-apps-token'),
    configuredToken: AUTH_TOKEN,
    host: req.headers.host,
    origin: req.get('origin'),
    forwardedFor: req.get('x-forwarded-for'),
    allowedHosts: [LAN_IP, TAILSCALE_IP, os.hostname(), `${os.hostname()}.local`],
  });
  if (d.allow) return next();
  return res.status(d.status).json({ error: 'unauthorized - control actions and sensitive reads require LOCAL_APPS_TOKEN off localhost' });
});

// The dashboard shell is served with a real asset stamp (mtime of app.js/app.css) in place
// of the hand-typed ?v= so a deploy busts the 1h asset cache by itself; the shell is no-cache.
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');
const ASSET_STAMP = Math.max(...['app.js', 'app.css'].map(f => { try { return Math.floor(fs.statSync(path.join(__dirname, 'public', f)).mtimeMs); } catch { return 0; } }));
app.get('/', (req, res) => {
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.end(INDEX_HTML.replace(/\?v=\d+/g, `?v=${ASSET_STAMP}`));
});
app.use(serveStatic(path.join(__dirname, 'public')));

// --- Caddy reverse-proxy management -> lib/caddy.js ---

// Optional integration: ~/.claude/tab-colors.json is the owner's terminal-tab registry. When
// the file exists, a rename keeps its label in sync; when it does not, this is a no-op.
function updateTabColors(id, label, caddyUrl) {
  const colorsPath = path.join(os.homedir(), '.claude', 'tab-colors.json');
  try {
    const colors = JSON.parse(fs.readFileSync(colorsPath, 'utf8'));
    // Try app ID first, then caddy hostname
    const caddyHost = caddyUrl ? caddyUrl.replace(/^https?:\/\//, '').replace(/\.localhost.*/, '') : null;
    const key = colors[id] ? id : (caddyHost && colors[caddyHost]) ? caddyHost : null;
    if (key) {
      colors[key].label = label.toUpperCase();
      fs.writeFileSync(colorsPath, JSON.stringify(colors, null, 2));
    }
  } catch (e) { dbg('updateTabColors', e); }
}

// --- LaunchAgent management ---
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const USERNAME = os.userInfo().username;
const { createLaunchAgent, removeLaunchAgent } =
  makeLaunchd({ username: USERNAME, launchAgentsDir: LAUNCH_AGENTS_DIR, npmPath: NPM_PATH, xmlEscape, exec: execSync });

// createLaunchAgent, removeLaunchAgent -> lib/launchd.js

const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 9875; // below monitor port

// --- Port allocation (provisioning and POST /api/apps) ---
function isPortTaken(port, excludeId) {
  for (const a of db.getApps()) {
    if (excludeId && a.id === excludeId) continue;
    if (a.localUrl) {
      try { if (parseInt(new URL(a.localUrl).port) === port) return a.id; } catch (e) { dbg('isPortTaken', e); }
    }
    if (a.healthUrl) {
      try { if (parseInt(new URL(a.healthUrl).port) === port) return a.id; } catch (e) { dbg('isPortTaken', e); }
    }
  }
  return null;
}
function getNextAvailablePort() {
  const usedPorts = new Set();
  for (const a of db.getApps()) {
    for (const u of [a.localUrl, a.healthUrl]) {   // both count, exactly as isPortTaken counts them
      if (!u) continue;
      try { const p = parseInt(new URL(u).port); if (p) usedPorts.add(p); } catch (e) { dbg('getNextAvailablePort', e); }
    }
  }
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) return p;
  }
  return null;
}

// --- Full infra setup/teardown ---
// Caddy proxies and LaunchAgents are host features of a Homebrew macOS box. Anywhere
// else the dashboard and API run in monitoring mode, exactly as the README promises.
const CAN_PROVISION = process.platform === 'darwin';
function setupInfra(id, data) {
  const result = {};

  // Port: use provided localUrl, healthUrl, or auto-assign
  let port = null;
  if (data.localUrl) {
    try { port = new URL(data.localUrl).port; } catch (e) { dbg('setupInfra', e); }
  }
  if (!port && data.healthUrl) {
    try { port = new URL(data.healthUrl).port; } catch (e) { dbg('setupInfra', e); }
  }
  if (!port) {
    port = getNextAvailablePort();
    if (port) {
      result.localUrl = `http://localhost:${port}`;
      result.healthUrl = `http://localhost:${port}`;
    }
  }

  if (!CAN_PROVISION) return result;
  // Caddy
  if (port) {
    result.caddyUrl = addCaddyEntry(id, port);
  }

  // LaunchAgent
  if (data.localPath) {
    const logPath = data.logPath || path.join(LOG_DIR, `${id}.log`);
    const la = createLaunchAgent(id, data.localPath, logPath, data.startCommand);
    result.launchAgent = la.launchAgent;
    result.launchAgentPath = la.launchAgentPath;
    result.logPath = logPath;
  }

  return result;
}

async function teardownInfra(app) {
  // Takes the record, not the id: DELETE calls this before the row is gone, so the port is known.
  const id = typeof app === 'string' ? app : app.id;
  try {
    const port = app && app.localUrl ? new URL(app.localUrl).port : null;
    if (port) await killPort(port);
  } catch (e) { dbg('teardown/killPort', e); }
  if (!CAN_PROVISION) return;
  if (app && app.launchAgent) { try { await execAsync(bootoutCmd(process.getuid(), app.launchAgent), { timeout: 10000 }); } catch (e) { dbg('teardown/bootout', e); } }
  // A PUT may have renamed the Caddy host; tear down the block the record actually points at.
  const host = app && app.caddyUrl ? String(app.caddyUrl).replace(/^https?:\/\//, '').replace(/\.localhost.*$/, '') : id;
  removeCaddyEntry(host);
  if (host !== id) removeCaddyEntry(id);
  removeLaunchAgent(id);
  console.log(`  cleanup: ${id}`);
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // Skip Tailscale's CGNAT block (RFC 6598, the 100.64/10 range) so the LAN QR shows the
      // real LAN IP, not the Tailscale IP, regardless of interface order.
      const [a, b] = iface.address.split('.').map(Number);
      if (a === 100 && b >= 64 && b <= 127) continue;
      return iface.address;
    }
  }
  return 'N/A';
}
let LAN_IP = getLanIp();
// Boot can happen (via launchd KeepAlive) before the LAN interface is up, freezing
// LAN_IP at 'N/A'. Refresh on an interval like TAILSCALE_IP so it self-heals.
setInterval(() => { LAN_IP = getLanIp(); }, 60000).unref();

// --- Tailscale IP detection (cached; refreshed on an interval, not per request) ---
function getTailscaleIp() {
  // Tailscale ships as a Homebrew formula, a Mac App Store app, or the standalone package; look
  // in PATH first, then the 3 known locations.
  const bins = ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  for (const b of bins) {
    try { const ip = execSync(`${b} ip -4 2>/dev/null`, { timeout: 5000 }).toString().trim(); if (ip) return ip; } catch (e) { dbg('tailscale', e); }
  }
  return null;
}
let TAILSCALE_IP = getTailscaleIp();
// Refresh out-of-band so the hot /api/status path never shells out (execSync would
// block the single-threaded event loop on every poll from every open tab).
// The 60s refresh is async: a slow tailscale binary must never block the event loop.
setInterval(() => {
  const bins = ['tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale', '/Applications/Tailscale.app/Contents/MacOS/Tailscale'];
  (function tryNext(i) {
    if (i >= bins.length) { TAILSCALE_IP = null; return; }
    require('child_process').exec(`${bins[i]} ip -4 2>/dev/null`, { timeout: 5000 }, (err, out) => { const ip = String(out || '').trim(); if (!err && ip) TAILSCALE_IP = ip; else tryNext(i + 1); });
  })(0);
}, 60000).unref();

// --- Machine model detection ---
// sysctl answers in ~20 ms; system_profiler can take seconds, so it refines the label after boot
// instead of blocking the listener.
let MACHINE_MODEL = (() => {
  try { const hw = execSync('/usr/sbin/sysctl -n hw.model 2>/dev/null', { timeout: 5000 }).toString().trim(); return hw.includes('Macmini') || hw.startsWith('Mac16,') ? 'Mac mini' : (hw || 'Mac'); }
  catch { return process.platform === 'darwin' ? 'Mac' : os.type(); }
})();
setTimeout(() => {
  require('child_process').exec('system_profiler SPHardwareDataType 2>/dev/null', { timeout: 10000 }, (err, out) => {
    if (err) return dbg('system_profiler', err);
    const m = String(out).match(/Model Name: (.+)/); if (m) MACHINE_MODEL = m[1].trim();
  });
}, 5000).unref();

// --- HTTP client (used across peer sync + health checks) ---

// --- SSE clients ---
const sseClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// Health-check primitives (state, tcpCheck, processCheck, checkSingle) -> lib/health.js
const { getState, clearState, tcpCheck, processCheck, checkSingle } = makeHealth({ broadcast });

// --- Health check loop ---
let checkAllRunning = false;
async function checkAll() {
  // Re-entrancy guard: a slow tick (serial tcp checks + auto-restart execSync) can
  // outlast the 30s interval; overlapping runs would stack restart attempts and block
  // the event loop further. Skip a tick if the previous one is still in flight.
  if (checkAllRunning) return;
  checkAllRunning = true;
  try {
  const apps = db.getApps();
  // Probe every app concurrently. The checks are independent reads with no shared state,
  // and serially they cost ~555ms across 64 apps when the down ones refuse instantly -
  // but a *hung* app burns the full 3s timeout, so ~10 of those used to push a tick past
  // its own 30s interval. The escalation loop below stays sequential on purpose: it shells
  // out, and 65 concurrent `npm install`s would be worse than a slow tick.
  const probes = await Promise.all(apps.map((appCfg) => {
    if (appCfg.healthUrl) return tcpCheck(appCfg.healthUrl);
    if (appCfg.processCheck) return processCheck(appCfg.processCheck);
    return false;
  }));

  // Read once per tick, not once per app: 2 booleans that cannot change mid-tick.
  const autoRestartCfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auto-restart.json'), 'utf8')); } catch { return {}; } })();
  const autoRestartEnabled = !!autoRestartCfg.enabled;
  const autoRestartAgent = autoRestartCfg.agent === true;
  for (const [index, appCfg] of apps.entries()) {
    const s = getState(appCfg.id);
    s.lastChecked = new Date().toISOString();
    const now = Date.now();
    // === Auto-restart escalation chain ===
    // Level 1 (30s):  detect down, kickstart via launchctl
    // Level 2 (90s):  still down? kill port, bootout+bootstrap fresh
    // Level 3 (180s): still down? read logs, try common fixes (npm install, port kill)
    // Level 4 (300s): still down? hand to the local agent (opt-in)
    // Level 5: breaker trips on 3 flaps in 2 min or a chain exhausted and still down; a
    // breaker OFF re-arms when observed up or after the cooldown.
    // Which of these fires is decided by lib/tick.js (pure, unit-tested); this loop only executes it.
    const d = decide({ s, app: appCfg, up: probes[index], now, hub: IS_HUB, autoRestart: autoRestartEnabled });
    if (d.changed) {
      broadcast({ type: 'update', id: appCfg.id, status: d.status });
      if (d.status === 'down') broadcast({ type: 'alert', id: appCfg.id, name: appCfg.name });
    }
    if (d.rearm) {
      db.setAppDisabled(appCfg.id, false);
      appCfg.disabled = false;
      console.log(`  [L5] re-armed ${appCfg.id} (${d.rearm})`);
      broadcast({ type: 'update', id: appCfg.id, status: d.status, disabled: false });
    }
    if (d.recovered && d.recovered.attempts > 0) console.log(`  ✓ recovered: ${appCfg.id} (after ${d.recovered.attempts} attempts, ${Math.round(d.recovered.downMs / 1000)}s)`);
    if (!d.trip && !d.level) continue;

    const uid = process.getuid();
    const label = appCfg.launchAgent;
    const plistPath = appCfg.launchAgentPath;
    const port = appCfg.localUrl ? (() => { try { return new URL(appCfg.localUrl).port; } catch { return null; } })() : null;
    if (d.trip) {
      try {
        if (port) await killPort(port);
        if (label) await execAsync(bootoutCmd(uid, label), { timeout: 10000 });
      } catch (e) { dbg('checkAll', e); }
      db.setAppDisabled(appCfg.id, true, 'breaker');
      appCfg.disabled = true;
      console.log(`  [L5] circuit breaker -> disabled ${appCfg.id} (${d.trip.flaps} flaps, ${d.trip.attempts} attempts)`);
      broadcast({ type: 'update', id: appCfg.id, status: 'down', disabled: true });
      broadcast({ type: 'alert', id: appCfg.id, name: appCfg.name, disabled: true });
      continue;
    }
    // Every level records the attempt before running its command.
    recordAttempt(s, now);
    try {
      await runLevel(d.level, { id: appCfg.id, uid, label, plistPath, port, dir: appCfg.localPath, logPath: appCfg.logPath || path.join(LOG_DIR, `${appCfg.id}.log`), downMs: now - s.downSince },
        { exec: execAsync, killPort, exists: fs.existsSync, log: console.log, warn: console.warn, startCmd, bootoutCmd, spawn, agent: autoRestartAgent, openLog: (p) => fs.openSync(p, 'a') });
    } catch (e) { dbg(`L${d.level}`, e); }
  }
  } finally { checkAllRunning = false; }
}

// Validate app id: lowercase alphanumeric, hyphens only, 1-64 chars
// isValidId, isSafePath, isSafeCommand, validateAppFields, xmlEscape -> lib/validate.js

// --- Machine Sync API ---
// Each machine exposes its app list + identity. Machines can pull from each other.

// --- File watcher (public dir only) ---
let reloadTimer = null;
if (IS_MAIN) fs.watch(path.join(__dirname, 'public'), { recursive: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 200);
});

// --- Routes live in routes/*.js, registered against a small ctx. LAN_IP, TAILSCALE_IP and
// MACHINE_MODEL are getters because they refresh on timers. ---
const ctx = { isLoopback, clientAddress, appRecord, bootoutCmd, getNextAvailablePort, isPortTaken, killPort, CHROME_EXT_ERROR, IS_HUB, IS_MAIN, MACHINE_ROLE, PORT, QRCode, addCaddyEntry, broadcast, checkSingle, clearState, db, dbg, execAsync, fetchJson, forViewer, getState, isChromeExtensionRepo, isValidId, peerRecord, renameCaddyEntry, setupInfra, spawn, sseClients, startCmd, sweepSubnet, teardownInfra, updateTabColors, validateAppFields,
  LAN_IP: () => LAN_IP, TAILSCALE_IP: () => TAILSCALE_IP, MACHINE_MODEL: () => MACHINE_MODEL };
require('./routes/apps')(app, ctx);
require('./routes/meta')(app, ctx);
const { startupSync } = require('./routes/machines')(app, ctx);

// --- Boot ---
if (IS_MAIN) {
  checkAll();
  setInterval(checkAll, CHECK_INTERVAL);
}

// NOTE (2026-05-21): A2A (agent-to-agent) was removed from local-apps and consolidated
// into the dashboard app at :3003 (POST /api/a2a). local-apps is monitoring-only - do not
// re-add an A2A endpoint here. The single A2A server lives in ~/Sites/claude.

// Global error handler - no stack traces leaked, but honest status codes.
// A thrown error with an explicit .status keeps it (400/404/...); everything else is
// a real server fault -> 500, so clients and monitoring can tell the two apart.
app.use((err, req, res, _next) => {
  console.error(err.message);
  const status = Number.isInteger(err.status) ? err.status : 500;
  res.status(status).json({ error: status < 500 ? err.message : 'Internal error' });
});

// This one process serves BOTH the dashboard UI (public/index.html) and the
// control API, so it must be reachable on the LAN/tailnet for iPad access, the LAN QR,
// and peer-machine sync. Bind 0.0.0.0 by default; set API_BIND=127.0.0.1 to lock it to
// localhost-only (and front it with Caddy). The mutating API was already LAN-reachable
// via the old Next proxy, so this is the same surface. Gate it with LOCAL_APPS_TOKEN.
const API_BIND = process.env.API_BIND || '0.0.0.0';

module.exports = app;

// --- Listen ---
if (IS_MAIN) app.listen(PORT, API_BIND, () => {
  console.log(`\n  Local Apps (UI + control plane) running at:`);
  console.log(`  http://${API_BIND}:${PORT}`);
  if (API_BIND !== '127.0.0.1' && API_BIND !== 'localhost' && !AUTH_TOKEN) {
    console.log(`  ⚠  Bound to ${API_BIND} without LOCAL_APPS_TOKEN - off-box callers can VIEW status but`);
    console.log(`     all control actions + sensitive reads are DENIED. Set LOCAL_APPS_TOKEN for LAN control.`);
  }
  console.log(`  Role:   ${MACHINE_ROLE.toUpperCase()}${IS_HUB ? ' (bots + auto-fix enabled)' : ' (status reporting only)'}\n`);
  startupSync();
});
