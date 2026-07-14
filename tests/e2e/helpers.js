// Tiny fetch helper for e2e tests against the running local-apps server.
// Tests hit the live instance on 9876 (the always-on dashboard) and only ever
// send inputs that trip the safety guards, so nothing real is killed or mutated.
const BASE = process.env.LOCAL_APPS_URL || 'http://localhost:9876';

async function api(method, p, body) {
  const opts = { method, headers: {} };
  if (body !== undefined) {
    opts.headers['Content-Type'] = 'application/json';
    opts.body = JSON.stringify(body);
  }
  const res = await fetch(BASE + p, opts);
  let json = null;
  const text = await res.text();
  try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  return { status: res.status, json };
}

async function serverUp() {
  try {
    const r = await fetch(BASE + '/api/loops', { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

module.exports = { api, serverUp, BASE };
