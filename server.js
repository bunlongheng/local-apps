const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode');
const db = require('./db');

const { marked } = require('marked');
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
const PORT = 9876;
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
const NPM_PATH = (() => {
  try { return execSync('which npm').toString().trim(); }
  catch { return '/opt/homebrew/bin/npm'; }
})();

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// --- Caddy + /etc/hosts management ---
function getCaddyfile() {
  try { return fs.readFileSync(CADDYFILE, 'utf8'); } catch { return ''; }
}

function writeCaddyfile(content) {
  fs.writeFileSync(CADDYFILE, content, 'utf8');
}

function reloadCaddy() {
  // Validate first - never reload with broken config
  try {
    execSync('caddy validate --config ' + CADDYFILE + ' --adapter caddyfile 2>/dev/null');
    execSync('caddy reload --config ' + CADDYFILE + ' --adapter caddyfile 2>/dev/null');
  } catch { /* validation failed or reload failed - don't crash caddy */ }
}

function addCaddyEntry(id, port) {
  const domain = `http://${id}.localhost`;
  const caddyContent = getCaddyfile();
  if (caddyContent.includes(`${id}.localhost`)) return domain;
  const block = `\n${domain} {\n\treverse_proxy ${LAN_IP}:${port}\n\thandle_errors 502 503 {\n\t\troot * ${CADDY_ERROR_ROOT}\n\t\trewrite * /offline.html\n\t\tfile_server\n\t}\n}\n`;
  writeCaddyfile(caddyContent + block);
  reloadCaddy();
  return domain;
}

function removeCaddyEntry(id) {
  const lines = getCaddyfile().split('\n');
  const marker = `http://${id}.localhost`;
  const out = [];
  let depth = 0;
  let skipping = false;
  for (const line of lines) {
    if (!skipping && line.trim().startsWith(marker)) {
      skipping = true;
      depth = 0;
    }
    if (skipping) {
      depth += (line.match(/\{/g) || []).length;
      depth -= (line.match(/\}/g) || []).length;
      if (depth <= 0 && line.includes('}')) { skipping = false; continue; }
      continue;
    }
    out.push(line);
  }
  const updated = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
  if (updated !== getCaddyfile()) {
    writeCaddyfile(updated);
    reloadCaddy();
  }
}


// --- LaunchAgent management ---
const LAUNCH_AGENTS_DIR = path.join(os.homedir(), 'Library', 'LaunchAgents');
const USERNAME = os.userInfo().username;

