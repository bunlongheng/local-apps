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
const { startCmd, killPort } = require('./launchctl-cmds');
const { shouldTrip, rearmReason } = require('./lib/breaker');
const { nextLevel, recordAttempt, l3Fixes } = require('./lib/escalation');
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
    "script-src 'self' 'unsafe-inline'",
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
    try { return JSON.parse(fs.readFileSync(roleFile, 'utf8')).role || 'hub'; } catch (e) { dbg('line65', e); }
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
// NOTE: enabling the token currently requires the caller to send the header; wiring the
// dashboard fetches to forward it from localStorage is a tracked follow-up, so today the
// gate is meant for API/CLI clients.
// Trust-loopback auth policy lives in lib/auth-gate.js (pure + unit-tested). See it for the rule.
const { decide: authDecide, isLoopback, effectiveAddress } = require('./lib/auth-gate');
// Off-box viewers (the LAN/tailnet dashboard) get status without filesystem paths or launchd internals.
const OFFBOX_STRIP = ['localPath', 'logPath', 'launchAgentPath', 'launchAgent', 'startCommand', 'processCheck'];
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
  } catch (e) { dbg('line122', e); }
}


// --- LaunchAgent management ---
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const USERNAME = os.userInfo().username;
const { createLaunchAgent, removeLaunchAgent } =
  makeLaunchd({ username: USERNAME, launchAgentsDir: LAUNCH_AGENTS_DIR, npmPath: NPM_PATH, xmlEscape, exec: execSync });

// createLaunchAgent, removeLaunchAgent -> lib/launchd.js

// --- Port allocation ---
const PORT_RANGE_START = 3000;
const PORT_RANGE_END = 9875; // below monitor port


