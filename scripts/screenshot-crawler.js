#!/usr/bin/env node
/**
 * Screenshot Crawler
 * Crawl a URL, detect nav links, capture full HD screenshots in 5 modes:
 *   desktop, mobile, macbook-framed, iphone-framed, ipad-framed
 *
 * Device framing uses the Frames app API at http://localhost:3005/api/frame
 *
 * Usage:
 *   node scripts/screenshot-crawler.js <url> [desktop] [mobile] [macbook] [iphone] [ipad]
 *
 * Output: ~/Desktop/<app-name>.<timestamp>/
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const os = require('os');

// ─── Config ───────────────────────────────────────────────────────────────
const VIEWPORT_DESKTOP = { width: 1920, height: 1080 };
const VIEWPORT_MOBILE  = { width: 390, height: 844 };
const SCALE_DESKTOP = 1;  // Frames API resizes to fit device screen anyway
const SCALE_MOBILE  = 2;  // 2x is sufficient, 3x wastes memory
const FRAMES_API = 'http://localhost:3005/api/frame';

// ─── Parse args ───────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const url = args[0];
if (!url) {
  console.error('Usage: node screenshot-crawler.js <url> [desktop] [mobile] [macbook] [iphone] [ipad]');
  process.exit(1);
}

const ALL_MODES = ['desktop', 'mobile', 'macbook', 'iphone', 'ipad'];
const resumeIdx = args.indexOf('--resume');
const resumeDir = resumeIdx !== -1 ? args[resumeIdx + 1] : null;
const filteredArgs = args.slice(1).filter(a => a !== '--resume' && a !== resumeDir);
const requestedModes = filteredArgs.filter(m => ALL_MODES.includes(m));
const modes = requestedModes.length ? requestedModes : ALL_MODES;

// Derive app name + output dir
const urlObj = new URL(url);
const appName = urlObj.hostname.replace('.localhost', '').replace(/\./g, '-') || 'site';
const ts = new Date().toISOString().replace(/[T:]/g, '-').replace(/\..+/, '').replace(/-/g, '').replace(/(\d{8})(\d{6})/, '$1-$2');
const outDir = resumeDir || path.join(os.homedir(), 'Desktop', `${appName}.${ts}`);

// ─── Helpers ──────────────────────────────────────────────────────────────
function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

function slug(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'page';
}

async function waitReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(() => {});
  await page.waitForTimeout(500);
}

async function unlockScroll(page) {
  await page.evaluate(() => {
    document.documentElement.style.overflow = 'visible';
    document.body.style.overflow = 'visible';
  });
}

// ─── Link discovery ───────────────────────────────────────────────────────
async function discoverLinks(page, baseUrl) {
  const origin = new URL(baseUrl).origin;

  const links = await page.evaluate((origin) => {
    const selectors = [
      'nav a[href]', '.sidebar a[href]', '.sidebar-nav a[href]',
      '[class*="nav"] a[href]', 'header a[href]', 'aside a[href]',
    ];
    const seen = new Set();
    const results = [];

    for (const sel of selectors) {
      for (const el of document.querySelectorAll(sel)) {
        const href = el.getAttribute('href');
        if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
        let fullUrl;
        try { fullUrl = new URL(href, window.location.origin).href; } catch { continue; }
        if (!fullUrl.startsWith(origin)) continue;
        const pathname = new URL(fullUrl).pathname;
        if (seen.has(pathname)) continue;
        seen.add(pathname);
        const rawLabel = el.textContent.trim().replace(/\s+/g, ' ');
        // Strip nav count badges (e.g. "Status 17/18" → "Status")
        const label = rawLabel.replace(/\s*\d+[\/]\d+\s*$/, '').replace(/\s*\d+\s*$/, '').trim() || pathname;
        results.push({ url: fullUrl, pathname, label });
      }
    }

    if (results.length === 0) {
      results.push({ url: window.location.href, pathname: new URL(window.location.href).pathname, label: 'home' });
    }
    return results;
  }, origin);

  return links;
}

// ─── Helpers: sleep, retry ────────────────────────────────────────────────
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ─── Screenshot capture ───────────────────────────────────────────────────
async function captureMode(browser, links, mode, dir) {
  ensureDir(dir);

  const isMobile = (mode === 'mobile');
  const viewport = isMobile ? VIEWPORT_MOBILE : VIEWPORT_DESKTOP;
  const scale = isMobile ? SCALE_MOBILE : SCALE_DESKTOP;

  const context = await browser.newContext({
    viewport,
    deviceScaleFactor: scale,
    isMobile,
    hasTouch: isMobile,
    userAgent: isMobile
      ? 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1'
      : undefined,
  });

  const page = await context.newPage();
  let count = 0;

  for (let i = 0; i < links.length; i++) {
    const link = links[i];
    const idx = String(i + 1).padStart(2, '0');
    const filename = `${idx}-${slug(link.label)}.png`;
    const filePath = path.join(dir, filename);

    // Resume: skip if already captured
    if (fs.existsSync(filePath) && fs.statSync(filePath).size > 1000) {
      console.log(`  [${mode}] ${filename} (cached)`);
      count++;
      continue;
    }

    // Retry up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        await page.goto(link.url, { timeout: 30000, waitUntil: 'domcontentloaded' });
        await waitReady(page);
        await unlockScroll(page);
        await page.screenshot({ path: filePath, fullPage: true });
        console.log(`  [${mode}] ${filename}`);
        count++;
        break;
      } catch (err) {
        if (attempt === 2) {
          console.log(`  WARN [${mode}] ${filename} -- ${err.message.slice(0, 80)}`);
        } else {
          await sleep(2000); // wait before retry
        }
      }
    }

    // Breathe between captures
    await sleep(300);
  }

  await context.close();
  return count;
}

// ─── Frames API framing ──────────────────────────────────────────────────
async function frameViaAPI(screenshotPath, device) {
  const form = new FormData();
  form.append('image', new Blob([fs.readFileSync(screenshotPath)], { type: 'image/png' }), path.basename(screenshotPath));
  form.append('device', device);

  const res = await fetch(FRAMES_API, { method: 'POST', body: form, signal: AbortSignal.timeout(60000) });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Frames API ${res.status}: ${text.slice(0, 100)}`);
  }

  // Stream to file to avoid holding full buffer in memory
  const chunks = [];
  for await (const chunk of res.body) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function frameScreenshots(srcDir, destDir, device) {
  ensureDir(destDir);
  const files = fs.readdirSync(srcDir).filter(f => f.endsWith('.png'));
  let count = 0;

  for (const file of files) {
    const src = path.join(srcDir, file);
    const dest = path.join(destDir, file);

    // Resume: skip if already framed
    if (fs.existsSync(dest) && fs.statSync(dest).size > 5000) {
      console.log(`  [${device}-framed] ${file} (cached)`);
      count++;
      continue;
    }

    // Retry up to 2 times
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const framedBuffer = await frameViaAPI(src, device);
        fs.writeFileSync(dest, framedBuffer);
        console.log(`  [${device}-framed] ${file}`);
        count++;
        break;
      } catch (err) {
        if (attempt === 2) {
          console.log(`  WARN [${device}-framed] ${file} -- ${err.message.slice(0, 80)}`);
        } else {
          console.log(`  RETRY [${device}-framed] ${file} -- attempt ${attempt}`);
          await sleep(3000);
        }
      }
    }

    // 1s cooldown between frames — let CPU and Frames app breathe
    await sleep(1000);
  }

  return count;
}

// ─── HTML gallery per folder ──────────────────────────────────────────────
function generateHTML(dir, title, isPortrait) {
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.png')).sort();
  if (files.length === 0) return;

  const orientation = isPortrait ? 'portrait' : 'landscape';
  const imgStyle = isPortrait
    ? 'max-width: 400px; width: 100%;'
    : 'max-width: 100%; width: 100%;';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <title>${title}</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body { background: #111; color: #eee; font-family: -apple-system, system-ui, sans-serif; padding: 40px; }
    h1 { font-size: 24px; margin-bottom: 8px; }
    .meta { color: #666; font-size: 13px; margin-bottom: 32px; }
    .grid { display: flex; flex-direction: column; gap: 48px; align-items: center; }
    .shot { text-align: center; }
    .shot img { ${imgStyle} border-radius: 8px; box-shadow: 0 4px 24px rgba(0,0,0,0.5); }
    .shot .name { margin-top: 12px; font-size: 12px; color: #555; }
    @media print {
      body { background: #fff; color: #000; padding: 20px; }
      .shot { page-break-after: always; }
      .shot img { box-shadow: none; border-radius: 0; }
    }
    @page { size: ${orientation}; margin: 0.5in; }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div class="meta">${files.length} screenshots &middot; ${new Date().toLocaleDateString()}</div>
  <div class="grid">
${files.map(f => `    <div class="shot"><img src="${f}" loading="lazy" /><div class="name">${f.replace('.png', '')}</div></div>`).join('\n')}
  </div>
</body>
</html>`;

  fs.writeFileSync(path.join(dir, 'index.html'), html);
  console.log(`  [html] ${path.basename(dir)}/index.html`);
}

// ─── Main ─────────────────────────────────────────────────────────────────
process.on('uncaughtException', (err) => { console.error('UNCAUGHT:', err.message); });
process.on('unhandledRejection', (err) => { console.error('UNHANDLED:', err?.message || err); });

(async () => {
  console.log(`\nCrawling: ${url}`);
  console.log(`Output:   ${outDir}`);
  console.log(`Resume:   existing files will be skipped\n`);

  ensureDir(outDir);

  // Save run config for resume
  const configPath = path.join(outDir, '.crawler.json');
  fs.writeFileSync(configPath, JSON.stringify({ url, modes, startedAt: new Date().toISOString() }, null, 2));

  const browser = await chromium.launch({ headless: true });

  // Step 1: Discover links
  const discoverCtx = await browser.newContext({ viewport: VIEWPORT_DESKTOP });
  const discoverPage = await discoverCtx.newPage();
  await discoverPage.goto(url, { timeout: 15000, waitUntil: 'domcontentloaded' });
  await waitReady(discoverPage);

  const links = await discoverLinks(discoverPage, url);
  await discoverCtx.close();

  console.log(`Found ${links.length} pages:`);
  links.forEach((l, i) => console.log(`   ${i + 1}. ${l.label} -> ${l.pathname}`));
  console.log('');

  // Step 2: Capture raw screenshots (desktop and/or mobile)
  const results = {};
  const needDesktop = modes.includes('desktop') || modes.includes('macbook') || modes.includes('ipad');
  const needMobile  = modes.includes('mobile') || modes.includes('iphone');

  if (needDesktop) {
    const dir = path.join(outDir, 'desktop');
    results.desktop = await captureMode(browser, links, 'desktop', dir);
  }

  if (needMobile) {
    const dir = path.join(outDir, 'mobile');
    results.mobile = await captureMode(browser, links, 'mobile', dir);
  }

  await browser.close();

  // Step 3: Frame via Frames API
  let framesAvailable = true;
  try {
    // Warm up the Frames app (first request compiles Next.js routes)
    await fetch('http://localhost:3005/', { signal: AbortSignal.timeout(15000) }).catch(() => {});
    const probe = await fetch(FRAMES_API, { method: 'GET', signal: AbortSignal.timeout(15000) });
    framesAvailable = probe.ok;
    if (framesAvailable) console.log('\nFrames API ready at ' + FRAMES_API);
  } catch (err) {
    framesAvailable = false;
    console.log('\nWARN: Frames API not available (' + (err.message || 'timeout') + ') -- skipping device framing');
  }

  if (framesAvailable) {
    if (modes.includes('macbook') && results.desktop > 0) {
      const src = path.join(outDir, 'desktop');
      const dest = path.join(outDir, 'macbook-framed');
      results['macbook-framed'] = await frameScreenshots(src, dest, 'macbook');
    }

    if (modes.includes('iphone') && results.mobile > 0) {
      const src = path.join(outDir, 'mobile');
      const dest = path.join(outDir, 'iphone-framed');
      results['iphone-framed'] = await frameScreenshots(src, dest, 'iphone');
    }

    if (modes.includes('ipad') && results.desktop > 0) {
      const src = path.join(outDir, 'desktop');
      const dest = path.join(outDir, 'ipad-framed');
      results['ipad-framed'] = await frameScreenshots(src, dest, 'ipad-landscape');
    }
  }

  // Step 4: Generate HTML gallery per folder
  console.log('');
  const desktopDir = path.join(outDir, 'desktop');
  const mobileDir  = path.join(outDir, 'mobile');
  const macbookDir = path.join(outDir, 'macbook-framed');
  const iphoneDir  = path.join(outDir, 'iphone-framed');
  const ipadDir    = path.join(outDir, 'ipad-framed');

  if (fs.existsSync(desktopDir)) generateHTML(desktopDir, `${appName} -- Desktop`, false);
  if (fs.existsSync(mobileDir))  generateHTML(mobileDir, `${appName} -- Mobile`, true);
  if (fs.existsSync(macbookDir)) generateHTML(macbookDir, `${appName} -- MacBook Framed`, false);
  if (fs.existsSync(iphoneDir))  generateHTML(iphoneDir, `${appName} -- iPhone Framed`, true);
  if (fs.existsSync(ipadDir))    generateHTML(ipadDir, `${appName} -- iPad Framed`, false);

  // Step 5: Summary
  console.log(`\nDone! Saved to ${outDir}\n`);
  console.log('Mode              Count   Folder');
  console.log('────────────────  ─────   ──────────────');
  for (const [mode, count] of Object.entries(results)) {
    const folder = mode.includes('framed') ? mode + '/' : mode + '/';
    console.log(`${mode.padEnd(18)}${String(count).padEnd(8)}${folder}`);
  }
  console.log(`\nTotal: ${Object.values(results).reduce((a, b) => a + b, 0)} screenshots`);
  console.log(`Each folder has an index.html for print-to-PDF.`);
})();