function createLaunchAgent(id, localPath, logPath, startCommand) {
  if (!localPath) return { launchAgent: null, launchAgentPath: null };
  const label = `com.${USERNAME}.${id}`;
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  if (fs.existsSync(plistPath)) return { launchAgent: label, launchAgentPath: plistPath };

  const log = logPath || `/tmp/${id}.log`;
  // Default: "npm run dev", allow override e.g. "npm start", "bun dev"
  const cmd = startCommand || 'npm run dev';
  const parts = cmd.split(/\s+/);
  const bin = parts[0] === 'npm' ? NPM_PATH : parts[0];
  const args = parts.slice(1);
  const argsXml = [bin, ...args].map(a => `\t\t<string>${a}</string>`).join('\n');

  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
\t<key>Label</key>
\t<string>${label}</string>
\t<key>WorkingDirectory</key>
\t<string>${localPath}</string>
\t<key>ProgramArguments</key>
\t<array>
${argsXml}
\t</array>
\t<key>EnvironmentVariables</key>
\t<dict>
\t\t<key>PATH</key>
\t\t<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
\t</dict>
\t<key>RunAtLoad</key>
\t<false/>
\t<key>KeepAlive</key>
\t<false/>
\t<key>StandardOutPath</key>
\t<string>${log}</string>
\t<key>StandardErrorPath</key>
\t<string>${log}</string>
</dict>
</plist>`;

  try {
    fs.mkdirSync(LAUNCH_AGENTS_DIR, { recursive: true });
    fs.writeFileSync(plistPath, plist, 'utf8');
    return { launchAgent: label, launchAgentPath: plistPath };
  } catch { return { launchAgent: null, launchAgentPath: null }; }
}

function removeLaunchAgent(id) {
  const label = `com.${USERNAME}.${id}`;
  const plistPath = path.join(LAUNCH_AGENTS_DIR, `${label}.plist`);
  try {
    execSync(`launchctl unload "${plistPath}" 2>/dev/null || true`);
    if (fs.existsSync(plistPath)) fs.unlinkSync(plistPath);
  } catch { /* best effort */ }
}

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
}

function getLanIp() {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return 'N/A';
}
const LAN_IP = getLanIp();

// --- Tailscale IP detection (re-checked each status call) ---
function getTailscaleIp() {
  try { return execSync('tailscale ip -4 2>/dev/null').toString().trim(); }
  catch { return null; }
}
let TAILSCALE_IP = getTailscaleIp();

// --- Machine model detection ---
const MACHINE_MODEL = (() => {
  try {
    const name = execSync('system_profiler SPHardwareDataType 2>/dev/null').toString();
    const match = name.match(/Model Name:\s*(.+)/);
    return match ? match[1].trim() : null;
  } catch { return null; }
})();

// --- State ---
const state = {};
function getState(id) {
  if (!state[id]) state[id] = { status: 'unknown', lastChecked: null };
  return state[id];
}

// --- HTTP health check (GET, only 2xx/3xx = "up") ---
const http = require('http');
function tcpCheck(url) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(url, { timeout: 3000, headers: { 'User-Agent': 'local-apps' } }, res => {
        res.destroy();
        resolve(res.statusCode >= 200 && res.statusCode < 400);
      });
      req.on('error', () => resolve(false));
      req.on('timeout', () => { req.destroy(); resolve(false); });
    } catch { resolve(false); }
  });
}

// --- Process name check ---
function processCheck(name) {
  try {
    const out = execSync(`pgrep -f "${name}" 2>/dev/null`).toString().trim();
    return out.length > 0;
  } catch { return false; }
}

// --- SSE clients ---
const sseClients = new Set();
function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) res.write(msg);
}

// --- Health check loop ---
async function checkAll() {
  const apps = db.getApps();
  for (const appCfg of apps) {
    const s = getState(appCfg.id);
    s.lastChecked = new Date().toISOString();

    let up = false;
    if (appCfg.healthUrl) {
      up = await tcpCheck(appCfg.healthUrl);
    } else if (appCfg.processCheck) {
      up = processCheck(appCfg.processCheck);
    }

    const newStatus = up ? 'up' : 'down';
    if (s.status !== newStatus) {
      s.status = newStatus;
      broadcast({ type: 'update', id: appCfg.id, status: newStatus });
      if (newStatus === 'down') broadcast({ type: 'alert', id: appCfg.id, name: appCfg.name });
    }

    // Auto-restart: hub only, with 90s cooldown to prevent restart loops
    if (IS_HUB && newStatus === 'down' && (appCfg.launchAgentPath || appCfg.launchAgent)) {
      const lastRestart = s.lastRestart || 0;
      const cooldown = 90000; // 90s - give apps time to compile
      if (Date.now() - lastRestart > cooldown) {
        try {
          if (appCfg.launchAgentPath) {
            execSync(`launchctl load -w "${appCfg.launchAgentPath}" 2>/dev/null || launchctl start "${appCfg.launchAgent}" 2>/dev/null || true`);
          } else {
            execSync(`launchctl start "${appCfg.launchAgent}" 2>/dev/null || true`);
          }
          s.lastRestart = Date.now();
          console.log(`  ↻ auto-restart: ${appCfg.id}`);
        } catch {}
      }
    }
  }
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
  TAILSCALE_IP = getTailscaleIp();
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
      hostname: os.hostname(),
      hasScreenshots: screenshotCache[a.id] || false,
    };
  });
  res.json({ apps, lanIp: LAN_IP, tailscaleIp: TAILSCALE_IP, machineModel: MACHINE_MODEL, machineRole: MACHINE_ROLE, monitorUrl: `http://${LAN_IP}:${PORT}` });
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

// Validate app id: lowercase alphanumeric, hyphens only, 1-64 chars
function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

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

  const result = db.upsertApp(data);
  broadcast({ type: 'reload' });
  res.json(result);
});

app.delete('/api/apps/:id', (req, res) => {
  const deleted = db.deleteApp(req.params.id);
  if (!deleted) return res.status(404).json({ error: 'not found' });
  teardownInfra(req.params.id);
  delete state[req.params.id];
  broadcast({ type: 'update', id: req.params.id, status: 'removed' });
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
  try {
    const out = execSync(`tail -30 "${appCfg.logPath}" 2>/dev/null || true`).toString();
    res.json({ lines: out.trim().split('\n').filter(Boolean) });
  } catch { res.json({ lines: [] }); }
});

