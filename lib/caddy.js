// Caddyfile reverse-proxy management. Extracted from server.js.
// Factory: pass the Caddyfile path, the error-page root, a getLanIp() function
// (evaluated per call so IP changes are picked up), and an exec (execSync).
const fs = require('fs');

module.exports = function makeCaddy({ caddyfile, errorRoot, getLanIp, exec }) {
  function getCaddyfile() {
    try { return fs.readFileSync(caddyfile, 'utf8'); } catch { return ''; }
  }

  function writeCaddyfile(content) {
    fs.writeFileSync(caddyfile, content, 'utf8');
  }

  function reloadCaddy() {
    // Validate first - never reload with broken config.
    try {
      exec('caddy validate --config ' + caddyfile + ' --adapter caddyfile 2>/dev/null');
      exec('caddy reload --config ' + caddyfile + ' --adapter caddyfile 2>/dev/null');
    } catch { /* validation/reload failed - don't crash caddy */ }
  }

  function addCaddyEntry(id, port) {
    const domain = `http://${id}.localhost`;
    const caddyContent = getCaddyfile();
    if (caddyContent.includes(`${id}.localhost`)) return domain;
    const block = `\n${domain} {\n\treverse_proxy ${getLanIp()}:${port}\n\thandle_errors 502 503 {\n\t\troot * ${errorRoot}\n\t\trewrite * /offline.html\n\t\tfile_server\n\t}\n}\n`;
    writeCaddyfile(caddyContent + block);
    reloadCaddy();
    return domain;
  }

  function removeCaddyEntry(id) {
    const lines = getCaddyfile().split('\n');
    const marker = `http://${id}.localhost`;
    const out = [];
    let depth = 0;
    let skipping = false;
    for (const line of lines) {
      if (!skipping && line.trim().startsWith(marker)) {
        skipping = true;
        depth = 0;
      }
      if (skipping) {
        depth += (line.match(/\{/g) || []).length;
        depth -= (line.match(/\}/g) || []).length;
        if (depth <= 0 && line.includes('}')) { skipping = false; continue; }
        continue;
      }
      out.push(line);
    }
    const updated = out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
    if (updated !== getCaddyfile()) {
      writeCaddyfile(updated);
      reloadCaddy();
    }
  }

  function renameCaddyEntry(oldId, newId, port) {
    removeCaddyEntry(oldId);
    return addCaddyEntry(newId, port);
  }

  return { getCaddyfile, writeCaddyfile, reloadCaddy, addCaddyEntry, removeCaddyEntry, renameCaddyEntry };
};
