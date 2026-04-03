const express = require('express');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync, spawn } = require('child_process');
const QRCode = require('qrcode');
const swaggerUi = require('swagger-ui-express');
const swaggerDoc = require('./swagger.json');
const db = require('./db');

const app = express();
const PORT = 9876;
const CHECK_INTERVAL = 10000;
const CADDYFILE = process.env.CADDYFILE || '/opt/homebrew/etc/Caddyfile';
const CADDY_ERROR_ROOT = path.dirname(CADDYFILE);
const NPM_PATH = (() => {
  try { return execSync('which npm').toString().trim(); }
  catch { return '/opt/homebrew/bin/npm'; }
})();

app.use(express.json());
app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDoc, {
  customCss: `
    .swagger-ui .topbar { display: none }
    body { background: #1a1a2e }
    .swagger-ui { font-family: -apple-system, BlinkMacSystemFont, 'SF Mono', monospace }
  `,
  customSiteTitle: 'Local Apps — API Docs',
}));
app.use(express.static(path.join(__dirname, 'public')));

// --- Caddy + /etc/hosts management ---
function getCaddyfile() {
  try { return fs.readFileSync(CADDYFILE, 'utf8'); } catch { return ''; }
}

function writeCaddyfile(content) {
  fs.writeFileSync(CADDYFILE, content, 'utf8');
}

