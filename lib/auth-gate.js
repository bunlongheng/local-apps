// Pure decision for the control-API auth gate. Extracted from server.js so the
// trust-loopback security policy is unit-testable in isolation (no HTTP needed).
//
// Policy (fail closed off-box): loopback callers - the localhost dashboard, direct or via
// the Caddy loopback proxy - are fully trusted. Any OFF-BOX caller may read only
// non-sensitive GETs (the iPad/LAN status view); every mutating request and every sensitive
// GET (logs) requires the configured token and is DENIED when no token is set. This closes
// unauthenticated LAN command-injection and secret reads even in the default (no-token) setup.
const crypto = require('crypto');

// Reads that reveal filesystem paths, the shell/tab registry, or per-machine internals.
const SENSITIVE_GET = /\/api\/(log|capabilities|tab-colors|consistency|app-profiles|icon-sync|all-apps|machines\/[^/]+\/(apps|status))(\/|$)|\/log(\/|$)/;

function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

// Constant-time compare; false unless both are set and equal length.
function tokenOk(given, configured) {
  if (!configured || !given || given.length !== configured.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(configured)); } catch { return false; }
}

// Returns { allow: true } or { allow: false, status: 401 }.
// Host values a request may legitimately arrive on. Anything else on a loopback socket
// is DNS rebinding (attacker.example resolving to 127.0.0.1) and gets a 421.
function hostAllowed(host, extra = []) {
  const h = String(host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[(.*)\]$/, '$1');
  if (!h) return false;
  if (h === 'localhost' || h === '127.0.0.1' || h === '::1' || h.endsWith('.localhost')) return true;
  return extra.filter(Boolean).map(String).map(x => x.toLowerCase()).includes(h);
}
// The only thing that legitimately connects from loopback on behalf of someone else is the
// Caddy reverse proxy on :80, and it always sets X-Forwarded-For. So on a loopback socket the
// first XFF hop IS the client; a real loopback client never needs to send the header (sending
// one can only reduce its own trust, never raise it).
function effectiveAddress(remoteAddress, forwardedFor) {
  if (!isLoopback(remoteAddress) || !forwardedFor) return remoteAddress;
  const first = String(forwardedFor).split(',')[0].trim();
  return first || remoteAddress;
}
function decide({ remoteAddress, method, path, token, configuredToken, host, origin, allowedHosts = [], forwardedFor }) {
  remoteAddress = effectiveAddress(remoteAddress, forwardedFor);
  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE';
  if (host !== undefined && !hostAllowed(host, allowedHosts)) return { allow: false, status: 421 };
  // A browser sends Origin on cross-site POSTs; a same-site page or a CLI does not, or sends
  // one of our own hosts. Anything else is a simple-request CSRF and is refused.
  if (mutating && origin) {
    let oh = null; try { oh = new URL(origin).hostname; } catch { oh = null; }
    if (!hostAllowed(oh, allowedHosts)) return { allow: false, status: 403 };
  }
  if (isLoopback(remoteAddress)) return { allow: true };
  const sensitive = method === 'GET' && SENSITIVE_GET.test(path);
  if (!mutating && !sensitive) return { allow: true };
  if (tokenOk(token, configuredToken)) return { allow: true };
  return { allow: false, status: 401 };
}

module.exports = { decide, isLoopback, tokenOk, hostAllowed, effectiveAddress, SENSITIVE_GET };
