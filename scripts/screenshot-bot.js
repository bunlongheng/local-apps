#!/usr/bin/env node
/**
 * Screenshot Bot
 * For each app: landing → login → after-login → nav pages → CRUD per page
 *
 * Usage:
 *   node scripts/screenshot-bot.js           # all apps
 *   node scripts/screenshot-bot.js bheng     # single app
 *
 * Credentials: scripts/screenshot-credentials.json
 */

const { chromium, devices } = require('playwright');
const fs   = require('fs');
const path = require('path');
const sharp = require('sharp');

const ROOT        = path.join(__dirname, '..');
const db          = require(path.join(ROOT, 'db'));
const CREDS_FILE  = path.join(__dirname, 'screenshot-credentials.json');
const RULES_FILE  = path.join(__dirname, 'screenshot-rules.json');
const OUT_DIR     = path.join(ROOT, 'public', 'screenshots');
const TEST_STAMP  = `bot-${Date.now()}`;
const VIEWPORT_DESKTOP = { width: 1920, height: 1080 };
const VIEWPORT_MOBILE  = { width: 390,  height: 844  };
const SCALE_DESKTOP    = 2;
const SCALE_MOBILE     = 3;

// ─── helpers ────────────────────────────────────────────────────────────────

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

// Unlock overflow-hidden so fullPage screenshots capture the whole document
async function unlockScroll(page) {
  await page.evaluate(() => {
    document.documentElement.style.overflow = 'visible';
    document.body.style.overflow = 'visible';
  });
}

async function shot(page, dir, filename, rules = {}, fullPage = true) {
  if (rules.fixOverflow && fullPage) await unlockScroll(page);
  const file = path.join(dir, filename);
  await page.screenshot({ path: file, fullPage });
  console.log(`    📸  ${filename}`);
}

function slug(text) {
  return text.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 32) || 'page';
}

async function waitReady(page) {
  await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
  await page.waitForLoadState('networkidle',      { timeout: 6000 }).catch(() => {});
}

async function isVisible(locator) {
  return locator.isVisible({ timeout: 1500 }).catch(() => false);
}

// ─── device framing ──────────────────────────────────────────────────────────

const FRAMES_DIR   = path.join(__dirname, 'frames');
const IPHONE_FRAME = path.join(FRAMES_DIR, 'iphone.png');
const MACBOOK_FRAME= path.join(FRAMES_DIR, 'macbook.png');

// iPhone 15 Pro Max frame: 1490x2996, screen area x=99 y=243 w=1290 h=2653
const IPHONE_SCREEN = { x: 99, y: 243, w: 1290, h: 2653 };
// MacBook Air frame: 2664x1816, screen area x=52 y=52 w=2560 h=1600
const MACBOOK_SCREEN = { x: 52, y: 52, w: 2560, h: 1600 };

async function addIPhoneFrame(inputPath, outputPath) {
  const { x, y, w, h } = IPHONE_SCREEN;
  // Resize screenshot to exactly fit the screen area
  const screen = await sharp(inputPath)
    .resize(w, h, { fit: 'cover', position: 'top' })
    .png().toBuffer();

  await sharp(IPHONE_FRAME)
    .composite([{ input: screen, top: y, left: x }])
    .png().toFile(outputPath);
}

async function addMacBookFrame(inputPath, outputPath) {
  const { x, y, w, h } = MACBOOK_SCREEN;
  const meta = await sharp(inputPath).metadata();
  const srcW = meta.width, srcH = meta.height;
  const frameAR = w / h;  // 16:10
  const srcAR = srcW / srcH;

  let screen;
  if (srcAR >= frameAR) {
    // Wider than frame — fit width, crop bottom if needed
    screen = await sharp(inputPath)
      .resize(w, h, { fit: 'cover', position: 'top' })
      .png().toBuffer();
  } else {
    // Taller than frame (full-page scroll) — crop to frame AR from top, then resize
    const cropH = Math.round(srcW / frameAR);
    screen = await sharp(inputPath)
      .extract({ left: 0, top: 0, width: srcW, height: Math.min(cropH, srcH) })
      .resize(w, h, { fit: 'fill' })
      .png().toBuffer();
  }

  await sharp(MACBOOK_FRAME)
    .composite([{ input: screen, top: y, left: x }])
    .png().toFile(outputPath);
}

