const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode');
const db = require('./db');
const { startCmd } = require('./launchctl-cmds');
const { shouldTrip, rearmReason } = require('./lib/breaker');
const { isValidId, validateAppFields, xmlEscape } = require('./lib/validate');
const makeCaddy = require('./lib/caddy');
const makeLaunchd = require('./lib/launchd');
const makeHealth = require('./lib/health');

const compression = require('compression');
const app = express();
// True only when run directly (node server.js), false when require()d by a test - lets the
// test import the configured Express app without starting the health loops, peer probes, or listener.
const IS_MAIN = require.main === module;
app.use(compression());
// Baseline security headers, ported from the former next.config so collapsing to a
// single Express service (UI + API on :9875) keeps the same posture. HSTS is omitted:
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
    try { return JSON.parse(fs.readFileSync(roleFile, 'utf8')).role || 'hub'; } catch {}
  }
  return 'hub';
})();
const IS_HUB = MACHINE_ROLE === 'hub';
const CADDYFILE = process.env.CADDYFILE || '/opt/homebrew/etc/Caddyfile';
const CADDY_ERROR_ROOT = path.dirname(CADDYFILE);
const { addCaddyEntry, removeCaddyEntry, renameCaddyEntry } =
  makeCaddy({ caddyfile: CADDYFILE, errorRoot: CADDY_ERROR_ROOT, getLanIp, exec: execSync });
const NPM_PATH = (() => {
  try { return execSync('which npm').toString().trim(); }
  catch { return '/opt/homebrew/bin/npm'; }
})();

app.use(express.json());

// --- Optional shared-secret gate ---------------------------------------------
// When LOCAL_APPS_TOKEN is set, every mutating request (POST/PUT/DELETE) and every
// sensitive read route requires a matching `x-local-apps-token` header. Unset -> fully
// open (unchanged default), so this never breaks an existing single-machine setup; set
// it to lock the LAN/tailnet surface. Sensitive GETs = any log reader (/api/log/*, /api/*/log).
// NOTE: enabling the token currently requires the caller to send the header; wiring the
// dashboard fetches to forward it from localStorage is a tracked follow-up, so today the
// gate is meant for API/CLI clients.
// Trust-loopback auth policy lives in lib/auth-gate.js (pure + unit-tested). See it for the rule.
const { decide: authDecide } = require('./lib/auth-gate');
const AUTH_TOKEN = process.env.LOCAL_APPS_TOKEN || '';
app.use((req, res, next) => {
  const d = authDecide({
    remoteAddress: req.socket.remoteAddress || '',
    method: req.method,
    path: req.path,
    token: req.get('x-local-apps-token'),
    configuredToken: AUTH_TOKEN,
  });
  if (d.allow) return next();
  return res.status(d.status).json({ error: 'unauthorized - control actions and sensitive reads require LOCAL_APPS_TOKEN off localhost' });
});

app.use(express.static(path.join(__dirname, 'public')));

// --- Caddy reverse-proxy management -> lib/caddy.js ---

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
  } catch {}
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

function getNextAvailablePort() {
  const usedPorts = new Set();
  for (const a of db.getApps()) {
    if (a.localUrl) {
      try { usedPorts.add(parseInt(new URL(a.localUrl).port)); } catch {}
    }
  }
  for (let p = PORT_RANGE_START; p <= PORT_RANGE_END; p++) {
    if (!usedPorts.has(p)) return p;
  }
  return null;
}

