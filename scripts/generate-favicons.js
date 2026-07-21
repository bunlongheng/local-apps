#!/usr/bin/env node
/**
 * generate-favicons.js
 * Scans apps and generates:
 *   favicon.ico (16+32 multi-size), apple-touch-icon.png (180), icon.png (512)
 *
 * Usage:
 *   node scripts/generate-favicons.js              # DB-registered apps only
 *   node scripts/generate-favicons.js bheng        # single app by ID
 *   node scripts/generate-favicons.js --all        # ALL ~/Sites/* directories
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const sharp = require('sharp');
const { Resvg } = require('@resvg/resvg-js');
const db = require('../db');

const LOCAL_APPS_DIR = path.join(__dirname, '..');
const FAVICONS_DIR = path.join(LOCAL_APPS_DIR, 'public', 'favicons');
const SITES_DIR = path.join(os.homedir(), 'Sites');
const SIZES = { ico16: 16, ico32: 32, apple: 180, full: 512 };

// --- Source resolution map ---
const APP_SOURCES = {
  bheng:                { paths: ['app/icon.png'] },
  tools:                { fallbackSvg: 'tools.svg' },
  diagrams:             { paths: ['public/icon.svg'] },
  claude:               { paths: ['public/favicon.svg'] },
  '3pi':                { fallbackSvg: '3pi.svg' },
  '3pi-poc':            { paths: ['app/icon.png'] },
  stickies:             { paths: ['app/icon.svg'] },
  mindmaps:             { skip: true },
  safe:                 { letter: 'S', gradient: ['#16a34a', '#15803d'] },
  // Additional Sites/* repos
  'flash-cards':        { paths: ['public/logo512.png'] },
  'score-card':         { paths: ['app/icon.svg'] },
  'norden-study':       { paths: ['public/icon.png'] },
  'pixy':               { paths: ['app/icon.png'] },
  'local-apps':         { skip: true },
  'pm2026':             { letter: 'P', gradient: ['#0891b2', '#22d3ee'] },
  'notes':              { letter: 'N', gradient: ['#ca8a04', '#facc15'] },
  'portfolio-2026':     { letter: 'P', gradient: ['#059669', '#34d399'] },
  '3pi-tools':          { letter: '3', gradient: ['#1e3a5f', '#38bdf8'] },
};

// Auto-detect paths
const AUTO_DETECT = [
  'app/icon.png', 'app/icon.svg', 'public/icon.png', 'public/icon.svg',
  'public/favicon.svg',
];

// --- Consistent color from string (for unknown apps) ---
const GRADIENTS = [
  ['#7c3aed', '#a78bfa'], ['#0891b2', '#22d3ee'], ['#b91c1c', '#ef4444'],
  ['#059669', '#34d399'], ['#ca8a04', '#facc15'], ['#1e40af', '#3b82f6'],
  ['#c026d3', '#e879f9'], ['#0f172a', '#334155'], ['#4338ca', '#6366f1'],
];
function hashGradient(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = ((h << 5) - h + str.charCodeAt(i)) | 0;
  return GRADIENTS[Math.abs(h) % GRADIENTS.length];
}

// --- Letter icon SVG generator ---
function letterSvg(letter, colors) {
  const [c1, c2] = colors;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs><linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
    <stop offset="0%" stop-color="${c1}"/>
    <stop offset="100%" stop-color="${c2}"/>
  </linearGradient></defs>
  <rect width="512" height="512" rx="115" fill="url(#bg)"/>
  <text x="256" y="256" text-anchor="middle" dominant-baseline="central"
    font-family="-apple-system, BlinkMacSystemFont, sans-serif"
    font-weight="700" font-size="320" fill="white">${letter}</text>
</svg>`;
}

// --- SVG → PNG via resvg ---
function rasterize(svgBuffer, width) {
  const resvg = new Resvg(svgBuffer, {
    fitTo: { mode: 'width', value: width },
    font: { loadSystemFonts: true },
  });
  return resvg.render().asPng();
}

// --- Build ICO file from PNG buffers (no external dep) ---
function buildIco(pngBuffers) {
  const count = pngBuffers.length;
  const headerSize = 6 + count * 16;
  let offset = headerSize;

  const dir = [];
  for (const png of pngBuffers) {
    const w = png.readUInt32BE(16);
    const h = png.readUInt32BE(20);
    dir.push({ w: w >= 256 ? 0 : w, h: h >= 256 ? 0 : h, size: png.length, offset });
    offset += png.length;
  }

  const buf = Buffer.alloc(headerSize);
  buf.writeUInt16LE(0, 0);
  buf.writeUInt16LE(1, 2);
  buf.writeUInt16LE(count, 4);

  for (let i = 0; i < count; i++) {
    const base = 6 + i * 16;
    buf.writeUInt8(dir[i].w, base);
    buf.writeUInt8(dir[i].h, base + 1);
    buf.writeUInt8(0, base + 2);
    buf.writeUInt8(0, base + 3);
    buf.writeUInt16LE(1, base + 4);
    buf.writeUInt16LE(32, base + 6);
    buf.writeUInt32LE(dir[i].size, base + 8);
    buf.writeUInt32LE(dir[i].offset, base + 12);
  }

  return Buffer.concat([buf, ...pngBuffers]);
}

// --- Resolve source image for an app ---
async function resolveSource(appId, localPath) {
  const config = APP_SOURCES[appId] || {};

  // Skip flag
  if (config.skip) return null;

  // Letter generation (explicit or auto for unknown apps)
  if (config.letter) {
    const svg = letterSvg(config.letter, config.gradient || hashGradient(appId));
    return { buffer: Buffer.from(svg), format: 'svg', source: 'generated' };
  }

  // Try explicit paths first (only SVG/PNG, skip ICO)
  if (config.paths && localPath) {
    for (const rel of config.paths) {
      const full = path.join(localPath, rel);
      if (fs.existsSync(full)) {
        const buf = fs.readFileSync(full);
        const fmt = rel.endsWith('.svg') ? 'svg' : 'png';
        return { buffer: buf, format: fmt, source: full };
      }
    }
  }

  // Fallback: local-apps/public/favicons/{fallbackSvg} or {id}.svg/.png
  if (config.fallbackSvg) {
    const fallback = path.join(FAVICONS_DIR, config.fallbackSvg);
    if (fs.existsSync(fallback)) {
      return { buffer: fs.readFileSync(fallback), format: 'svg', source: fallback };
    }
  }
  for (const ext of ['.svg', '.png']) {
    const fallback = path.join(FAVICONS_DIR, appId + ext);
    if (fs.existsSync(fallback)) {
      const fmt = ext === '.svg' ? 'svg' : 'png';
      return { buffer: fs.readFileSync(fallback), format: fmt, source: fallback };
    }
  }

  // Auto-detect in app repo (only SVG/PNG sources, not ICO)
  if (localPath) {
    for (const rel of AUTO_DETECT) {
      const full = path.join(localPath, rel);
      if (fs.existsSync(full)) {
        const buf = fs.readFileSync(full);
        const fmt = rel.endsWith('.svg') ? 'svg' : 'png';
        return { buffer: buf, format: fmt, source: full };
      }
    }
  }

  // Final fallback: generate letter icon from first char
  if (!config.skip) {
    const letter = appId.charAt(0).toUpperCase();
    const gradient = hashGradient(appId);
    const svg = letterSvg(letter, gradient);
    return { buffer: Buffer.from(svg), format: 'svg', source: 'auto-letter' };
  }

  return null;
}

// --- Generate all sizes for one app ---
async function generateForApp(appId, localPath) {
  const source = await resolveSource(appId, localPath);
  if (!source) {
    console.log(`  ⏭  ${appId}: skipped`);
    return { appId, status: 'skipped', files: [] };
  }

  console.log(`  🔧 ${appId}: source=${source.source} (${source.format})`);

  // Get 512px PNG as base
  let png512;
  if (source.format === 'svg') {
    png512 = rasterize(source.buffer, SIZES.full);
  } else {
    png512 = await sharp(source.buffer).resize(SIZES.full, SIZES.full, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toBuffer();
  }

  // Resize to all needed sizes
  const png180 = await sharp(png512).resize(SIZES.apple, SIZES.apple).png().toBuffer();
  const png32 = await sharp(png512).resize(SIZES.ico32, SIZES.ico32).png().toBuffer();
  const png16 = await sharp(png512).resize(SIZES.ico16, SIZES.ico16).png().toBuffer();

  // Build ICO
  const ico = buildIco([png16, png32]);

  // Determine output dir
  let outDir;
  if (localPath && fs.existsSync(path.join(localPath, 'app'))) {
    outDir = path.join(localPath, 'app');
  } else if (localPath && fs.existsSync(path.join(localPath, 'public'))) {
    outDir = path.join(localPath, 'public');
  } else {
    console.log(`  ⚠  ${appId}: no app/ or public/ directory`);
    return { appId, status: 'no_output_dir', files: [] };
  }

  // Write files
  const files = [];
  const writes = [
    ['favicon.ico', ico],
    ['apple-touch-icon.png', png180],
    ['icon.png', png512],
  ];

  for (const [name, buf] of writes) {
    const dest = path.join(outDir, name);
    fs.writeFileSync(dest, buf);
    files.push(dest);
  }

  // Also copy 512px PNG to local-apps/public/favicons/{id}.png
  const dashboardCopy = path.join(FAVICONS_DIR, `${appId}.png`);
  fs.writeFileSync(dashboardCopy, png512);
  files.push(dashboardCopy);

  console.log(`  ✅ ${appId}: ${files.length} files written to ${outDir}`);
  return { appId, status: 'done', files };
}

// --- Main ---
async function main() {
  const arg = process.argv[2] || null;
  const scanAll = arg === '--all';
  const targetId = (!scanAll && arg) ? arg : null;

  let entries; // { id, localPath }[]

  if (scanAll) {
    // Scan ALL ~/Sites/* directories
    const dirs = fs.readdirSync(SITES_DIR, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith('.'))
      .map(d => ({ id: d.name, localPath: path.join(SITES_DIR, d.name) }));
    entries = dirs;
    console.log(`\n🎨 Favicon Generator (--all mode)`);
    console.log(`   Scanning: ${SITES_DIR} (${entries.length} directories)\n`);
  } else {
    // Use DB-registered apps
    entries = db.getApps().map(a => ({ id: a.id, localPath: a.localPath }));
    console.log(`\n🎨 Favicon Generator`);
    console.log(`   Apps: ${entries.length} registered, target: ${targetId || 'all'}\n`);
  }

  const results = [];
  for (const entry of entries) {
    if (targetId && entry.id !== targetId) continue;
    try {
      const result = await generateForApp(entry.id, entry.localPath);
      results.push(result);
    } catch (err) {
      console.error(`  ❌ ${entry.id}: ${err.message}`);
      results.push({ appId: entry.id, status: 'error', error: err.message });
    }
  }

  // Summary
  const done = results.filter(r => r.status === 'done').length;
  const skipped = results.filter(r => r.status === 'skipped').length;
  const errors = results.filter(r => r.status === 'error').length;
  const noDir = results.filter(r => r.status === 'no_output_dir').length;
  console.log(`\n📊 Done: ${done} generated, ${skipped} skipped, ${noDir} no output dir, ${errors} errors\n`);

  if (process.env.JSON_OUTPUT) {
    process.stdout.write(JSON.stringify(results));
  }
}

main().catch(err => {
  console.error('Fatal:', err);
  process.exit(1);
});
