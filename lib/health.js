// App health-check primitives: per-app state, HTTP reachability, process check,
// and a single-app recheck. Extracted from server.js. The auto-restart
// orchestration (checkAll) stays in server.js and consumes these.
// Factory dep: broadcast(fn) for SSE status pushes.
const http = require('http');
const https = require('https');
const { execFile } = require('child_process');

module.exports = function makeHealth({ broadcast }) {
  const state = {};

  function getState(id) {
    if (!state[id]) state[id] = { status: 'unknown', lastChecked: null };
    return state[id];
  }

  function clearState(id) {
    delete state[id];
  }

  // HTTP health check - only 2xx/3xx counts as "up". Non-blocking.
  // HEAD is enough to know a server answers and costs a dev server no render; a few frameworks
  // answer 405/501 to HEAD, and those get 1 GET.
  function probe(url, method) {
    return new Promise(resolve => {
      try {
        const parsed = new URL(url);
        const mod = parsed.protocol === 'https:' ? https : http;
        const req = mod.request(url, { method, timeout: 3000, headers: { 'User-Agent': 'local-apps' } }, res => {
          res.destroy();
          resolve(res.statusCode);
        });
        req.on('error', () => resolve(null));
        req.on('timeout', () => { req.destroy(); resolve(null); });
        req.end();
      } catch { resolve(null); }
    });
  }
  async function tcpCheck(url) {
    let code = await probe(url, 'HEAD');
    if (code === 405 || code === 501) code = await probe(url, 'GET');
    return code !== null && code >= 200 && code < 400;
  }

  // Process name check - shell-free (execFile passes name as an arg, so it
  // cannot be shell-injected) and async (does not block the event loop).
  function processCheck(name) {
    return new Promise((resolve) => {
      execFile('pgrep', ['-f', name], { timeout: 3000 }, (err, stdout) => {
        resolve(!err && String(stdout).trim().length > 0);
      });
    });
  }

  // Single-app recheck for immediate UI update after a start/stop.
  async function checkSingle(appCfg) {
    const s = getState(appCfg.id);
    let up = false;
    if (appCfg.healthUrl) up = await tcpCheck(appCfg.healthUrl);
    else if (appCfg.processCheck) up = await processCheck(appCfg.processCheck);
    const newStatus = up ? 'up' : 'down';
    if (s.status !== newStatus) {
      s.status = newStatus;
      s.lastChecked = new Date().toISOString();
      broadcast({ type: 'update', id: appCfg.id, status: newStatus });
      if (newStatus === 'up' && s.downSince) {
        s.downSince = null;
        s.restartAttempts = 0;
      }
    }
  }

  return { getState, clearState, tcpCheck, processCheck, checkSingle };
};
