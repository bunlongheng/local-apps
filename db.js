const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const os = require('os');

const DB_PATH = process.env.LOCAL_APPS_DB || path.join(__dirname, 'local.db');
// Personal registry (gitignored) if present, else the checked-in example so a
// fresh clone still seeds a working demo dashboard.
const CONFIG_FILE = fs.existsSync(path.join(__dirname, 'apps.config.json'))
  ? path.join(__dirname, 'apps.config.json')
  : path.join(__dirname, 'apps.config.example.json');

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// --- Schema ---
db.exec(`
  CREATE TABLE IF NOT EXISTS apps (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    health_url TEXT,
    local_url TEXT,
    process_check TEXT,
    caddy_url TEXT,
    prod_url TEXT,
    local_path TEXT,
    log_path TEXT,
    repo TEXT,
    launch_agent TEXT,
    launch_agent_path TEXT,
    start_command TEXT DEFAULT 'npm run dev',
    no_screenshot INTEGER DEFAULT 0,
    login INTEGER DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration: add start_command if missing (existing DBs)
try { db.exec(`ALTER TABLE apps ADD COLUMN start_command TEXT DEFAULT 'npm run dev'`); } catch { /* already exists */ }
// Migration: add login flag (apps whose prod URL requires a login - shows a lock badge)
try { db.exec(`ALTER TABLE apps ADD COLUMN login INTEGER DEFAULT 0`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE apps ADD COLUMN icon TEXT`); } catch { /* already exists */ }

// Migration: add disabled toggle
try { db.exec(`ALTER TABLE apps ADD COLUMN disabled INTEGER DEFAULT 0`); } catch { /* already exists */ }

