// Hub extras. tab colors, consistency, profiles, icon sync and capabilities read the hub owner's
// registry and repos, so they register on the hub role only; favicons, manifest and QR serve the
// dashboard on every role.
// Registered by server.js as require('./routes/meta')(app, ctx). Everything a handler needs comes
// from ctx, so this file has no module-level state beyond what it declares itself.
const fs = require('fs');
const path = require('path');
const { manifestLabel } = require('../lib/validate');

// Repo root: moved handlers keep resolving files from the project, not from routes/.
const ROOT = path.join(__dirname, '..');

const REQUIRED = ['LAN_IP', 'IS_HUB', 'db', 'dbg', 'QRCode', 'PORT', 'home'];

module.exports = function register(app, ctx) {
  // Fail at boot, not at request time, when server.js forgets to pass a dependency.
  for (const k of REQUIRED) if (!(k in ctx)) throw new Error(`routes/meta.js: ctx is missing ${k}`);
  // home: the owner's home dir (tab registry, MCP config, ~/.local/bin); tests point it at a fixture.
  const { IS_HUB, db, dbg, QRCode, PORT, home } = ctx;

  // --- Tab Colors ---
  if (IS_HUB) app.get('/api/tab-colors', (req, res) => {
    const out = {};
    const toHex = (r, g, b) => '#' + [r, g, b].map((v) => (v | 0).toString(16).padStart(2, '0')).join('');
    // Primary source: ~/.claude/tab-colors.json (the same file that drives the terminal
    // _tab colors), so the dashboard chip and the claude tab always match.
    try {
      const json = JSON.parse(fs.readFileSync(path.join(home, '.claude', 'tab-colors.json'), 'utf8'));
      for (const k of Object.keys(json)) {
        const e = json[k];
        if (e && typeof e.r === 'number') out[k] = { label: e.label || k.toUpperCase(), color: toHex(e.r, e.g, e.b), icon: e.icon || '' };
      }
    } catch (e) { dbg('meta', e); }
    // Fallback: DB tab colors for anything not defined in the json.
    try {
      const dbc = db.getTabColors() || {};
      for (const k of Object.keys(dbc)) if (!out[k]) out[k] = dbc[k];
    } catch (e) { dbg('meta', e); }
    // Merge the shell alias (e.g. _bheng) per key from ~/.claude-tabs.sh.
    try {
      const sh = fs.readFileSync(path.join(home, '.claude-tabs.sh'), 'utf8');
      const re = /(_[A-Za-z0-9]+)\(\)\s*\{\s*_tab\s+"([^"]+)"/g;
      let m;
      while ((m = re.exec(sh))) if (out[m[2]] && !out[m[2]].alias) out[m[2]].alias = m[1];
    } catch (e) { dbg('meta', e); }
    res.json(out);
  });

  // Consistency police: the same artifact matrix /onboard enforces (favicon, stickies
  // icon+registry, tab color+alias, caddy, launch-agent, profile, repo+prod). Backed by
  // scripts/consistency.js so onboard and the dashboard never drift. Optional ?id=<app>.
  if (IS_HUB) app.get('/api/consistency', (req, res) => {
    try {
      const id = (req.query.id || '').replace(/[^a-z0-9-]/gi, '');
      // In-process: the script reads the same db.js and does synchronous file checks only,
      // a few ms per app, instead of a child node that shelled out to sqlite3 per app.
      res.json(require('../scripts/consistency').audit(id || undefined));
    } catch (e) {
      res.status(500).json({ error: 'consistency check failed', detail: String(e.message || e) });
    }
  });

  // --- Auto-generated FAVICONS map from /public/favicons/ ---
  app.get('/api/favicons', (req, res) => {
    const dir = path.join(ROOT, 'public', 'favicons');
    const map = {};
    const priority = { png: 3, ico: 2, svg: 1 };
    const chosen = {}; // track which ext won per id
    try {
      for (const f of fs.readdirSync(dir)) {
        const m = f.match(/^(.+)\.(png|svg|ico)$/);
        if (!m) continue;
        const [, id, ext] = m;
        if ((priority[ext] || 0) > (chosen[id] || 0)) {
          chosen[id] = priority[ext];
          const mtime = fs.statSync(path.join(dir, f)).mtimeMs;
          map[id] = '/favicons/' + f + '?v=' + Math.floor(mtime);
        }
      }
    } catch (e) { dbg('meta', e); }
    res.setHeader('Cache-Control', 'no-cache');
    res.json(map);
  });

  // --- App profiles (about, architect, deploy, security, performance) ---
  if (IS_HUB) app.get('/api/app-profiles', (req, res) => {
    const apps = db.getApps();
    const profiles = {};
    for (const a of apps) {
      profiles[a.id] = {
        about: a.about || null,
        features: a.features || null,
        architect: a.architect || null,
        deploy: a.deploy || null,
        security: a.security || null,
        performance: a.performance || null,
        prompt: a.prompt || null,
      };
    }
    res.json(profiles);
  });

  if (IS_HUB) app.put('/api/app-profiles/:id', (req, res) => {
    const existing = db.getApp(req.params.id);
    if (!existing) return res.status(404).json({ error: 'not found' });
    // Profile route writes profile columns only. Spreading req.body let a caller rewrite
    // launchAgent, launchAgentPath, startCommand or localPath here, past validateAppFields.
    const PROFILE_FIELDS = ['about', 'features', 'architect', 'deploy', 'security', 'performance', 'prompt', 'sortOrder'];
    const patch = { id: req.params.id };
    for (const k of PROFILE_FIELDS) if (k in (req.body || {})) patch[k] = req.body[k];
    db.upsertApp(patch);
    res.json({ ok: true });
  });

  // --- Dynamic manifest (adapts name based on access method) ---
  app.get('/api/manifest', (req, res) => {
    const label = manifestLabel(req.hostname || req.headers.host || '');

    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'public', 'manifest.json'), 'utf8'));
    manifest.name = label;
    manifest.short_name = label;
    manifest.start_url = `http://${req.headers.host}/`;
    res.setHeader('Content-Type', 'application/manifest+json');
    res.json(manifest);
  });

  // --- Other routes ---
  app.get('/api/qr', async (req, res) => {
    const url = `http://${ctx.LAN_IP()}:${PORT}`;
    const dataUrl = await QRCode.toDataURL(url, { width: 200, margin: 1, color: { dark: '#e2e8f0', light: '#1a1d27' } });
    res.json({ url, dataUrl });
  });

  // Icon sync check: compare local-apps favicon vs app's own icon
  if (IS_HUB) app.get('/api/icon-sync', (req, res) => {
    const apps = db.getApps();
    const result = {};
    for (const a of apps) {
      const fav = path.join(ROOT, 'public', 'favicons', `${a.id}.png`);
      const hasFav = fs.existsSync(fav);
      let hasAppIcon = false;
      let synced = false;
      if (a.localPath) {
        // app/icon.png first: generate-favicons.js writes the 512px PNG to app/ when
        // an app/ dir exists (Next App Router), so checking public/favicon.png first
        // compared a 512 icon against a 64px favicon and always read out of sync.
        for (const p of ['app/icon.png', 'public/favicon.png', 'public/apple-touch-icon.png', 'public/icon.png']) {
          const full = path.join(a.localPath, p);
          if (fs.existsSync(full)) {
            hasAppIcon = true;
            try {
              const favSize = fs.statSync(fav).size;
              const appSize = fs.statSync(full).size;
              synced = favSize === appSize;
            } catch (e) { dbg('meta', e); }
            break;
          }
        }
      }
      result[a.id] = { hasFavicon: hasFav, hasAppIcon, synced };
    }
    res.json(result);
  });

  // App capabilities: MCP, API, CLI detection
  if (IS_HUB) app.get('/api/capabilities', (req, res) => {
    const apps = db.getApps();
    const globalMcp = (() => {
      try { return JSON.parse(fs.readFileSync(path.join(home, '.claude', '.mcp.json'), 'utf8')); } catch { return {}; }
    })();
    const mcpServers = globalMcp.mcpServers || {};
    const result = {};

    const localBinDir = path.join(home, '.local', 'bin');
    const localBins = fs.existsSync(localBinDir) ? fs.readdirSync(localBinDir) : [];
    // Read each ~/.local/bin script once per request, not once per app per request.
    const localBinText = new Map();
    for (const b of localBins) { try { localBinText.set(b, fs.readFileSync(path.join(localBinDir, b), 'utf8')); } catch (e) { dbg('capabilities', e); } }

    for (const a of apps) {
      const dir = a.localPath;
      if (!dir || !fs.existsSync(dir)) continue;
      const flags = {};

      // MCP: project-level .mcp.json or referenced in global config or has mcp-server file
      try {
        const hasProjMcp = fs.existsSync(path.join(dir, '.mcp.json'));
        const globalRef = Object.entries(mcpServers).find(([, v]) => {
          const args = v.args || [];
          return args.some(arg => typeof arg === 'string' && arg.includes(a.id));
        });
        let hasMcpFile = false;
        try { hasMcpFile = fs.readdirSync(dir).some(f => f.includes('mcp') && (f.endsWith('.js') || f.endsWith('.ts'))); } catch (e) { dbg('meta', e); }
        // Also check ~/.claude/mcp-servers/ for files matching this app
        const mcpServersDir = path.join(home, '.claude', 'mcp-servers');
        let hasMcpServerFile = false;
        if (fs.existsSync(mcpServersDir)) {
          try { hasMcpServerFile = fs.readdirSync(mcpServersDir).some(f => f.includes(a.id)); } catch (e) { dbg('meta', e); }
        }
        if (hasProjMcp || globalRef || hasMcpFile || hasMcpServerFile) {
          flags.mcp = true;
          if (globalRef) flags.mcpName = globalRef[0];
          if (hasProjMcp) flags.mcpPath = path.join(dir, '.mcp.json');
        }
      } catch (e) { dbg('meta', e); }

      // API: Next.js app/api, Express server, pages/api
      try {
        if (fs.existsSync(path.join(dir, 'app', 'api')) ||
            fs.existsSync(path.join(dir, 'pages', 'api')) ||
            fs.existsSync(path.join(dir, 'server.js')) ||
            fs.existsSync(path.join(dir, 'src', 'server.ts'))) {
          flags.api = true;
        }
      } catch (e) { dbg('meta', e); }

      // CLI: bin field in package.json or cli files or script in ~/.local/bin
      try {
        const pkgPath = path.join(dir, 'package.json');
        if (fs.existsSync(pkgPath)) {
          const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
          if (pkg.bin) flags.cli = true;
        }
        if (fs.existsSync(path.join(dir, 'cli.js')) || fs.existsSync(path.join(dir, 'bin', 'cli.js'))) flags.cli = true;
        for (const b of localBins) {
          if (b === 'tabs' || b === 'tab') continue; // Skip tab manager (matches all apps)
          const content = localBinText.get(b) || '';
          if (content.includes(a.id) || content.includes(dir)) { flags.cli = true; flags.cliBin = b; break; }
        }
      } catch (e) { dbg('meta', e); }

      if (Object.keys(flags).length > 0) result[a.id] = flags;
    }
    res.json(result);
  });
};
