// Pure decision for the control-API auth gate. Extracted from server.js so the
// trust-loopback security policy is unit-testable in isolation (no HTTP needed).
//
// Policy (fail closed off-box): loopback callers - the localhost dashboard, direct or via
// the Caddy loopback proxy - are fully trusted. Any OFF-BOX caller may read only
// non-sensitive GETs (the iPad/LAN status view); every mutating request and every sensitive
// GET (logs) requires the configured token and is DENIED when no token is set. This closes
// unauthenticated LAN command-injection and secret reads even in the default (no-token) setup.
const crypto = require('crypto');

const SENSITIVE_GET = /\/log(\/|$)/;

function isLoopback(remoteAddress) {
  return remoteAddress === '127.0.0.1' || remoteAddress === '::1' || remoteAddress === '::ffff:127.0.0.1';
}

// Constant-time compare; false unless both are set and equal length.
function tokenOk(given, configured) {
  if (!configured || !given || given.length !== configured.length) return false;
  try { return crypto.timingSafeEqual(Buffer.from(given), Buffer.from(configured)); } catch { return false; }
}

// Returns { allow: true } or { allow: false, status: 401 }.
function decide({ remoteAddress, method, path, token, configuredToken }) {
  if (isLoopback(remoteAddress)) return { allow: true };
  const mutating = method === 'POST' || method === 'PUT' || method === 'DELETE';
  const sensitive = method === 'GET' && SENSITIVE_GET.test(path);
  if (!mutating && !sensitive) return { allow: true };
  if (tokenOk(token, configuredToken)) return { allow: true };
  return { allow: false, status: 401 };
}

module.exports = { decide, isLoopback, tokenOk, SENSITIVE_GET };