// Migration: add tab color columns
try { db.exec(`ALTER TABLE apps ADD COLUMN tab_color TEXT`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE apps ADD COLUMN tab_icon TEXT`); } catch { /* already exists */ }

// Migration: add a second prod URL (some apps have both a Vercel deploy and a custom domain)
try { db.exec(`ALTER TABLE apps ADD COLUMN prod_url2 TEXT`); } catch { /* already exists */ }
// Backfill prod_url2 from apps.config.json for existing rows still missing it.
if (fs.existsSync(CONFIG_FILE)) {
  try {
    const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    const setProdUrl2 = db.prepare(`UPDATE apps SET prod_url2 = @prodUrl2 WHERE id = @id AND prod_url2 IS NULL`);
    const txProd2 = db.transaction((rows) => {
      for (const a of rows) {
        if (a.prodUrl2) setProdUrl2.run({ id: a.id, prodUrl2: a.prodUrl2 });
      }
    });
    txProd2(cfg);
  } catch { /* config unreadable - skip backfill */ }
}

// Migration: add app-profile columns
const profileColumns = [
  ['about', 'TEXT'],
  ['features', 'TEXT'],        // JSON array
  ['architect', 'TEXT'],
  ['deploy', 'TEXT'],
  ['security', 'TEXT'],        // JSON array
  ['performance', 'TEXT'],     // JSON array
  ['prompt', 'TEXT'],
  ['sort_order', 'INTEGER DEFAULT 0'],
];
for (const [col, type] of profileColumns) {
  try { db.exec(`ALTER TABLE apps ADD COLUMN ${col} ${type}`); } catch { /* already exists */ }
}

// Migrate data from app-profiles.json into the new columns
const PROFILES_FILE = path.join(__dirname, 'data', 'app-profiles.json');
if (fs.existsSync(PROFILES_FILE)) {
  const profiles = JSON.parse(fs.readFileSync(PROFILES_FILE, 'utf8'));
  const updateProfile = db.prepare(`
    UPDATE apps SET
      about = @about,
      features = @features,
      architect = @architect,
      deploy = @deploy,
      security = @security,
      performance = @performance,
      updated_at = datetime('now')
    WHERE id = @id AND about IS NULL
  `);
  const txProfiles = db.transaction((profiles) => {
    for (const [id, p] of Object.entries(profiles)) {
      updateProfile.run({
        id,
        about: p.about || null,
        features: p.features ? JSON.stringify(p.features) : null,
        architect: p.architect || null,
        deploy: p.deploy || null,
        security: p.security ? JSON.stringify(p.security) : null,
        performance: p.performance ? JSON.stringify(p.performance) : null,
      });
    }
  });
  txProfiles(profiles);
}


// Sync tab color/icon from ~/.claude/tab-colors.json onto apps that ALREADY exist.
// We intentionally do NOT create apps from tab-colors entries: the registry includes
// terminal-only tabs (jira, slack, ssh sessions) that are not monitored apps, and
// auto-creating them bloated the dashboard. Curated apps live in apps.config.json.
const TAB_COLORS_FILE = path.join(os.homedir(), '.claude', 'tab-colors.json');
if (fs.existsSync(TAB_COLORS_FILE)) {
  const tabColors = JSON.parse(fs.readFileSync(TAB_COLORS_FILE, 'utf8'));
  const updateTabColor = db.prepare(`
    UPDATE apps SET tab_color = @color, tab_icon = @icon, updated_at = datetime('now')
    WHERE id = @id AND tab_color IS NULL
  `);
  const txTabColors = db.transaction((colors) => {
    for (const [id, c] of Object.entries(colors)) {
      const hex = '#' + [c.r, c.g, c.b].map(v => v.toString(16).padStart(2, '0')).join('');
      updateTabColor.run({ id, color: hex.toUpperCase(), icon: c.icon || null });
    }
  });
  txTabColors(tabColors);
}

// --- Machines table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    ip TEXT NOT NULL,
    port INTEGER DEFAULT 9875,
    model TEXT,
    last_seen TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Claude table (flexible document store for .md, .json, etc.) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS claude (
    id TEXT PRIMARY KEY,
    category TEXT NOT NULL,
    name TEXT NOT NULL,
    content TEXT NOT NULL,
    meta TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// --- Seed from JSON if DB is empty ---
const count = db.prepare('SELECT COUNT(*) as n FROM apps').get().n;
if (count === 0 && fs.existsSync(CONFIG_FILE)) {
  const apps = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
  const insert = db.prepare(`
    INSERT OR IGNORE INTO apps (id, name, health_url, local_url, process_check, caddy_url, prod_url, local_path, log_path, repo, launch_agent, launch_agent_path, start_command, icon, no_screenshot)
    VALUES (@id, @name, @healthUrl, @localUrl, @processCheck, @caddyUrl, @prodUrl, @localPath, @logPath, @repo, @launchAgent, @launchAgentPath, @startCommand, @icon, @noScreenshot)
  `);
  const tx = db.transaction((rows) => {
    for (const a of rows) {
      insert.run({
        id: a.id,
        name: a.name || a.id,
        healthUrl: a.healthUrl || null,
        localUrl: a.localUrl || null,
        processCheck: a.processCheck || null,
        caddyUrl: a.caddyUrl || null,
        prodUrl: a.prodUrl || null,
        localPath: a.localPath || null,
        logPath: a.logPath || null,
        repo: a.repo || null,
        launchAgent: a.launchAgent || null,
        launchAgentPath: a.launchAgentPath || null,
        startCommand: a.startCommand || 'npm run dev',
        icon: a.icon || null,
        noScreenshot: a.noScreenshot ? 1 : 0,
      });
    }
  });
  tx(apps);
  console.log(`  Seeded ${apps.length} apps from apps.config.json`);
}

// --- Remote apps table (apps from other machines) ---
db.exec(`
  CREATE TABLE IF NOT EXISTS remote_apps (
    id TEXT NOT NULL,
    machine_id TEXT NOT NULL,
    name TEXT,
    health_url TEXT,
    local_url TEXT,
    caddy_url TEXT,
    prod_url TEXT,
    repo TEXT,
    icon TEXT,
    status TEXT DEFAULT 'unknown',
    synced_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id, machine_id)
  )
`);

// --- Remote apps helpers ---
function upsertRemoteApp(machineId, app) {
  db.prepare(`
    INSERT INTO remote_apps (id, machine_id, name, health_url, local_url, caddy_url, prod_url, repo, icon, status, synced_at)
    VALUES (@id, @machineId, @name, @healthUrl, @localUrl, @caddyUrl, @prodUrl, @repo, @icon, @status, datetime('now'))
    ON CONFLICT(id, machine_id) DO UPDATE SET
      name = @name, health_url = @healthUrl, local_url = @localUrl,
      caddy_url = @caddyUrl, prod_url = @prodUrl, repo = @repo,
      icon = @icon, status = @status, synced_at = datetime('now')
  `).run({
    id: app.id,
    machineId,
    name: app.name || app.id,
    healthUrl: app.healthUrl || app.localUrl || null,
    localUrl: app.localUrl || null,
    caddyUrl: app.caddyUrl || null,
    prodUrl: app.prodUrl || null,
    repo: app.repo || null,
    icon: app.icon || null,
    status: app.status || 'unknown',
  });
}

function syncRemoteApps(machineId, apps) {
  const tx = db.transaction((machineId, apps) => {
    // Remove old apps from this machine
    db.prepare('DELETE FROM remote_apps WHERE machine_id = ?').run(machineId);
    // Insert fresh
    for (const app of apps) {
      upsertRemoteApp(machineId, app);
    }
  });
  tx(machineId, apps);
}

function getRemoteApps(machineId) {
  if (machineId) {
    return db.prepare('SELECT * FROM remote_apps WHERE machine_id = ? ORDER BY name').all(machineId);
  }
  return db.prepare('SELECT * FROM remote_apps ORDER BY machine_id, name').all();
}

function deleteRemoteApps(machineId) {
  return db.prepare('DELETE FROM remote_apps WHERE machine_id = ?').run(machineId).changes;
}

// --- Helpers (camelCase output) ---
// A malformed JSON string in a profile column (e.g. written through a pass-through
// PUT) must not throw here - that would take down getApps() and with it /api/status,
// /api/apps, and the checkAll health loop. Degrade to null instead.
function safeParse(s) {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}
function rowToApp(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    healthUrl: row.health_url,
    localUrl: row.local_url,
    processCheck: row.process_check,
    caddyUrl: row.caddy_url,
    prodUrl: row.prod_url,
    prodUrl2: row.prod_url2,
    localPath: row.local_path,
    logPath: row.log_path,
    repo: row.repo,
    launchAgent: row.launch_agent,
    launchAgentPath: row.launch_agent_path,
    startCommand: row.start_command,
    icon: row.icon,
    noScreenshot: !!row.no_screenshot,
    login: !!row.login,
    disabled: !!row.disabled,
    about: row.about,
    features: safeParse(row.features),
    architect: row.architect,
    deploy: row.deploy,
    security: safeParse(row.security),
    performance: safeParse(row.performance),
    prompt: row.prompt,
    tabColor: row.tab_color || null,
    tabIcon: row.tab_icon || null,
    sortOrder: row.sort_order || 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function getApps() {
  return db.prepare('SELECT * FROM apps ORDER BY created_at').all().map(rowToApp);
}

function getApp(id) {
  return rowToApp(db.prepare('SELECT * FROM apps WHERE id = ?').get(id));
}

function upsertApp(data) {
  // Security backstop (defense in depth): launch_agent + launch_agent_path flow into
  // `launchctl ... gui/<uid>/<label>` / `bootstrap ... "<path>"` shell strings at start/stop.
  // Reject any value with shell metacharacters here so NO write path (even ones that skip the
  // API validateAppFields guard) can persist an injection payload into the exec source.
  if (data.launchAgent && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(data.launchAgent)) {
    throw new Error('unsafe launchAgent label rejected');
  }
  if (data.launchAgentPath && !(/^\/[^\0"'`;|&$<>\n\r]+\.plist$/.test(data.launchAgentPath))) {
    throw new Error('unsafe launchAgentPath rejected');
  }
  const existing = db.prepare('SELECT * FROM apps WHERE id = ?').get(data.id);
  if (existing) {
    const fields = [];
    const params = { id: data.id };
    const map = {
      name: 'name', healthUrl: 'health_url', localUrl: 'local_url',
      processCheck: 'process_check', caddyUrl: 'caddy_url', prodUrl: 'prod_url', prodUrl2: 'prod_url2',
      localPath: 'local_path', logPath: 'log_path', repo: 'repo',
      launchAgent: 'launch_agent', launchAgentPath: 'launch_agent_path',
      startCommand: 'start_command', icon: 'icon', noScreenshot: 'no_screenshot',
      about: 'about', features: 'features', architect: 'architect',
      deploy: 'deploy', security: 'security', performance: 'performance',
      prompt: 'prompt', sortOrder: 'sort_order',
      tabColor: 'tab_color', tabIcon: 'tab_icon',
    };
    const jsonFields = new Set(['features', 'security', 'performance']);
    for (const [camel, col] of Object.entries(map)) {
      if (camel in data) {
        fields.push(`${col} = @${camel}`);
        if (camel === 'noScreenshot') params[camel] = data[camel] ? 1 : 0;
        else if (jsonFields.has(camel) && Array.isArray(data[camel])) params[camel] = JSON.stringify(data[camel]);
        else params[camel] = data[camel];
      }
    }
    if (fields.length === 0) return rowToApp(existing);
    fields.push("updated_at = datetime('now')");
    db.prepare(`UPDATE apps SET ${fields.join(', ')} WHERE id = @id`).run(params);
  } else {
    db.prepare(`
      INSERT INTO apps (id, name, health_url, local_url, process_check, caddy_url, prod_url, local_path, log_path, repo, launch_agent, launch_agent_path, start_command, icon, no_screenshot)
      VALUES (@id, @name, @healthUrl, @localUrl, @processCheck, @caddyUrl, @prodUrl, @localPath, @logPath, @repo, @launchAgent, @launchAgentPath, @startCommand, @icon, @noScreenshot)
    `).run({
      id: data.id,
      name: data.name || data.id,
      healthUrl: data.healthUrl || null,
      localUrl: data.localUrl || null,
      processCheck: data.processCheck || null,
      caddyUrl: data.caddyUrl || null,
      prodUrl: data.prodUrl || null,
      localPath: data.localPath || null,
      logPath: data.logPath || null,
      repo: data.repo || null,
      launchAgent: data.launchAgent || null,
      launchAgentPath: data.launchAgentPath || null,
      startCommand: data.startCommand || 'npm run dev',
      icon: data.icon || null,
      noScreenshot: data.noScreenshot ? 1 : 0,
    });
  }
  return getApp(data.id);
}

