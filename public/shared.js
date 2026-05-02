// ─── Single source of truth: all app data from DB ───────────────────────
let FAVICONS = {};
let APP_LIST = [];
let APP_MAP = {};  // id → { id, name, icon, localUrl, ... }

const _sharedReady = Promise.all([
  fetch('/api/favicons').then(r => r.json()).then(m => { FAVICONS = m; }).catch(() => {}),
  fetch('/api/apps').then(r => r.json()).then(apps => {
    APP_LIST = apps;
    apps.forEach(a => { APP_MAP[a.id] = a; });
  }).catch(() => {}),
]);

// ─── Helpers: consistent name + icon everywhere ─────────────────────────
function getAppName(id) {
  return APP_MAP[id]?.name || id;
}

function getAppIcon(id) {
  return FAVICONS[id] || '';
}

function appIconHtml(id, size = 20) {
  const src = getAppIcon(id);
  if (!src) return '';
  return `<img src="${src}" width="${size}" height="${size}" style="border-radius:${Math.round(size/5)}px;object-fit:contain;flex-shrink:0" onerror="this.style.display='none'" alt="">`;
}

// ─── Sidebar nav counts ─────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  await _sharedReady;
  try {
    const [status, crons, screenshots] = await Promise.all([
      fetch('/api/status').then(r => r.json()).catch(() => ({ apps: [] })),
      fetch('/api/crons').then(r => r.json()).catch(() => []),
      fetch('/screenshots/index.json').then(r => r.json()).catch(() => []),
    ]);

    const apps = status.apps || [];
    const up = apps.filter(a => a.status === 'up').length;
    const cronList = Array.isArray(crons) ? crons : (crons.crons || []);
    const shotApps = Array.isArray(screenshots) ? screenshots.length : 0;

    const counts = {
      '/': `${up}/${apps.length}`,
      '/routines.html': String(cronList.length),
      '/gallery.html': String(shotApps),
      '/apps.html': String(apps.length),
      '/readmes.html': String(apps.length),
    };

    const style = 'margin-left:auto;font-size:10px;color:rgba(255,255,255,0.25);font-weight:500;';
    document.querySelectorAll('.sidebar-nav a').forEach(a => {
      const href = new URL(a.href, location.origin).pathname;
      const count = counts[href];
      if (count && !a.querySelector('.nav-count')) {
        const span = document.createElement('span');
        span.className = 'nav-count';
        span.setAttribute('style', style);
        span.textContent = count;
        a.appendChild(span);
      }
    });
  } catch {}
});
