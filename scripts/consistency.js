#!/usr/bin/env node
// consistency.js - the single source of truth for "is an app fully wired?"
// Shared by /onboard (its final gate) AND local-apps (/api/consistency police panel),
// so both enforce the exact same artifact matrix - one rule set, two callers.
//
// Usage:
//   node scripts/consistency.js            # audit every app in the DB
//   node scripts/consistency.js <id>       # audit one app (exit 1 if any gap)
//   node scripts/consistency.js --json     # machine-readable (for /api/consistency)
//   node scripts/consistency.js --icons    # only the icon-family rules (favicon/stickies/tab)
//
// Read-only: it reports gaps, it never writes. Auto-heal lives elsewhere.

const fs = require("fs");
const os = require("os");
const path = require("path");
const db = require(path.join(__dirname, "..", "db"));

const H = os.homedir();
const P = {
  favDir:  path.join(__dirname, "..", "public", "favicons"),
  saiDir:  path.join(H, "Sites/stickies/public/app-icons"),
  reg:     path.join(H, "Sites/stickies/lib/app-icons.ts"),
  colors:  path.join(H, ".claude/tab-colors.json"),
  tabsh:   path.join(H, ".claude-tabs.sh"),
  caddy:   process.env.CADDYFILE || "/opt/homebrew/etc/Caddyfile",
  laDir:   path.join(H, "Library/LaunchAgents"),
};

const ICON_RULES = new Set(["favicon", "stickies-icon", "stickies-reg", "tab-color", "tab-alias"]);

const read = (f) => { try { return fs.readFileSync(f, "utf8"); } catch { return ""; } };
const exists = (f) => fs.existsSync(f);

function apps(oneId) {
  if (oneId) return [oneId];
  return db.getApps().map((a) => a.id).sort();
}

// Row straight from db.js (honours LOCAL_APPS_DB), mapped to the names the rules use.
function dbRow(id) {
  const a = db.getApp(id);
  if (!a) return {};
  return { about: a.about || "", features: Array.isArray(a.features) ? JSON.stringify(a.features) : (a.features || ""),
           repo: a.repo || "", prod: a.prodUrl || "", local_path: a.localPath || "", plist: a.launchAgentPath || "" };
}

// The rule set. Each returns true (ok) or false (miss). ORDER = display order.
function checkApp(id) {
  const reg = read(P.reg);
  const colors = read(P.colors);
  const tabsh = read(P.tabsh);
  const caddy = read(P.caddy);
  const row = dbRow(id);
  const canonAlias = "_" + id.replace(/-/g, "_");
  // Aliases are GENERATED at shell start by _tab_defs() in ~/.claude-tabs.sh, which
  // evals one function per key in tab-colors.json. They never appear as literal text
  // in the file, so registry membership + a present generator IS the alias.
  const generated = /_tab_defs\s*\(\)/.test(tabsh) && new RegExp(`"${id}"\\s*:`).test(colors);
  const aliasNames = tabsh.split("\n")
    .filter((l) => new RegExp(`_tab\\s+"${id}"`).test(l))
    .map((l) => (l.match(/^\s*(_[a-z0-9_-]+)\(\)/) || [])[1]).filter(Boolean);
  const hasCanon = generated || aliasNames.includes(canonAlias);
  // Hand-written aliases are drift - the generator already covers both spellings.
  const shortcuts = aliasNames.filter((n) => n !== canonAlias && n !== "_" + id);

  // Vercel app? a deployed app has a .vercel/project.json in its repo. Only Vercel
  // apps must carry a prod_url in the modal (owner rule 2026-08-05); local-only exempt.
  const lp = row.local_path || path.join(H, "Sites", id);
  const isVercel = exists(path.join(lp, ".vercel", "project.json"));

  const checks = [
    ["favicon",       exists(path.join(P.favDir, `${id}.png`))],
    ["stickies-icon", exists(path.join(P.saiDir, `${id}.png`))],
    ["stickies-reg",  new RegExp(`"${id}"\\s*:`).test(reg)],
    ["tab-color",     new RegExp(`"${id}"\\s*:`).test(colors)],
    ["tab-alias",     hasCanon && shortcuts.length === 0],
    ["caddy-host",    new RegExp(`${id}\\.localhost`).test(caddy)],
    ["launch-agent",  !!row.plist && exists(row.plist)],
    ["profile",       !!(row.about && row.features && row.features !== "[]")],
    ["repo",          !!row.repo],
    ["prod-url",      !isVercel || !!row.prod],
  ];
  const note = shortcuts.length ? `shortcut alias ${shortcuts.join(",")} - want only ${canonAlias}`
             : (!hasCanon ? `missing alias ${canonAlias}` : "");
  return { checks, note };
}

function audit(id, iconsOnly = false) {
  return apps(id).map((app) => {
    const { checks, note } = checkApp(app);
    const relevant = iconsOnly ? checks.filter(([k]) => ICON_RULES.has(k)) : checks;
    const misses = relevant.filter(([, ok]) => !ok).map(([k]) => k);
    return { id: app, ok: misses.length === 0, misses, note: misses.includes("tab-alias") ? note : "" };
  });
}

function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes("--json");
  const iconsOnly = argv.includes("--icons");
  const id = argv.find((a) => !a.startsWith("--"));
  const list = apps(id);
  if (!list.length) { console.error("no apps found (is local.db present?)"); process.exit(2); }
  const report = audit(id, iconsOnly);

  if (asJson) { console.log(JSON.stringify(report, null, 2)); process.exit(0); }

  const dirty = report.filter((r) => !r.ok);
  const scope = iconsOnly ? " (icon rules only)" : "";
  console.log(`CONSISTENCY POLICE${scope} - ${list.length} app(s): ${list.length - dirty.length} clean, ${dirty.length} with gaps\n`);
  for (const r of dirty) {
    console.log(`  x ${r.id}`);
    console.log(`      missing: ${r.misses.join(", ")}${r.note ? `  [${r.note}]` : ""}`);
  }
  if (!dirty.length) console.log("  all apps fully wired - tidy.");
  process.exit(id && dirty.length ? 1 : 0);
}

// P is exported so tests can point every rule at fixture paths instead of the owner's home.
module.exports = { checkApp, audit, P };
if (require.main === module) main();
