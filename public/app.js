/* Local Apps dashboard - vanilla, served by the Express control plane (:9875).
   All data comes from the same-origin /api/* routes. No framework, no build. */
(function () {
  "use strict";

  // ---- helpers ----------------------------------------------------------
  var ESC = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) { return ESC[c]; }); }

  var AVATAR_COLORS = [
    ["#3b82f6", "#fff"], ["#8b5cf6", "#fff"], ["#ec4899", "#fff"], ["#f59e0b", "#000"],
    ["#10b981", "#fff"], ["#ef4444", "#fff"], ["#06b6d4", "#fff"], ["#f97316", "#fff"],
  ];
  function avatarColor(id) {
    var h = 0; id = id || "";
    for (var i = 0; i < id.length; i++) h = ((h << 5) - h + id.charCodeAt(i)) | 0;
    return AVATAR_COLORS[Math.abs(h) % AVATAR_COLORS.length];
  }

  var DEVICE_MAP = { "mac mini": "mac-mini", "macbook pro": "macbook-pro", "macbook air": "macbook-air" };
  function deviceIcon(model) {
    if (!model) return null;
    var lc = model.toLowerCase();
    for (var k in DEVICE_MAP) if (lc.indexOf(k) !== -1) return "/devices/" + DEVICE_MAP[k] + ".png";
    return null;
  }

  function detectAccessMode() {
    var host = location.hostname;
    if (host === "localhost" || host === "127.0.0.1") return { mode: "local", label: "localhost" };
    if (/\.localhost$/.test(host)) return { mode: "caddy", label: host };
    if (host.indexOf("10.") === 0 || host.indexOf("192.168.") === 0) return { mode: "lan", label: host };
    if (host.indexOf("100.") === 0) return { mode: "tailscale", label: host };
    return { mode: "remote", label: host };
  }

  // Honest phase-based startup progress from raw Next.js log lines.
  function detectStartupPhase(lines) {
    var text = (lines || []).join("\n");
    if (!text.trim()) return { phase: "wait", label: "Starting...", percent: 5 };
    var best = { phase: "wait", label: "Starting...", percent: 5 };
    function consider(s) { if (s.percent >= best.percent) best = s; }
    if (/▲\s*Next\.js|next dev/i.test(text)) consider({ phase: "boot", label: "Booting", percent: 20 });
    if (/-\s*Local:|^\s*Local:/im.test(text)) consider({ phase: "serve-start", label: "Server starting", percent: 45 });
    if (/Ready in|✓\s*Ready/i.test(text)) consider({ phase: "ready", label: "Server ready", percent: 70 });
    if (/○?\s*Compiling/i.test(text)) consider({ phase: "compile", label: "Compiling", percent: 85 });
    if (/✓\s*Compiled|\bGET\b.*\b200\b/i.test(text)) consider({ phase: "serving", label: "Serving", percent: 100 });
    if (/EADDRINUSE|address already in use|Cannot find module|Failed to compile|^\s*Error:/im.test(text))
      return { phase: "error", label: "Error - check log", percent: best.percent };
    return best;
  }

  function stripProto(u) { return String(u || "").replace(/^https?:\/\//, ""); }
  function getPort(url) { try { return new URL(url).port || null; } catch (e) { return null; } }

  var ROW_EMOJI = { Host: "\u{1F50C}", Local: "\u{1F310}", LAN: "\u{1F4E1}", Tailscale: "\u{1F517}", Caddy: "\u{1F3E0}", Prod: "\u{1F680}", GitHub: "\u{1F419}", Screenshots: "\u{1F4F8}" };
  var PROFILE_TABS = [
    { key: "info", label: "Info" }, { key: "screenshots", label: "Screenshots" }, { key: "about", label: "About" },
    { key: "architect", label: "Architect" }, { key: "security", label: "Security" },
    { key: "performance", label: "Performance" }, { key: "prompt", label: "Prompt" }, { key: "deploy", label: "Deploy" },
  ];
  // Compact icon per tab (Feather-style, drawn with currentColor). Label stays as the tooltip.
  var TAB_ICONS = {
    info: '<circle cx="12" cy="12" r="9"/><path d="M12 11.5v4.5"/><path d="M12 7.6h.01"/>',
    screenshots: '<path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="3.5"/>',
    about: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><path d="M14 2v6h6"/><path d="M8 13h8"/><path d="M8 17h6"/>',
    architect: '<path d="M12 2 2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5"/>',
    security: '<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>',
    performance: '<path d="M22 12h-4l-3 8L9 4l-3 8H2"/>',
    prompt: '<path d="M12 3l1.9 4.8L18.7 9l-4.8 1.9L12 15.6l-1.9-4.7L5.3 9l4.8-1.2z"/><path d="M18.5 15l.8 2 2 .8-2 .8-.8 2-.8-2-2-.8 2-.8z"/>',
    deploy: '<path d="M12 2s4.5 2.2 4.5 8.5c0 2.6-1.1 4.7-2.1 6.2H9.6c-1-1.5-2.1-3.6-2.1-6.2C7.5 4.2 12 2 12 2z"/><circle cx="12" cy="9" r="1.6"/><path d="M8.2 16l-2 4 3.2-1M15.8 16l2 4-3.2-1"/>',
  };

  var faviconCache = {};
  // Render an app icon. When a src exists, render the IMAGE ALONE (no colored
  // backdrop) so a transparent/rounded PNG cannot bleed the avatar color at its
  // edges; the letter-avatar is only used when there is no image (or it errors,
  // handled in render()). `off` = not up (down/disabled) -> grayscale + dim.
  function appIcon(id, name, icon, size, off) {
    var c = avatarColor(id), letter = esc((name || id || "?").charAt(0).toUpperCase());
    var r = Math.round(size / 5), src = icon || faviconCache[id];
    var cls = "appicon" + (off ? " off" : "");
    var box = 'data-id="' + esc(id) + '" data-name="' + esc(name || id) + '" style="width:' + size + "px;height:" + size + "px;border-radius:" + r + 'px';
    if (src) {
      return '<span class="' + cls + '" ' + box + '"><img src="' + esc(src) + '" alt="' + esc(name) + '" style="border-radius:' + r + 'px"></span>';
    }
    return '<span class="' + cls + '" ' + box + ";background:" + c[0] + ";color:" + c[1] + ";font-size:" + Math.round(size * 0.44) + 'px">' + letter + "</span>";
  }
  // Fallback used by render() when an icon <img> fails to load: turn its span
  // back into the letter avatar so a broken image never leaves an empty box.
  function fallbackAvatar(span) {
    var id = span.getAttribute("data-id") || "", nm = span.getAttribute("data-name") || id;
    var c = avatarColor(id), size = parseInt(span.style.width, 10) || 32;
    span.innerHTML = "";
    span.style.background = c[0]; span.style.color = c[1];
    span.style.fontSize = Math.round(size * 0.44) + "px";
    span.textContent = (nm || "?").charAt(0).toUpperCase();
  }

  // ---- state ------------------------------------------------------------
  var S = {
    apps: [], loading: true, error: false,
    machines: [], activeMachine: null, localInfo: {}, activeInfo: {}, machineOnline: {},
    profiles: {}, capabilities: {}, iconSync: {}, tabColors: {},
    startingApps: {}, startupState: {}, startTimes: {},
    modalApp: null, modalTab: "info", logLines: [], logLoading: false,
    screenshots: null, screenshotsLoading: false, capturing: false,
    qrData: null, qrOpen: false, helpOpen: false, lightboxSrc: null,
    portfolioPreview: null, portfolioLoading: false, portfolioPreviewLoading: false,
  };
  var startPolls = {}, toastTimer = null, sse = null;

  function api(path, opts) {
    return fetch(path, opts).then(function (r) {
      if (!r.ok) throw new Error(String(r.status));
      var ct = r.headers.get("content-type") || "";
      return ct.indexOf("application/json") !== -1 ? r.json() : r.text();
    });
  }
  function toast(msg, ms) {
    S.toast = msg; render();
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { S.toast = null; render(); }, ms || 2000);
  }
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast("Copied", 1500); }, function () { fallbackCopy(text); });
    } else fallbackCopy(text);
  }
  function fallbackCopy(text) {
    var ta = document.createElement("textarea");
    ta.value = text; ta.style.cssText = "position:fixed;opacity:0";
    document.body.appendChild(ta); ta.select();
    try { document.execCommand("copy"); } catch (e) {}
    document.body.removeChild(ta); toast("Copied", 1500);
  }

  // ---- data loading -----------------------------------------------------
  function loadFavicons() { return api("/api/favicons").then(function (m) { faviconCache = m || {}; }, function () { faviconCache = {}; }); }
  function loadMachines() { return api("/api/machines").then(function (d) { S.machines = d || []; }, function () { S.machines = []; }); }

  function load() {
    var m = S.activeMachine && S.machines.filter(function (x) { return x.id === S.activeMachine; })[0];
    if (S.activeMachine && !m) { S.activeMachine = null; return load(); }
    var p = m
      ? api("/api/machines/" + encodeURIComponent(m.id) + "/status").then(function (data) {
          S.apps = (data.apps || []).map(function (a) {
            return Object.assign({}, a, { lanUrl: a.localUrl ? a.localUrl.replace("localhost", m.ip) : null });
          });
          S.machineOnline[m.id] = true;
          S.activeInfo = { hostname: m.hostname || m.ip, model: m.model, ip: m.ip };
        })
      : api("/api/status").then(function (data) {
          S.apps = data.apps || [];
          var info = { hostname: (S.apps[0] && S.apps[0].hostname) || "", model: data.machineModel, ip: data.lanIp };
          S.localInfo = info; S.activeInfo = info;
        });
    return p.then(function () { S.loading = false; S.error = false; render(); },
      function () { if (S.activeMachine) S.machineOnline[S.activeMachine] = false; S.error = true; S.loading = false; render(); });
  }

  function connectSSE() {
    function connect() {
      var es = new EventSource("/api/events"); sse = es;
      es.onmessage = function (e) {
        var msg; try { msg = JSON.parse(e.data); } catch (x) { return; }
        if (msg.type === "update") {
          if (msg.status === "removed") { S.apps = S.apps.filter(function (a) { return a.id !== msg.id; }); }
          else {
            S.apps = S.apps.map(function (a) { return a.id === msg.id ? Object.assign({}, a, { status: msg.status }) : a; });
            if (S.modalApp && S.modalApp.id === msg.id) S.modalApp = Object.assign({}, S.modalApp, { status: msg.status });
            if (msg.status === "up") {
              S.startupState[msg.id] = { phase: "serving", label: "Ready", percent: 100 };
              if (startPolls[msg.id]) { clearInterval(startPolls[msg.id]); delete startPolls[msg.id]; }
              setTimeout(function () { delete S.startingApps[msg.id]; delete S.startTimes[msg.id]; render(); }, 700);
            }
          }
          render();
        }
        if (msg.type === "reload") load();
        if (msg.type === "screenshots_done" && S.modalApp && S.modalApp.id === msg.id) loadScreenshots(msg.id);
      };
      es.onerror = function () { es.close(); setTimeout(connect, 3000); };
    }
    connect();
  }

  function loadLog(id) {
    S.logLoading = true; render();
    api("/api/log/" + id).then(function (d) { S.logLines = d.lines || []; S.logLoading = false; render(); scrollLog(); },
      function () { S.logLines = ["(could not read log)"]; S.logLoading = false; render(); });
  }
  function scrollLog() { setTimeout(function () { var el = document.getElementById("logBody"); if (el) el.scrollTop = el.scrollHeight; }, 50); }

  function loadScreenshots(id) {
    S.screenshotsLoading = true; render();
    Promise.all([api("/api/screenshots/" + id), api("/api/screenshots-status").catch(function () { return {}; })])
      .then(function (r) { S.screenshots = r[0]; S.capturing = !!r[1][id]; S.screenshotsLoading = false; render(); },
        function () { S.screenshots = null; S.screenshotsLoading = false; render(); });
  }

  // ---- actions ----------------------------------------------------------
  function openModal(id) {
    var app = S.apps.filter(function (a) { return a.id === id; })[0]; if (!app) return;
    S.modalApp = app; S.modalTab = "info"; S.logLines = [];
    render();
    if (app.status === "down" && app.logPath) loadLog(id);
    if (!S.activeMachine) loadScreenshots(id);
  }
  function closeModal() { S.modalApp = null; render(); }

  function startApp(id) {
    S.startingApps[id] = true; S.logLines = []; S.logLoading = true; S.startTimes[id] = Date.now();
    S.startupState[id] = { phase: "wait", label: "Starting...", percent: 5 }; render();
    api("/api/start/" + id, { method: "POST" }).then(function () {
      var poll = setInterval(function () {
        api("/api/log/" + id).then(function (d) {
          var lines = d.lines || []; S.logLines = lines; S.logLoading = false;
          var phase = detectStartupPhase(lines);
          var elapsed = Date.now() - (S.startTimes[id] || Date.now());
          phase.stalled = elapsed > 30000 && phase.phase !== "serving" && phase.phase !== "error";
          S.startupState[id] = phase; render(); scrollLog();
        }).catch(function () {});
      }, 2000);
      startPolls[id] = poll;
      setTimeout(function () { clearInterval(poll); delete startPolls[id]; delete S.startingApps[id]; delete S.startTimes[id]; render(); }, 60000);
    }, function () { delete S.startingApps[id]; S.logLoading = false; render(); });
  }
  function stopApp(id) {
    api("/api/stop/" + id, { method: "POST" }).then(function () {
      S.apps = S.apps.map(function (a) { return a.id === id ? Object.assign({}, a, { status: "down" }) : a; });
      if (S.modalApp && S.modalApp.id === id) S.modalApp = Object.assign({}, S.modalApp, { status: "down" });
      toast("Stopped"); render();
    }).catch(function () {});
  }
  function toggleApp(id, name) {
    api("/api/apps/" + id + "/toggle", { method: "POST" }).then(function (d) {
      S.apps = S.apps.map(function (a) { return a.id === id ? Object.assign({}, a, { disabled: d.disabled }) : a; });
      if (S.modalApp && S.modalApp.id === id) S.modalApp = Object.assign({}, S.modalApp, { disabled: d.disabled });
      toast(d.disabled ? name + " disabled" : name + " enabled"); render();
    }).catch(function () {});
  }
  function deleteApp(id, name) {
    if (!confirm('Delete "' + name + '" and all its data? This removes:\n- Database entry\n- LaunchAgent\n- Caddy proxy\n- Screenshots\n- Kills running process\n\nThis cannot be undone.')) return;
    api("/api/apps/" + id, { method: "DELETE" }).then(function () {
      S.apps = S.apps.filter(function (a) { return a.id !== id; }); S.modalApp = null; toast(name + " deleted", 3000); render();
    }, function () { toast("Delete failed", 3000); });
  }
  function capture(id) {
    S.capturing = true; render();
    api("/api/screenshots/" + id, { method: "POST" }).then(function () {
      var poll = setInterval(function () {
        api("/api/screenshots-status").then(function (s) {
          if (!s[id]) { clearInterval(poll); S.capturing = false; toast("Screenshots captured", 3000); loadScreenshots(id); }
        }).catch(function () {});
      }, 3000);
    }, function () { S.capturing = false; toast("Capture failed", 3000); });
  }
  function addToPortfolio(id) {
    S.portfolioPreviewLoading = true; render();
    api("/api/portfolio/preview?appId=" + encodeURIComponent(id)).then(function (d) { S.portfolioPreview = d; },
      function () { toast("Preview failed", 3000); }).then(function () { S.portfolioPreviewLoading = false; render(); });
  }
  function confirmPortfolio() {
    if (!S.portfolioPreview) return;
    S.portfolioLoading = true; render();
    api("/api/portfolio", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ appId: S.portfolioPreview.slug }) })
      .then(function (d) { toast("Added to portfolio (" + d.images + " images)", 3000); }, function () { toast("Portfolio failed", 3000); })
      .then(function () { S.portfolioLoading = false; S.portfolioPreview = null; render(); });
  }
  function toggleQR() {
    if (S.qrOpen) { S.qrOpen = false; render(); return; }
    var go = S.qrData ? Promise.resolve() : api("/api/qr").then(function (d) { S.qrData = d; });
    go.then(function () { S.qrOpen = true; render(); }, function () {});
  }
  function switchMachine(id) { S.activeMachine = id; try { localStorage.setItem("activeMachine", id || ""); } catch (e) {} S.loading = true; render(); load(); }

  // ---- render -----------------------------------------------------------
  function vercelSvg() { return '<svg width="14" height="14" viewBox="0 0 76 65" fill="white"><path d="M37.5274 0L75.0548 65H0L37.5274 0Z"/></svg>'; }
  function qrSvg() {
    return '<svg width="22" height="22" viewBox="0 0 22 22" fill="none">' +
      '<rect x="1" y="1" width="8" height="8" rx="1" stroke="white" stroke-width="1.5"/><rect x="3.5" y="3.5" width="3" height="3" fill="white"/>' +
      '<rect x="13" y="1" width="8" height="8" rx="1" stroke="white" stroke-width="1.5"/><rect x="15.5" y="3.5" width="3" height="3" fill="white"/>' +
      '<rect x="1" y="13" width="8" height="8" rx="1" stroke="white" stroke-width="1.5"/><rect x="3.5" y="15.5" width="3" height="3" fill="white"/>' +
      '<rect x="13" y="13" width="2.5" height="2.5" fill="white"/><rect x="16.5" y="13" width="2.5" height="2.5" fill="white"/>' +
      '<rect x="13" y="16.5" width="2.5" height="2.5" fill="white"/><rect x="16.5" y="16.5" width="2.5" height="2.5" fill="white"/></svg>';
  }
  function copySvg() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#aaa" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>'; }
  function camSvg() { return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z"/><circle cx="12" cy="13" r="4"/></svg>'; }

  function dotClass(app) { return app.disabled ? "disabled" : app.status === "up" ? "up" : "starting-up"; }

  function headerHTML(access) {
    var isTail = access.mode === "tailscale";
    var upCount = S.apps.filter(function (a) { return a.status === "up"; }).length;
    var downCount = S.apps.filter(function (a) { return a.status !== "up"; }).length;
    var shortHost = ((S.activeInfo.hostname || "").replace(".local", "")) || "Local";
    var hIcon = isTail ? "/devices/tailscale.svg" : deviceIcon(S.activeInfo.model);
    var h = '<header class="header"><div class="header-inner">';
    h += '<div class="header-left">';
    if (hIcon) h += '<img class="header-device-icon" src="' + esc(hIcon) + '" width="28" height="28" alt="" style="opacity:.85">';
    h += '<div><div class="header-title">' + esc(shortHost) + "</div>";
    if (S.activeInfo.ip) h += '<div class="header-ip">' + esc(S.activeInfo.ip) + "</div>";
    h += "</div></div>";
    h += '<div class="counters"><div class="counter up">' + upCount + "</div>";
    if (downCount > 0) h += '<div class="counter down">' + downCount + "</div>";
    h += "</div>";
    h += '<div class="header-right"><button class="icon-btn" data-act="help" title="Quick Reference">?</button>';
    h += '<div class="qr-wrap"><button class="qr-toggle' + (S.qrOpen ? " open" : "") + '" data-act="qr" title="Show LAN QR code">' + qrSvg() + "</button>";
    if (S.qrOpen && S.qrData) h += '<div class="qr-pop" data-keep="qr"><img src="' + esc(S.qrData.dataUrl) + '" alt="QR"><div class="url">' + esc(S.qrData.url) + "</div></div>";
    h += "</div></div></div></header>";
    return h;
  }

  function machineTabsHTML() {
    var h = '<div class="machine-tabs">';
    var li = deviceIcon(S.localInfo.model);
    h += '<button class="machine-tab' + (!S.activeMachine ? " active" : "") + '" data-act="machine" data-machine="">' +
      (li ? '<img src="' + esc(li) + '" width="14" height="14" alt="" style="opacity:.7">' : "") +
      esc(((S.localInfo.hostname || "").replace(".local", "")) || "Local") + "</button>";
    S.machines.forEach(function (m) {
      var mi = deviceIcon(m.model), mn = (m.hostname || m.ip).replace(".local", "");
      h += '<button class="machine-tab' + (S.activeMachine === m.id ? " active" : "") + '" data-act="machine" data-machine="' + esc(m.id) + '">' +
        (mi ? '<img src="' + esc(mi) + '" width="14" height="14" alt="" style="opacity:.7">' : "") + esc(mn) + "</button>";
    });
    return h + "</div>";
  }

  function tableHTML(access) {
    var isTail = access.mode === "tailscale", lanish = access.mode === "lan" || access.mode === "remote";
    var apps = S.apps.slice().sort(function (a, b) {
      if (!!a.disabled !== !!b.disabled) return a.disabled ? 1 : -1;
      var o = { up: 0, starting: 1, unknown: 2, down: 3 };
      return (o[a.status] == null ? 2 : o[a.status]) - (o[b.status] == null ? 2 : o[b.status]);
    });
    var h = '<main class="apps"><table class="apps-table"><thead><tr>' +
      '<th class="col-app">App</th><th class="col-hostname">Hostname</th><th class="col-lan">LAN</th><th class="col-actions">Actions</th>' +
      "</tr></thead><tbody>";
    if (S.loading) h += '<tr><td class="empty" colspan="4">Loading...</td></tr>';
    else if (S.error) h += '<tr><td class="empty" colspan="4">' + (S.activeMachine ? "Machine unreachable - retrying..." : "Monitor unreachable - retrying...") + "</td></tr>";
    else if (!apps.length) h += '<tr><td class="empty" colspan="4">No apps</td></tr>';
    else apps.forEach(function (app) {
      var best = isTail ? (app.tailscaleUrl || app.lanUrl || "#") : lanish ? (app.lanUrl || "#") : (app.localUrl || "#");
      var hostU = lanish ? (app.lanUrl || app.localUrl || "#") : (app.caddyUrl || app.localUrl || "#");
      var lanU = isTail ? (app.tailscaleUrl || "#") : (app.lanUrl || app.localUrl || "#");
      h += '<tr data-act="open" data-id="' + esc(app.id) + '" tabindex="0">';
      h += '<td class="col-app"><div class="app-cell"><span class="dot ' + dotClass(app) + '"></span>' +
        appIcon(app.id, app.name, app.icon, 32, app.disabled || app.status !== "up") +
        '<div class="app-meta"><a class="app-name' + (app.disabled ? " disabled" : "") + '" href="' + esc(best) + '" target="_blank" rel="noopener" data-stop>' + esc(app.name) + "</a>";
      if (S.startingApps[app.id]) {
        var s = S.startupState[app.id] || { phase: "wait", label: "Starting...", percent: 5 };
        var tone = s.phase === "error" ? "error" : s.stalled ? "stalled" : s.percent >= 100 ? "done" : "active";
        h += '<div class="startup-row"><span class="phase-chip ' + tone + '">' + (tone === "active" ? '<span class="spin-dot"></span>' : "") +
          esc(s.label + (s.stalled && s.phase !== "error" ? " · taking longer than usual" : "")) + "</span>" +
          '<span class="progress-bar ' + tone + '"><span class="progress-fill" style="width:' + s.percent + '%"></span></span></div>';
      }
      h += "</div></div></td>";
      h += '<td class="col-hostname"><a class="link-sm' + (app.disabled ? " disabled" : "") + '" href="' + esc(hostU) + '" target="_blank" rel="noopener" data-stop>' + esc(stripProto(hostU)) + "</a></td>";
      h += '<td class="col-lan"><a class="link-sm' + (app.disabled ? " disabled" : "") + '" href="' + esc(lanU) + '" target="_blank" rel="noopener" data-stop>' + esc(stripProto(lanU)) + "</a></td>";
      h += '<td class="col-actions"><div class="actions">';
      if (isTail) h += '<a class="action-icon' + (app.tailscaleUrl ? "" : " dim") + '" href="' + esc(app.tailscaleUrl || "#") + '" target="_blank" rel="noopener" data-stop title="Tailscale"><img src="/devices/tailscale.svg" width="16" height="16" alt="Tailscale" style="opacity:.85"></a>';
      h += '<a class="action-icon' + (app.prodUrl ? "" : " dim") + '" href="' + esc(app.prodUrl || "#") + '" target="_blank" rel="noopener" data-stop title="Vercel">' + vercelSvg() + "</a>";
      h += "</div></td></tr>";
    });
    return h + "</tbody></table></main>";
  }

  function panelHTML(tab, prof) {
    prof = prof || {};
    function prose(v, fb) { return "<p>" + esc(v || fb || "Not documented yet.") + "</p>"; }
    function bullets(items, dot, fb) {
      if (!items || !items.length) return prose(null, fb);
      return "<ul>" + items.map(function (s) { return '<li><span class="bullet" style="background:' + dot + '"></span>' + esc(s) + "</li>"; }).join("") + "</ul>";
    }
    if (tab === "about") return prose(prof.about, "No description yet.") + '<div style="margin-top:10px">' + bullets(prof.features, "#3b82f6", "") + "</div>";
    if (tab === "architect") return prose(prof.architect);
    if (tab === "deploy") return prose(prof.deploy);
    if (tab === "security") return bullets(prof.security, "#22c55e");
    if (tab === "performance") return bullets(prof.performance, "#eab308");
    if (tab === "prompt") {
      if (!prof.prompt) return prose(null, "No icon prompt saved for this app yet.");
      return '<div class="prompt-block"><button class="prompt-copy" data-act="copy" data-copy="' + esc(prof.prompt) + '">Copy</button>' +
        '<div class="prompt-text">' + esc(prof.prompt) + "</div></div>";
    }
    return "";
  }

  function infoRowsHTML(app) {
    var rows = [], port = getPort(app.localUrl), isDown = app.status === "down", isStarting = !!S.startingApps[app.id];
    if (port) {
      var host = app.caddyUrl ? stripProto(app.caddyUrl) : app.id + ".localhost";
      var extra = "";
      if (app.launchAgent) {
        extra = isDown
          ? '<button class="mini-btn start" data-act="start" data-id="' + esc(app.id) + '"' + (isStarting ? " disabled" : "") + '>' + (isStarting ? '<span class="spin-dot"></span> Starting' : "Start") + "</button>"
          : '<button class="mini-btn stop" data-act="stop" data-id="' + esc(app.id) + '">Stop</button>';
      }
      rows.push({ label: "Host", value: host, extra: extra });
    }
    if (app.localUrl) rows.push({ label: "Local", value: app.localUrl, url: app.localUrl });
    if (app.lanUrl) rows.push({ label: "LAN", value: app.lanUrl, url: app.lanUrl });
    if (app.tailscaleUrl) rows.push({ label: "Tailscale", value: app.tailscaleUrl, url: app.tailscaleUrl });
    if (app.prodUrl) rows.push({ label: "Prod", value: app.prodUrl.replace("https://", ""), url: app.prodUrl });
    if (app.repo) rows.push({ label: "GitHub", value: app.repo.replace("https://github.com/", ""), url: app.repo });

    var h = '<div class="info-rows">';
    rows.forEach(function (r) {
      var emoji = ROW_EMOJI[r.label] || "";
      h += '<div class="info-row"><span class="info-label">' + (emoji ? emoji + " " : "") + esc(r.label) + "</span>";
      h += '<span class="info-value">';
      if (r.url) h += '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" data-stop>' + esc(r.value) + "</a>";
      else h += "<span>" + esc(r.value) + (r.extra || "") + "</span>";
      h += "</span>";
      h += '<button class="copy-btn" data-act="copy" data-copy="' + esc(r.url || r.value) + '" title="Copy">' + copySvg() + "</button></div>";
    });
    h += "</div>";

    if (isStarting) {
      var s = S.startupState[app.id] || { phase: "wait", label: "Starting...", percent: 5 };
      var tone = s.phase === "error" ? "error" : s.stalled ? "stalled" : s.percent >= 100 ? "done" : "active";
      h += '<div style="margin-top:12px"><div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:6px">' +
        '<span class="phase-chip lg ' + tone + '">' + (tone === "active" ? '<span class="spin-dot"></span>' : "") + esc(s.label) + "</span>" +
        '<span style="font-size:11px;color:var(--muted)">' + s.percent + "%</span></div>";
      if (s.stalled && s.phase !== "error") h += '<div style="font-size:10px;color:var(--starting);margin-bottom:6px">Taking longer than usual - it may be stuck.</div>';
      h += '<span class="progress-bar lg ' + tone + '"><span class="progress-fill" style="width:' + s.percent + '%"></span></span></div>';
    }
    if ((app.status === "down" || isStarting) && app.logPath) {
      h += '<div class="log"><button class="log-copy" data-act="copy" data-copy="' + esc(S.logLines.join("\n")) + '">Copy</button>' +
        '<div class="log-body" id="logBody">' + esc(S.logLoading ? "Loading log..." : S.logLines.length ? S.logLines.join("\n") : "(no log output)") + "</div></div>";
    }
    return h;
  }

  function screenshotsTabHTML(app) {
    var ss = S.screenshots, has = ss && (ss.desktop && ss.desktop.length || ss.mobile && ss.mobile.length || ss.screenshots && ss.screenshots.length);
    var h = '<div style="margin-top:4px"><div class="shots-head"><span class="shots-title">Screenshots' +
      (ss && ss.screenshots && ss.screenshots.length ? " (" + ss.screenshots.length + ")" : "") +
      (ss && ss.capturedAt ? " · " + esc(new Date(ss.capturedAt).toLocaleString()) : "") + "</span>";
    h += '<div class="shots-actions">';
    h += '<button class="shot-btn portfolio" data-act="portfolio" data-id="' + esc(app.id) + '"' + (S.portfolioPreviewLoading || !has ? " disabled" : "") + '>' + (S.portfolioPreviewLoading ? "Loading..." : "Add to Portfolio") + "</button>";
    h += '<button class="shot-btn capture" data-act="capture" data-id="' + esc(app.id) + '"' + (S.capturing ? " disabled" : "") + '>' + (S.capturing ? "Running..." : "Capture") + "</button>";
    h += "</div></div>";
    if (S.screenshotsLoading) h += '<div style="color:var(--muted);font-size:11px;margin-top:10px;text-align:center;padding:20px 0">Loading screenshots...</div>';
    else if (ss && ss.screenshots && ss.screenshots.length) {
      h += '<div class="shots-grid">';
      ss.screenshots.forEach(function (file) {
        var src = "/screenshots/" + app.id + "/" + file;
        var label = file.replace(".png", "").replace(/^\d+-/, "").replace(/-/g, " ");
        h += '<div class="shot"><img src="' + esc(src) + '" alt="' + esc(label) + '" loading="lazy" data-act="lightbox" data-src="' + esc(src) + '"><div class="label">' + esc(label) + "</div></div>";
      });
      h += "</div>";
    } else h += '<div style="color:var(--muted);font-size:11px;margin-top:10px;text-align:center;padding:20px 0">No screenshots yet - click Capture to generate</div>';
    return h + "</div>";
  }

  function modalHTML() {
    var app = S.modalApp; if (!app) return "";
    var caps = S.capabilities[app.id] || {}, sync = S.iconSync[app.id];
    var badges = [
      { label: "MCP", active: !!caps.mcp, title: caps.mcp ? (caps.mcpName ? "MCP Server: " + caps.mcpName : "MCP configured") : "No MCP server", href: caps.mcp ? "http://claude.localhost/mcp" : null },
      { label: "API", active: !!caps.api, title: caps.api ? "API routes available" : "No API routes" },
      { label: "CLI", active: !!caps.cli, title: caps.cli ? (caps.cliBin ? "CLI: ~/.local/bin/" + caps.cliBin : "CLI available") : "No CLI" },
    ];
    if (sync) {
      var ok = sync.hasFavicon && sync.hasAppIcon && sync.synced;
      badges.push({ label: "ICON", active: ok, title: !sync.hasFavicon ? "No favicon in local-apps" : !sync.hasAppIcon ? "App repo has no icon file" : sync.synced ? "Icon synced with app repo" : "Icon out of sync with app repo" });
    }
    var h = '<div class="overlay" data-act="overlay-modal"><div class="modal">';
    h += '<button class="modal-close" data-act="close">✕</button>';
    h += '<div class="modal-head"><div class="modal-head-inner"><span class="dot ' + dotClass(app) + '"></span>' + appIcon(app.id, app.name, app.icon, 32, app.disabled || app.status !== "up") +
      '<span class="modal-title">' + esc(app.name) + "</span>";
    h += '<div class="badges">' + badges.map(function (b) {
      var span = '<span class="badge' + (b.active ? " active" : "") + '" title="' + esc(b.title) + '">' + b.label + "</span>";
      return b.href ? '<a class="badge-link" href="' + esc(b.href) + '" target="_blank" rel="noopener" data-stop>' + span + "</a>" : span;
    }).join("") + "</div>";
    if (app.hasScreenshots) h += '<span class="gallery-icon" title="Screenshots">' + camSvg() + "</span>";
    h += "</div>"; // close modal-head-inner
    // claude-tab chip (top-right): the app's _alias, its color, click-to-copy the full launch command
    var tc = S.tabColors[app.id];
    if (tc && tc.alias) {
      var cmd = tc.alias + " && cd ~/Sites/" + app.id + " && claude";
      var fav = app.icon || faviconCache[app.id];
      var chipLogo = fav
        ? '<img class="tab-chip-logo" src="' + esc(fav) + '" alt="">'
        : (tc.icon ? '<span class="tab-chip-icon">' + tc.icon + "</span>" : "");
      h += '<span class="tab-chip" data-act="copy" data-copy="' + esc(cmd) + '" title="' + esc(cmd) + '" style="background:' + esc(tc.color || "#333") + '">' +
        chipLogo + '<span class="tab-chip-alias">' + esc(tc.alias) + "</span></span>";
    }
    h += "</div>"; // close modal-head
    if (app.lastChecked) h += '<div class="modal-checked">' + esc(new Date(app.lastChecked).toLocaleString()) + "</div>";
    // toggle row: active-tab title on the left, ON/OFF label + switch grouped on the right
    var tabLabel = (PROFILE_TABS.filter(function (t) { return t.key === S.modalTab; })[0] || { label: "" }).label;
    h += '<div class="toggle-row"><span class="modal-tab-title">' + esc(tabLabel) + "</span>" +
      '<div class="toggle-group"><span class="toggle-label ' + (app.disabled ? "off" : "on") + '">' + (app.disabled ? "OFF" : "ON") + "</span>" +
      '<button class="toggle ' + (app.disabled ? "off" : "on") + '" data-act="toggle" data-id="' + esc(app.id) + '" data-name="' + esc(app.name) + '"><span class="toggle-knob" style="left:' + (app.disabled ? 2 : 18) + 'px"></span></button></div></div>';
    // tabs
    h += '<div class="tabs">' + PROFILE_TABS.map(function (t) {
      var active = S.modalTab === t.key;
      return '<button class="tab tab-icon' + (active ? " active" : "") + '" data-act="tab" data-tab="' + t.key + '" title="' + esc(t.label) + '" aria-label="' + esc(t.label) + '">' +
        '<svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (TAB_ICONS[t.key] || "") + "</svg></button>";
    }).join("") + "</div>";
    if (S.modalTab !== "info" && S.modalTab !== "screenshots") h += '<div class="panel">' + panelHTML(S.modalTab, S.profiles[app.id]) + "</div>";
    if (S.modalTab === "info") h += infoRowsHTML(app);
    if (S.modalTab === "screenshots" && !S.activeMachine) h += screenshotsTabHTML(app);
    if (S.modalTab === "screenshots") h += '<div class="danger-zone"><button class="danger-btn" data-act="delete" data-id="' + esc(app.id) + '" data-name="' + esc(app.name) + '">Delete App</button></div>';
    h += "</div></div>";
    return h;
  }

  var HELP_TEXT = "Register this app with the local-apps monitor.\nInclude ALL fields so the modal is fully populated.\n\nPOST http://local-apps.localhost/api/apps\nContent-Type: application/json\n\nRequired:\n- \"id\": app slug (lowercase, kebab-case)\n- \"name\": display name\n- \"localPath\": absolute path to project root\n\nInfrastructure (auto-generated if omitted):\n- \"localUrl\": defaults to next available port\n- \"healthUrl\": defaults to localUrl\n- \"repo\": GitHub URL\n- \"startCommand\": defaults to \"npm run dev\"\n- \"logPath\": defaults to /tmp/{id}.log\n- \"prodUrl\": production URL\n- \"noScreenshot\": skip screenshots (boolean)\n\nApp Profile (AI should generate these):\n- \"about\": one compelling sentence describing the app\n- \"features\": JSON array of 3-5 top features\n- \"architect\": paragraph on tech stack and architecture\n- \"deploy\": paragraph on how to deploy and run\n- \"security\": JSON array of 3-4 security measures\n- \"performance\": JSON array of 3-4 performance optimizations\n\nThe monitor will automatically:\n1. Assign a dedicated port if not provided\n2. Create a Caddy reverse proxy at http://{id}.localhost\n3. Create a macOS LaunchAgent plist\n4. Begin health-checking\n5. Show the app on the dashboard with its full profile";

  function helpHTML() {
    if (!S.helpOpen) return "";
    return '<div class="overlay" data-act="overlay-help"><div class="modal">' +
      '<button class="modal-close" data-act="help-close">✕</button>' +
      '<div class="help-head"><h2>AI Instruction</h2><button class="help-copy" data-act="copy" data-copy="' + esc(HELP_TEXT) + '">Copy</button></div>' +
      '<div class="help-block">' + esc(HELP_TEXT) + "</div></div></div>";
  }

  function portfolioHTML() {
    var p = S.portfolioPreview; if (!p) return "";
    var TAG_COLORS = { "Next.js": "#0070f3", "React": "#61dafb", "TypeScript": "#3178c6", "Tailwind": "#38bdf8", "Supabase": "#3ecf8e", "Node.js": "#68a063", "Express": "#ffffff", "SQLite": "#003b57", "Electron": "#9feaf9", "Vite": "#646cff", "Python": "#3776ab", "Rust": "#dea584" };
    var h = '<div class="overlay" style="background:rgba(0,0,0,.8);z-index:350" data-act="overlay-portfolio"><div class="modal" style="width:780px;padding:0">';
    h += '<div style="padding:20px 24px 16px;border-bottom:1px solid rgba(255,255,255,.08);display:flex;align-items:center;justify-content:space-between">' +
      '<div style="display:flex;align-items:center;gap:10px">' + (p.icon ? '<img src="' + esc(p.icon) + '" width="28" height="28" alt="" style="border-radius:6px">' : "") +
      '<span style="font-size:16px;font-weight:700;color:#fff">' + esc(p.title) + "</span>" +
      '<span style="font-size:10px;font-weight:600;padding:3px 8px;border-radius:4px;background:rgba(59,130,246,.15);color:rgba(59,130,246,.9);text-transform:capitalize">' + esc(p.type) + "</span></div>" +
      '<button class="modal-close" style="position:static" data-act="portfolio-cancel">✕</button></div>';
    h += '<div style="display:flex">';
    h += '<div style="flex:1 1 55%;padding:20px;border-right:1px solid rgba(255,255,255,.06)"><div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:10px">Screenshots (' + p.screenshots.length + ")</div>";
    if (p.screenshots.length) {
      h += '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:8px">';
      p.screenshots.forEach(function (s) {
        var label = s.name.replace(".png", "").replace(/^\d+-/, "").replace(/-/g, " ");
        h += '<div><img src="' + esc(s.path) + '" alt="' + esc(label) + '" loading="lazy" style="width:100%;aspect-ratio:' + (s.type === "mobile-framed" ? "9/16" : "16/9") + ';object-fit:cover;border-radius:6px;border:1px solid rgba(255,255,255,.08);background:#000">' +
          '<div style="font-size:8px;color:var(--muted);margin-top:3px;text-align:center;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + (s.type === "mobile-framed" ? "M" : "D") + " - " + esc(label) + "</div></div>";
      });
      h += "</div>";
    } else h += '<div style="color:var(--muted);font-size:11px;text-align:center;padding:30px 0">No framed screenshots</div>';
    h += "</div>";
    h += '<div style="flex:1 1 45%;padding:20px;display:flex;flex-direction:column;gap:14px">';
    h += '<div><div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:6px">Tags</div><div style="display:flex;flex-wrap:wrap;gap:4px">';
    if (p.tags.length) p.tags.forEach(function (tag) {
      var c = TAG_COLORS[tag] || "#a78bfa";
      h += '<span style="font-size:10px;font-weight:600;padding:2px 8px;border-radius:10px;background:' + c + '20;color:' + c + ';border:1px solid ' + c + '30">' + esc(tag) + "</span>";
    }); else h += '<span style="font-size:10px;color:var(--muted)">No tags detected</span>';
    h += "</div></div>";
    h += '<div><div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:6px">Description</div><div style="background:rgba(255,255,255,.03);border:1px solid rgba(255,255,255,.06);border-radius:6px;padding:10px 12px;font-size:11px;color:rgba(255,255,255,.7);line-height:1.5">' +
      p.description.map(function (line, i) { return '<div style="margin-bottom:' + (i === 0 ? 8 : 2) + 'px">' + (i === 0 ? esc(line) : "• " + esc(line)) + "</div>"; }).join("") + "</div></div>";
    if (p.url) h += '<div><div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:6px">Production URL</div><a href="' + esc(p.url) + '" target="_blank" rel="noopener" data-stop style="font-size:11px;color:var(--accent)">' + esc(p.url) + "</a></div>";
    h += '<div><div style="font-size:10px;font-weight:600;color:var(--muted);margin-bottom:6px">Slug</div><span style="font-size:11px;color:rgba(255,255,255,.5)">' + esc(p.slug) + "</span></div>";
    h += "</div></div>";
    h += '<div style="padding:16px 24px;border-top:1px solid rgba(255,255,255,.08);display:flex;justify-content:flex-end;gap:10px">' +
      '<button class="mini-btn" style="border:1px solid rgba(255,255,255,.15);color:var(--muted);font-size:12px;font-weight:600;padding:8px 20px;border-radius:6px;margin:0" data-act="portfolio-cancel">Cancel</button>' +
      '<button style="background:rgba(59,130,246,.9);border:none;color:#fff;font-size:12px;font-weight:600;padding:8px 20px;border-radius:6px;cursor:pointer' + (S.portfolioLoading ? ";opacity:.6" : "") + '" data-act="portfolio-confirm"' + (S.portfolioLoading ? " disabled" : "") + ">" + (S.portfolioLoading ? "Uploading..." : "Confirm & Post") + "</button></div>";
    return h + "</div></div>";
  }

  function lightboxHTML() {
    if (!S.lightboxSrc) return "";
    return '<div class="lightbox" data-act="lightbox-close"><img src="' + esc(S.lightboxSrc) + '" alt=""></div>';
  }
  function toastHTML() { return '<div class="toast' + (S.toast ? " show" : "") + '">' + esc(S.toast || "Copied") + "</div>"; }

  function render() {
    var access = detectAccessMode();
    var root = document.getElementById("root");
    root.innerHTML = headerHTML(access) + machineTabsHTML() + tableHTML(access) +
      modalHTML() + helpHTML() + portfolioHTML() + lightboxHTML() + toastHTML();
    fixIconImgs(root);
  }
  // A broken app-icon <img> turns its span back into the letter avatar.
  function fixIconImgs(root) {
    var imgs = root.querySelectorAll(".appicon img");
    for (var i = 0; i < imgs.length; i++) {
      (function (img) {
        img.onerror = function () { fallbackAvatar(img.parentNode); };
        if (img.complete && img.naturalWidth === 0) fallbackAvatar(img.parentNode);
      })(imgs[i]);
    }
  }

  // ---- Cmd-K command palette (mounted on <body>, outside render() so the input keeps focus) ----
  var cmdk = { open: false, q: "", i: 0, matches: [] };
  function cmdkFilter() {
    var q = cmdk.q.trim().toLowerCase();
    var apps = S.apps.slice();
    if (q) {
      apps = apps.filter(function (a) { return ((a.name || "") + " " + a.id).toLowerCase().indexOf(q) !== -1; })
        .sort(function (a, b) {
          var aS = ((a.name || "").toLowerCase().indexOf(q) === 0 || a.id.toLowerCase().indexOf(q) === 0);
          var bS = ((b.name || "").toLowerCase().indexOf(q) === 0 || b.id.toLowerCase().indexOf(q) === 0);
          if (aS !== bS) return aS ? -1 : 1;
          return (a.name || a.id).localeCompare(b.name || b.id);
        });
    } else {
      apps.sort(function (a, b) { return (a.name || a.id).localeCompare(b.name || b.id); });
    }
    cmdk.matches = apps.slice(0, 8);
    if (cmdk.i >= cmdk.matches.length) cmdk.i = Math.max(0, cmdk.matches.length - 1);
  }
  function cmdkResultsHTML() {
    if (!cmdk.matches.length) return '<div class="cmdk-empty">No apps match "' + esc(cmdk.q) + '"</div>';
    return cmdk.matches.map(function (a, idx) {
      var c = avatarColor(a.id), active = idx === cmdk.i;
      return '<div class="cmdk-item' + (active ? " active" : "") + '" data-cmdk-i="' + idx + '"' +
        (active ? ' style="background:' + c[0] + '26"' : "") + '>' +
        appIcon(a.id, a.name, a.icon, 40) +
        '<div class="cmdk-meta"><div class="cmdk-name">' + esc(a.name || a.id) + '</div><div class="cmdk-slug">/' + esc(a.id) + "</div></div>" +
        (active ? '<span class="cmdk-arrow">→</span>' : "") + "</div>";
    }).join("");
  }
  function renderCmdkResults() {
    var r = document.getElementById("cmdk-results");
    if (r) { r.innerHTML = cmdkResultsHTML(); fixIconImgs(r); }
  }
  function openCmdK() {
    if (cmdk.open) return;
    cmdk.open = true; cmdk.q = ""; cmdk.i = 0; cmdkFilter();
    var ov = document.createElement("div");
    ov.className = "cmdk-overlay"; ov.id = "cmdk-overlay";
    ov.innerHTML =
      '<div class="cmdk"><div class="cmdk-search">' +
      '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>' +
      '<input id="cmdk-input" class="cmdk-input" placeholder="Search apps..." autocomplete="off" spellcheck="false">' +
      '<span class="cmdk-esc">ESC</span></div>' +
      '<div class="cmdk-results" id="cmdk-results">' + cmdkResultsHTML() + "</div>" +
      '<div class="cmdk-footer"><span><kbd>↑</kbd><kbd>↓</kbd> navigate</span><span><kbd>↵</kbd> open</span><span><kbd>⌘</kbd><kbd>K</kbd> toggle</span></div></div>';
    document.body.appendChild(ov);
    fixIconImgs(ov);
    ov.addEventListener("click", function (e) {
      if (e.target === ov) return closeCmdK();
      var it = e.target.closest("[data-cmdk-i]");
      if (it) { cmdk.i = +it.getAttribute("data-cmdk-i"); cmdkOpenSelected(); }
    });
    var input = document.getElementById("cmdk-input");
    input.addEventListener("input", function () { cmdk.q = input.value; cmdk.i = 0; cmdkFilter(); renderCmdkResults(); });
    input.focus();
  }
  function closeCmdK() { cmdk.open = false; var ov = document.getElementById("cmdk-overlay"); if (ov) ov.remove(); }
  function cmdkOpenSelected() { var a = cmdk.matches[cmdk.i]; if (!a) return; closeCmdK(); openModal(a.id); }
  function cmdkMove(d) {
    if (!cmdk.matches.length) return;
    cmdk.i = (cmdk.i + d + cmdk.matches.length) % cmdk.matches.length;
    renderCmdkResults();
    var el = document.querySelector(".cmdk-item.active"); if (el) el.scrollIntoView({ block: "nearest" });
  }

  // ---- events -----------------------------------------------------------
  document.addEventListener("click", function (e) {
    var link = e.target.closest("[data-stop]");
    if (link) { e.stopPropagation(); return; } // real <a> links open normally
    var el = e.target.closest("[data-act]");
    if (!el) { if (S.qrOpen) { S.qrOpen = false; render(); } return; }
    var act = el.getAttribute("data-act"), id = el.getAttribute("data-id"), name = el.getAttribute("data-name");
    switch (act) {
      case "open": openModal(id); break;
      case "close": closeModal(); break;
      case "overlay-modal": if (e.target === el) closeModal(); break;
      case "tab": S.modalTab = el.getAttribute("data-tab"); render(); break;
      case "machine": switchMachine(el.getAttribute("data-machine") || null); break;
      case "start": startApp(id); break;
      case "stop": stopApp(id); break;
      case "toggle": toggleApp(id, name); break;
      case "delete": deleteApp(id, name); break;
      case "capture": capture(id); break;
      case "portfolio": addToPortfolio(id); break;
      case "portfolio-confirm": confirmPortfolio(); break;
      case "portfolio-cancel": case "overlay-portfolio": if (act === "portfolio-cancel" || e.target === el) { S.portfolioPreview = null; render(); } break;
      case "copy": copy(el.getAttribute("data-copy")); break;
      case "help": S.helpOpen = true; render(); break;
      case "help-close": case "overlay-help": if (act === "help-close" || e.target === el) { S.helpOpen = false; render(); } break;
      case "qr": e.stopPropagation(); toggleQR(); break;
      case "lightbox": e.stopPropagation(); S.lightboxSrc = el.getAttribute("data-src"); render(); break;
      case "lightbox-close": S.lightboxSrc = null; render(); break;
    }
  });
  document.addEventListener("keydown", function (e) {
    // Cmd/Ctrl-K toggles the command palette from anywhere.
    if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
      e.preventDefault(); cmdk.open ? closeCmdK() : openCmdK(); return;
    }
    if (cmdk.open) {
      if (e.key === "Escape") { e.preventDefault(); closeCmdK(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); cmdkMove(1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); cmdkMove(-1); }
      else if (e.key === "Enter") { e.preventDefault(); cmdkOpenSelected(); }
      return; // palette owns the keyboard while open
    }
    if (e.key === "Escape") {
      if (S.lightboxSrc) { S.lightboxSrc = null; render(); }
      else if (S.portfolioPreview) { S.portfolioPreview = null; render(); }
      else if (S.helpOpen) { S.helpOpen = false; render(); }
      else if (S.modalApp) closeModal();
    }
    if ((e.key === "Enter" || e.key === " ") && document.activeElement && document.activeElement.matches("tr[data-act=open]")) {
      e.preventDefault(); openModal(document.activeElement.getAttribute("data-id"));
    }
  });

  // ---- boot -------------------------------------------------------------
  try { var saved = localStorage.getItem("activeMachine"); if (saved) S.activeMachine = saved; } catch (e) {}
  var um = new URLSearchParams(location.search).get("machine"); if (um) S.activeMachine = um;

  render();
  Promise.all([loadFavicons(), loadMachines()]).then(function () {
    load();
    api("/api/app-profiles").then(function (p) { S.profiles = p || {}; render(); }).catch(function () {});
    api("/api/capabilities").then(function (c) { S.capabilities = c || {}; render(); }).catch(function () {});
    api("/api/icon-sync").then(function (s) { S.iconSync = s || {}; render(); }).catch(function () {});
    api("/api/tab-colors").then(function (t) { S.tabColors = t || {}; render(); }).catch(function () {});
  });
  setInterval(load, 15000);
  setInterval(loadMachines, 30000);
  setTimeout(connectSSE, 3000);
})();
