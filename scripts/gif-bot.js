#!/usr/bin/env node
/**
 * GIF Animation Bot v2
 * Records HD animated GIFs - captures 30s of real page activity
 * then fast-forwards into a crisp 5s looping GIF at 2x retina
 *
 * Usage:
 *   node scripts/gif-bot.js 3pi                               # all pages, auto-detect LAN
 *   node scripts/gif-bot.js 3pi --url http://remote-ip:3333  # explicit URL
 *   node scripts/gif-bot.js 3pi --pages /,/quality             # specific pages
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const sharp = require('sharp');
const GIFEncoder = require('gif-encoder-2');

const ROOT = path.join(__dirname, '..');
const db = require(path.join(ROOT, 'db'));
const OUT_DIR = path.join(ROOT, 'public', 'screenshots');

// Recording settings
const VIEWPORT = { width: 1920, height: 1080 };
const SCALE = 2;                // 2x retina capture (3840x2160 raw)
const GIF_WIDTH = 1920;         // Full HD output
const GIF_HEIGHT = 1080;
const RECORD_DURATION = 30000;  // 30s of real activity
const CAPTURE_INTERVAL = 200;   // capture a frame every 200ms (5fps raw)
const TARGET_DURATION = 5000;   // compress into 5s GIF
const QUALITY = 10;             // GIF quality (1=best, 30=worst)

// 3pi pages
const PAGES_3PI = [
  { path: '/', name: 'dashboard' },
  { path: '/quality', name: 'quality' },
  { path: '/security', name: 'security' },
  { path: '/bugs', name: 'bugs' },
  { path: '/performance', name: 'performance' },
  { path: '/tech-debt', name: 'tech-debt' },
  { path: '/deployment', name: 'deployment' },
  { path: '/releases', name: 'releases' },
  { path: '/cycles', name: 'cycles' },
  { path: '/capacity', name: 'capacity' },
  { path: '/velocity', name: 'velocity' },
  { path: '/metrics', name: 'metrics' },
  { path: '/architecture', name: 'architecture' },
  { path: '/data-flow', name: 'data-flow' },
  { path: '/database', name: 'database' },
  { path: '/jira-view', name: 'jira-view' },
  { path: '/pm', name: 'pm' },
  { path: '/slack', name: 'slack' },
  { path: '/links', name: 'links' },
  { path: '/notifications', name: 'notifications' },
  { path: '/api-reference', name: 'api-reference' },
  { path: '/me', name: 'me' },
  { path: '/settings', name: 'settings' },
  { path: '/admin/users', name: 'admin-users' },
  { path: '/admin/completed', name: 'admin-completed' },
];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

async function captureFrame(page) {
  const buf = await page.screenshot({ type: 'png' });
  // Resize from 3840x2160 (2x) down to 1920x1080 for GIF
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
    // Small initial wait for first paint
    await page.waitForTimeout(1000);
  } catch (err) {
    console.log(`    x ${pageDef.name} - failed to load: ${err.message.slice(0, 60)}`);
    return false;
  }

  console.log(`    > ${pageDef.name} - recording ${RECORD_DURATION / 1000}s...`);

  // Phase 1: Capture raw frames for RECORD_DURATION
  const rawFrames = [];
  const totalFrames = Math.floor(RECORD_DURATION / CAPTURE_INTERVAL);
  const scrollHeight = await page.evaluate(() => document.body.scrollHeight);
  const viewHeight = VIEWPORT.height;
  const scrollDistance = scrollHeight - viewHeight;

  for (let i = 0; i < totalFrames; i++) {
    // Gentle scroll during recording - slow pan down then back up
    if (scrollDistance > 50) {
      const progress = i / totalFrames;
      let scrollY;
      if (progress < 0.1) {
        // First 10% - stay at top (let page animate in)
        scrollY = 0;
      } else if (progress < 0.55) {
        // 10-55% - scroll down
        scrollY = ((progress - 0.1) / 0.45) * scrollDistance;
      } else if (progress < 0.65) {
        // 55-65% - pause at bottom
        scrollY = scrollDistance;
      } else if (progress < 0.95) {
        // 65-95% - scroll back up
        scrollY = (1 - (progress - 0.65) / 0.3) * scrollDistance;
      } else {
        // Last 5% - back at top
        scrollY = 0;
      }
      await page.evaluate((y) => window.scrollTo({ top: y, behavior: 'instant' }), Math.round(scrollY));
    }

    const { data } = await captureFrame(page);
    rawFrames.push(data);

    // Wait between captures
    await page.waitForTimeout(CAPTURE_INTERVAL);

    // Progress indicator
    if ((i + 1) % 25 === 0) {
      const pct = Math.round(((i + 1) / totalFrames) * 100);
      process.stdout.write(`\r    > ${pageDef.name} - ${pct}%`);
    }
  }
  process.stdout.write(`\r    > ${pageDef.name} - encoding...          \n`);

  // Phase 2: Fast-forward - pick evenly spaced frames to fit TARGET_DURATION
  // Target ~20fps in the output GIF for smooth playback
  const outputFps = 20;
  const outputFrameCount = Math.round(TARGET_DURATION / 1000 * outputFps);
  const frameDelay = Math.round(1000 / outputFps);
  const step = rawFrames.length / outputFrameCount;

  const encoder = new GIFEncoder(GIF_WIDTH, GIF_HEIGHT, 'neuquant', true);
  encoder.setDelay(frameDelay);
  encoder.setQuality(QUALITY);
  encoder.setRepeat(0);
  encoder.start();

  for (let i = 0; i < outputFrameCount; i++) {
    const frameIdx = Math.min(Math.floor(i * step), rawFrames.length - 1);
    encoder.addFrame(rawFrames[frameIdx]);
  }

  encoder.finish();

  const gifBuffer = encoder.out.getData();
  fs.writeFileSync(outFile, gifBuffer);
  const sizeMB = (gifBuffer.length / 1024 / 1024).toFixed(1);
  console.log(`    gif ${pageDef.name}.gif (${sizeMB}MB, ${outputFrameCount} frames)`);
  return true;
}

async function main() {
  const args = process.argv.slice(2);
  const appId = args[0] || '3pi';

  let customUrl = null;
  let specificPages = null;
  for (let i = 1; i < args.length; i++) {
    if (args[i] === '--url' && args[i + 1]) { customUrl = args[++i]; }
    if (args[i] === '--pages' && args[i + 1]) { specificPages = args[++i].split(','); }
  }

  // Resolve base URL - try LAN first
  let baseUrl = customUrl;
  if (!baseUrl) {
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

  let pages = PAGES_3PI;
  if (specificPages) {
    pages = pages.filter(p => specificPages.includes(p.path) || specificPages.includes(p.name));
  }

  const outDir = path.join(OUT_DIR, appId, 'gifs');
  ensureDir(outDir);

  console.log(`\nGIF Bot v2 - ${appId} (${pages.length} pages)`);
  console.log(`  URL:      ${baseUrl}`);
  console.log(`  Capture:  ${RECORD_DURATION / 1000}s per page @ ${1000 / CAPTURE_INTERVAL}fps`);
  console.log(`  Output:   ${GIF_WIDTH}x${GIF_HEIGHT} HD, compressed to ${TARGET_DURATION / 1000}s`);
  console.log(`  Retina:   ${SCALE}x device pixel ratio`);
  console.log(`  Dir:      ${outDir}\n`);

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
