// Input validation + escaping helpers for the control API.
// Extracted from server.js so they can be unit-tested in isolation.

// App id: lowercase alphanumeric + hyphens, 1-64 chars.
function isValidId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

// Values that flow into the launchd plist and into exec (cd "${dir}",
// tail "${logPath}") must be free of shell/XML metacharacters. Paths must be
// absolute; startCommand is a whitespace-split command line, no shell operators.
function isSafePath(p) {
  return typeof p === 'string' && /^\/[^\0"'`;|&$<>\n\r]+$/.test(p);
}
function isSafeCommand(c) {
  return typeof c === 'string' && /^[a-zA-Z0-9 _./@=:-]+$/.test(c);
}

// caddyUrl becomes a Caddyfile site label (http://<host>.localhost). It must be a bare
// localhost hostname with no braces/newlines or it can inject arbitrary Caddy directives
// into the global Caddyfile that gets `caddy reload`ed. Accept http(s):// + <slug>.localhost.
function isSafeCaddyUrl(u) {
  return typeof u === 'string' && /^https?:\/\/[a-z0-9][a-z0-9-]{0,63}\.localhost(?::\d+)?\/?$/.test(u);
}

// launchAgent is a launchd label that flows into `launchctl kickstart/bootout gui/<uid>/<label>`
// (a shell string), so it MUST be a plain reverse-DNS-style label with no shell metacharacters,
// or an attacker-registered app becomes command injection at start/stop time. e.g. com.bheng.foo.
function isSafeLaunchAgent(l) {
  return typeof l === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(l);
}
// launchAgentPath flows into `launchctl bootstrap gui/<uid> "<path>"` - absolute .plist, no metas.
function isSafeLaunchAgentPath(p) {
  return isSafePath(p) && p.endsWith('.plist');
}
// URL path segment (plugin/skill/command names) used in path.join - reject traversal + separators.
function isSafeSegment(s) {
  return typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(s) && !s.includes('..');
}

// Returns an error string for the first invalid field, or null if all clean.
function validateAppFields(body) {
  if (body.localPath != null && body.localPath !== '' && !isSafePath(body.localPath)) return 'localPath must be an absolute path with no shell metacharacters';
  if (body.logPath != null && body.logPath !== '' && !isSafePath(body.logPath)) return 'logPath must be an absolute path with no shell metacharacters';
  if (body.startCommand != null && body.startCommand !== '' && !isSafeCommand(body.startCommand)) return 'startCommand may only contain letters, numbers, spaces and _.-/@=:';
  if (body.caddyUrl != null && body.caddyUrl !== '' && !isSafeCaddyUrl(body.caddyUrl)) return 'caddyUrl must be http(s)://<name>.localhost with no other characters';
  if (body.launchAgent != null && body.launchAgent !== '' && !isSafeLaunchAgent(body.launchAgent)) return 'launchAgent must be a plain launchd label (letters, numbers, . _ -)';
  if (body.launchAgentPath != null && body.launchAgentPath !== '' && !isSafeLaunchAgentPath(body.launchAgentPath)) return 'launchAgentPath must be an absolute .plist path with no shell metacharacters';
  return null;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { isValidId, isSafePath, isSafeCommand, isSafeCaddyUrl, isSafeLaunchAgent, isSafeLaunchAgentPath, isSafeSegment, validateAppFields, xmlEscape };