function reloadCaddy() {
  try { execSync('caddy reload --config ' + CADDYFILE + ' --adapter caddyfile 2>/dev/null || brew services restart caddy 2>/dev/null || true'); }
  catch { /* best effort */ }
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
  const caddyContent = getCaddyfile();
  // Remove the full block for this id
  const regex = new RegExp(`\\n?http://${id}\\.localhost\\s*\\{[^}]*(?:\\{[^}]*\\}[^}]*)*\\}\\n?`, 'g');
  const updated = caddyContent.replace(regex, '\n');
  if (updated !== caddyContent) {
    writeCaddyfile(updated.replace(/\n{3,}/g, '\n\n').trim() + '\n');
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

// --- HTTP health check (GET, accept any 1xx-4xx response as "up") ---
const http = require('http');
const https = require('https');
function tcpCheck(url) {
  return new Promise(resolve => {
    try {
      const parsed = new URL(url);
      const mod = parsed.protocol === 'https:' ? https : http;
      const req = mod.get(url, { timeout: 3000, headers: { 'User-Agent': 'local-apps' } }, res => {
        res.destroy();
        resolve(res.statusCode < 500);
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
  }
}

// --- Status route (dashboard) ---
app.get('/api/status', (req, res) => {
  res.header('Access-Control-Allow-Origin', '*');
  const apps = db.getApps().map(a => {
    const s = getState(a.id);
    const ssIndex = path.join(__dirname, 'public', 'screenshots', a.id, 'index.json');
    let hasScreenshots = false;
    if (fs.existsSync(ssIndex)) {
      try {
        const idx = JSON.parse(fs.readFileSync(ssIndex, 'utf8'));
        hasScreenshots = (idx.desktop?.length > 0) || (idx.mobile?.length > 0);
      } catch {}
    }
    return {
      id: a.id,
      name: a.name,
      localUrl: a.localUrl,
      lanUrl: a.localUrl ? a.localUrl.replace('localhost', LAN_IP) : null,
      status: s.status,
      lastChecked: s.lastChecked,
      caddyUrl: a.caddyUrl || null,
      launchAgent: a.launchAgent || null,
      launchAgentPath: a.launchAgentPath || null,
      icon: a.icon || null,
      repo: a.repo || null,
      localPath: a.localPath || null,
      logPath: a.logPath || null,
      hostname: os.hostname(),
      hasScreenshots,
    };
  });
  res.json({ apps, lanIp: LAN_IP, machineModel: MACHINE_MODEL, monitorUrl: `http://${LAN_IP}:${PORT}` });
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

app.post('/api/apps', (req, res) => {
  const { id } = req.body;
  if (!id) return res.status(400).json({ error: 'id is required' });

  // Auto-setup infra (caddy, hosts, launch agent)
  const infra = setupInfra(id, req.body);
  const merged = { ...req.body, ...infra };

  // Auto-set healthUrl from localUrl if not provided
  if (!merged.healthUrl && merged.localUrl) merged.healthUrl = merged.localUrl;

  const result = db.upsertApp(merged);
  broadcast({ type: 'reload' });
  res.status(201).json(result);
});

app.put('/api/apps/:id', (req, res) => {
  const existing = db.getApp(req.params.id);
  if (!existing) return res.status(404).json({ error: 'not found' });

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
  broadcast({ type: 'reload' });
  res.json({ ok: true });
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

// --- Machines (peers) ---
app.get('/api/machines', (req, res) => {
  res.json(db.getMachines());
});

app.post('/api/machines', async (req, res) => {
  let { ip, port = 9876 } = req.body;
  if (!ip) return res.status(400).json({ error: 'ip is required' });
  // Clean up: strip protocol, port, trailing slash
  ip = ip.replace(/^https?:\/\//, '').replace(/:\d+\/?$/, '').replace(/\/+$/, '');
  const url = `http://${ip}:${port}/api/machine`;
  try {
    const info = await new Promise((resolve, reject) => {
      http.get(url, { timeout: 5000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); } });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    });
    const id = info.hostname || ip;
    const machine = db.upsertMachine({ id, hostname: info.hostname, ip, port, model: info.model });
    res.json(machine);
  } catch (err) {
    // Fallback: try /api/status to get hostname
    try {
      const statusUrl = `http://${ip}:${port}/api/status`;
      const info = await new Promise((resolve, reject) => {
        http.get(statusUrl, { timeout: 5000 }, (resp) => {
          let data = '';
          resp.on('data', c => data += c);
          resp.on('end', () => { try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); } });
        }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
      });
      const hostname = info.apps?.[0]?.hostname || null;
      const model = info.machineModel || null;
      const id = hostname || ip;
      const machine = db.upsertMachine({ id, hostname, ip, port, model });
      res.json(machine);
    } catch {
      const machine = db.upsertMachine({ id: ip, hostname: null, ip, port, model: null });
      res.json(machine);
    }
  }
});

app.delete('/api/machines/:id', (req, res) => {
  const ok = db.deleteMachine(req.params.id);
  res.json({ deleted: ok });
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
    lanIp: LAN_IP,
    port: PORT,
    appCount: db.getApps().length,
  });
});

// Export: portable app list (no machine-specific paths)
app.get('/api/apps/export', (req, res) => {
  const apps = db.getApps().map(a => ({
    id: a.id,
    name: a.name,
    healthUrl: a.healthUrl,
    localUrl: a.localUrl,
    repo: a.repo,
    startCommand: a.startCommand,
    icon: a.icon,
  }));
  res.json({ hostname: os.hostname(), lanIp: LAN_IP, apps });
});

// Sync: pull app list from a remote machine and merge (ports, repos, icons)
// POST /api/sync { "remote": "10.0.0.218:9876" }
app.post('/api/sync', async (req, res) => {
  const { remote } = req.body;
  if (!remote) return res.status(400).json({ error: 'remote is required (ip:port or ip)' });

  const remoteUrl = remote.includes(':') ? remote : `${remote}:${PORT}`;
  const url = `http://${remoteUrl}/api/apps/export`;

  try {
    const remoteData = await new Promise((resolve, reject) => {
      http.get(url, { timeout: 5000 }, (resp) => {
        let data = '';
        resp.on('data', c => data += c);
        resp.on('end', () => {
          try { resolve(JSON.parse(data)); } catch { reject(new Error('invalid JSON')); }
        });
      }).on('error', reject).on('timeout', function() { this.destroy(); reject(new Error('timeout')); });
    });

    const localApps = new Map(db.getApps().map(a => [a.id, a]));
    const homedir = os.homedir();
    let added = 0, updated = 0;

    for (const app of remoteData.apps) {
      const local = localApps.get(app.id);
      if (!local) {
        // New app — add it with local paths derived from convention
        const localPath = path.join(homedir, 'Sites', app.id);
        db.upsertApp({
          id: app.id,
          name: app.name,
          healthUrl: app.healthUrl,
          localUrl: app.localUrl,
          repo: app.repo,
          startCommand: app.startCommand || 'npm run dev',
          icon: app.icon,
          localPath: fs.existsSync(localPath) ? localPath : null,
          logPath: `/tmp/${app.id}.log`,
        });
        added++;
      } else {
        // Existing app — sync port, repo, icon if different
        const updates = {};
        if (app.localUrl && app.localUrl !== local.localUrl) { updates.localUrl = app.localUrl; updates.healthUrl = app.healthUrl; }
        if (app.repo && !local.repo) updates.repo = app.repo;
        if (app.icon && !local.icon) updates.icon = app.icon;
        if (Object.keys(updates).length) {
          db.upsertApp({ id: app.id, ...updates });
          updated++;
        }
      }
    }

    broadcast({ type: 'reload' });
    res.json({
      synced: true,
      remote: { hostname: remoteData.hostname, ip: remoteData.lanIp },
      added,
      updated,
      total: db.getApps().length,
    });
  } catch (err) {
    res.status(502).json({ error: `Failed to reach ${url}: ${err.message}` });
  }
});

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
  res.json({ status: 'started' });
});

app.post('/api/generate-icons', (req, res) => {
  if (iconJobs.has('__all__')) return res.json({ status: 'already_running' });

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
  res.json({ status: 'started' });
});

app.get('/api/generate-icons/status', (req, res) => {
  const jobs = {};
  for (const [id, job] of iconJobs) jobs[id] = { startedAt: job.startedAt };
  res.json(jobs);
});

// --- File watcher (public dir only) ---
let reloadTimer = null;
fs.watch(path.join(__dirname, 'public'), { recursive: true }, () => {
  clearTimeout(reloadTimer);
  reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 200);
});

// --- Boot ---
checkAll();
setInterval(checkAll, CHECK_INTERVAL);

app.listen(PORT, () => {
  console.log(`\n  Local Apps running at:`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  LAN:    http://${LAN_IP}:${PORT}\n`);
});