async function frameAll(srcDir, dstDir, type) {
  ensureDir(dstDir);
  const pngs = fs.readdirSync(srcDir).filter(f => f.endsWith('.png')).sort();
  for (const f of pngs) {
    const src = path.join(srcDir, f);
    const dst = path.join(dstDir, f);
    try {
      if (type === 'iphone') await addIPhoneFrame(src, dst);
      else                   await addMacBookFrame(src, dst);
    } catch (err) {
      console.log(`    ✗   frame ${f}: ${err.message.slice(0, 60)}`);
    }
  }
  console.log(`    🖼   ${pngs.length} ${type} frame(s) → ${path.basename(dstDir)}/`);
}

// ─── login ──────────────────────────────────────────────────────────────────

async function tryLogin(page, creds, dir) {
  // navigate to a specific login URL if provided
  if (creds?.loginUrl) {
    const base = new URL(page.url()).origin;
    await page.goto(base + creds.loginUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await waitReady(page);
  }

  const pwField = page.locator('input[type="password"]').first();
  if (!await isVisible(pwField)) return false;

  await shot(page, dir, '02-login.png');

  // username / email field — try name attr first, fall back to type
  const userSel = creds?.usernameField
    ? `input[name="${creds.usernameField}"], input[type="${creds.usernameField}"], input[placeholder*="${creds.usernameField}" i]`
    : 'input[type="email"], input[name="email"], input[name="username"], input[name="user"]';
  const userField = page.locator(userSel).first();
  if (await isVisible(userField)) await userField.fill(creds?.username ?? '');

  await pwField.fill(creds?.password ?? '');

  const submit = page.locator(
    'button[type="submit"], input[type="submit"], ' +
    'button:has-text("Log in"), button:has-text("Login"), button:has-text("Sign in")'
  ).first();
  if (await isVisible(submit)) await submit.click();

  // wait for URL change (redirect after auth) or up to 8s
  const beforeUrl = page.url();
  await Promise.race([
    page.waitForURL(url => url.toString() !== beforeUrl, { timeout: 8000 }),
    page.waitForTimeout(8000),
  ]).catch(() => {});
  await waitReady(page);

  // navigate to a specific post-login page if provided
  if (creds?.postLoginUrl) {
    const base = new URL(page.url()).origin;
    await page.goto(base + creds.postLoginUrl, { waitUntil: 'domcontentloaded', timeout: 8000 });
    await waitReady(page);
  }

  await shot(page, dir, '03-after-login.png');
  return true;
}

// ─── nav links ──────────────────────────────────────────────────────────────

async function getNavLinks(page, baseUrl, customSelector) {
  const origin = new URL(baseUrl).origin;

  const raw = await page.evaluate(({ origin, customSelector }) => {
    const seen = new Map();

    // Priority: explicit nav elements
    const navCandidates = document.querySelectorAll(
      customSelector ||
      'nav a, header a, aside a, [role="navigation"] a, ' +
      '.navbar a, .sidebar a, .menu a, .nav a, ' +
      '[class*="nav"] a, [class*="menu"] a, [class*="sidebar"] a, [class*="header"] a'
    );
    for (const a of navCandidates) {
      const href = a.href;
      const text = (a.textContent || a.getAttribute('aria-label') || '').trim();
      if (href && text && text.length < 60 && href.startsWith(origin) &&
          !href.startsWith('javascript') && !href.includes('mailto')) {
        seen.set(href, text);
      }
    }

    // Fallback: all internal links if nothing found in nav
    if (seen.size === 0) {
      for (const a of document.querySelectorAll('a[href]')) {
        const href = a.href;
        const text = (a.textContent || '').trim();
        if (href && text && text.length > 1 && text.length < 60 &&
            href.startsWith(origin) && !href.startsWith('javascript') &&
            !href.includes('mailto') && !href.includes('#')) {
          seen.set(href, text);
        }
      }
    }

    return [...seen.entries()].map(([href, text]) => ({ href, text }));
  }, { origin, customSelector: customSelector || null });

  // dedupe by pathname
  const byPath = new Map();
  for (const link of raw) {
    try {
      const p = new URL(link.href).pathname;
      if (!byPath.has(p)) byPath.set(p, link);
    } catch {}
  }
  return [...byPath.values()];
}

// ─── CRUD ────────────────────────────────────────────────────────────────────

async function fillForm(page) {
  const inputs = page.locator(
    'input[type="text"]:visible, input:not([type]):visible, ' +
    'input[type="number"]:visible, textarea:visible'
  );
  const count = await inputs.count();
  for (let i = 0; i < Math.min(count, 6); i++) {
    const inp = inputs.nth(i);
    const type = await inp.getAttribute('type');
    try {
      if (type === 'number') await inp.fill('42');
      else await inp.fill(`${TEST_STAMP}-field${i}`);
    } catch {}
  }

  // selects — pick second option if available
  const selects = page.locator('select:visible');
  const sc = await selects.count();
  for (let i = 0; i < sc; i++) {
    try {
      const opts = await selects.nth(i).locator('option').all();
      if (opts.length > 1) await selects.nth(i).selectOption({ index: 1 });
    } catch {}
  }
}

async function tryCRUD(page, appDir, prefix) {
  const results = [];

  // ── READ: screenshot existing list / table ──────────────────────────────
  const listEl = page.locator('table, [role="grid"], [role="list"], ul.list, .data-table').first();
  if (await isVisible(listEl)) {
    await shot(page, appDir, `${prefix}-R-read.png`);
    results.push('R');
  }

  // ── CREATE ──────────────────────────────────────────────────────────────
  const createBtn = page.locator(
    'button:has-text("New"), button:has-text("Create"), button:has-text("Add"), ' +
    'a:has-text("New"), a:has-text("Create"), a:has-text("Add"), ' +
    '[aria-label*="create" i], [aria-label*="new" i], [aria-label*="add" i]'
  ).first();

  if (await isVisible(createBtn)) {
    await createBtn.click();
    await waitReady(page);
    await fillForm(page);
    await shot(page, appDir, `${prefix}-C-create.png`);

    const saveBtn = page.locator(
      'button[type="submit"], button:has-text("Save"), button:has-text("Create"), ' +
      'button:has-text("Submit"), button:has-text("Add"), button:has-text("OK")'
    ).first();
    if (await isVisible(saveBtn)) {
      await saveBtn.click();
      await waitReady(page);
    }
    results.push('C');

    // return to list if navigated away
    if (!page.url().includes(page.url())) await page.goBack().catch(() => {});
  }

  // ── UPDATE ──────────────────────────────────────────────────────────────
  const editBtn = page.locator(
    'button:has-text("Edit"), a:has-text("Edit"), ' +
    'button:has-text("Update"), a:has-text("Update"), ' +
    '[aria-label*="edit" i], [title*="edit" i], .edit-btn, [data-action="edit"]'
  ).first();

  if (await isVisible(editBtn)) {
    await editBtn.click();
    await waitReady(page);

    // change first text input
    const firstInput = page.locator('input[type="text"]:visible, textarea:visible').first();
    if (await isVisible(firstInput)) {
      await firstInput.press('Control+a');
      await firstInput.fill(`${TEST_STAMP}-updated`);
    }
    await shot(page, appDir, `${prefix}-U-update.png`);

    const saveBtn = page.locator(
      'button[type="submit"], button:has-text("Save"), button:has-text("Update"), button:has-text("OK")'
    ).first();
    if (await isVisible(saveBtn)) {
      await saveBtn.click();
      await waitReady(page);
    }
    results.push('U');
    await page.goBack().catch(() => {});
  }

  // ── DELETE ──────────────────────────────────────────────────────────────
  const deleteBtn = page.locator(
    'button:has-text("Delete"), a:has-text("Delete"), ' +
    'button:has-text("Remove"), a:has-text("Remove"), ' +
    '[aria-label*="delete" i], [title*="delete" i], .delete-btn, [data-action="delete"]'
  ).first();

  if (await isVisible(deleteBtn)) {
    await shot(page, appDir, `${prefix}-D-delete.png`);

    // handle confirm dialog
    page.once('dialog', d => d.accept().catch(() => {}));
    await deleteBtn.click();
    await waitReady(page);
    results.push('D');
  }

  return results;
}

// ─── custom flows ────────────────────────────────────────────────────────────

async function flowDiagrams(page, appDir, creds) {
  // 1. Landing + login
  await page.goto('http://localhost:3002', { waitUntil: 'domcontentloaded', timeout: 12000 });
  await waitReady(page);
  await shot(page, appDir, '01-landing.png');

  // Click "Sign In" button to reveal auth form
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In"), button:has-text("Login"), a:has-text("Login")').first();
  if (await isVisible(signInBtn)) {
    await signInBtn.click();
    await waitReady(page);
    await page.waitForTimeout(800);
  }

  await tryLogin(page, creds, appDir);
  await page.waitForTimeout(2000);
  await waitReady(page);

  // 2. Index — full overview
  await shot(page, appDir, '04-index-all.png');

  // 3. Click each category filter tab and screenshot
  const categoryTabs = await page.evaluate(() => {
    const tabs = [];
    document.querySelectorAll('button, [role="tab"], .tab, .filter-btn').forEach(el => {
      const txt = el.textContent.trim();
      if (txt.match(/^(All|AI|API|Learning|Personal|Research|Test|Work)(\s+\d+)?$/)) {
        tabs.push(txt);
      }
    });
    return [...new Set(tabs)];
  });

  console.log(`    🗂   Category tabs: ${categoryTabs.join(', ')}`);

  let tabIdx = 5;
  for (const tabText of categoryTabs) {
    try {
      const tab = page.locator(`button:has-text("${tabText.split(' ')[0]}"), [role="tab"]:has-text("${tabText.split(' ')[0]}")`).first();
      if (await isVisible(tab)) {
        await tab.click();
        await page.waitForTimeout(600);
        const n = String(tabIdx).padStart(2, '0');
        await shot(page, appDir, `${n}-filter-${slug(tabText)}.png`);
        tabIdx++;
      }
    } catch {}
  }

  // 4. Click a card to open the editor
  // First go back to "All" to make sure cards are visible
  try {
    const allTab = page.locator('button:has-text("All"), [role="tab"]:has-text("All")').first();
    if (await isVisible(allTab)) { await allTab.click(); await page.waitForTimeout(600); }
  } catch {}

  // Find first card and click it
  const cardClicked = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="card"], [class*="item"], [class*="thumb"], .diagram-card, .grid > div, .grid > a');
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.width > 80 && rect.height > 80) {
        card.click();
        return true;
      }
    }
    return false;
  });

  if (!cardClicked) await page.mouse.click(200, 300);

  await page.waitForTimeout(2000);
  await waitReady(page);

  const editorUrl = page.url();
  console.log(`    🖊   Editor URL: ${editorUrl}`);

  // Editor screenshots start at 20 to avoid overlap with filter tabs
  // 5. Editor overview
  await shot(page, appDir, '20-editor.png');

  // Inspect what buttons exist in the editor toolbar
  const editorBtns = await page.evaluate(() => {
    const btns = [];
    document.querySelectorAll('button').forEach(el => {
      const txt = (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
      if (txt && txt.length < 40) btns.push(txt);
    });
    return [...new Set(btns)];
  });
  console.log(`    🔘   Editor buttons: ${editorBtns.join(', ')}`);

  // 6. Click Code button
  const codeBtn = page.locator('button:has-text("Code")').first();
  if (await isVisible(codeBtn)) {
    await codeBtn.click();
    await page.waitForTimeout(800);
    await shot(page, appDir, '21-editor-code.png');
  }

  // 7. Click Format → screenshot + each sub-tab/section
  const formatBtn = page.locator('button:has-text("Format"), button[title*="Format" i], button[aria-label*="Format" i]').first();
  if (await isVisible(formatBtn)) {
    await formatBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, appDir, '22-editor-format.png');

    // Discover tabs inside the format panel
    const formatTabs = await page.evaluate(() => {
      const tabs = [];
      document.querySelectorAll('button, [role="tab"]').forEach(el => {
        const txt = el.textContent.trim();
        // Look for short label-style text that might be format sub-tabs
        if (txt && txt.length < 25 && txt.length > 1) tabs.push(txt);
      });
      return [...new Set(tabs)];
    });
    console.log(`    🎨   All buttons while format open: ${formatTabs.slice(0, 20).join(', ')}`);

    // Format panel tabs discovered: general, components, share, Light, Dark, Monokai
    const fTabNames = ['general', 'components', 'share', 'Light', 'Dark', 'Monokai'];
    let fIdx = 23;
    for (const tabText of fTabNames) {
      try {
        // Re-open format panel if it closed between clicks
        if (!await isVisible(page.locator('button:has-text("general"), button:has-text("components")').first())) {
          const fb = page.locator('button:has-text("Format")').first();
          if (await isVisible(fb)) { await fb.click(); await page.waitForTimeout(600); }
        }
        const t = page.locator(`button:has-text("${tabText}")`).first();
        if (await isVisible(t)) {
          await t.click();
          await page.waitForTimeout(700);
          const n = String(fIdx).padStart(2, '0');
          await shot(page, appDir, `${n}-format-${slug(tabText)}.png`);
          fIdx++;
        }
      } catch {}
    }
  } else {
    console.log('    ⚠️   Format button not found');
  }

  // 8. Share button (do before Play since Play may change view)
  const shareBtn = page.locator('button:has-text("Share")').first();
  if (await isVisible(shareBtn)) {
    await shareBtn.click();
    await page.waitForTimeout(1000);
    await shot(page, appDir, '30-editor-share.png');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(600);
  }

  // 9. Click Play / Preview (renders the diagram live)
  const playBtn = page.locator('button:has-text("Play"), button:has-text("Preview"), button[title*="play" i], button[title*="preview" i]').first();
  if (await isVisible(playBtn)) {
    await playBtn.click();
    await page.waitForTimeout(1500);
    await shot(page, appDir, '31-editor-play.png');
  }
}