function deleteApp(id) {
  return db.prepare('DELETE FROM apps WHERE id = ?').run(id).changes > 0;
}

function toggleApp(id) {
  const app = getApp(id);
  if (!app) return null;
  const newState = app.disabled ? 0 : 1;
  db.prepare('UPDATE apps SET disabled = ? WHERE id = ?').run(newState, id);
  return { id, disabled: !!newState };
}

function setAppDisabled(id, disabled) {
  db.prepare('UPDATE apps SET disabled = ? WHERE id = ?').run(disabled ? 1 : 0, id);
}

// --- Machines ---
function getMachines() {
  return db.prepare('SELECT * FROM machines ORDER BY rowid').all();
}

function upsertMachine(data) {
  db.prepare(`
    INSERT INTO machines (id, hostname, ip, port, model, last_seen)
    VALUES (@id, @hostname, @ip, @port, @model, datetime('now'))
    ON CONFLICT(id) DO UPDATE SET hostname=@hostname, ip=@ip, port=@port, model=@model, last_seen=datetime('now')
  `).run({
    id: data.id,
    hostname: data.hostname || null,
    ip: data.ip,
    port: data.port || 9875,
    model: data.model || null,
  });
  return db.prepare('SELECT * FROM machines WHERE id = ?').get(data.id);
}

function deleteMachine(id) {
  return db.prepare('DELETE FROM machines WHERE id = ?').run(id).changes > 0;
}

function getTabColors() {
  const rows = db.prepare('SELECT id, name, tab_color, tab_icon FROM apps WHERE tab_color IS NOT NULL').all();
  const result = {};
  for (const r of rows) {
    result[r.id] = { label: (r.name || r.id).toUpperCase(), color: r.tab_color, icon: r.tab_icon || '' };
  }
  return result;
}

module.exports = {
  getApps, getApp, upsertApp, deleteApp, toggleApp, setAppDisabled, getTabColors,
  getMachines, upsertMachine, deleteMachine,
  getRemoteApps, syncRemoteApps, deleteRemoteApps,
};
