#!/usr/bin/env node
/**
 * Link Crawler - visits every page in every app, detects crashes,
 * screenshots errors, and reports findings.
 *
 * Usage:
 *   node scripts/link-crawler.js           # all apps
 *   node scripts/link-crawler.js bheng     # single app
 *
 * Output:
 *   /tmp/link-crawler.log                  # full log
 *   public/screenshots/{app}/errors/       # error screenshots
 *   /tmp/link-crawler-summary.json         # JSON summary
 */

const { chromium } = require('playwright');
const fs = require('fs');
const path = require('path');
const db = require(path.join(__dirname, '..', 'db'));

const OUT_DIR = path.join(__dirname, '..', 'public', 'screenshots');
const TIMEOUT = 15000;
const VIEWPORT = { width: 1920, height: 1080 };

const APPS = [
    { id: 'bheng',    url: 'http://localhost:3000' },
    { id: 'tools',    url: 'http://localhost:3001' },
    { id: 'diagrams', url: 'http://localhost:3002' },
    { id: 'claude',   url: 'http://localhost:3003' },
    { id: '3pi',      url: 'http://localhost:3333' },
    { id: '3pi-poc',  url: 'http://localhost:3334' },
    { id: 'stickies', url: 'http://localhost:4444' },
    { id: 'vault',    url: 'http://localhost:4445' },
    { id: 'mindmaps', url: 'http://localhost:5173' },
    { id: 'safe',     url: 'http://localhost:6100' },
    { id: 'drop-web', url: 'http://localhost:3010' },
];

function ensureDir(d) { fs.mkdirSync(d, { recursive: true }); }

async function crawlApp(browser, app) {
    const errors = [];
    const visited = new Set();
    const consoleErrors = [];

    const errDir = path.join(OUT_DIR, app.id, 'errors');
    ensureDir(errDir);

    const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: 2 });
    const page = await context.newPage();

    // Collect console errors
    page.on('console', msg => {
        if (msg.type() === 'error') {
            consoleErrors.push({ url: page.url(), text: msg.text().slice(0, 200) });
        }
    });

    // Collect page crashes
    page.on('pageerror', err => {
        errors.push({ type: 'crash', url: page.url(), message: err.message.slice(0, 200) });
    });

    // Start with homepage
    const toVisit = [app.url];

    while (toVisit.length > 0 && visited.size < 50) {
        const url = toVisit.shift();
        const pathname = new URL(url).pathname;

        if (visited.has(pathname)) continue;
        visited.add(pathname);

        try {
            const resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: TIMEOUT });
            await page.waitForTimeout(2000);

            const status = resp?.status() || 0;

            // Check for error status
            if (status >= 400) {
                const errFile = `${app.id}-${pathname.replace(/\//g, '_')}-${status}.png`;
                await page.screenshot({ path: path.join(errDir, errFile), fullPage: false });
                errors.push({ type: 'http', url, status, screenshot: errFile });
                console.log(`    x ${pathname} -> ${status} (screenshot saved)`);
                continue;
            }

            // Check for error text in page
            const hasError = await page.evaluate(() => {
                const body = document.body?.innerText || '';
                return /unhandled|internal server error|application error|500|something went wrong/i.test(body);
            });

            if (hasError) {
                const errFile = `${app.id}-${pathname.replace(/\//g, '_')}-error.png`;
                await page.screenshot({ path: path.join(errDir, errFile), fullPage: false });
                errors.push({ type: 'page-error', url, screenshot: errFile });
                console.log(`    x ${pathname} -> page error text detected (screenshot saved)`);
            } else {
                console.log(`    ok ${pathname} -> ${status}`);
            }

            // Discover more links
            const links = await page.evaluate((baseUrl) => {
                const origin = new URL(baseUrl).origin;
                return [...new Set(
                    Array.from(document.querySelectorAll('a[href]'))
                        .map(a => a.href)
                        .filter(h => h.startsWith(origin) && !h.includes('#') && !h.includes('_next'))
                )];
            }, app.url);

            for (const link of links) {
                const lp = new URL(link).pathname;
                if (!visited.has(lp)) toVisit.push(link);
            }
        } catch (err) {
            const errFile = `${app.id}-${pathname.replace(/\//g, '_')}-timeout.png`;
            try { await page.screenshot({ path: path.join(errDir, errFile), fullPage: false }); } catch {}
            errors.push({ type: 'timeout', url, message: err.message.slice(0, 100), screenshot: errFile });
            console.log(`    x ${pathname} -> timeout/error`);
        }
    }

    await context.close();

    return {
        id: app.id,
        pagesVisited: visited.size,
        errors,
        consoleErrors: consoleErrors.slice(0, 20),
    };
}

async function main() {
    const targetId = process.argv[2];
    const apps = targetId ? APPS.filter(a => a.id === targetId) : APPS;

    console.log(`\nLink Crawler - ${apps.length} app(s)\n`);

    const browser = await chromium.launch();
    const results = [];

    for (const app of apps) {
        console.log(`  ${app.id} (${app.url})`);
        try {
            const result = await crawlApp(browser, app);
            results.push(result);
            const errCount = result.errors.length;
            console.log(`    ${result.pagesVisited} pages, ${errCount} error(s)\n`);
        } catch (err) {
            console.log(`    SKIP - ${err.message.slice(0, 60)}\n`);
            results.push({ id: app.id, pagesVisited: 0, errors: [{ type: 'fatal', message: err.message.slice(0, 200) }], consoleErrors: [] });
        }
    }

    await browser.close();

    // Summary
    const totalPages = results.reduce((s, r) => s + r.pagesVisited, 0);
    const totalErrors = results.reduce((s, r) => s + r.errors.length, 0);

    console.log(`Done: ${totalPages} pages crawled, ${totalErrors} error(s) found\n`);

    // Save JSON
    fs.writeFileSync('/tmp/link-crawler-summary.json', JSON.stringify({
        timestamp: new Date().toISOString(),
        totalPages,
        totalErrors,
        results,
    }, null, 2));

    // Post to stickies if errors found
    if (totalErrors > 0) {
        const errorReport = results
            .filter(r => r.errors.length > 0)
            .map(r => `${r.id}: ${r.errors.map(e => `${e.type} ${e.url || ''}`).join(', ')}`)
            .join('\n');

        try {
            const { execSync } = require('child_process');
            execSync(`source ~/.zshrc 2>/dev/null; echo "${errorReport.replace(/"/g, '\\"')}" | stickies --title="Link Crawler: ${totalErrors} errors" --tags=crawler,errors --path=/Reporting 2>/dev/null || true`, { shell: '/bin/zsh' });
        } catch {}
    }

    process.exit(totalErrors > 0 ? 1 : 0);
}

main().catch(err => { console.error(err.message); process.exit(1); });
