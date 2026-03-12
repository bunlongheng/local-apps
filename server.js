const express = require('express');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');

const app = express();
const PORT = 9876;
const CONFIG_FILE = path.join(__dirname, 'apps.config.json');
const CHECK_INTERVAL = 10000;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function loadConfig() {
  return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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

// --- State ---
const state = {};
function getState(id) {
  if (!state[id]) state[id] = { status: 'unknown', lastChecked: null };
  return state[id];
}

// --- TCP port check (tries IPv4 then IPv6) ---
function tcpCheck(url) {
  const port = new URL(url).port || 80;
  const tryHost = (host) => new Promise(resolve => {
    const sock = new net.Socket();
    sock.setTimeout(2000);
    sock.connect(port, host, () => { sock.destroy(); resolve(true); });
    sock.on('error', () => resolve(false));
    sock.on('timeout', () => { sock.destroy(); resolve(false); });
  });
  return tryHost('127.0.0.1').then(ok => ok ? true : tryHost('::1'));
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
  const config = loadConfig();
  for (const appCfg of config) {
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

// --- Routes ---
app.get('/api/status', (req, res) => {
  const config = loadConfig();
  const apps = config.map(a => {
    const s = getState(a.id);
    return {
      id: a.id,
      name: a.name,
      localUrl: a.localUrl,
      lanUrl: a.localUrl ? a.localUrl.replace('localhost', LAN_IP) : null,
      status: s.status,
      lastChecked: s.lastChecked,
      launchAgent: a.launchAgent || null,
      launchAgentPath: a.launchAgentPath || null,
      repo: a.repo || null,
      localPath: a.localPath || null,
      logPath: a.logPath || null,
      hostname: os.hostname(),
    };
  });
  res.json({ apps, lanIp: LAN_IP, monitorUrl: `http://${LAN_IP}:${PORT}` });
});

app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  res.on('close', () => sseClients.delete(res));
});

// --- File watcher ---
let reloadTimer = null;
[path.join(__dirname, 'public'), CONFIG_FILE].forEach(p => {
  fs.watch(p, { recursive: true }, () => {
    clearTimeout(reloadTimer);
    reloadTimer = setTimeout(() => broadcast({ type: 'reload' }), 200);
  });
});

// --- Boot ---
checkAll();
setInterval(checkAll, CHECK_INTERVAL);

app.listen(PORT, () => {
  console.log(`\n  Apps Monitor running at:`);
  console.log(`  Local:  http://localhost:${PORT}`);
  console.log(`  LAN:    http://${LAN_IP}:${PORT}\n`);
});
