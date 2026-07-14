#!/usr/bin/env node
/**
 * board-from-shots.js — turn a screenshot-crawler run folder into a visual map:
 *   • board.excalidraw  (all screens embedded + red "string" from hub to each)
 *   • crime-board.html  (interactive corkboard, modes: Hub / Ring / Web)
 *
 * Usage: node board-from-shots.js <run-folder>
 *   <run-folder> = a ~/Desktop/<app>.<ts>/ produced by screenshot-crawler.js
 * Generic: derives page labels from filenames, hub = first screenshot.
 */
const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

const RUN = process.argv[2];
if (!RUN || !fs.existsSync(RUN)) { console.error("usage: board-from-shots.js <run-folder>"); process.exit(1); }

const cfg = (() => { try { return JSON.parse(fs.readFileSync(path.join(RUN, ".crawler.json"), "utf8")); } catch { return {}; } })();
const baseUrl = cfg.url || "";
const appName = (baseUrl.replace(/^https?:\/\//, "").replace(/[:/].*$/, "") || "APP").toUpperCase();

const modeDir = ["desktop", "mobile"].map(m => path.join(RUN, m)).find(d => fs.existsSync(d));
if (!modeDir) { console.error("no desktop/mobile folder in run"); process.exit(1); }
const modeName = path.basename(modeDir);
const pngs = fs.readdirSync(modeDir).filter(f => /\.png$/i.test(f)).sort();
if (!pngs.length) { console.error("no pngs in " + modeDir); process.exit(1); }

const labelOf = f => f.replace(/^\d+[-_]/, "").replace(/\.png$/i, "").replace(/[-_]+/g, " ").trim().toUpperCase() || f;

// ── layout: hub at center, the rest evenly on a ring ────────────────────────
const N = pngs.length, RATIO = 9 / 16, W = 300, HUBW = 400;
const R = Math.max(440, Math.round((N * 330) / (2 * Math.PI)));
const cx = R + 540, cy = R + 380;
const nodes = pngs.map((f, i) => {
  if (i === 0) return { f, label: labelOf(f), x: Math.round(cx - HUBW / 2), y: Math.round(cy - HUBW * RATIO / 2), w: HUBW, h: Math.round(HUBW * RATIO), hub: true };
  const k = i - 1, ang = (k / (N - 1)) * Math.PI * 2 - Math.PI / 2;
  return { f, label: labelOf(f), x: Math.round(cx + R * Math.cos(ang) - W / 2), y: Math.round(cy + R * Math.sin(ang) - W * RATIO / 2), w: W, h: Math.round(W * RATIO) };
});
nodes.forEach(n => { n.cx = n.x + n.w / 2; n.cy = n.y + n.h / 2; });

// ── 1) board.excalidraw (embed resized images) ──────────────────────────────
const TMP = fs.mkdtempSync("/tmp/board-");
const elements = [], files = {};
const rnd = () => Math.floor(Math.random() * 2 ** 31);
const uid = p => p + "-" + Math.random().toString(36).slice(2, 10);

function embed(n) {
  const out = path.join(TMP, n.f);
  try { execSync(`sips --resampleWidth 760 ${JSON.stringify(path.join(modeDir, n.f))} --out ${JSON.stringify(out)}`, { stdio: "ignore" }); }
  catch { fs.copyFileSync(path.join(modeDir, n.f), out); }
  const fileId = uid("file");
  files[fileId] = { mimeType: "image/png", id: fileId, dataURL: "data:image/png;base64," + fs.readFileSync(out).toString("base64"), created: Date.now() };
  elements.push({ type: "image", id: uid("img"), x: n.x, y: n.y, width: n.w, height: n.h, angle: 0, strokeColor: "transparent",
    backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 2, strokeStyle: "solid", roughness: 0, opacity: 100, groupIds: [],
    frameId: null, roundness: null, seed: rnd(), version: 2, versionNonce: rnd(), isDeleted: false, boundElements: [], updated: Date.now(),
    link: null, locked: false, status: "saved", fileId, scale: [1, 1] });
  elements.push({ type: "text", id: uid("t"), x: n.x, y: n.y + n.h + 10, width: n.w, height: 28, angle: 0,
    strokeColor: n.hub ? "#e8590c" : "#f08c00", backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid",
    roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, seed: rnd(), version: 2, versionNonce: rnd(), isDeleted: false,
    boundElements: [], updated: Date.now(), link: null, locked: false, fontSize: n.hub ? 26 : 20, fontFamily: 1, text: n.label,
    textAlign: "center", verticalAlign: "top", containerId: null, originalText: n.label, lineHeight: 1.25, baseline: 18 });
}
function string(a, b, color, width) {
  const sag = 25 + Math.random() * 40;
  elements.push({ type: "line", id: uid("ln"), x: a.cx, y: a.cy, width: Math.abs(b.cx - a.cx), height: Math.abs(b.cy - a.cy), angle: 0,
    strokeColor: color, backgroundColor: "transparent", fillStyle: "solid", strokeWidth: width, strokeStyle: "solid", roughness: 1,
    opacity: 92, groupIds: [], frameId: null, roundness: { type: 2 }, seed: rnd(), version: 2, versionNonce: rnd(), isDeleted: false,
    boundElements: [], updated: Date.now(), link: null, locked: false,
    points: [[0, 0], [(b.cx - a.cx) / 2 + (Math.random() * 40 - 20), (b.cy - a.cy) / 2 + sag], [b.cx - a.cx, b.cy - a.cy]],
    lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: null });
}
nodes.forEach(embed);
nodes.slice(1).forEach(n => string(nodes[0], n, "#c11a25", 2.6));
elements.push({ type: "text", id: uid("title"), x: nodes[0].x - R + 40, y: 30, width: 800, height: 50, angle: 0, strokeColor: "#e03131",
  backgroundColor: "transparent", fillStyle: "solid", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [],
  frameId: null, roundness: null, seed: rnd(), version: 2, versionNonce: rnd(), isDeleted: false, boundElements: [], updated: Date.now(),
  link: null, locked: false, fontSize: 38, fontFamily: 1, text: appName + " — UI MAP", textAlign: "left", verticalAlign: "top",
  containerId: null, originalText: appName + " — UI MAP", lineHeight: 1.25, baseline: 32 });

const exPath = path.join(RUN, "board.excalidraw");
fs.writeFileSync(exPath, JSON.stringify({ type: "excalidraw", version: 2, source: "https://excalidraw.com", elements, appState: { viewBackgroundColor: "#1e1208", gridSize: null }, files }));

// ── 2) crime-board.html (interactive, modes Hub / Ring / Web) ────────────────
const htmlNodes = nodes.map(n => ({ file: modeName + "/" + n.f, label: n.label, x: n.x, y: n.y, w: n.w, hub: !!n.hub }));
const html = `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${appName} — UI MAP</title>
<link href="https://fonts.googleapis.com/css2?family=Special+Elite&family=Permanent+Marker&display=swap" rel="stylesheet">
<style>
*{box-sizing:border-box;margin:0;padding:0}html,body{background:#1a1410}body{font-family:'Special Elite',monospace;overflow:auto}
.board{position:relative;width:${2 * cx}px;height:${2 * cy}px;margin:28px auto;border-radius:6px;
 box-shadow:0 0 0 16px #3a2516,0 0 0 19px #20140b,0 30px 80px rgba(0,0,0,.7);background-color:#c69a5e;
 background-image:radial-gradient(circle at 20% 30%,rgba(0,0,0,.1) 0 2px,transparent 3px),radial-gradient(circle at 70% 60%,rgba(0,0,0,.08) 0 2px,transparent 3px),radial-gradient(ellipse at center,#cfa468,#b07f3f);background-size:90px 90px,120px 120px,100% 100%}
.board::after{content:"";position:absolute;inset:0;border-radius:6px;pointer-events:none;box-shadow:inset 0 0 160px rgba(0,0,0,.45)}
svg.yarn{position:absolute;inset:0;width:100%;height:100%;pointer-events:none;z-index:5}
.photo{position:absolute;z-index:10;padding:9px 9px 32px;background:linear-gradient(#fdfdf7,#efeadd);box-shadow:0 10px 22px rgba(0,0,0,.5);transition:transform .18s}
.photo:hover{transform:scale(1.6)!important;z-index:40}.photo img{width:100%;display:block;border:1px solid rgba(0,0,0,.25);background:#000}
.photo .cap{position:absolute;left:0;right:0;bottom:8px;text-align:center;font-size:14px;color:#2a2118;text-transform:uppercase}
.pin{position:absolute;top:-11px;left:50%;transform:translateX(-50%);width:22px;height:22px;border-radius:50%;z-index:20;background:radial-gradient(circle at 35% 30%,#ff8a8a,#d11a25 55%,#7c0d14);box-shadow:0 4px 6px rgba(0,0,0,.5),inset 0 -2px 3px rgba(0,0,0,.4),inset 0 2px 2px rgba(255,255,255,.5)}
.title{position:absolute;top:18px;left:34px;z-index:30;background:linear-gradient(#e9dcc0,#d8c69e);padding:14px 20px;box-shadow:0 8px 20px rgba(0,0,0,.5);transform:rotate(-1.2deg);border-left:6px solid #8a1118}
.title h1{font-size:24px;color:#241a10;letter-spacing:.04em}.title .s{font-size:11px;color:#5a4a33;margin-top:3px}
.modes{position:absolute;top:18px;left:50%;transform:translateX(-50%);z-index:35;display:flex;gap:8px}
.modes button{font-family:'Special Elite',monospace;font-size:13px;text-transform:uppercase;padding:9px 16px;cursor:pointer;color:#3a2c1a;border:1px solid #6b4f2e;background:linear-gradient(#e4d4b2,#cbb488);border-bottom:3px solid #6b4f2e;border-radius:4px 4px 2px 2px;box-shadow:0 4px 10px rgba(0,0,0,.35)}
.modes button.active{background:linear-gradient(#b51723,#8a0f18);color:#fbe9c8;border-color:#5a0a10}
</style></head><body><div class="board" id="board"><svg class="yarn" id="yarn"></svg>
<div class="title"><h1>${appName} — UI MAP</h1><div class="s">${N} screens · ${baseUrl}</div></div>
<div class="modes" id="modes"><button data-m="hub" class="active">Hub</button><button data-m="ring">Ring</button><button data-m="web">The Web</button></div>
<script>
const NODES=${JSON.stringify(htmlNodes)};
const board=document.getElementById("board"),yarn=document.getElementById("yarn");
NODES.forEach((n,i)=>{const el=document.createElement("div");el.className="photo";el.style.cssText="left:"+n.x+"px;top:"+n.y+"px;width:"+n.w+"px;transform:rotate("+((i*37)%7-3)+"deg)";el.innerHTML='<div class="pin"></div><img src="'+n.file+'"><div class="cap">'+n.label+'</div>';board.appendChild(el);n._el=el;});
function pc(n){const b=n._el.querySelector(".pin").getBoundingClientRect(),bb=board.getBoundingClientRect();return{x:b.left-bb.left+b.width/2,y:b.top-bb.top+b.height/2};}
function str(a,b,c,w){const A=pc(a),B=pc(b),sag=25+Math.random()*40,mx=(A.x+B.x)/2+(Math.random()*40-20),my=(A.y+B.y)/2+sag;const p=document.createElementNS("http://www.w3.org/2000/svg","path");p.setAttribute("d","M "+A.x+" "+A.y+" Q "+mx+" "+my+" "+B.x+" "+B.y);p.setAttribute("fill","none");p.setAttribute("stroke",c);p.setAttribute("stroke-width",w);p.setAttribute("stroke-linecap","round");p.setAttribute("opacity",".9");p.setAttribute("filter","drop-shadow(0 2px 2px rgba(0,0,0,.45))");yarn.appendChild(p);}
const EDGES={hub:()=>NODES.slice(1).map(n=>[NODES[0],n,"#c11a25",2.6]),
 ring:()=>{const e=[[NODES[0],NODES[1],"#c11a25",2.4]];for(let i=1;i<NODES.length;i++)e.push([NODES[i],NODES[i%(NODES.length-1)+1],"#e8631a",1.9]);return e;},
 web:()=>{const e=[];for(let i=0;i<NODES.length;i++)for(let j=i+1;j<NODES.length;j++)e.push([NODES[i],NODES[j],"rgba(181,23,35,.45)",1]);return e;}};
function render(m){yarn.innerHTML="";EDGES[m]().forEach(([a,b,c,w])=>str(a,b,c,w));}
document.getElementById("modes").addEventListener("click",e=>{const b=e.target.closest("button");if(!b)return;document.querySelectorAll(".modes button").forEach(x=>x.classList.remove("active"));b.classList.add("active");render(b.dataset.m);});
window.addEventListener("load",()=>setTimeout(()=>render("hub"),120));
window.addEventListener("resize",()=>render(document.querySelector(".modes .active").dataset.m));
</script></div></body></html>`;
const htmlPath = path.join(RUN, "crime-board.html");
fs.writeFileSync(htmlPath, html);

try { fs.rmSync(TMP, { recursive: true, force: true }); } catch {}
console.log("board.excalidraw -> " + exPath);
console.log("crime-board.html -> " + htmlPath);
console.log("screens: " + N + " | hub: " + nodes[0].label);
