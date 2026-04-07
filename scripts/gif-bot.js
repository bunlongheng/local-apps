#!/usr/bin/env node
/**
 * GIF Animation Bot
 * Records HD animated GIFs of app pages with scroll + hover interactions
 *
 * Usage:
 *   node scripts/gif-bot.js 3pi                    # record all pages
 *   node scripts/gif-bot.js 3pi --url http://10.0.0.138:3333  # custom URL
 *   node scripts/gif-bot.js 3pi --pages /,/quality  # specific pages only
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const GIFEncoder = require('gif-encoder-2');
const { createCanvas, Image } = (() => {
  try { return require('canvas'); } catch { return {}; }
})();

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'db'));
const OUT_DIR = path.join(ROOT, 'public', 'screenshots');
const RULES_FILE = path.join(__dirname, 'screenshot-rules.json');

const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = 2;
const GIF_WIDTH = 960;   // Half of 1920 for reasonable GIF size
const GIF_HEIGHT = 540;  // Half of 1080
const FRAME_DELAY = 120; // ms between frames
const SCROLL_FRAMES = 8;
const PAUSE_FRAMES = 12; // pause at top/bottom
const QUALITY = 10;      // GIF quality (1-30, lower = better)

// 3pi page definitions with interaction hints
const PAGES_3PI = [
  { path: '/', name: 'dashboard', interactions: ['scroll'] },
  { path: '/quality', name: 'quality', interactions: ['scroll'] },
  { path: '/security', name: 'security', interactions: ['scroll'] },
  { path: '/bugs', name: 'bugs', interactions: ['scroll'] },
  { path: '/performance', name: 'performance', interactions: ['scroll'] },
  { path: '/tech-debt', name: 'tech-debt', interactions: ['scroll'] },
  { path: '/deployment', name: 'deployment', interactions: ['scroll'] },
  { path: '/releases', name: 'releases', interactions: ['scroll'] },
  { path: '/cycles', name: 'cycles', interactions: ['scroll'] },
  { path: '/capacity', name: 'capacity', interactions: ['scroll'] },
  { path: '/velocity', name: 'velocity', interactions: ['scroll'] },
  { path: '/metrics', name: 'metrics', interactions: ['scroll'] },
  { path: '/architecture', name: 'architecture', interactions: ['scroll'] },
  { path: '/data-flow', name: 'data-flow', interactions: ['scroll'] },
  { path: '/database', name: 'database', interactions: ['scroll'] },
  { path: '/jira-view', name: 'jira-view', interactions: ['scroll'] },
  { path: '/pm', name: 'pm', interactions: ['scroll'] },
  { path: '/slack', name: 'slack', interactions: ['scroll'] },
  { path: '/links', name: 'links', interactions: ['scroll'] },
  { path: '/notifications', name: 'notifications', interactions: ['scroll'] },
  { path: '/api-reference', name: 'api-reference', interactions: ['scroll'] },
  { path: '/me', name: 'me', interactions: ['scroll'] },
  { path: '/settings', name: 'settings', interactions: ['scroll'] },
  { path: '/admin/users', name: 'admin-users', interactions: ['scroll'] },
  { path: '/admin/completed', name: 'admin-completed', interactions: ['scroll'] },
];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

async function captureFrame(page) {
  const buf = await page.screenshot({ type: 'png' });
  // Resize to GIF dimensions
  return sharp(buf)
    .resize(GIF_WIDTH, GIF_HEIGHT, { fit: 'cover', position: 'top' })
    .raw()
    .ensureAlpha()
    .toBuffer({ resolveWithObject: true });
}

async function recordPageGif(page, baseUrl, pageDef, outDir) {
  const url = baseUrl + pageDef.path;
  const outFile = path.join(outDir, `${pageDef.name}.gif`);

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForTimeout(3000); // let page render fully
  } catch (err) {
    console.log(`    x ${pageDef.name} - failed to load: ${err.message.slice(0, 60)}`);
    return false;
  }

  const encoder = new GIFEncoder(GIF_WIDTH, GIF_HEIGHT, 'neuquant', true);
  encoder.setDelay(FRAME_DELAY);
  encoder.setQuality(QUALITY);
  encoder.setRepeat(0); // loop forever
  encoder.start();

  const frames = [];

  // Frame 1: initial view (pause)
  console.log(`    > ${pageDef.name} - capturing frames...`);
  for (let i = 0; i < PAUSE_FRAMES; i++) {
    const { data } = await captureFrame(page);
    encoder.addFrame(data);
  }

  // Scroll down smoothly
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewHeight = VIEWPORT.height;
  const scrollDistance = scrollHeight - viewHeight;

  if (scrollDistance > 50) {
    const steps = Math.min(SCROLL_FRAMES * 3, Math.ceil(scrollDistance / 100));
    const stepSize = scrollDistance / steps;

    for (let i = 1; i <= steps; i++) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), stepSize * i);
      await page.waitForTimeout(80);
      const { data } = await captureFrame(page);
      encoder.addFrame(data);
    }

    // Pause at bottom
    for (let i = 0; i < PAUSE_FRAMES / 2; i++) {
      const { data } = await captureFrame(page);
      encoder.addFrame(data);
    }

    // Scroll back up
    for (let i = steps - 1; i >= 0; i--) {
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), stepSize * i);
      await page.waitForTimeout(80);
      const { data } = await captureFrame(page);
      encoder.addFrame(data);
    }

    // Pause at top
    for (let i = 0; i < PAUSE_FRAMES / 2; i++) {
      const { data } = await captureFrame(page);
      encoder.addFrame(data);
    }
  }

  encoder.finish();

  const gifBuffer = encoder.out.getData();
  fs.writeFileSync(outFile, gifBuffer);
  const sizeMB = (gifBuffer.length / 1024 / 1024).toFixed(1);
  console.log(`    gif ${pageDef.name}.gif (${sizeMB}MB)`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const appId = args[0] || '3pi';

  // Parse flags
  let customUrl = null;
  let specificPages = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) { customUrl = args[++i]; }
    if (args[i] === '--pages' && args[i + 1]) { specificPages = args[++i].split(','); }
  }

  // Resolve base URL
  let baseUrl = customUrl;
  if (!baseUrl) {
    // Try remote machine first (LAN), then local
    const machines = db.getMachines();
    for (const m of machines) {
      const testUrl = `http://${m.ip}:3333`;
      try {
        const ok = await new Promise((resolve) => {
          require('http').get(testUrl, { timeout: 3000 }, (r) => {
            resolve(r.statusCode < 500);
          }).on('error', () => resolve(false));
        });
        if (ok) { baseUrl = testUrl; break; }
      } catch {}
    }
    if (!baseUrl) baseUrl = 'http://localhost:3333';
  }

  // Filter pages
  let pages = PAGES_3PI;
  if (specificPages) {
    pages = pages.filter(p => specificPages.includes(p.path) || specificPages.includes(p.name));
  }

  const outDir = path.join(OUT_DIR, appId, 'gifs');
  ensureDir(outDir);

  console.log(`\nGIF Bot - ${appId} (${pages.length} pages)`);
  console.log(`  URL: ${baseUrl}`);
  console.log(`  Output: ${outDir}`);
  console.log(`  Size: ${GIF_WIDTH}x${GIF_HEIGHT} @${FRAME_DELAY}ms\n`);

  const browser = await chromium.launch();
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: SCALE,
  });
  const page = await context.newPage();

  let success = 0;
  let failed = 0;

  for (const pageDef of pages) {
    const ok = await recordPageGif(page, baseUrl, pageDef, outDir);
    if (ok) success++;
    else failed++;
  }

  await browser.close();

  // Write index
  const gifs = fs.readdirSync(outDir).filter(f => f.endsWith('.gif')).sort();
  fs.writeFileSync(
    path.join(outDir, 'index.json'),
    JSON.stringify({ appId, gifs, capturedAt: new Date().toISOString() }, null, 2)
  );

  console.log(`\n  Done: ${success} recorded, ${failed} failed\n`);
}

main().catch(err => { console.error('\nx', err.message); process.exit(1); });