async function flowMindmaps(page, appDir, creds) {
  // 1. Landing + login
  await page.goto('http://localhost:5173', { waitUntil: 'domcontentloaded', timeout: 12000 });
  await waitReady(page);
  await page.waitForTimeout(1500); // Vite dev server may need a moment
  await shot(page, appDir, '01-landing.png');

  // Try login (standard form or click-to-reveal)
  const signInBtn = page.locator('button:has-text("Sign In"), a:has-text("Sign In"), button:has-text("Login"), a:has-text("Login")').first();
  if (await isVisible(signInBtn)) {
    await signInBtn.click();
    await waitReady(page);
    await page.waitForTimeout(800);
  }

  await tryLogin(page, creds, appDir);
  await page.waitForTimeout(2000);
  await waitReady(page);

  // 2. Index overview
  await shot(page, appDir, '04-index.png');

  // 3. Discover and click category filter tabs (skip action buttons like "New", single chars)
  const indexUrl = page.url();
  const categoryTabs = await page.evaluate(() => {
    const tabs = [];
    // Look for tabs/filters that contain a category name followed by optional count
    document.querySelectorAll('button, [role="tab"], .tab, .filter').forEach(el => {
      const txt = el.textContent.trim();
      // Skip: very short (1 char), action words, or too long
      if (!txt || txt.length < 2 || txt.length > 25) return;
      if (/^(New|Add|Create|Delete|Remove|Edit|Save|Cancel|B|C|D|E|F|G|H|I|J|K|L|M|N|O|P|Q|R|S|T|U|V|W|X|Y|Z)$/i.test(txt)) return;
      tabs.push(txt);
    });
    return [...new Set(tabs)].slice(0, 12);
  });
  console.log(`    🗂   Filter tabs: ${categoryTabs.join(', ')}`);

  let tabIdx = 5;
  for (const tabText of categoryTabs) {
    try {
      const tab = page.locator(`button:has-text("${tabText}"), [role="tab"]:has-text("${tabText}")`).first();
      if (await isVisible(tab)) {
        await tab.click();
        await page.waitForTimeout(600);
        // If we navigated away from index, go back
        if (page.url() !== indexUrl) { await page.goto(indexUrl, { waitUntil: 'domcontentloaded', timeout: 8000 }); await waitReady(page); continue; }
        const n = String(tabIdx).padStart(2, '0');
        await shot(page, appDir, `${n}-filter-${slug(tabText)}.png`);
        tabIdx++;
      }
    } catch {}
  }

  // 4. Click first card/thumbnail to open mindmap editor
  const cardClicked = await page.evaluate(() => {
    const cards = document.querySelectorAll('[class*="card"], [class*="item"], [class*="thumb"], .map-card, .grid > div, .grid > a');
    for (const card of cards) {
      const rect = card.getBoundingClientRect();
      if (rect.width > 80 && rect.height > 80) {
        card.click();
        return true;
      }
    }
    return false;
  });

  if (!cardClicked) await page.mouse.click(200, 300);

  await page.waitForTimeout(2000);
  await waitReady(page);

  console.log(`    🗺   Editor URL: ${page.url()}`);
  await shot(page, appDir, '20-editor.png');

  // 5. Look for toolbar buttons and screenshot each
  const toolbarBtns = await page.evaluate(() => {
    const btns = [];
    document.querySelectorAll('button, [role="button"]').forEach(el => {
      const txt = (el.textContent || el.getAttribute('title') || el.getAttribute('aria-label') || '').trim();
      if (txt && txt.length < 30) btns.push(txt);
    });
    return [...new Set(btns)].slice(0, 15);
  });
  console.log(`    🔘   Toolbar: ${toolbarBtns.join(', ')}`);

  const showcaseBtns = ['Format', 'Style', 'Theme', 'Layout', 'Export', 'Share', 'Settings'];
  let bIdx = 21;
  for (const label of showcaseBtns) {
    try {
      const btn = page.locator(`button:has-text("${label}"), [title*="${label}" i], [aria-label*="${label}" i]`).first();
      if (await isVisible(btn)) {
        await btn.click();
        await page.waitForTimeout(800);
        const n = String(bIdx).padStart(2, '0');
        await shot(page, appDir, `${n}-editor-${slug(label)}.png`);
        bIdx++;
        await page.keyboard.press('Escape');
        await page.waitForTimeout(400);
      }
    } catch {}
  }
}