app.post('/api/start/:id', (req, res) => {
  const appCfg = db.getApp(req.params.id);
  if (!appCfg) return res.status(404).json({ error: 'not found' });
  try {
    if (appCfg.launchAgentPath) {
      execSync(`launchctl load -w "${appCfg.launchAgentPath}" 2>/dev/null || launchctl start "${appCfg.launchAgent}" 2>/dev/null || true`);
    } else if (appCfg.launchAgent) {
      execSync(`launchctl start "${appCfg.launchAgent}" 2>/dev/null || true`);
    } else {
      return res.status(400).json({ error: 'no launchAgent configured' });
    }
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
  if (filename.includes('/') || filename.includes('..')) return res.status(400).json({ error: 'invalid filename' })
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

function probeHost(ip, port = 9876) {
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
        http.get(`http://${p.ip}:${p.port || 9876}/api/status`, { timeout: 3000 }, (resp) => {
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

// --- Cron Status API ---
const CRON_JOBS = [
  // Always running
  { id: 'auto-restart',       hour: '30s',   desc: 'Restart any down app via launchctl',                    autoFix: true,  log: '/tmp/local-apps.log',           summary: null },
  { id: 'health-check-fix',   hour: '5min',  desc: 'Quick fix + Claude agents for stubborn failures',       autoFix: true,  log: '/tmp/health-check-fix.log',     summary: '/tmp/health-check-summary.json' },
  // Nightly pipeline
  { id: 'git-pull-all',       hour: '12 AM', desc: 'Sync all repos from GitHub',                            autoFix: false, log: '/tmp/git-pull-all.log',         summary: null },
  { id: 'nightly-tests',      hour: '1 AM',  desc: 'Unit + E2E tests, Claude agents auto-fix',              autoFix: true,  log: '/tmp/nightly-tests.log',        summary: '/tmp/nightly-tests-summary.json' },
  { id: 'nightly-crawler',    hour: '1:30 AM', desc: 'Crawl all pages, screenshot errors, Claude agents fix', autoFix: true, log: '/tmp/link-crawler.log',         summary: '/tmp/link-crawler-summary.json' },
  { id: 'nightly-screenshots', hour: '2 AM', desc: 'All apps desktop + mobile + framed',                    autoFix: false, log: '/tmp/nightly-screenshots.log',  summary: null },
  { id: 'nightly-gifs',       hour: '3 AM',  desc: 'Animated HD recordings via LAN',                        autoFix: false, log: '/tmp/nightly-gifs.log',         summary: null },
  { id: 'deep-audit',         hour: '4 AM',  desc: 'Cache, modules, ports, disk, Caddy',                    autoFix: true,  log: '/tmp/deep-audit.log',           summary: '/tmp/deep-audit-summary.json' },
  { id: 'nightly-scan',       hour: '5 AM',  desc: 'Security + performance scan (flags only)',               autoFix: false, log: '/tmp/nightly-scan.log',         summary: '/tmp/nightly-scan-summary.json' },
  { id: 'nightly-summary',    hour: '6 AM',  desc: 'Aggregate results, post to stickies',                   autoFix: false, log: '/tmp/nightly-summary.log',      summary: null },
  // Daytime
  { id: 'health-reminder',    hour: '45min', desc: 'Water, breaks, walks, eye rest, stretch reminders',     autoFix: false, log: '/tmp/health-reminder.log',      summary: null },
  // Nexus Agents (12 agents x 2 runs = 24hr coverage)
  { id: 'agent-pulse',  hour: '12AM+12PM', desc: '💫 Pulse — Git sync, stale branches, backup verify',      autoFix: false, log: '/tmp/agent-pulse.log',  summary: null },
  { id: 'agent-blitz',  hour: '1AM+1PM',   desc: '💎 Blitz — Unit tests, type check, lint',                 autoFix: true,  log: '/tmp/agent-blitz.log',  summary: '/tmp/nightly-tests-summary.json' },
  { id: 'agent-arrow',  hour: '2AM+2PM',   desc: '🎯 Arrow — E2E tests, accessibility, link crawler',      autoFix: true,  log: '/tmp/agent-arrow.log',  summary: '/tmp/link-crawler-summary.json' },
  { id: 'agent-shadow', hour: '3AM+3PM',   desc: '🥷 Shadow — Security scan, dependency audit',             autoFix: false, log: '/tmp/agent-shadow.log', summary: '/tmp/nightly-scan-summary.json' },
  { id: 'agent-frost',  hour: '4AM+4PM',   desc: '🧊 Frost — Lighthouse, screenshots',                     autoFix: false, log: '/tmp/agent-frost.log',  summary: null },
  { id: 'agent-earth',  hour: '5AM+5PM',   desc: '🌍 Earth — Deep audit, dead code hunter',                 autoFix: true,  log: '/tmp/agent-earth.log',  summary: '/tmp/deep-audit-summary.json' },
  { id: 'agent-zap',    hour: '6AM+6PM',   desc: '⚡ Zap — Bundle analyzer, performance profiler',          autoFix: false, log: '/tmp/agent-zap.log',    summary: '/tmp/agent-zap-summary.json' },
  { id: 'agent-sand',   hour: '7AM+7PM',   desc: '🏖️ Sand — DB integrity, API health',                     autoFix: false, log: '/tmp/agent-sand.log',   summary: '/tmp/agent-sand-summary.json' },
  { id: 'agent-venus',  hour: '8AM+8PM',   desc: '💜 Venus — UI regression, screenshot diff',               autoFix: false, log: '/tmp/agent-venus.log',  summary: '/tmp/agent-venus-summary.json' },
  { id: 'agent-rock',   hour: '9AM+9PM',   desc: '🪨 Rock — Log analyzer, GIF recordings',                  autoFix: false, log: '/tmp/agent-rock.log',   summary: null },
  { id: 'agent-blaze',  hour: '10AM+10PM', desc: '🔥 Blaze — SEO check, documentation audit',               autoFix: false, log: '/tmp/agent-blaze.log',  summary: '/tmp/agent-blaze-summary.json' },
  { id: 'agent-snow',   hour: '11AM+11PM', desc: '❄️ Snow — Summary report, auto-fix orchestrator',         autoFix: true,  log: '/tmp/agent-snow.log',   summary: '/tmp/agent-snow-summary.json' },
];

// Cache cron data - refresh every 30s instead of reading files on every request
let cronCache = { data: null, ts: 0 };
function refreshCronCache() {
  cronCache.data = CRON_JOBS.map(c => {
    const result = { ...c, lastRun: null, lastLines: null, summaryData: null };
    try {
      const stat = fs.statSync(c.log);
      result.lastRun = stat.mtime.toISOString();
      const content = fs.readFileSync(c.log, 'utf8');
      result.lastLines = content.split('\n').slice(-12).join('\n');
    } catch {}
    if (c.summary) {
      try { result.summaryData = JSON.parse(fs.readFileSync(c.summary, 'utf8')); } catch {}
    }
    return result;
  });
  cronCache.ts = Date.now();
}
refreshCronCache();
setInterval(refreshCronCache, 30000);

app.get('/api/crons', (req, res) => {
  res.json(cronCache.data || []);
});

app.get('/api/crons/:id/log', (req, res) => {
  const cron = CRON_JOBS.find(c => c.id === req.params.id);
  if (!cron) return res.status(404).json({ error: 'cron not found' });
  try {
    const lines = parseInt(req.query.lines) || 100;
    const content = fs.readFileSync(cron.log, 'utf8');
    const tail = content.split('\n').slice(-lines).join('\n');
    res.type('text').send(tail);
  } catch { res.type('text').send('No log file yet'); }
});

// --- README API ---
app.get('/api/readme/:id', (req, res) => {
  const appConfig = db.getApps().find(a => a.id === req.params.id);
  const localPath = appConfig?.localPath;
  if (!localPath) return res.status(404).json({ error: 'app not found' });

  const readmePath = path.join(localPath, 'README.md');
  try {
    const md = fs.readFileSync(readmePath, 'utf8');
    const html = marked(md);
    res.json({ markdown: md, html });
  } catch {
    res.status(404).json({ error: 'no README.md' });
  }
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

// Global error handler — no stack traces leaked
app.use((err, req, res, _next) => {
  console.error(err.message);
  res.status(400).json({ error: 'Bad request' });
});

app.listen(PORT, () => {
  console.log(`\n  Local Apps running at:`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  LAN:    http://${LAN_IP}:${PORT}`);
  console.log(`  Role:   ${MACHINE_ROLE.toUpperCase()}${IS_HUB ? ' (bots + auto-fix enabled)' : ' (status reporting only)'}\n`);
  startupSync();
});
