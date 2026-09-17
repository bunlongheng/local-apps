// Peer machine helpers. One JSON-over-http primitive with a real timeout (the hand-rolled
// copies in server.js had 4 variants, 2 of them without a 'timeout' handler, so a half-open
// peer hung the sweep), and a subnet sweep with a concurrency cap so 253 probes never open
// 253 sockets at once.
const http = require('http');

function fetchJson(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (resp) => {
      let body = '';
      resp.on('data', (c) => { body += c; });
      resp.on('end', () => { try { resolve(JSON.parse(body)); } catch { reject(new Error('invalid JSON')); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
  });
}

// Run `probe(ip)` over every host of a /24 except self, at most `concurrency` in flight.
async function sweepSubnet(lanIp, probe, { concurrency = 32 } = {}) {
  if (!lanIp || lanIp === 'N/A') return [];
  const subnet = lanIp.split('.').slice(0, 3).join('.');
  const ips = [];
  for (let i = 1; i <= 254; i++) { const ip = `${subnet}.${i}`; if (ip !== lanIp) ips.push(ip); }
  const found = [];
  for (let i = 0; i < ips.length; i += concurrency) {
    const batch = await Promise.all(ips.slice(i, i + concurrency).map((ip) => probe(ip).catch(() => null)));
    found.push(...batch.filter(Boolean));
  }
  return found;
}

// A LAN host answering /api/machine is not trusted: its hostname is rendered in the hub
// dashboard and used as a db key, so it must be a plain hostname or it becomes the ip.
const HOSTNAME = /^[A-Za-z0-9][A-Za-z0-9.-]{0,62}$/;
function peerRecord(ip, port, info) {
  const hostname = HOSTNAME.test(String(info?.hostname || '')) ? String(info.hostname) : ip;
  const model = String(info?.model || '').replace(/[^\w .()-]/g, '').slice(0, 40);
  const appCount = Number.isInteger(info?.appCount) && info.appCount >= 0 ? info.appCount : 0;
  return { id: hostname, hostname, ip, port, model, appCount };
}

module.exports = { fetchJson, sweepSubnet, peerRecord };