async function flow3pi(page, appDir, creds) {
  const base = 'http://10.0.0.138:3333';

  // 1. Login via landing
  await page.goto(base, { waitUntil: 'commit', timeout: 60000 });
  await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
  await tryLogin(page, creds, appDir);
  await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

  const routes = [
    { path: '/',                 name: '01-dashboard' },
    { path: '/quality',          name: '02-quality' },
    { path: '/security',         name: '03-security' },
    { path: '/bugs',             name: '04-bugs' },
    { path: '/performance',      name: '05-performance' },
    { path: '/tech-debt',        name: '06-tech-debt' },
    { path: '/deployment',       name: '07-deployment' },
    { path: '/releases',         name: '08-releases' },
    { path: '/cycles',           name: '09-cycles' },
    { path: '/capacity',         name: '10-capacity' },
    { path: '/velocity',         name: '11-velocity' },
    { path: '/metrics',          name: '12-metrics' },
    { path: '/architecture',     name: '13-architecture' },
    { path: '/data-flow',        name: '14-data-flow' },
    { path: '/database',         name: '15-database' },
    { path: '/jira-view',        name: '16-jira-view' },
    { path: '/pm',               name: '17-pm' },
    { path: '/slack',            name: '18-slack' },
    { path: '/links',            name: '19-links' },
    { path: '/notifications',    name: '20-notifications' },
    { path: '/api-reference',    name: '21-api-reference' },
    { path: '/me',               name: '22-me' },
    { path: '/settings',         name: '23-settings' },
    { path: '/admin/users',      name: '24-admin-users' },
    { path: '/admin/completed',  name: '25-admin-completed' },
  ];

  for (const { path, name } of routes) {
    try {
      await page.goto(base + path, { waitUntil: 'commit', timeout: 60000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 60000 }).catch(() => {});
      await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
      await shot(page, appDir, `${name}.png`);
    } catch (err) {
      console.log(`    ✗   ${path}: ${err.message.slice(0, 70)}`);
    }
  }
}

