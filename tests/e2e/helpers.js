// Tiny fetch helper for e2e tests against a running local-apps server (LOCAL_APPS_URL, default :9875).
// apps-guards.test.js only sends inputs that trip the safety guards, so nothing is mutated.
// lifecycle.test.js DOES register and delete an app (on macOS that provisions a real Caddy block
// and LaunchAgent), so it only runs with E2E_MUTATE=1 - set that against a scratch instance, never
// the live hub. CI boots one (see .github/workflows/ci.yml); locally see CLAUDE.md.
const BASE = process.env.LOCAL_APPS_URL || 'http://localhost:9875';

async function api(method, p, body) {
  // Bounded: a wedged handler must fail in seconds with the server log, not at the job timeout.
  const opts = { method, headers: {}, signal: AbortSignal.timeout(15000) };
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
    const r = await fetch(BASE + '/api/status', { signal: AbortSignal.timeout(3000) });
    return r.ok;
  } catch { return false; }
}

module.exports = { api, serverUp, BASE };
