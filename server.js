const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode');
const db = require('./db');
const { startCmd } = require('./launchctl-cmds');
const { isValidId, validateAppFields, xmlEscape } = require('./lib/validate');
const makeCaddy = require('./lib/caddy');
const makeLaunchd = require('./lib/launchd');
const makeHealth = require('./lib/health');

const compression = require('compression');
const app = express();
app.use(compression());
app.use((req, res, next) => {
  // Cache static files for 1 hour, busted by ?v= timestamp in JS
  if (req.path.match(/\.(ico|png|svg|jpg|css|js|woff2?)$/)) {
    res.setHeader('Cache-Control', 'public, max-age=3600');
  }
  next();
});
const PORT = 9875;  // API-only, Next.js frontend on 9876
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
// it to lock the LAN/tailnet surface. Sensitive GETs = shell dotfiles, ALL of /api/claude/*
// (config, sessions, and the skill/command readers that return files holding live tokens),
// and any log reader (/api/log/*, /api/*/log). NOTE: enabling the token currently requires
// the caller to send the header; wiring the dashboard fetches to forward it from
// localStorage is a tracked follow-up, so today the gate is meant for API/CLI clients.
const crypto = require('crypto');
const AUTH_TOKEN = process.env.LOCAL_APPS_TOKEN || '';
const SENSITIVE_GET = /^\/api\/(shell|claude\/)|\/log(\/|$)/;
function tokenOk(given) {
  if (!given || given.length !== AUTH_TOKEN.length) return false;
  return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(AUTH_TOKEN));
}
app.use((req, res, next) => {
  if (!AUTH_TOKEN) return next();
  const mutating = req.method === 'POST' || req.method === 'PUT' || req.method === 'DELETE';
  const sensitive = req.method === 'GET' && SENSITIVE_GET.test(req.path);
  if (!mutating && !sensitive) return next();
  if (tokenOk(req.get('x-local-apps-token'))) return next();
  return res.status(401).json({ error: 'unauthorized' });
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

  // Clean up screenshots
  const ssDir = path.join(__dirname, 'public', 'screenshots', id);
  if (fs.existsSync(ssDir)) {
    fs.rmSync(ssDir, { recursive: true, force: true });
    console.log(`  🗑 screenshots: ${id}`);
  }

  // Remove from gallery index
  const idxPath = path.join(__dirname, 'public', 'screenshots', 'index.json');
  if (fs.existsSync(idxPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'));
      const filtered = idx.filter(a => a.id !== id);
      if (filtered.length !== idx.length) {
        fs.writeFileSync(idxPath, JSON.stringify(filtered, null, 2));
        console.log(`  🗑 gallery index: ${id}`);
      }
    } catch {}
  }

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
const LAN_IP = getLanIp();

// --- Tailscale IP detection (cached; refreshed on an interval, not per request) ---
function getTailscaleIp() {
  try { return execSync('/usr/local/bin/tailscale ip -4 2>/dev/null').toString().trim(); }
  catch { return null; }
}
let TAILSCALE_IP = getTailscaleIp();
// Refresh out-of-band so the hot /api/status path never shells out (execSync would
// block the single-threaded event loop on every poll from every open tab).
setInterval(() => { TAILSCALE_IP = getTailscaleIp(); }, 60000);

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

// --- HTTP client (used across peer sync, health checks, screenshots) ---
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
    if (IS_HUB && autoRestartEnabled && newStatus === 'down' && !appCfg.disabled && (appCfg.launchAgentPath || appCfg.launchAgent)) {
      const uid = process.getuid();
      const label = appCfg.launchAgent;
      const plistPath = appCfg.launchAgentPath;
      const downSince = s.downSince || (s.downSince = Date.now());
      const downDuration = Date.now() - downSince;
      const attempts = s.restartAttempts || 0;
      const lastRestart = s.lastRestart || 0;
      const port = appCfg.localUrl ? (() => { try { return new URL(appCfg.localUrl).port; } catch { return null; } })() : null;

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
// Cache screenshot existence - refresh every 60s
const screenshotCache = {};
function refreshScreenshotCache() {
  for (const a of db.getApps()) {
    const ssIndex = path.join(__dirname, 'public', 'screenshots', a.id, 'index.json');
    try {
      if (fs.existsSync(ssIndex)) {
        const idx = JSON.parse(fs.readFileSync(ssIndex, 'utf8'));
        screenshotCache[a.id] = (idx.desktop?.length > 0) || (idx.mobile?.length > 0);
      } else { screenshotCache[a.id] = false; }
    } catch { screenshotCache[a.id] = false; }
  }
}
refreshScreenshotCache();
setInterval(refreshScreenshotCache, 60000);

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
      localPath: a.localPath || null,
      logPath: a.logPath || null,
      disabled: a.disabled || false,
      hostname: os.hostname(),
      hasScreenshots: screenshotCache[a.id] || false,
      tabColor: a.tabColor || null,
      tabIcon: a.tabIcon || null,
    };
  });
  res.json({ apps, lanIp: LAN_IP, tailscaleIp: TAILSCALE_IP, machineModel: MACHINE_MODEL, machineRole: MACHINE_ROLE, monitorUrl: `http://${LAN_IP}:9876` });
});