async function flowDropWeb(page, appDir) {
  const base = 'http://localhost:3010';
  const routes = [
    { path: '/',     name: '01-home' },
    { path: '/drop', name: '02-drop' },
  ];

  for (const { path, name } of routes) {
    try {
      await page.goto(base + path, { waitUntil: 'commit', timeout: 30000 });
      await page.waitForLoadState('domcontentloaded', { timeout: 20000 }).catch(() => {});
      await page.waitForTimeout(5000);
      await shot(page, appDir, `${name}.png`);
    } catch (err) {
      console.log(`    ✗   ${path}: ${err.message.slice(0, 70)}`);
    }
  }
}

async function flowStickies(page, appDir) {
  const base = 'http://localhost:4444';
  const routes = [
    { path: '/sign-in',        name: '01-sign-in' },
    { path: '/',               name: '02-home' },
    { path: '/share',          name: '03-share' },
    { path: '/tools/stickies', name: '04-tools-stickies' },
  ];

  for (const { path, name } of routes) {
    try {
      await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitReady(page);
      await page.waitForTimeout(1000);
      await shot(page, appDir, `${name}.png`);
    } catch (err) {
      console.log(`    ✗   ${path}: ${err.message.slice(0, 70)}`);
    }
  }
}

async function flow3piPoc(page, appDir) {
  const base = 'http://localhost:3334';
  const routes = [
    { path: '/',                          name: '01-home' },
    { path: '/auth',                      name: '02-auth' },
    { path: '/integrator',               name: '03-integrator' },
    { path: '/integrator/verify',        name: '04-integrator-verify' },
    { path: '/integrator-poc',           name: '05-integrator-poc' },
    { path: '/integrator-admin',         name: '06-integrator-admin' },
    { path: '/integrator-admin/integrations', name: '07-integrator-admin-integrations' },
    { path: '/sts',                       name: '08-sts' },
    { path: '/oauth/complete',            name: '09-oauth-complete' },
    { path: '/privacy',                   name: '10-privacy' },
    { path: '/terms',                     name: '11-terms' },
  ];

  for (const { path, name } of routes) {
    try {
      await page.goto(base + path, { waitUntil: 'domcontentloaded', timeout: 15000 });
      await waitReady(page);
      await page.waitForTimeout(800);
      await shot(page, appDir, `${name}.png`);
    } catch (err) {
      console.log(`    ✗   ${path}: ${err.message.slice(0, 70)}`);
    }
  }
}