// --- Full infra setup/teardown ---
function setupInfra(id, data) {
  const result = {};

  // Port: use provided localUrl, healthUrl, or auto-assign
  let port = null;
  if (data.localUrl) {
    try { port = new URL(data.localUrl).port; } catch {}
  }
  if (!port && data.healthUrl) {
    try { port = new URL(data.healthUrl).port; } catch {}
  }
  if (!port) {
    port = getNextAvailablePort();
    if (port) {
      result.localUrl = `http://localhost:${port}`;
      result.healthUrl = `http://localhost:${port}`;
    }
  }

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

function teardownInfra(id) {
  removeCaddyEntry(id);
  removeLaunchAgent(id);

  // Kill any running process
  try {
    const app = db.getApp ? db.getApp(id) : null;
    if (app && app.localUrl) {
      const port = new URL(app.localUrl).port;
      if (port) execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`);
    }
  } catch {}

  console.log(`  ✅ full cleanup: ${id}`);
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      // Skip Tailscale's CGNAT range (100.64.0.0/10) so the LAN QR shows the
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
  try { return execSync('/usr/local/bin/tailscale ip -4 2>/dev/null').toString().trim(); }
  catch { return null; }
}
let TAILSCALE_IP = getTailscaleIp();
// Refresh out-of-band so the hot /api/status path never shells out (execSync would
// block the single-threaded event loop on every poll from every open tab).
setInterval(() => { TAILSCALE_IP = getTailscaleIp(); }, 60000).unref();

// --- Machine model detection ---
const MACHINE_MODEL = (() => {
  try {
    const name = execSync('system_profiler SPHardwareDataType 2>/dev/null').toString();
    const match = name.match(/Model Name:\s*(.+)/);
    if (match) return match[1].trim();
  } catch {}
  // Fallback: sysctl hw.model (works in sandboxed envs where system_profiler fails)
  try {
    const hw = execSync('/usr/sbin/sysctl -n hw.model 2>/dev/null').toString().trim();
    if (hw.includes('Macmini') || hw.includes('Mac16,')) return 'Mac mini';
    if (hw.includes('MacBookPro') || hw.includes('Mac15,') || hw.includes('Mac14,')) return 'MacBook Pro';
    if (hw.includes('MacBookAir')) return 'MacBook Air';
    if (hw.startsWith('Mac')) return 'Mac mini';
  } catch {}
  return null;
})();

// --- HTTP client (used across peer sync + health checks) ---
const http = require('http');

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
  for (const appCfg of apps) {
    const s = getState(appCfg.id);
    s.lastChecked = new Date().toISOString();

    let up = false;
    if (appCfg.healthUrl) {
      up = await tcpCheck(appCfg.healthUrl);
    } else if (appCfg.processCheck) {
      up = await processCheck(appCfg.processCheck);
    }

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
    const autoRestartEnabled = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'auto-restart.json'), 'utf8')).enabled; } catch { return false; } })();
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
      const lastRestart = s.lastRestart || 0;
      const port = appCfg.localUrl ? (() => { try { return new URL(appCfg.localUrl).port; } catch { return null; } })() : null;

      // Level 5: Circuit breaker. The chain is churning - stop trying and land the app
      // cleanly OFF (disabled) instead of blinking yellow forever / flapping CPU in a loop.
      // Trips on 3 flaps in 2 min, or the whole L1-L4 chain exhausted and still down
      // (policy in lib/breaker.js). Runs before L1 so it intercepts; once disabled, the
      // outer !disabled guard skips future ticks until the re-arm above fires.
      if (shouldTrip(s, Date.now())) {
        try {
          if (port) execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { timeout: 5000 });
          if (label) execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null`, { timeout: 10000 });
        } catch {}
        db.setAppDisabled(appCfg.id, true, 'breaker');
        appCfg.disabled = true;
        console.log(`  [L5] circuit breaker -> disabled ${appCfg.id} (${s.flapWindow.length} flaps, ${attempts} attempts)`);
        s.downSince = null; s.restartAttempts = 0; s.flapWindow = [];
        broadcast({ type: 'update', id: appCfg.id, status: 'down', disabled: true });
        broadcast({ type: 'alert', id: appCfg.id, name: appCfg.name });
        continue;
      }

      // Level 1: Quick kickstart (first attempt, or 60s since last try)
      // kickstart fails if the service was booted out (LaunchAgent purge) - bootstrap the plist as fallback
      if (attempts === 0 || (attempts === 1 && Date.now() - lastRestart > 60000)) {
        try {
          execSync(startCmd(uid, label, plistPath), { timeout: 15000 });
          s.lastRestart = Date.now();
          s.restartAttempts = (s.restartAttempts || 0) + 1;
          console.log(`  [L1] kickstart: ${appCfg.id}`);
        } catch {}
      }

      // Level 2: Kill port + full reload (90s+ down, attempt 2)
      else if (attempts <= 2 && downDuration > 90000 && Date.now() - lastRestart > 60000) {
        try {
          if (port) execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { timeout: 5000 });
          execSync(`launchctl bootout gui/${uid}/${label} 2>/dev/null; sleep 1; launchctl bootstrap gui/${uid} "${plistPath}" 2>/dev/null`, { timeout: 15000 });
          s.lastRestart = Date.now();
          s.restartAttempts = (s.restartAttempts || 0) + 1;
          console.log(`  [L2] port-kill + reload: ${appCfg.id}`);
        } catch {}
      }

      // Level 3: Common fixes - npm install, clear .next cache (180s+ down)
      else if (attempts <= 3 && downDuration > 180000 && Date.now() - lastRestart > 60000) {
        try {
          const dir = appCfg.localPath;
          if (dir && fs.existsSync(dir)) {
            // Check logs for common errors
            const logPath = appCfg.logPath || `/tmp/${appCfg.id}.log`;
            let logTail = '';
            try { logTail = execSync(`tail -30 "${logPath}" 2>/dev/null`).toString(); } catch {}
            // Module not found -> npm install
            if (logTail.includes('Cannot find module') || logTail.includes('MODULE_NOT_FOUND')) {
              console.log(`  [L3] npm install: ${appCfg.id}`);
              // --ignore-scripts: a registered app dir is attacker-influencable, so never
              // run its package lifecycle scripts (preinstall/postinstall) during auto-heal.
              try { execSync(`cd "${dir}" && npm install --ignore-scripts 2>/dev/null`, { timeout: 60000 }); } catch (e) { console.warn(`  [L3] npm install failed: ${appCfg.id}: ${e.message}`); }
            }
            // Build cache corrupt -> clear .next
            if (logTail.includes('.next') || logTail.includes('ENOENT') || logTail.includes('Build error')) {
              console.log(`  [L3] clear .next cache: ${appCfg.id}`);
              try { execSync(`rm -rf "${dir}/.next" 2>/dev/null`, { timeout: 5000 }); } catch {}
            }
            // Port still stuck
            if (port) execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { timeout: 5000 });
          }
          // Restart after fixes
          execSync(startCmd(uid, label, plistPath), { timeout: 15000 });
          s.lastRestart = Date.now();
          s.restartAttempts = (s.restartAttempts || 0) + 1;
          console.log(`  [L3] fix + restart: ${appCfg.id}`);
        } catch {}
      }

      // Level 4: Deploy Claude Code agent to debug (300s+ down, last resort)
      else if (attempts <= 4 && downDuration > 300000 && Date.now() - lastRestart > 120000) {
        const dir = appCfg.localPath;
        const logPath = appCfg.logPath || `/tmp/${appCfg.id}.log`;
        if (dir && fs.existsSync(dir)) {
          console.log(`  [L4] deploying Claude agent: ${appCfg.id}`);
          const prompt = `The app "${appCfg.id}" at ${dir} has been down for ${Math.round(downDuration/60000)} minutes. `
            + `Port: ${port || '?'}. LaunchAgent: ${label}. `
            + `Read the last 50 lines of ${logPath}, diagnose the issue, fix it, then run: `
            + `${startCmd(uid, label, plistPath)} `
            + `Wait 10s, verify http://localhost:${port} returns 200. If not, try harder.`;
          const agentCmd = `cd "${dir}" && claude -p "${prompt.replace(/"/g, '\\"')}" --dangerously-skip-permissions 2>/dev/null &`;
          try { spawn('bash', ['-c', agentCmd], { detached: true, stdio: 'ignore' }).unref(); } catch {}
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

// --- Status route (dashboard) ---

app.get('/api/status', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const apps = db.getApps().map(a => {
    const s = getState(a.id);
    return {
      id: a.id,
      name: a.name,
      localUrl: a.localUrl,
      lanUrl: a.localUrl ? a.localUrl.replace('localhost', LAN_IP) : null,
      tailscaleUrl: (TAILSCALE_IP && a.localUrl) ? a.localUrl.replace('localhost', TAILSCALE_IP) : null,
      status: s.status,
      mode: (a.startCommand || '').includes('start') && !(a.startCommand || '').includes('dev') ? 'prod' : 'dev',
      lastChecked: s.lastChecked,
      caddyUrl: a.caddyUrl || null,
      launchAgent: a.launchAgent || null,
      launchAgentPath: a.launchAgentPath || null,
      icon: a.icon || null,
      repo: a.repo || null,
      prodUrl: a.prodUrl || null,
      prodUrl2: a.prodUrl2 || null,
      localPath: a.localPath || null,
      logPath: a.logPath || null,
      disabled: a.disabled || false,
      hostname: os.hostname(),
      tabColor: a.tabColor || null,
      tabIcon: a.tabIcon || null,
    };
  });
  res.json({ apps, lanIp: LAN_IP, tailscaleIp: TAILSCALE_IP, machineModel: MACHINE_MODEL, machineRole: MACHINE_ROLE, monitorUrl: `http://${LAN_IP}:${PORT}` });
});

// --- Tab Colors ---
app.get('/api/tab-colors', (req, res) => {
  const out = {};
  const toHex = (r, g, b) => '#' + [r, g, b].map((v) => (v | 0).toString(16).padStart(2, '0')).join('');
  // Primary source: ~/.claude/tab-colors.json (the same file that drives the terminal
  // _tab colors), so the dashboard chip and the claude tab always match.
  try {
    const json = JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', 'tab-colors.json'), 'utf8'));
    for (const k of Object.keys(json)) {
      const e = json[k];
      if (e && typeof e.r === 'number') out[k] = { label: e.label || k.toUpperCase(), color: toHex(e.r, e.g, e.b), icon: e.icon || '' };
    }
  } catch {}
  // Fallback: DB tab colors for anything not defined in the json.
  try {
    const dbc = db.getTabColors() || {};
    for (const k of Object.keys(dbc)) if (!out[k]) out[k] = dbc[k];
  } catch {}
  // Merge the shell alias (e.g. _bheng) per key from ~/.claude-tabs.sh.
  try {
    const sh = fs.readFileSync(path.join(os.homedir(), '.claude-tabs.sh'), 'utf8');
    const re = /(_[A-Za-z0-9]+)\(\)\s*\{\s*_tab\s+"([^"]+)"/g;
    let m;
    while ((m = re.exec(sh))) if (out[m[2]] && !out[m[2]].alias) out[m[2]].alias = m[1];
  } catch {}
  res.json(out);
});