// --- Tab Colors ---
app.get('/api/tab-colors', (req, res) => {
  res.json(db.getTabColors());
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
  const url = `http://${LAN_IP}:9876`;
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

// --- Screenshot management ---

// Delete a screenshot file and remove it from index.json
app.delete('/api/screenshot', express.json(), (req, res) => {
  const { appId, mode, filename } = req.body || {}
  if (!appId || !mode || !filename) return res.status(400).json({ error: 'missing fields' })
  // Safety: only allow filenames, no path traversal
  if (!/^[\w.-]+\.(png|jpg|jpeg|gif|webp)$/i.test(filename)) return res.status(400).json({ error: 'invalid filename' })
  const filePath = path.join(__dirname, 'public', 'screenshots', appId, mode, filename)
  if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  // Remove from index.json
  const idxPath = path.join(__dirname, 'public', 'screenshots', appId, 'index.json')
  if (fs.existsSync(idxPath)) {
    try {
      const idx = JSON.parse(fs.readFileSync(idxPath, 'utf8'))
      if (Array.isArray(idx[mode])) {
        idx[mode] = idx[mode].filter(f => f !== filename)
        fs.writeFileSync(idxPath, JSON.stringify(idx, null, 2))
      }
    } catch {}
  }
  res.json({ ok: true })
})

// Toggle retake flag — stored in screenshots/<appId>/retake.json
app.post('/api/retake', express.json(), (req, res) => {
  const { appId, mode, filename } = req.body || {}
  if (!appId || !mode || !filename) return res.status(400).json({ error: 'missing fields' })
  const retakePath = path.join(__dirname, 'public', 'screenshots', appId, 'retake.json')
  let retake = {}
  try { if (fs.existsSync(retakePath)) retake = JSON.parse(fs.readFileSync(retakePath, 'utf8')) } catch {}
  const key = `${mode}/${filename}`
  if (retake[key]) delete retake[key]; else retake[key] = true
  fs.writeFileSync(retakePath, JSON.stringify(retake, null, 2))
  res.json({ marked: !!retake[key] })
})

// Get retake list for an app
app.get('/api/retake/:appId', (req, res) => {
  const retakePath = path.join(__dirname, 'public', 'screenshots', req.params.appId, 'retake.json')
  try {
    const data = fs.existsSync(retakePath) ? JSON.parse(fs.readFileSync(retakePath, 'utf8')) : {}
    res.json(data)
  } catch { res.json({}) }
})

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
discoverPeers();
setInterval(discoverPeers, 30000);

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
  const url = `http://${m.ip}:${m.port || 9876}/api/status`;
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

// Identity: who is this machine?
app.get('/api/machine', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.json({
    hostname: os.hostname(),
    model: MACHINE_MODEL,
    role: MACHINE_ROLE,
    lanIp: LAN_IP,
    port: PORT,
    appCount: db.getApps().length,
  });
});

// Export: portable app list (no machine-specific paths)
// --- File watcher ---

// --- Screenshots API ---
const SCREENSHOTS_DIR = path.join(__dirname, 'public', 'screenshots');

app.get('/api/screenshots', (req, res) => {
  const indexFile = path.join(SCREENSHOTS_DIR, 'index.json');
  if (!fs.existsSync(indexFile)) return res.json([]);
  res.json(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
});

app.get('/api/screenshots/:id', (req, res) => {
  const dir = path.join(SCREENSHOTS_DIR, req.params.id);
  const indexFile = path.join(dir, 'index.json');
  if (fs.existsSync(indexFile)) {
    return res.json(JSON.parse(fs.readFileSync(indexFile, 'utf8')));
  }
  if (!fs.existsSync(dir)) return res.json({ id: req.params.id, screenshots: [] });
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  res.json({ id: req.params.id, screenshots: files });
});

// Track running screenshot jobs
const screenshotJobs = new Map();

app.post('/api/screenshots/:id', (req, res) => {
  const id = req.params.id;
  const appCfg = db.getApp(id);
  if (!appCfg) return res.status(404).json({ error: 'not found' });
  if (screenshotJobs.has(id)) return res.json({ status: 'already_running' });

  const proc = spawn('node', [path.join(__dirname, 'scripts', 'screenshot-bot.js'), id], {
    cwd: __dirname,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let output = '';
  proc.stdout.on('data', d => output += d.toString());
  proc.stderr.on('data', d => output += d.toString());

  screenshotJobs.set(id, { proc, startedAt: new Date().toISOString() });

  proc.on('close', (code) => {
    screenshotJobs.delete(id);
    broadcast({ type: 'screenshots_done', id, code });
  });

  res.json({ status: 'started' });
});

app.get('/api/screenshots-status', (req, res) => {
  const jobs = {};
  for (const [id, job] of screenshotJobs) jobs[id] = { startedAt: job.startedAt };
  res.json(jobs);
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

// --- Screenshot ZIP download ---
app.get('/api/screenshots/:id/download', (req, res) => {
  const id = req.params.id;
  const baseDir = path.join(__dirname, 'public', 'screenshots', id);
  if (!fs.existsSync(baseDir)) return res.status(404).json({ error: 'no screenshots' });

  const { execSync } = require('child_process');
  const tmpZip = `/tmp/${id}-screenshots.zip`;
  try { fs.unlinkSync(tmpZip); } catch {}

  // Collect subfolders: desktop, desktop-framed, mobile, mobile-framed, gifs
  const folders = ['desktop', 'desktop-framed', 'mobile', 'mobile-framed', 'gifs'];
  const existing = folders.filter(f => {
    const full = path.join(baseDir, f);
    return fs.existsSync(full) && fs.readdirSync(full).length > 0;
  });

  if (!existing.length) return res.status(404).json({ error: 'no screenshot files' });

  // Build zip with subfolders preserved
  const args = existing.map(f => `"${f}/"`).join(' ');
  execSync(`cd "${baseDir}" && zip -r "${tmpZip}" ${args}`, { stdio: 'ignore' });

  res.download(tmpZip, `${id}.zip`, () => {
    try { fs.unlinkSync(tmpZip); } catch {}
  });
});

// --- File watcher (public dir only) ---
let reloadTimer = null;
fs.watch(path.join(__dirname, 'public'), { recursive: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 200);
});

// --- Startup: ping known machines to update last_seen ---
async function startupSync() {
  const machines = db.getMachines();
  for (const m of machines) {
    try {
      const info = await new Promise((resolve, reject) => {
        http.get(`http://${m.ip}:${m.port || 9876}/api/machine`, { timeout: 3000 }, (resp) => {
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
checkAll();
setInterval(checkAll, CHECK_INTERVAL);

// ─── Claude Sessions API (used by Claude dashboard on LAN) ──────────────────
const CLAUDE_DIR = path.join(os.homedir(), '.claude', 'projects');
const STALE_DAYS = 7;

function readFirstBytesSync(filePath, maxBytes = 12288) {
  let fd = -1;
  try {
    fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(maxBytes);
    const bytesRead = fs.readSync(fd, buf, 0, maxBytes, 0);
    return buf.subarray(0, bytesRead).toString('utf-8');
  } catch { return ''; }
  finally { if (fd >= 0) try { fs.closeSync(fd); } catch {} }
}

function parseSessionFast(filePath) {
  let customTitle = null, firstMessage = '', createdAt = '';
  try {
    const chunk = readFirstBytesSync(filePath, 12288);
    const lines = chunk.split('\n').filter(Boolean);
    if (lines.length > 1) lines.pop();
    for (const line of lines) {
      try {
        const d = JSON.parse(line);
        if (!createdAt && d.timestamp) createdAt = d.timestamp;
        if (d.type === 'custom-title' && d.customTitle) customTitle = d.customTitle;
        if (!firstMessage && d.type === 'user') {
          const c = d.message?.content;
          const text = typeof c === 'string' ? c
            : Array.isArray(c) ? (c.find(x => x.type === 'text')?.text ?? '') : '';
          if (text.trim()) firstMessage = text.slice(0, 120);
        }
        if (createdAt && firstMessage) break;
      } catch {}
    }
  } catch {}
  if (!createdAt) {
    try { createdAt = fs.statSync(filePath).birthtime.toISOString(); } catch { createdAt = new Date().toISOString(); }
  }
  return { customTitle, firstMessage, createdAt };
}

app.get('/api/claude/sessions', (req, res) => {
  if (!fs.existsSync(CLAUDE_DIR)) return res.json({ projects: [] });

  const projects = [];
  for (const folder of fs.readdirSync(CLAUDE_DIR)) {
    const folderPath = path.join(CLAUDE_DIR, folder);
    try { if (!fs.statSync(folderPath).isDirectory()) continue; } catch { continue; }

    const sessions = [];
    for (const file of fs.readdirSync(folderPath).filter(f => f.endsWith('.jsonl'))) {
      const filePath = path.join(folderPath, file);
      const stat = fs.statSync(filePath);
      const parsed = parseSessionFast(filePath);
      const daysSince = (Date.now() - stat.mtime.getTime()) / 86400000;
      sessions.push({
        id: file.replace('.jsonl', ''),
        filePath,
        sizeBytes: stat.size,
        customTitle: parsed.customTitle,
        title: parsed.firstMessage,
        createdAt: parsed.createdAt,
        updatedAt: stat.mtime.toISOString(),
        stale: daysSince > STALE_DAYS,
      });
    }
    sessions.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    if (sessions.length > 0) {
      projects.push({ project: folder, path: folder.replace(/-/g, '/'), sessions });
    }
  }
  projects.sort((a, b) => new Date(b.sessions[0]?.updatedAt ?? 0) - new Date(a.sessions[0]?.updatedAt ?? 0));
  res.json({ machine: os.hostname(), projects });
});

// ─── Claude Config API (skills, commands, hooks, mcp, claudeMd) ─────────────
const CLAUDE_HOME = path.join(os.homedir(), '.claude');
const MKT_DIR = path.join(CLAUDE_HOME, 'plugins', 'marketplaces', 'claude-plugins-official');
const PLG_DIR = path.join(MKT_DIR, 'plugins');
const EXT_DIR = path.join(MKT_DIR, 'external_plugins');
const STANDALONE_SKILLS = path.join(CLAUDE_HOME, 'skills');
const STANDALONE_CMDS = path.join(CLAUDE_HOME, 'commands');

function safeReadFile(p) { try { return fs.readFileSync(p, 'utf-8'); } catch { return ''; } }
function safeJsonFile(p) { try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; } }
function isDir(p) { try { return fs.statSync(p).isDirectory(); } catch { return false; } }
function isFile(p) { try { return fs.statSync(p).isFile(); } catch { return false; } }

app.get('/api/claude/config', (req, res) => {
  const plugins = [], skills = [], commands = [], mcp = [], hooks = [], claudeMd = [];
  const bases = [PLG_DIR, EXT_DIR];

  // Plugins
  for (const base of bases) {
    if (!isDir(base)) continue;
    const isExt = base === EXT_DIR;
    for (const name of fs.readdirSync(base)) {
      const dir = path.join(base, name);
      if (!isDir(dir)) continue;
      const m = safeJsonFile(path.join(dir, 'plugin.json')) ?? safeJsonFile(path.join(dir, 'manifest.json'));
      plugins.push({ name, description: m?.description ?? name, path: dir, type: isExt ? 'external' : name.endsWith('-lsp') ? 'lsp' : 'builtin' });

      // Skills
      const sd = path.join(dir, 'skills');
      if (isDir(sd)) for (const s of fs.readdirSync(sd)) {
        const sDir = path.join(sd, s);
        if (!isDir(sDir)) continue;
        const c = safeReadFile(path.join(sDir, 'SKILL.md'));
        skills.push({ name: s, plugin: name, description: (c.split('\n').find(l => l.trim() && !l.startsWith('#')) ?? s).slice(0, 120), path: sDir });
      }

      // Commands
      const cd = path.join(dir, 'commands');
      if (isDir(cd)) for (const f of fs.readdirSync(cd).filter(f => f.endsWith('.md'))) {
        const c = safeReadFile(path.join(cd, f));
        const fl = c.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))?.trim() ?? f;
        commands.push({ name: '/' + f.replace('.md', ''), plugin: name, description: fl.slice(0, 120), path: path.join(cd, f), content: c });
      }

      // MCP
      const mcpData = safeJsonFile(path.join(dir, '.mcp.json'));
      if (mcpData) {
        const servers = mcpData.mcpServers ?? mcpData;
        for (const [n, cfg] of Object.entries(servers)) {
          if (typeof cfg !== 'object' || !cfg) continue;
          mcp.push({ name: n, type: cfg.command ? 'command' : cfg.type === 'sse' ? 'sse' : cfg.url ? 'http' : 'unknown', url: cfg.url, command: cfg.command ? `${cfg.command} ${(cfg.args ?? []).join(' ')}`.trim() : undefined, path: path.join(dir, '.mcp.json') });
        }
      }

      // Hooks
      const hData = safeJsonFile(path.join(dir, 'hooks', 'hooks.json'));
      if (hData) {
        const hObj = hData.hooks ?? hData;
        const evts = [], cmds = [];
        for (const [evt, handlers] of Object.entries(hObj)) {
          if (!Array.isArray(handlers)) continue;
          evts.push(evt);
          for (const h of handlers) for (const ih of (h.hooks ?? [h])) if (ih.command) cmds.push(ih.command);
        }
        if (evts.length) hooks.push({ name: hData.description ?? name, plugin: name, events: evts, command: cmds[0], path: path.join(dir, 'hooks', 'hooks.json') });
      }
    }
  }

  // Standalone skills in ~/.claude/skills/
  if (isDir(STANDALONE_SKILLS)) for (const s of fs.readdirSync(STANDALONE_SKILLS)) {
    const sDir = path.join(STANDALONE_SKILLS, s);
    if (!isDir(sDir)) continue;
    let c = safeReadFile(path.join(sDir, 'SKILL.md'));
    if (!c) continue;
    if (c.startsWith('---')) { const end = c.indexOf('---', 3); if (end !== -1) c = c.slice(end + 3); }
    const fl = c.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---') && !l.startsWith('name:'))?.trim() ?? s;
    skills.push({ name: s, plugin: 'standalone', description: fl.slice(0, 120), path: sDir, source: 'external' });
  }

  // Standalone commands in ~/.claude/commands/
  if (isDir(STANDALONE_CMDS)) for (const f of fs.readdirSync(STANDALONE_CMDS).filter(f => f.endsWith('.md'))) {
    const fp = path.join(STANDALONE_CMDS, f);
    const c = safeReadFile(fp);
    const fl = c.split('\n').find(l => l.trim() && !l.startsWith('#') && !l.startsWith('---'))?.trim() ?? f;
    commands.push({ name: '/' + f.replace('.md', ''), plugin: 'standalone', description: fl.slice(0, 120), path: fp, content: c, source: 'external' });
  }

  // Also add source field to plugin skills/commands
  skills.forEach(s => { if (!s.source) s.source = s.path?.includes('external_plugins') ? 'external' : 'builtin'; });
  commands.forEach(c => { if (!c.source) c.source = c.path?.includes('external_plugins') ? 'external' : 'builtin'; });

  // CLAUDE.md files
  const globalMd = path.join(CLAUDE_HOME, 'CLAUDE.md');
  if (isFile(globalMd)) claudeMd.push({ name: 'Global CLAUDE.md', path: globalMd, content: safeReadFile(globalMd), scope: 'global' });
  const projDir = path.join(CLAUDE_HOME, 'projects');
  if (isDir(projDir)) for (const f of fs.readdirSync(projDir)) {
    const pm = path.join(projDir, f, 'CLAUDE.md');
    if (isFile(pm)) claudeMd.push({ name: 'Project: ' + f.replace(/-/g, '/'), path: pm, content: safeReadFile(pm), scope: 'project' });
  }

  // Settings
  const settings = safeJsonFile(path.join(CLAUDE_HOME, 'settings.json'));
  const localSettings = safeJsonFile(path.join(CLAUDE_HOME, 'settings.local.json'));

  res.json({
    machine: os.hostname(), plugins, skills, commands, mcp, hooks, claudeMd, settings, localSettings,
    summary: { plugins: plugins.length, skills: skills.length, commands: commands.length, mcp: mcp.length, hooks: hooks.length, claudeMd: claudeMd.length },
  });
});

// ─── Skill Sync API ─────────────────────────────────────────────────────────

// GET /api/claude/skill/:plugin/:skill — read full skill directory
app.get('/api/claude/skill/:plugin/:skill', (req, res) => {
  const { plugin, skill } = req.params;
  // Search both builtin and external
  for (const base of [PLG_DIR, EXT_DIR]) {
    const skillDir = path.join(base, plugin, 'skills', skill);
    if (!isDir(skillDir)) continue;
    const files = {};
    for (const f of fs.readdirSync(skillDir)) {
      const fp = path.join(skillDir, f);
      if (isFile(fp)) files[f] = safeReadFile(fp);
    }
    return res.json({ plugin, skill, files, path: skillDir });
  }
  res.status(404).json({ error: 'skill not found' });
});

// POST /api/claude/skill/:plugin/:skill — write skill files
app.post('/api/claude/skill/:plugin/:skill', (req, res) => {
  const { plugin, skill } = req.params;
  const { files } = req.body;
  if (!files || typeof files !== 'object') return res.status(400).json({ error: 'files object required' });

  // Write to external_plugins (safe — never touch builtins)
  const skillDir = path.join(EXT_DIR, plugin, 'skills', skill);
  try {
    fs.mkdirSync(skillDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
      // Safety: no path traversal
      if (name.includes('/') || name.includes('..')) continue;
      fs.writeFileSync(path.join(skillDir, name), content, 'utf-8');
    }
    res.json({ ok: true, path: skillDir });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// GET /api/claude/command/:plugin/:command — read command .md
app.get('/api/claude/command/:plugin/:command', (req, res) => {
  const { plugin, command } = req.params;
  for (const base of [PLG_DIR, EXT_DIR]) {
    const fp = path.join(base, plugin, 'commands', command + '.md');
    if (isFile(fp)) return res.json({ plugin, command, content: safeReadFile(fp), path: fp });
  }
  res.status(404).json({ error: 'command not found' });
});

// POST /api/claude/command/:plugin/:command — write command .md
app.post('/api/claude/command/:plugin/:command', (req, res) => {
  const { plugin, command } = req.params;
  const { content } = req.body;
  if (typeof content !== 'string') return res.status(400).json({ error: 'content string required' });

  const cmdDir = path.join(EXT_DIR, plugin, 'commands');
  try {
    fs.mkdirSync(cmdDir, { recursive: true });
    fs.writeFileSync(path.join(cmdDir, command + '.md'), content, 'utf-8');
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Portfolio Preview ---
app.get('/api/portfolio/preview', (req, res) => {
  try {
    const { appId } = req.query;
    if (!appId) return res.status(400).json({ error: 'appId required' });

    const appData = db.getApp(appId);
    if (!appData) return res.status(404).json({ error: 'App not found' });

    const slug = appData.id;
    const ssBase = path.join(__dirname, 'public', 'screenshots', slug);
    const screenshots = [];
    for (const subdir of ['desktop-framed', 'mobile-framed']) {
      const dir = path.join(ssBase, subdir);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
      for (const f of files) {
        screenshots.push({ path: `/screenshots/${slug}/${subdir}/${f}`, name: f, type: subdir });
      }
    }

    const architect = appData.architect || '';
    const TAG_PATTERNS = [
      'Next.js', 'React', 'TypeScript', 'JavaScript', 'Tailwind', 'Supabase',
      'Vite', 'SQLite', 'PostgreSQL', 'Node.js', 'Express', 'Electron',
      'WebSocket', 'Redis', 'Docker', 'Swift', 'Python', 'Rust', 'Go',
      'Vue', 'Svelte', 'Angular', 'MongoDB', 'Prisma', 'Drizzle',
    ];
    const tags = TAG_PATTERNS.filter(t => architect.toLowerCase().includes(t.toLowerCase()));

    const description = [appData.about || appData.name];
    if (appData.features) {
      try {
        const features = typeof appData.features === 'string' ? JSON.parse(appData.features) : appData.features;
        if (Array.isArray(features)) description.push(...features);
      } catch {}
    }

    res.json({
      title: appData.name,
      slug,
      type: 'professional',
      tags,
      description,
      url: appData.prodUrl || null,
      icon: appData.icon || null,
      screenshots,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- Add to Portfolio ---
// Reads Supabase creds from the file at PORTFOLIO_ENV_PATH, uploads framed screenshots, creates portfolio entry
app.post('/api/portfolio', async (req, res) => {
  try {
    const { appId } = req.body;
    if (!appId) return res.status(400).json({ error: 'appId required' });

    // 1. Get app data from DB
    const appData = db.getApp(appId);
    if (!appData) return res.status(404).json({ error: 'App not found' });

    // 2. Read the portfolio app's Supabase creds from the path in PORTFOLIO_ENV_PATH
    const envPath = process.env.PORTFOLIO_ENV_PATH;
    if (!envPath || !fs.existsSync(envPath)) return res.status(500).json({ error: 'PORTFOLIO_ENV_PATH not set or file not found' });
    const envContent = fs.readFileSync(envPath, 'utf8');
    const getEnv = (key) => {
      const m = envContent.match(new RegExp(`^${key}="?([^"\\n]+)"?`, 'm'));
      return m ? m[1] : null;
    };
    const SUPABASE_URL = getEnv('NEXT_PUBLIC_SUPABASE_URL');
    const SERVICE_KEY = getEnv('SUPABASE_SERVICE_ROLE_KEY');
    if (!SUPABASE_URL || !SERVICE_KEY) return res.status(500).json({ error: 'Missing Supabase creds in PORTFOLIO_ENV_PATH file' });

    // 3. Find framed screenshots
    const slug = appData.id;
    const ssBase = path.join(__dirname, 'public', 'screenshots', slug);
    const uploadFiles = [];
    for (const subdir of ['desktop-framed', 'mobile-framed']) {
      const dir = path.join(ssBase, subdir);
      if (!fs.existsSync(dir)) continue;
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
      for (const f of files) uploadFiles.push({ path: path.join(dir, f), name: f, type: subdir });
    }
    if (uploadFiles.length === 0) return res.status(400).json({ error: 'No framed screenshots found. Run Capture first.' });

    // 4. Upload each to Supabase storage
    const uploadedFilenames = [];
    for (const file of uploadFiles) {
      const buffer = fs.readFileSync(file.path);
      const filename = `${Date.now()}-${file.type}-${file.name.replace('.png', '')}.png`;
      const storagePath = `${slug}/${filename}`;

      const uploadRes = await fetch(`${SUPABASE_URL}/storage/v1/object/portfolio/${storagePath}`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${SERVICE_KEY}`,
          'Content-Type': 'image/png',
          'x-upsert': 'false',
        },
        body: buffer,
      });
      if (!uploadRes.ok) {
        const err = await uploadRes.text();
        return res.status(500).json({ error: `Upload failed for ${file.name}: ${err}` });
      }
      uploadedFilenames.push(filename);
      // Small delay to ensure unique timestamps
      await new Promise(r => setTimeout(r, 50));
    }

    // 5. Extract tags from architect field
    const architect = appData.architect || '';
    const TAG_PATTERNS = [
      'Next.js', 'React', 'TypeScript', 'JavaScript', 'Tailwind', 'Supabase',
      'Vite', 'SQLite', 'PostgreSQL', 'Node.js', 'Express', 'Electron',
      'WebSocket', 'Redis', 'Docker', 'Swift', 'Python', 'Rust', 'Go',
      'Vue', 'Svelte', 'Angular', 'MongoDB', 'Prisma', 'Drizzle',
    ];
    const tags = TAG_PATTERNS.filter(t => architect.toLowerCase().includes(t.toLowerCase()));

    // 6. Build description array
    const description = [appData.about || appData.name];
    if (appData.features) {
      try {
        const features = typeof appData.features === 'string' ? JSON.parse(appData.features) : appData.features;
        if (Array.isArray(features)) description.push(...features);
      } catch {}
    }

    // 7. Create portfolio entry via Supabase REST
    const portfolioBody = {
      slug,
      title: appData.name,
      type: 'professional',
      tags,
      description,
      images: uploadedFilenames,
      thumbnail: uploadedFilenames[0],
      url: appData.prodUrl || null,
    };

    // Get next sort_order
    const orderRes = await fetch(`${SUPABASE_URL}/rest/v1/portfolios?select=sort_order&order=sort_order.desc&limit=1`, {
      headers: { 'apikey': SERVICE_KEY, 'Authorization': `Bearer ${SERVICE_KEY}` },
    });
    const orderRows = await orderRes.json();
    const nextOrder = (orderRows[0]?.sort_order ?? 0) + 1;
    portfolioBody.sort_order = nextOrder;

    const insertRes = await fetch(`${SUPABASE_URL}/rest/v1/portfolios`, {
      method: 'POST',
      headers: {
        'apikey': SERVICE_KEY,
        'Authorization': `Bearer ${SERVICE_KEY}`,
        'Content-Type': 'application/json',
        'Prefer': 'return=representation',
      },
      body: JSON.stringify(portfolioBody),
    });

    if (!insertRes.ok) {
      const err = await insertRes.text();
      return res.status(500).json({ error: `Portfolio insert failed: ${err}` });
    }

    const created = await insertRes.json();
    res.json({ ok: true, portfolio: created[0] || created, images: uploadedFilenames.length });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- MCP Activity Logging ---
app.post('/api/mcp/log', (req, res) => {
  const { server, tool, args, resultLength, isError, durationMs, cwd } = req.body;
  if (!server || !tool) return res.status(400).json({ error: 'server and tool required' });
  try {
    db.insertMcpActivity({
      server, tool,
      args: typeof args === 'string' ? args.slice(0, 2000) : JSON.stringify(args || {}).slice(0, 2000),
      resultLength: resultLength || 0,
      isError: isError ? 1 : 0,
      durationMs: durationMs || null,
      cwd: cwd || null,
    });
  } catch {}
  res.status(204).end();
});

app.get('/api/mcp/activity', (req, res) => {
  const { server, tool, from, to, limit = '50', offset = '0' } = req.query;
  const data = db.getMcpActivity({ server, tool, from, to, limit: parseInt(limit), offset: parseInt(offset) });
  res.json(data);
});

app.get('/api/mcp/stats', (req, res) => {
  const { server, from, to } = req.query;
  res.json(db.getMcpStats({ server, from, to }));
});

// Purge old MCP activity on startup + daily
db.purgeMcpActivity(30);
setInterval(() => db.purgeMcpActivity(30), 24 * 60 * 60 * 1000);

// Shell config download - allows other machines to pull zsh setup
app.get('/api/shell/:file', (req, res) => {
  const allowed = {
    'zshrc': path.join(os.homedir(), '.zshrc'),
    'profile': path.join(os.homedir(), '.profile'),
    'claude-tabs': path.join(os.homedir(), '.claude-tabs.sh'),
    'tab-colors': path.join(os.homedir(), '.claude', 'tab-colors.json'),
  };
  const file = allowed[req.params.file];
  if (!file) return res.status(404).json({ error: 'not found', available: Object.keys(allowed) });
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'file missing' });
  res.type(file.endsWith('.json') ? 'json' : 'text').send(fs.readFileSync(file, 'utf8'));
});

app.get('/api/shell', (req, res) => {
  res.json({ zshrc: '~/.zshrc', profile: '~/.profile', 'claude-tabs': '~/.claude-tabs.sh', 'tab-colors': '~/.claude/tab-colors.json' });
});

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

// Bind the control API to localhost only. The network-facing dashboard (Next, 9876)
// reaches it via a same-host proxy, so the raw exec/launchd/Caddy API is never
// directly reachable from the LAN or tailnet. Override with API_BIND if you run a
// trusted multi-machine setup that needs peer-to-peer sync.
const API_BIND = process.env.API_BIND || '127.0.0.1';
app.listen(PORT, API_BIND, () => {
  console.log(`\n  Local Apps API (control plane) running at:`);
  console.log(`  http://${API_BIND}:${PORT}  (dashboard: http://localhost:9876)`);
  console.log(`  Role:   ${MACHINE_ROLE.toUpperCase()}${IS_HUB ? ' (bots + auto-fix enabled)' : ' (status reporting only)'}\n`);
  startupSync();
});