// ─── per-app runner ──────────────────────────────────────────────────────────

async function runMode(browser, cfg, creds, rules, modeDir, isM) {
  ensureDir(modeDir);

  const fullPage = !isM;
  const viewport = isM ? VIEWPORT_MOBILE
    : (rules?.viewport ? { width: rules.viewport[0], height: rules.viewport[1] } : VIEWPORT_DESKTOP);
  const scale    = isM ? SCALE_MOBILE : SCALE_DESKTOP;

  const ctxOpts = { viewport, deviceScaleFactor: scale };
  if (isM) {
    ctxOpts.isMobile  = true;
    ctxOpts.hasTouch  = true;
    ctxOpts.userAgent = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
  }

  const ctx  = await browser.newContext(ctxOpts);
  const page = await ctx.newPage();
  page.on('console', () => {});

  const customFlows = { diagrams: flowDiagrams, mindmaps: flowMindmaps, '3pi-poc': flow3piPoc, stickies: flowStickies, 'drop-web': flowDropWeb, '3pi': flow3pi };

  try {
    if (customFlows[cfg.id]) {
      await customFlows[cfg.id](page, modeDir, creds);
    } else {
      // 1. Landing
      await page.goto(cfg.localUrl, { waitUntil: 'domcontentloaded', timeout: 12000 });
      await waitReady(page);
      if (rules?.extraWait) await page.waitForTimeout(rules.extraWait);
      await shot(page, modeDir, '01-landing.png', rules, fullPage);

      // 2. Login
      const loggedIn = await tryLogin(page, creds, modeDir);
      if (creds && !loggedIn) console.log('    ⚠️   login form not detected — continuing as guest');
      if (!loggedIn) await shot(page, modeDir, '03-after-login.png', rules, fullPage);

      // 3. Nav crawl + CRUD
      await page.waitForTimeout(rules?.navWait ?? 1500);
      const navLinks = await getNavLinks(page, cfg.localUrl, rules?.navSelector);
      const visited  = new Set([page.url()]);
      let   navIdx   = 4;

      console.log(`    🔗  ${navLinks.length} nav link(s) found`);

      for (const { href, text } of navLinks) {
        const canonical = href.split('?')[0];
        if (visited.has(canonical)) continue;
        if (rules?.skipPages?.some(p => href.includes(p))) { console.log(`    ⏭   skip: ${text}`); continue; }
        visited.add(canonical);

        try {
          await page.goto(href, { waitUntil: 'domcontentloaded', timeout: rules?.pageTimeout ?? 10000 });
          await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});

          const n      = String(navIdx).padStart(2, '0');
          const prefix = `${n}-nav-${slug(text)}`;
          await shot(page, modeDir, `${prefix}.png`, rules, fullPage);

          if (!isM) {
            const crud = await tryCRUD(page, modeDir, prefix);
            if (crud.length) console.log(`    ✱   CRUD on ${text}: [${crud.join(',')}]`);
          }

          navIdx++;
        } catch (err) {
          console.log(`    ✗   ${text}: ${err.message.slice(0, 70)}`);
        }
      }
    }

    const shots = fs.readdirSync(modeDir).filter(f => f.endsWith('.png')).sort();
    console.log(`    ✓   ${shots.length} shot(s) → ${path.basename(modeDir)}/`);
    return shots;

  } catch (err) {
    console.log(`    ✗   fatal [${path.basename(modeDir)}]: ${err.message.slice(0, 100)}`);
    const saved = fs.readdirSync(modeDir).filter(f => f.endsWith('.png')).sort();
    return saved;
  } finally {
    await ctx.close();
  }
}