// --- CRUD: Apps ---
app.get('/api/apps', (req, res) => {
  res.json(db.getApps());
});

app.get('/api/apps/:id', (req, res) => {
  const a = db.getApp(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  res.json(a);
});

// Consistency police: the same artifact matrix /onboard enforces (favicon, stickies
// icon+registry, tab color+alias, caddy, launch-agent, profile, repo+prod). Backed by
// scripts/consistency.js so onboard and the dashboard never drift. Optional ?id=<app>.
app.get('/api/consistency', (req, res) => {
  try {
    const id = (req.query.id || '').replace(/[^a-z0-9-]/gi, '');
    const args = [`${__dirname}/scripts/consistency.js`, '--json'];
    if (id) args.push(id);
    const out = execSync(`node ${args.map((a) => `'${a}'`).join(' ')}`, { encoding: 'utf8', timeout: 15000 });
    res.json(JSON.parse(out));
  } catch (e) {
    res.status(500).json({ error: 'consistency check failed', detail: String(e.message || e) });
  }
});

// Toggle app disabled state (excludes from auto-restart when disabled)
app.post('/api/apps/:id/toggle', (req, res) => {
  const a = db.getApp(req.params.id);
  if (!a) return res.status(404).json({ error: 'not found' });
  const newState = !a.disabled;
  db.setAppDisabled(a.id, newState);
  // If disabling, also stop the app
  if (newState && a.launchAgent) {
    const uid = process.getuid();
    try { execSync(`launchctl bootout gui/${uid}/${a.launchAgent} 2>/dev/null`, { timeout: 10000 }); } catch {}
    const s = getState(a.id);
    s.status = 'down';
    s.downSince = null;
    s.restartAttempts = 0;
    broadcast({ type: 'update', id: a.id, status: 'down' });
  }
  // If enabling, kick it back to life (bootstrap if the service isn't loaded in launchd)
  if (!newState && a.launchAgent) {
    const uid = process.getuid();
    try { execSync(startCmd(uid, a.launchAgent, a.launchAgentPath), { timeout: 15000 }); } catch {}
    setTimeout(() => checkSingle(a), 3000);
    setTimeout(() => checkSingle(a), 8000);
    setTimeout(() => checkSingle(a), 15000);
  }
  console.log(`  ${newState ? '⏸' : '▶'} ${a.id} ${newState ? 'disabled' : 'enabled'}`);
  res.json({ id: a.id, disabled: newState });
});

// Bulk toggle: disable all except specified IDs
app.post('/api/apps/bulk-toggle', (req, res) => {
  const { keep = [] } = req.body || {};
  const apps = db.getApps();
  const uid = process.getuid();
  const results = [];
  for (const a of apps) {
    const shouldDisable = !keep.includes(a.id);
    const wasDisabled = a.disabled;
    db.setAppDisabled(a.id, shouldDisable);
    // Stop newly disabled apps
    if (shouldDisable && !wasDisabled && a.launchAgent) {
      try { execSync(`launchctl bootout gui/${uid}/${a.launchAgent} 2>/dev/null`, { timeout: 10000 }); } catch {}
      const s = getState(a.id);
      s.status = 'down';
      s.downSince = null;
      s.restartAttempts = 0;
      broadcast({ type: 'update', id: a.id, status: 'down' });
    }
    // Start newly enabled apps
    if (!shouldDisable && wasDisabled && a.launchAgent) {
      try { execSync(startCmd(uid, a.launchAgent, a.launchAgentPath), { timeout: 15000 }); } catch {}
    }
    results.push({ id: a.id, disabled: shouldDisable });
  }
  console.log(`  bulk-toggle: keeping ${keep.join(', ')}, disabled ${results.filter(r => r.disabled).length} apps`);
  res.json({ ok: true, results });
});

// Validate app id: lowercase alphanumeric, hyphens only, 1-64 chars
// isValidId, isSafePath, isSafeCommand, validateAppFields, xmlEscape -> lib/validate.js

// --- Port conflict check ---
function isPortTaken(port, excludeId) {
  for (const a of db.getApps()) {
    if (excludeId && a.id === excludeId) continue;
    if (a.localUrl) {
      try { if (parseInt(new URL(a.localUrl).port) === port) return a.id; } catch {}
    }
    if (a.healthUrl) {
      try { if (parseInt(new URL(a.healthUrl).port) === port) return a.id; } catch {}
    }
  }
  return null;
}

app.post('/api/apps', (req, res) => {
  const { id } = req.body;
  if (!id || typeof id !== 'string') return res.status(400).json({ error: 'id is required (string)' });
  if (!isValidId(id)) return res.status(400).json({ error: 'id must be lowercase alphanumeric/hyphens, 1-64 chars' });
  if (req.body.name && typeof req.body.name !== 'string') return res.status(400).json({ error: 'name must be a string' });
  const vErr = validateAppFields(req.body);
  if (vErr) return res.status(400).json({ error: vErr });

  // Check for port conflict if a port is specified
  const requestedUrl = req.body.localUrl || req.body.healthUrl;
  if (requestedUrl) {
    try {
      const requestedPort = parseInt(new URL(requestedUrl).port);
      const conflictApp = isPortTaken(requestedPort, id);
      if (conflictApp) {
        const suggested = getNextAvailablePort();
        return res.status(409).json({
          error: `Port ${requestedPort} is already used by "${conflictApp}"`,
          suggestedPort: suggested,
          suggestedUrl: suggested ? `http://localhost:${suggested}` : null
        });
      }
    } catch {}
  }

  // Auto-setup infra (caddy, hosts, launch agent)
  const infra = setupInfra(id, req.body);
  const merged = { ...req.body, ...infra };

  // Auto-set healthUrl from localUrl if not provided
  if (!merged.healthUrl && merged.localUrl) merged.healthUrl = merged.localUrl;

  const result = db.upsertApp(merged);
  // Extract assigned port for clear response
  let assignedPort = null;
  try { assignedPort = parseInt(new URL(result.localUrl).port); } catch {}
  broadcast({ type: 'reload' });
  res.status(201).json({ ...result, assignedPort });
});


app.put('/api/apps/:id', (req, res) => {
  const existing = db.getApp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const vErr = validateAppFields(req.body);
  if (vErr) return res.status(400).json({ error: vErr });

  // Check for port conflict on update
  const requestedUrl = req.body.localUrl || req.body.healthUrl;
  if (requestedUrl) {
    try {
      const requestedPort = parseInt(new URL(requestedUrl).port);
      const conflictApp = isPortTaken(requestedPort, req.params.id);
      if (conflictApp) {
        const suggested = getNextAvailablePort();
        return res.status(409).json({
          error: `Port ${requestedPort} is already used by "${conflictApp}"`,
          suggestedPort: suggested,
          suggestedUrl: suggested ? `http://localhost:${suggested}` : null
        });
      }
    } catch {}
  }

  // Re-setup infra if localUrl or localPath changed
  const data = { ...req.body, id: req.params.id };
  if (data.localUrl || data.localPath) {
    const infra = setupInfra(req.params.id, { ...existing, ...data });
    Object.assign(data, infra);
  }

  // Sync tab-colors label when name changes
  if (data.name && data.name !== existing.name) {
    updateTabColors(req.params.id, data.name, data.caddyUrl || existing.caddyUrl);
  }

  // Sync Caddy hostname when caddyUrl changes
  if (data.caddyUrl && data.caddyUrl !== existing.caddyUrl) {
    const port = (() => { try { return new URL(data.localUrl || existing.localUrl).port; } catch { return null; } })();
    if (port) {
      // Extract new hostname from caddyUrl
      const newHost = data.caddyUrl.replace(/^https?:\/\//, '').replace(/\.localhost.*/, '');
      const oldHost = (existing.caddyUrl || '').replace(/^https?:\/\//, '').replace(/\.localhost.*/, '');
      if (newHost !== oldHost && oldHost) {
        renameCaddyEntry(oldHost, newHost, port);
      } else if (!oldHost) {
        addCaddyEntry(newHost, port);
      }
    }
  }

  const result = db.upsertApp(data);
  broadcast({ type: 'reload' });
  res.json(result);
});

app.delete('/api/apps/:id', (req, res) => {
  const deleted = db.deleteApp(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'not found' });
  teardownInfra(req.params.id);
  clearState(req.params.id);
  broadcast({ type: 'update', id: req.params.id, status: 'removed' });
  res.json({ ok: true });
});

// --- Auto-generated FAVICONS map from /public/favicons/ ---
app.get('/api/favicons', (req, res) => {
  const dir = path.join(__dirname, 'public', 'favicons');
  const map = {};
  const priority = { png: 3, ico: 2, svg: 1 };
  const chosen = {}; // track which ext won per id
  try {
    for (const f of fs.readdirSync(dir)) {
      const m = f.match(/^(.+)\.(png|svg|ico)$/);
      if (!m) continue;
      const [, id, ext] = m;
      if ((priority[ext] || 0) > (chosen[id] || 0)) {
        chosen[id] = priority[ext];
        const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
        map[id] = '/favicons/' + f + '?v=' + Math.floor(mtime);
      }
    }
  } catch {}
  res.setHeader('Cache-Control', 'no-cache');
  res.json(map);
});

// --- App profiles (about, architect, deploy, security, performance) ---
app.get('/api/app-profiles', (req, res) => {
  const apps = db.getApps();
  const profiles = {};
  for (const a of apps) {
    profiles[a.id] = {
      about: a.about || null,
      features: a.features || null,
      architect: a.architect || null,
      deploy: a.deploy || null,
      security: a.security || null,
      performance: a.performance || null,
      prompt: a.prompt || null,
    };
  }
  res.json(profiles);
});
app.put('/api/app-profiles/:id', (req, res) => {
  const existing = db.getApp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.upsertApp({ id: req.params.id, ...req.body });
  res.json({ ok: true });
});

// --- Dynamic manifest (adapts name based on access method) ---
app.get('/api/manifest', (req, res) => {
  const host = req.hostname || req.headers.host || '';
  let label = 'Local Apps';
  if (host.startsWith('100.')) label = 'Apps (Tailscale)';
  else if (host.startsWith('10.') || host.startsWith('192.168.')) label = 'Apps (LAN)';
  else if (host.endsWith('.localhost')) label = 'Apps (Caddy)';

  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, 'public', 'manifest.json'), 'utf8'));
  manifest.name = label;
  manifest.short_name = label;
  manifest.start_url = `http://${req.headers.host}/`;
  res.setHeader('Content-Type', 'application/manifest+json');
  res.json(manifest);
});

