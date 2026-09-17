// Caddyfile reverse-proxy management. Extracted from server.js.
// Factory: pass the Caddyfile path, the error-page root, a getLanIp() function
// (evaluated per call so IP changes are picked up), and an exec (execSync).
const fs = require('fs');

const fsx = require('fs');
const pathx = require('path');
module.exports = function makeCaddy({ caddyfile, errorRoot, getLanIp: _getLanIp, exec, offlineSource = pathx.join(__dirname, '..', 'public', 'offline.html') }) {
  // handle_errors rewrites 502/503 to <errorRoot>/offline.html; install the page we ship there
  // once, so a stopped app shows a real message instead of a blank Caddy response.
  function ensureOfflinePage() {
    try {
      const dest = pathx.join(errorRoot, 'offline.html');
      if (!fsx.existsSync(dest) && fsx.existsSync(offlineSource)) fsx.copyFileSync(offlineSource, dest);
    } catch (e) { console.warn(`  caddy: could not install offline.html: ${e.message}`); }
  }
  function getCaddyfile() {
    try { return fs.readFileSync(caddyfile, 'utf8'); } catch { return ''; }
  }

  function writeCaddyfile(content) {
    // Validate the candidate as a sibling file first; the live Caddyfile is only replaced when it
    // adapts, so a bad block can never take the proxy down.
    const candidate = caddyfile + '.candidate';
    fs.writeFileSync(candidate, content, 'utf8');
    try { exec('caddy validate --config ' + candidate + ' --adapter caddyfile 2>/dev/null', { timeout: 10000 }); }
    catch (e) { console.warn(`  caddy: candidate Caddyfile rejected, live file untouched: ${e.message}`); try { fs.unlinkSync(candidate); } catch { /* gone */ } return false; }
    fs.renameSync(candidate, caddyfile);
    return true;
  }


  // The candidate was validated before it went live (writeCaddyfile); a failed reload is a warning,
  // never a crash: the file on disk is right and the next reload picks it up.
  function reloadCaddy() {
    try { exec('caddy reload --config ' + caddyfile + ' --adapter caddyfile', { timeout: 15000, stdio: 'pipe' }); return true; }
    catch (e) { console.warn(`  caddy reload failed: ${String(e.stderr || e.message).trim().split('\n').pop()}`); return false; }
  }

  function addCaddyEntry(id, port) {
    ensureOfflinePage();
    const domain = `http://${id}.localhost`;
    const caddyContent = getCaddyfile();
    // Upsert: an existing block for this id is kept only if it already proxies this port;
    // otherwise it is removed and rewritten, so a PUT that moves the port takes effect.
    if (caddyContent.includes(`${id}.localhost`)) {
      if (new RegExp(`${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\.localhost \\{[^}]*reverse_proxy 127\\.0\\.0\\.1:${port}\\b`).test(caddyContent)) return domain;
      removeCaddyEntry(id);
    }
    const base = getCaddyfile();   // re-read: removeCaddyEntry may just have rewritten the file
    const block = `\n${domain} {\n\treverse_proxy 127.0.0.1:${port}\n\thandle_errors 502 503 {\n\t\troot * ${errorRoot}\n\t\trewrite * /offline.html\n\t\tfile_server\n\t}\n}\n`;
    // A rejected candidate leaves the live file untouched and must not be reported as a proxy URL.
    if (!writeCaddyfile(base + block)) return null;
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
    if (updated === getCaddyfile()) return true;   // nothing to remove
    // A rejected candidate leaves the block live: say so, and do not reload an unchanged file.
    if (!writeCaddyfile(updated)) return false;
    reloadCaddy();
    return true;
  }

  function renameCaddyEntry(oldId, newId, port) {
    removeCaddyEntry(oldId);
    return addCaddyEntry(newId, port);
  }

  return { getCaddyfile, writeCaddyfile, reloadCaddy, addCaddyEntry, removeCaddyEntry, renameCaddyEntry };
};
