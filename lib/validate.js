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

// Returns an error string for the first invalid field, or null if all clean.
function validateAppFields(body) {
  if (body.localPath != null && body.localPath !== '' && !isSafePath(body.localPath)) return 'localPath must be an absolute path with no shell metacharacters';
  if (body.logPath != null && body.logPath !== '' && !isSafePath(body.logPath)) return 'logPath must be an absolute path with no shell metacharacters';
  if (body.startCommand != null && body.startCommand !== '' && !isSafeCommand(body.startCommand)) return 'startCommand may only contain letters, numbers, spaces and _.-/@=:';
  return null;
}

function xmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}

module.exports = { isValidId, isSafePath, isSafeCommand, validateAppFields, xmlEscape };