// --- Other routes ---
app.get('/api/qr', async (req, res) => {
  const url = `http://${LAN_IP}:${PORT}`;
  const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1, color: { dark: '#e2e8f0', light: '#1a1d27' } });
  res.json({ url, dataUrl });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
});

app.get('/api/log/:id', (req, res) => {
  const appCfg = db.getApp(req.params.id);
  if (!appCfg || !appCfg.logPath) return res.json({ lines: [] });
  // Async, bounded tail (last 64KB) - no shell, does not block the event loop.
  const MAX = 64 * 1024;
  fs.open(appCfg.logPath, 'r', (err, fd) => {
    if (err) return res.json({ lines: [] });
    fs.fstat(fd, (e2, st) => {
      if (e2) { fs.close(fd, () => {}); return res.json({ lines: [] }); }
      const start = Math.max(0, st.size - MAX);
      const buf = Buffer.alloc(st.size - start);
      fs.read(fd, buf, 0, buf.length, start, () => {
        fs.close(fd, () => {});
        const lines = buf.toString('utf8').trimEnd().split('\n').filter(Boolean);
        res.json({ lines: lines.slice(-30) });
      });
    });
  });
});

app.post('/api/start/:id', (req, res) => {
  const appCfg = db.getApp(req.params.id);
  if (!appCfg) return res.status(404).json({ error: 'not found' });
  if (!appCfg.launchAgent) return res.status(400).json({ error: 'no launchAgent configured' });
  try {
    const uid = process.getuid();
    const label = appCfg.launchAgent;
    const plist = appCfg.launchAgentPath;
    // Kickstart in background (non-blocking), respond immediately; bootstrap if not loaded
    spawn('bash', ['-c', startCmd(uid, label, plist)], { detached: true, stdio: 'ignore' }).unref();
    // Recheck health at 3s, 8s, 15s so UI updates fast
    setTimeout(() => checkSingle(appCfg), 3000);
    setTimeout(() => checkSingle(appCfg), 8000);
    setTimeout(() => checkSingle(appCfg), 15000);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/stop/:id', (req, res) => {
  const appCfg = db.getApp(req.params.id);
  if (!appCfg) return res.status(404).json({ error: 'not found' });
  if (!appCfg.launchAgent) return res.status(400).json({ error: 'no launchAgent configured' });
  try {
    const uid = process.getuid();
    const label = appCfg.launchAgent;
    const port = appCfg.localUrl ? (() => { try { return new URL(appCfg.localUrl).port; } catch { return null; } })() : null;
    // Kill port first (instant), then bootout in background
    if (port) try { execSync(`lsof -ti:${port} | xargs kill -9 2>/dev/null`, { timeout: 3000 }); } catch {}
    spawn('bash', ['-c', `launchctl bootout gui/${uid}/${label} 2>/dev/null`], { detached: true, stdio: 'ignore' }).unref();
    // Update status immediately
    const s = getState(appCfg.id);
    s.status = 'down';
    broadcast({ type: 'update', id: appCfg.id, status: 'down' });
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Machines (peers) — auto-discovery ---
let discoveredPeers = []; // live peers found on network

function probeHost(ip, port = 9875) {
  return new Promise((resolve) => {
    const url = `http://${ip}:${port}/api/machine`;
    http.get(url, { timeout: 2000 }, (resp) => {
      let data = '';
      resp.on('data', c => data += c);
      resp.on('end', () => {
        try {
          const info = JSON.parse(data);
          resolve({ id: info.hostname || ip, hostname: info.hostname, ip, port, model: info.model, appCount: info.appCount });
        } catch { resolve(null); }
      });
    }).on('error', () => resolve(null)).on('timeout', function() { this.destroy(); resolve(null); });
  });
}

async function discoverPeers() {
  if (LAN_IP === 'N/A') return;
  const subnet = LAN_IP.split('.').slice(0, 3).join('.');
  const probes = [];
  for (let i = 1; i <= 254; i++) {
    const ip = `${subnet}.${i}`;
    if (ip === LAN_IP) continue; // skip self
    probes.push(probeHost(ip));
  }
  const results = await Promise.all(probes);
  discoveredPeers = results.filter(Boolean);
  // Sync to DB
  for (const p of discoveredPeers) {
    db.upsertMachine(p);
  }
  // Remove stale machines no longer on network
  const liveIps = new Set(discoveredPeers.map(p => p.ip));
  for (const m of db.getMachines()) {
    if (!liveIps.has(m.ip)) {
      db.deleteMachine(m.id);
      db.deleteRemoteApps(m.id);
    }
  }
  // Fetch and store apps from each peer
  for (const p of discoveredPeers) {
    try {
      const data = await new Promise((resolve, reject) => {
        http.get(`http://${p.ip}:${p.port || 9875}/api/status`, { timeout: 3000 }, (resp) => {
          let body = '';
          resp.on('data', c => body += c);
          resp.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(); } });
        }).on('error', reject);
      });
      if (data.apps && Array.isArray(data.apps)) {
        db.syncRemoteApps(p.id, data.apps);
      }
    } catch {}
  }
}

// Discover on boot + every 30s
if (IS_MAIN) {
  discoverPeers();
  setInterval(discoverPeers, 30000);
}

app.get('/api/machines', (req, res) => {
  res.json(db.getMachines());
});

// All apps from all machines (local + remote, stored in DB)
app.get('/api/all-apps', (req, res) => {
  const local = db.getApps().map(a => ({ ...a, machineId: 'local', machine: os.hostname() }));
  const remote = db.getRemoteApps().map(r => ({
    id: r.id, name: r.name, healthUrl: r.health_url, localUrl: r.local_url,
    caddyUrl: r.caddy_url, prodUrl: r.prod_url, repo: r.repo, icon: r.icon,
    status: r.status, machineId: r.machine_id, syncedAt: r.synced_at,
  }));
  res.json({ local, remote, total: local.length + remote.length });
});

// Remote apps for a specific machine
app.get('/api/machines/:id/apps', (req, res) => {
  const apps = db.getRemoteApps(req.params.id);
  res.json(apps.map(r => ({
    id: r.id, name: r.name, healthUrl: r.health_url, localUrl: r.local_url,
    caddyUrl: r.caddy_url, prodUrl: r.prod_url, repo: r.repo, icon: r.icon,
    status: r.status, syncedAt: r.synced_at,
  })));
});

// Proxy: fetch remote machine's /api/status server-side (avoids CORS)
app.get('/api/machines/:id/status', async (req, res) => {
  const m = db.getMachines().find(x => x.id === req.params.id);
  if (!m) return res.status(404).json({ error: 'machine not found' });
  const url = `http://${m.ip}:${m.port || 9875}/api/status`;
  try {
    const data = await new Promise((resolve, reject) => {
      http.get(url, { timeout: 5000 }, (resp) => {
        let body = '';
        resp.on('data', c => body += c);
        resp.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON')); } });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    });
    const hostname = data.apps?.[0]?.hostname || m.hostname;
    const model = data.machineModel || m.model;
    db.upsertMachine({ id: m.id, hostname, ip: m.ip, port: m.port, model });
    res.json(data);
  } catch (err) {
    res.status(502).json({ error: `unreachable: ${err.message}` });
  }
});

// --- Machine Sync API ---
// Each machine exposes its app list + identity. Machines can pull from each other.

// Identity: who is this machine? Peers read this server-side (http.get, no CORS needed), so
// no wildcard Access-Control-Allow-Origin here - it only let a LAN browser snoop machine identity.
app.get('/api/machine', (req, res) => {
  res.json({
    hostname: os.hostname(),
    model: MACHINE_MODEL,
    role: MACHINE_ROLE,
    lanIp: LAN_IP,
    port: PORT,
    appCount: db.getApps().length,
  });
});

// --- Icon Generation API ---
const iconJobs = new Map();

app.post('/api/generate-icons/:id', (req, res) => {
  const id = req.params.id;
  const appCfg = db.getApp(id);
  if (!appCfg) return res.status(404).json({ error: 'not found' });
  if (iconJobs.has(id)) return res.json({ status: 'already_running' });

  broadcast({ type: 'icons_start', ids: [id] });

  const proc = spawn('node', [path.join(__dirname, 'scripts', 'generate-favicons.js'), id], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', d => output += d.toString());
  iconJobs.set(id, { proc, startedAt: new Date().toISOString() });
  proc.on('close', (code) => {
    iconJobs.delete(id);
    broadcast({ type: 'icons_done', id, code });
  });
  res.json({ status: 'started', ids: [id] });
});

app.post('/api/generate-icons', (req, res) => {
  if (iconJobs.has('__all__')) return res.json({ status: 'already_running' });

  // Figure out which app IDs will be generated
  const allApps = db.getApps().map(a => a.id);
  broadcast({ type: 'icons_start', ids: allApps });

  const proc = spawn('node', [path.join(__dirname, 'scripts', 'generate-favicons.js')], {
    cwd: __dirname, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', d => output += d.toString());
  iconJobs.set('__all__', { proc, startedAt: new Date().toISOString() });
  proc.on('close', (code) => {
    iconJobs.delete('__all__');
    broadcast({ type: 'icons_done', id: '__all__', code });
  });
  res.json({ status: 'started', ids: allApps });
});

app.get('/api/generate-icons/status', (req, res) => {
  const jobs = {};
  for (const [id, job] of iconJobs) jobs[id] = { startedAt: job.startedAt };
  res.json(jobs);
});

// --- File watcher (public dir only) ---
let reloadTimer = null;
if (IS_MAIN) fs.watch(path.join(__dirname, 'public'), { recursive: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 200);
});

// --- Startup: ping known machines to update last_seen ---
async function startupSync() {
  const machines = db.getMachines();
  for (const m of machines) {
    try {
      const info = await new Promise((resolve, reject) => {
        http.get(`http://${m.ip}:${m.port || 9875}/api/machine`, { timeout: 3000 }, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(); } });
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(); });
      });
      db.upsertMachine({ id: m.id, hostname: info.hostname || m.hostname, ip: m.ip, port: m.port, model: info.model || m.model });
      console.log(`  Online: ${info.hostname || m.ip} (${info.appCount} apps)`);
    } catch {
      // unreachable — skip silently
    }
  }
}

// --- Boot ---
if (IS_MAIN) {
  checkAll();
  setInterval(checkAll, CHECK_INTERVAL);
}

// Icon sync check: compare local-apps favicon vs app's own icon
app.get('/api/icon-sync', (req, res) => {
  const apps = db.getApps();
  const result = {};
  for (const a of apps) {
    const fav = path.join(__dirname, 'public', 'favicons', `${a.id}.png`);
    const hasFav = fs.existsSync(fav);
    let hasAppIcon = false;
    let synced = false;
    if (a.localPath) {
      for (const p of ['public/favicon.png', 'public/apple-touch-icon.png', 'public/icon.png']) {
        const full = path.join(a.localPath, p);
        if (fs.existsSync(full)) {
          hasAppIcon = true;
          try {
            const favSize = fs.statSync(fav).size;
            const appSize = fs.statSync(full).size;
            synced = favSize === appSize;
          } catch {}
          break;
        }
      }
    }
    result[a.id] = { hasFavicon: hasFav, hasAppIcon, synced };
  }
  res.json(result);
});

// App capabilities: MCP, API, CLI detection
app.get('/api/capabilities', (req, res) => {
  const apps = db.getApps();
  const globalMcp = (() => {
    try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.claude', '.mcp.json'), 'utf8')); } catch { return {}; }
  })();
  const mcpServers = globalMcp.mcpServers || {};
  const result = {};

  const localBinDir = path.join(os.homedir(), '.local', 'bin');
  const localBins = fs.existsSync(localBinDir) ? fs.readdirSync(localBinDir) : [];

  for (const a of apps) {
    const dir = a.localPath;
    if (!dir || !fs.existsSync(dir)) continue;
    const flags = {};

    // MCP: project-level .mcp.json or referenced in global config or has mcp-server file
    try {
      const hasProjMcp = fs.existsSync(path.join(dir, '.mcp.json'));
      const globalRef = Object.entries(mcpServers).find(([, v]) => {
        const args = v.args || [];
        return args.some(arg => typeof arg === 'string' && arg.includes(a.id));
      });
      let hasMcpFile = false;
      try { hasMcpFile = fs.readdirSync(dir).some(f => f.includes('mcp') && (f.endsWith('.js') || f.endsWith('.ts'))); } catch {}
      // Also check ~/.claude/mcp-servers/ for files matching this app
      const mcpServersDir = path.join(os.homedir(), '.claude', 'mcp-servers');
      let hasMcpServerFile = false;
      if (fs.existsSync(mcpServersDir)) {
        try { hasMcpServerFile = fs.readdirSync(mcpServersDir).some(f => f.includes(a.id)); } catch {}
      }
      if (hasProjMcp || globalRef || hasMcpFile || hasMcpServerFile) {
        flags.mcp = true;
        if (globalRef) flags.mcpName = globalRef[0];
        if (hasProjMcp) flags.mcpPath = path.join(dir, '.mcp.json');
      }
    } catch {}

    // API: Next.js app/api, Express server, pages/api
    try {
      if (fs.existsSync(path.join(dir, 'app', 'api')) ||
          fs.existsSync(path.join(dir, 'pages', 'api')) ||
          fs.existsSync(path.join(dir, 'server.js')) ||
          fs.existsSync(path.join(dir, 'src', 'server.ts'))) {
        flags.api = true;
      }
    } catch {}

    // CLI: bin field in package.json or cli files or script in ~/.local/bin
    try {
      const pkgPath = path.join(dir, 'package.json');
      if (fs.existsSync(pkgPath)) {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
        if (pkg.bin) flags.cli = true;
      }
      if (fs.existsSync(path.join(dir, 'cli.js')) || fs.existsSync(path.join(dir, 'bin', 'cli.js'))) flags.cli = true;
      for (const b of localBins) {
        if (b === 'tabs' || b === 'tab') continue; // Skip tab manager (matches all apps)
        try {
          const content = fs.readFileSync(path.join(localBinDir, b), 'utf8');
          if (content.includes(a.id) || content.includes(dir)) { flags.cli = true; flags.cliBin = b; break; }
        } catch {}
      }
    } catch {}

    if (Object.keys(flags).length > 0) result[a.id] = flags;
  }
  res.json(result);
});

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

// This one Express process serves BOTH the dashboard UI (public/index.html) and the
// control API, so it must be reachable on the LAN/tailnet for iPad access, the LAN QR,
// and peer-machine sync. Bind 0.0.0.0 by default; set API_BIND=127.0.0.1 to lock it to
// localhost-only (and front it with Caddy). The mutating API was already LAN-reachable
// via the old Next proxy, so this is the same surface. Gate it with LOCAL_APPS_TOKEN.
const API_BIND = process.env.API_BIND || '0.0.0.0';
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

module.exports = app;
