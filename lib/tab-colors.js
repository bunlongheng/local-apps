// Optional integration: <home>/.claude/tab-colors.json is the owner's terminal-tab registry. When
// the file exists, a rename keeps its label in sync; when it does not, this is a no-op.
const fs = require('fs');
const path = require('path');

module.exports = function makeTabColors({ home, dbg }) {
  function updateTabColors(id, label, caddyUrl) {
    const colorsPath = path.join(home, '.claude', 'tab-colors.json');
    try {
      const colors = JSON.parse(fs.readFileSync(colorsPath, 'utf8'));
      // The app id first, then the Caddy hostname the registry may be keyed by.
      const caddyHost = caddyUrl ? String(caddyUrl).replace(/^https?:\/\//, '').replace(/\.localhost.*/, '') : null;
      const key = colors[id] ? id : (caddyHost && colors[caddyHost]) ? caddyHost : null;
      if (!key) return false;
      colors[key].label = String(label).toUpperCase();
      fs.writeFileSync(colorsPath, JSON.stringify(colors, null, 2));
      return true;
    } catch (e) { dbg('updateTabColors', e); return false; }
  }
  return { updateTabColors };
};