async function runApp(browser, cfg, creds, rules) {
  const appDir = path.join(OUT_DIR, cfg.id);
  ensureDir(appDir);

  console.log(`\n  ▶  ${cfg.id}  (${cfg.localUrl})`);

  const desktopDir        = path.join(appDir, 'desktop');
  const desktopFramedDir  = path.join(appDir, 'desktop-framed');
  const mobileDir         = path.join(appDir, 'mobile');
  const mobileFramedDir   = path.join(appDir, 'mobile-framed');

  // Desktop
  console.log(`    🖥   desktop`);
  const desktopShots = await runMode(browser, cfg, creds, rules, desktopDir, false);
  await frameAll(desktopDir, desktopFramedDir, 'macbook');

  // Mobile
  console.log(`    📱   mobile`);
  const mobileShots = await runMode(browser, cfg, creds, rules, mobileDir, true);
  await frameAll(mobileDir, mobileFramedDir, 'iphone');

  // Master index
  fs.writeFileSync(
    path.join(appDir, 'index.json'),
    JSON.stringify({
      id: cfg.id, name: cfg.name, capturedAt: new Date().toISOString(),
      desktop: desktopShots, mobile: mobileShots,
    }, null, 2)
  );
}

// ─── main ────────────────────────────────────────────────────────────────────

