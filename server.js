const express = require('express');
const net = require('net');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { execSync } = require('child_process');
const QRCode = require('qrcode');

// --- System memory helpers ---
const SWAP_HISTORY = [];
const SWAP_HISTORY_MAX = 20;

function getSystemStats() {
  const totalBytes = os.totalmem();

  // Use vm_stat for accurate available memory (macOS caches fill RAM aggressively)
  let availMb = null;
  let wiredMb = null;
  let compressedMb = null;
  let pageSize = 16384; // Apple Silicon default; override below
  try {
    const vmOut = execSync('vm_stat 2>/dev/null').toString();
    const pg = vmOut.match(/page size of (\d+) bytes/);
    if (pg) pageSize = parseInt(pg[1]);
    const grab = (label) => {
      const m = vmOut.match(new RegExp(label + ':\\s+(\\d+)'));
      return m ? parseInt(m[1]) * pageSize : 0;
    };
    const free        = grab('Pages free');
    const inactive    = grab('Pages inactive');
    const speculative = grab('Pages speculative');
    const purgeable   = grab('Pages purgeable');
    wiredMb      = grab('Pages wired down') / 1048576;
    compressedMb = grab('Pages occupied by compressor') / 1048576;
    availMb = (free + inactive + speculative + purgeable) / 1048576;
  } catch {}

  const usedMb  = availMb !== null ? (totalBytes / 1048576) - availMb : (totalBytes - os.freemem()) / 1048576;
  const totalMb = totalBytes / 1048576;
  const usedPct = (usedMb / totalMb) * 100;

  // macOS memory pressure level
  let pressure = 'normal'; // normal | warn | critical
  try {
    const mp = execSync('/usr/bin/memory_pressure 2>/dev/null').toString();
    if (/CRITICAL/i.test(mp)) pressure = 'critical';
    else if (/WARNING/i.test(mp)) pressure = 'warn';
  } catch {}

  let swapUsedMb = 0, swapTotalMb = 0;
  try {
    const sv = execSync('sysctl vm.swapusage 2>/dev/null').toString();
    const m = sv.match(/total\s*=\s*([\d.]+)(\w)\s+used\s*=\s*([\d.]+)(\w)/);
    if (m) {
      const toMb = (v, u) => u === 'G' ? parseFloat(v) * 1024 : parseFloat(v);
      swapTotalMb = toMb(m[1], m[2]);
      swapUsedMb  = toMb(m[3], m[4]);
    }
  } catch {}

  SWAP_HISTORY.push(swapUsedMb);
  if (SWAP_HISTORY.length > SWAP_HISTORY_MAX) SWAP_HISTORY.shift();

  let swapClimbing = false;
  if (SWAP_HISTORY.length >= 4) {
    const tail = SWAP_HISTORY.slice(-4);
    swapClimbing = tail[1] > tail[0] + 50 && tail[2] > tail[1] + 50 && tail[3] > tail[2] + 50;
  }

  return {
    ram: { totalMb, usedMb, availMb, wiredMb, compressedMb, pct: usedPct, pressure },
    swap: { totalMb: swapTotalMb, usedMb: swapUsedMb, climbing: swapClimbing },
  };
}

function getProcessList() {
  try {
    const out = execSync(
      "ps -eo pid,ppid,rss,pcpu,comm,args -r 2>/dev/null | head -100",
      { maxBuffer: 4 * 1024 * 1024 }
    ).toString();
    const lines = out.trim().split('\n').slice(1);
    return lines.map(line => {
      const parts = line.trim().split(/\s+/);
      const pid  = parseInt(parts[0]);
      const ppid = parseInt(parts[1]);
      const rss  = parseInt(parts[2]);   // KB
      const cpu  = parseFloat(parts[3]);
      const comm = parts[4] || '';
      const args = parts.slice(5).join(' ');
      const memMb = rss / 1024;
      const cl = comm.toLowerCase();
      const ag = args.toLowerCase();

      let type = 'other';
      if (cl.includes('claude') || ag.includes('/claude') || ag.includes('claude-code') || ag.includes('claude --') || ag.includes('@anthropic')) type = 'claude';
      else if ((cl === 'node' || cl === 'node.js') && (ag.includes('claude') || ag.includes('anthropic'))) type = 'claude';
      else if (ag.includes('google chrome') || ag.includes('chrome helper') || cl.includes('chrome')) type = 'chrome';
      else if (cl.includes('iterm')) type = 'iterm';
      else if (cl === 'node' || cl === 'node.js') type = 'node';

      // memory zone for per-process
      let zone = 'green';
      if (type === 'claude') {
        if (memMb > 8192) zone = 'critical';
        else if (memMb > 4096) zone = 'red';
        else if (memMb > 1536) zone = 'yellow';
      }

      return { pid, ppid, rss, cpu, comm, args, memMb, type, zone };
    }).filter(p => !isNaN(p.pid));
  } catch { return []; }
}

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
      caddyUrl: a.caddyUrl || null,
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

app.get('/api/system', (req, res) => {
  const stats = getSystemStats();
  const procs = getProcessList();
  res.json({ stats, procs });
});

app.post('/api/start/:id', (req, res) => {
  const config = loadConfig();
  const app = config.find(a => a.id === req.params.id);
  if (!app) return res.status(404).json({ error: 'not found' });
  try {
    if (app.launchAgentPath) {
      execSync(`launchctl load -w "${app.launchAgentPath}" 2>/dev/null || launchctl start "${app.launchAgent}" 2>/dev/null || true`);
    } else if (app.launchAgent) {
      execSync(`launchctl start "${app.launchAgent}" 2>/dev/null || true`);
    } else {
      return res.status(400).json({ error: 'no launchAgent configured' });
    }
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post('/api/kill/:pid', (req, res) => {
  const pid = parseInt(req.params.pid);
  if (!pid || pid < 2) return res.status(400).json({ error: 'invalid pid' });
  try {
    execSync(`kill -15 ${pid} 2>/dev/null || true`);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
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
