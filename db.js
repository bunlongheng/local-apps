const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = path.join(__dirname, 'local.db');
const CONFIG_FILE = path.join(__dirname, 'apps.config.json');

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
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
  )
`);

// Migration: add start_command if missing (existing DBs)
try { db.exec(`ALTER TABLE apps ADD COLUMN start_command TEXT DEFAULT 'npm run dev'`); } catch { /* already exists */ }
try { db.exec(`ALTER TABLE apps ADD COLUMN icon TEXT`); } catch { /* already exists */ }


// --- Machines table ---
db.exec(`
  CREATE TABLE IF NOT EXISTS machines (
    id TEXT PRIMARY KEY,
    hostname TEXT,
    ip TEXT NOT NULL,
    port INTEGER DEFAULT 9876,
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
    localPath: row.local_path,
    logPath: row.log_path,
    repo: row.repo,
    launchAgent: row.launch_agent,
    launchAgentPath: row.launch_agent_path,
    startCommand: row.start_command,
    icon: row.icon,
    noScreenshot: !!row.no_screenshot,
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
  const existing = db.prepare('SELECT * FROM apps WHERE id = ?').get(data.id);
  if (existing) {
    const fields = [];
    const params = { id: data.id };
    const map = {
      name: 'name', healthUrl: 'health_url', localUrl: 'local_url',
      processCheck: 'process_check', caddyUrl: 'caddy_url', prodUrl: 'prod_url',
      localPath: 'local_path', logPath: 'log_path', repo: 'repo',
      launchAgent: 'launch_agent', launchAgentPath: 'launch_agent_path',
      startCommand: 'start_command', icon: 'icon', noScreenshot: 'no_screenshot',
    };
    for (const [camel, col] of Object.entries(map)) {
      if (camel in data) {
        fields.push(`${col} = @${camel}`);
        params[camel] = camel === 'noScreenshot' ? (data[camel] ? 1 : 0) : data[camel];
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
    port: data.port || 9876,
    model: data.model || null,
  });
  return db.prepare('SELECT * FROM machines WHERE id = ?').get(data.id);
}

function deleteMachine(id) {
  return db.prepare('DELETE FROM machines WHERE id = ?').run(id).changes > 0;
}

module.exports = {
  getApps, getApp, upsertApp, deleteApp,
  getMachines, upsertMachine, deleteMachine,
  getRemoteApps, syncRemoteApps, deleteRemoteApps,
};