async function main() {
  const config = db.getApps();
  const creds  = fs.existsSync(CREDS_FILE) ? JSON.parse(fs.readFileSync(CREDS_FILE, 'utf8')) : {};
  const rules  = fs.existsSync(RULES_FILE) ? JSON.parse(fs.readFileSync(RULES_FILE, 'utf8')) : {};

  const targetId = process.argv[2];
  const apps     = (targetId ? config.filter(a => a.id === targetId) : config)
    .filter(a => a.localUrl && !a.noScreenshot && !(rules[a.id]?.skip));

  if (!apps.length) {
    console.error(targetId ? `App not found: ${targetId}` : 'No apps with localUrl');
    process.exit(1);
  }

  ensureDir(OUT_DIR);

  console.log(`\nScreenshot Bot — ${apps.length} app(s)  [${new Date().toLocaleTimeString()}]`);

  const browser = await chromium.launch({
    headless: false,
    args: ['--window-size=1440,900', '--headless=new'],
    executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  });

  for (const app of apps) {
    await runApp(browser, app, creds[app.id] ?? null, rules[app.id] ?? {});
  }

  await browser.close();

  // write master index — scan ALL app dirs, not just current run
  const allDirs = fs.existsSync(OUT_DIR) ? fs.readdirSync(OUT_DIR).filter(d => fs.statSync(path.join(OUT_DIR, d)).isDirectory()) : [];
  const masterIndex = allDirs
    .map(d => { const f = path.join(OUT_DIR, d, 'index.json'); return fs.existsSync(f) ? JSON.parse(fs.readFileSync(f, 'utf8')) : null; })
    .filter(Boolean);
  fs.writeFileSync(path.join(OUT_DIR, 'index.json'), JSON.stringify(masterIndex, null, 2));

  console.log('\n✓ All done\n');
}

main().catch(err => { console.error('\n✗', err.message); process.exit(1); });