// --- Port allocation (provisioning and POST /api/apps) ---
function isPortTaken(port, excludeId) {
  for (const a of db.getApps()) {
    if (excludeId && a.id === excludeId) continue;
    if (a.localUrl) {
      try { if (parseInt(new URL(a.localUrl).port) === port) return a.id; } catch (e) { dbg('line585', e); }
    }
    if (a.healthUrl) {
      try { if (parseInt(new URL(a.healthUrl).port) === port) return a.id; } catch (e) { dbg('line588', e); }
    }
  }
  return null;
}
function getNextAvailablePort() {
  const usedPorts = new Set();
  for (const a of db.getApps()) {
    if (a.localUrl) {
      try { usedPorts.add(parseInt(new URL(a.localUrl).port)); } catch (e) { dbg('line142', e); }
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
    try { port = new URL(data.localUrl).port; } catch (e) { dbg('line158', e); }
  }
  if (!port && data.healthUrl) {
    try { port = new URL(data.healthUrl).port; } catch (e) { dbg('line161', e); }
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
    const logPath = data.logPath || `/tmp/${id}.log`;
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
  if (app && app.launchAgent) { try { await execAsync(`launchctl bootout gui/${process.getuid()}/${app.launchAgent} 2>/dev/null`, { timeout: 10000 }); } catch (e) { dbg('teardown/bootout', e); } }
  removeCaddyEntry(id);
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
  try { return execSync('/usr/local/bin/tailscale ip -4 2>/dev/null', { timeout: 5000 }).toString().trim(); }
  catch { return null; }
}
let TAILSCALE_IP = getTailscaleIp();
// Refresh out-of-band so the hot /api/status path never shells out (execSync would
// block the single-threaded event loop on every poll from every open tab).
setInterval(() => { TAILSCALE_IP = getTailscaleIp(); }, 60000).unref();

// --- Machine model detection ---
const MACHINE_MODEL = (() => {
  try {
    const name = execSync('system_profiler SPHardwareDataType 2>/dev/null', { timeout: 10000 }).toString();
    const match = name.match(/Model Name:\s*(.+)/);
    if (match) return match[1].trim();
  } catch (e) { dbg('line239', e); }
  // Fallback: sysctl hw.model (works in sandboxed envs where system_profiler fails)
  try {
    const hw = execSync('/usr/sbin/sysctl -n hw.model 2>/dev/null', { timeout: 5000 }).toString().trim();
    if (hw.includes('Macmini') || hw.includes('Mac16,')) return 'Mac mini';
    if (hw.includes('MacBookPro') || hw.includes('Mac15,') || hw.includes('Mac14,')) return 'MacBook Pro';
    if (hw.includes('MacBookAir')) return 'MacBook Air';
    if (hw.startsWith('Mac')) return 'Mac mini';
  } catch (e) { dbg('line247', e); }
  return null;
})();

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

    const up = probes[index];
    const newStatus = up ? 'up' : 'down';
    if (s.status !== newStatus) {
      // Flap detection: going down shortly after a restart means it crashed on us.
      // Tracked in a rolling 2-min window that survives the 'up' counter reset below,
      // so a start-then-crash app can't loop the escalation chain forever (L5 trips it).
      if (newStatus === 'down' && s.status === 'up' && s.lastRestart && Date.now() - s.lastRestart < 120000) {
        s.flapWindow = (s.flapWindow || []).filter(t => Date.now() - t < 120000);
        s.flapWindow.push(Date.now());
      }
      s.status = newStatus;
      broadcast({ type: 'update', id: appCfg.id, status: newStatus });
      if (newStatus === 'down') broadcast({ type: 'alert', id: appCfg.id, name: appCfg.name });
    }

    // === Auto-restart escalation chain ===
    // Level 1 (30s):  detect down, kickstart via launchctl
    // Level 2 (90s):  still down? kill port, bootout+bootstrap fresh
    // Level 3 (180s): still down? read logs, try common fixes (npm install, port kill)
    // Level 4 (300s): still down? deploy Claude Code agent to debug and fix
    // Level 5 recovery: a breaker OFF (never a user OFF) re-arms when the port is
    // observed up or after the cooldown, so a healthy app can't sit grey forever.
    const rearm = IS_HUB && autoRestartEnabled ? rearmReason(appCfg, up, Date.now()) : null;
    if (rearm) {
      db.setAppDisabled(appCfg.id, false);
      appCfg.disabled = false;
      s.downSince = null; s.restartAttempts = 0; s.flapWindow = [];
      console.log(`  [L5] re-armed ${appCfg.id} (${rearm})`);
      broadcast({ type: 'update', id: appCfg.id, status: newStatus, disabled: false });
    }
    if (IS_HUB && autoRestartEnabled && newStatus === 'down' && !appCfg.disabled && (appCfg.launchAgentPath || appCfg.launchAgent)) {
      const uid = process.getuid();
      const label = appCfg.launchAgent;
      const plistPath = appCfg.launchAgentPath;
      const downSince = s.downSince || (s.downSince = Date.now());
      const downDuration = Date.now() - downSince;
      const attempts = s.restartAttempts || 0;
      const port = appCfg.localUrl ? (() => { try { return new URL(appCfg.localUrl).port; } catch { return null; } })() : null;

      // Level 5: Circuit breaker. The chain is churning - stop trying and land the app
      // cleanly OFF (disabled) instead of blinking yellow forever / flapping CPU in a loop.
      // Trips on 3 flaps in 2 min, or the whole L1-L4 chain exhausted and still down
      // (policy in lib/breaker.js). Runs before L1 so it intercepts; once disabled, the
      // outer !disabled guard skips future ticks until the re-arm above fires.
      if (shouldTrip(s, Date.now())) {
        try {
          if (port) await killPort(port);
          if (label) await execAsync(`launchctl bootout gui/${uid}/${label} 2>/dev/null`, { timeout: 10000 });
        } catch (e) { dbg('line340', e); }
        db.setAppDisabled(appCfg.id, true, 'breaker');
        appCfg.disabled = true;
        console.log(`  [L5] circuit breaker -> disabled ${appCfg.id} (${s.flapWindow.length} flaps, ${attempts} attempts)`);
        s.downSince = null; s.restartAttempts = 0; s.flapWindow = [];
        broadcast({ type: 'update', id: appCfg.id, status: 'down', disabled: true });
        broadcast({ type: 'alert', id: appCfg.id, name: appCfg.name });
        continue;
      }

      // Which level fires is decided by lib/escalation.js (pure, unit-tested); this loop
      // only executes it. Every level records the attempt before running its command.
      const level = nextLevel(s, Date.now());
      if (level === 1) {
        recordAttempt(s, Date.now());
        try {
          await execAsync(startCmd(uid, label, plistPath), { timeout: 15000 });
          console.log(`  [L1] kickstart: ${appCfg.id}`);
        } catch (e) { dbg('L1', e); }
      }
      else if (level === 2) {
        recordAttempt(s, Date.now());
        try {
          if (port) await killPort(port);
          await execAsync(`launchctl bootout gui/${uid}/${label} 2>/dev/null; sleep 1; launchctl bootstrap gui/${uid} "${plistPath}" 2>/dev/null`, { timeout: 15000 });
          console.log(`  [L2] port-kill + reload: ${appCfg.id}`);
        } catch (e) { dbg('L2', e); }
      }
      else if (level === 3) {
        recordAttempt(s, Date.now());
        try {
          const dir = appCfg.localPath;
          if (dir && fs.existsSync(dir)) {
            const logPath = appCfg.logPath || `/tmp/${appCfg.id}.log`;
            let logTail = '';
            try { logTail = (await execAsync(`tail -30 "${logPath}" 2>/dev/null`, { timeout: 5000 })).stdout; } catch (e) { dbg('line375', e); }
            const fixes = l3Fixes(logTail);
            if (fixes.npmInstall) {
              console.log(`  [L3] npm install: ${appCfg.id}`);
              // --ignore-scripts: a registered app dir is attacker-influencable, so never
              // run its package lifecycle scripts (preinstall/postinstall) during auto-heal.
              try { await execAsync(`cd "${dir}" && npm install --ignore-scripts 2>/dev/null`, { timeout: 60000 }); } catch (e) { console.warn(`  [L3] npm install failed: ${appCfg.id}: ${e.message}`); }
            }
            if (fixes.clearNext) {
              console.log(`  [L3] clear .next cache: ${appCfg.id}`);
              try { await execAsync(`rm -rf "${dir}/.next" 2>/dev/null`, { timeout: 5000 }); } catch (e) { dbg('L3', e); }
            }
            if (port) await killPort(port);
          }
          await execAsync(startCmd(uid, label, plistPath), { timeout: 15000 });
          console.log(`  [L3] fix + restart: ${appCfg.id}`);
        } catch (e) { dbg('L3', e); }
      }
      // Level 4: hand the failure to the local agent (last resort, opt-in)
      else if (level === 4) {
        const dir = appCfg.localPath;
        const logPath = appCfg.logPath || `/tmp/${appCfg.id}.log`;
        if (dir && fs.existsSync(dir)) {
          console.log(`  [L4] deploying Claude agent: ${appCfg.id}`);
          const prompt = `The app "${appCfg.id}" at ${dir} has been down for ${Math.round(downDuration/60000)} minutes. `
            + `Port: ${port || '?'}. LaunchAgent: ${label}. `
            + `Read the last 50 lines of ${logPath}, diagnose the issue, fix it, then run: `
            + `${startCmd(uid, label, plistPath)} `
            + `Wait 10s, verify http://localhost:${port} returns 200. If not, try harder.`;
          // Opt-in only (`agent: true` in data/auto-restart.json), argv not a shell string, and a
          // tool allowlist instead of --dangerously-skip-permissions: the prompt embeds
          // app-derived text, and the agent runs inside a directory the hub does not control.
          if (!autoRestartAgent) { console.log(`  [L4] agent disabled (set "agent": true in data/auto-restart.json): ${appCfg.id}`); }
          else {
            const args = ['-p', prompt, '--allowedTools', 'Read,Grep,Glob,Bash(launchctl:*),Bash(npm install:*),Bash(npm run:*),Bash(curl:*),Bash(tail:*)'];
            try {
              const out = fs.openSync(logPath, 'a');
              spawn('claude', args, { cwd: dir, detached: true, stdio: ['ignore', out, out] }).unref();
            } catch (e) { console.warn(`  [L4] could not start agent for ${appCfg.id}: ${e.message}`); }
          }
          s.lastRestart = Date.now();
          s.restartAttempts = (s.restartAttempts || 0) + 1;
        }
      }
    }

    // Reset escalation counters when app comes back up
    if (newStatus === 'up' && s.downSince) {
      if (s.restartAttempts > 0) console.log(`  ✓ recovered: ${appCfg.id} (after ${s.restartAttempts} attempts, ${Math.round((Date.now() - s.downSince)/1000)}s)`);
      s.downSince = null;
      s.restartAttempts = 0;
    }
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
const ctx = { appRecord, getNextAvailablePort, isPortTaken, killPort, AUTH_TOKEN, CHROME_EXT_ERROR, IS_HUB, IS_MAIN, MACHINE_ROLE, PORT, QRCode, addCaddyEntry, broadcast, checkSingle, clearState, db, dbg, execAsync, execSync, fetchJson, forViewer, getState, isChromeExtensionRepo, isValidId, peerRecord, renameCaddyEntry, setupInfra, spawn, sseClients, startCmd, sweepSubnet, teardownInfra, updateTabColors, validateAppFields,
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

// Global error handler — no stack traces leaked, but honest status codes.
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
