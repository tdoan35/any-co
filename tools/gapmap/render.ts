// Render the gap map as one self-contained HTML file (canvas, no external assets).
//   node --import tsx tools/gapmap/render.ts [--run runs/<market-analyst run>[=Label]]... (repeatable) [--out data/gapmap/map.html] [--regions 40]
// Dots: every mapped game (brighter = 50+ reviews). Rings: top indie-reachable regions by
// opportunity. Pins: a Market Analyst run's gaps (from its eval.json re-probe positions).
// Navigate: scroll/pinch to zoom, drag to pan, double-click to zoom in, + − 0 keys.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { GAPMAP_DIR } from "./embed.ts";
import { indieShare, loadMap } from "./query.ts";

const { values } = parseArgs({ options: { run: { type: "string", multiple: true }, out: { type: "string" }, regions: { type: "string", default: "40" } } });
const { map, games } = loadMap();
if (!map.games[0]?.xy) throw new Error("map.json has no layout; rebuild without --no-layout");

const r2 = (x: number) => Math.round(x * 100) / 100;
const X = map.games.map((g) => r2(g.xy![0]));
const Y = map.games.map((g) => r2(g.xy![1]));
const T = map.games.map((_, i) => (games[i].traction ? 1 : 0));
const V = map.games.map((_, i) => games[i].reviews);
const R = map.games.map((g) => g.region);
const N = map.games.map((_, i) => games[i].name);
const YR = map.games.map((_, i) => games[i].year ?? 0);

// Members of each region, for fly-to bounds (10th–90th percentile of member positions).
const members = new Map<number, number[]>();
map.games.forEach((g, i) => (members.get(g.region) ?? members.set(g.region, []).get(g.region)!).push(i));
const pct = (a: number[], p: number) => a[Math.min(a.length - 1, Math.floor(p * (a.length - 1)))];
const bounds = (id: number) => {
  const m = members.get(id) ?? [];
  const xs = m.map((i) => X[i]).sort((a, b) => a - b), ys = m.map((i) => Y[i]).sort((a, b) => a - b);
  return [pct(xs, 0.1), pct(ys, 0.1), pct(xs, 0.9), pct(ys, 0.9)];
};

// Top regions a small studio could reach (indie share >= 0.4), not AAA niches.
const top = map.regions
  .filter((r) => r.rank !== null && r.xy && indieShare(r.id) >= 0.4)
  .sort((a, b) => a.rank! - b.rank!)
  .slice(0, Number(values.regions))
  .map((r, i) => ({
    n: i + 1, id: r.id, rank: r.rank, xy: r.xy, score: r.window.opportunity, supply: r.window.supply,
    traction: r.window.traction, hit: r.window.hit_rate, after: r.after_window, indie: indieShare(r.id), size: r.size,
    tags: r.top_tags.slice(0, 5).map((t) => t.tag), examples: r.top_games.slice(0, 4).map((g) => g.name), box: bounds(r.id),
  }));

// Edges. Game → its nearest games (saved by build.ts). Region → its nearest regions.
const hasEdges = !!map.games[0]?.knn;
const KN = hasEdges ? map.games.flatMap((g) => g.knn!) : [];
const KS = hasEdges ? map.games.flatMap((g) => g.knn_sim!.map((s) => Math.round(s * 100))) : []; // similarity × 100
const indexOf = new Map(games.map((g, i) => [g.appid, i]));
const openIds = new Set(top.map((t) => t.id));
const regs = map.regions.filter((r) => r.xy).map((r) => ({
  id: r.id, xy: r.xy, rank: r.rank, open: openIds.has(r.id), score: r.window.opportunity ?? null, supply: r.window.supply,
  traction: r.window.traction, indie: indieShare(r.id), tags: r.top_tags.slice(0, 3).map((t) => t.tag),
  adj: (r.adjacent ?? []).map((a) => [a.id, a.sim]),
}));
for (const t of top as any[]) {
  const r = map.regions.find((x) => x.id === t.id)!;
  t.anchors = r.top_games.slice(0, 5).map((g) => indexOf.get(g.appid)).filter((i) => i !== undefined);
}
// Open-region network: pairs of open regions where either lists the other as a nearest region.
const openEdges: Array<[number, number, number]> = [];
const seen = new Set<string>();
for (const r of regs.filter((x) => x.open)) for (const [b, s] of r.adj as Array<[number, number]>) {
  if (!openIds.has(b)) continue;
  const key = [Math.min(r.id, b), Math.max(r.id, b)].join("-");
  if (!seen.has(key)) { seen.add(key); openEdges.push([r.id, b, s]); }
}

// Pins: one or more Market Analyst runs (--run dir, repeatable; "dir=Label" prefixes that run's pins, e.g. the studio/game).
let pins: any[] = [];
for (const spec of values.run ?? []) {
  const [dir, tag] = spec.split("=");
  if (!existsSync(path.join(dir, "eval.json"))) continue;
  const ev = JSON.parse(readFileSync(path.join(dir, "eval.json"), "utf8"));
  pins.push(...(ev.code_ranking ?? []).filter((g: any) => g.map?.xy).map((g: any) => ({ rank: g.rank, label: tag ? `${tag}: ${g.label}` : g.label, xy: g.map.xy })));
}

const data = { X, Y, T, V, R, N, YR, top, pins, KN, KS, EK: hasEdges ? map.games[0].knn!.length : 0, regs, openEdges, built: map.meta.built_at.slice(0, 10), window: map.meta.window, games: games.length };

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Steam Gap Map</title>
<style>
:root{
  --bg:#0b0d12;--panel:rgba(20,23,30,.86);--panel-solid:#14171e;--line:rgba(255,255,255,.08);
  --fg:#e8eaed;--muted:#8a919c;--dot:#4a5568;--hit:#6aa8ff;--ring:#f5c451;--pin:#ff6b6b;--sel:#7ee2b8;
  --shadow:0 8px 30px rgba(0,0,0,.35);--radius:12px;
}
@media (prefers-color-scheme: light){:root:not([data-theme="dark"]){
  --bg:#f6f7f9;--panel:rgba(255,255,255,.9);--panel-solid:#fff;--line:rgba(0,0,0,.08);
  --fg:#1d2128;--muted:#646b76;--dot:#b8c0cc;--hit:#2f6fe0;--ring:#b7791f;--pin:#d64545;--sel:#14966b;--shadow:0 8px 30px rgba(0,0,0,.10);
}}
:root[data-theme="dark"]{--bg:#0b0d12;--panel:rgba(20,23,30,.86);--panel-solid:#14171e;--line:rgba(255,255,255,.08);--fg:#e8eaed;--muted:#8a919c;--dot:#4a5568;--hit:#6aa8ff;--ring:#f5c451;--pin:#ff6b6b;--sel:#7ee2b8}
*{box-sizing:border-box}
html,body{margin:0;height:100%;overflow:hidden;background:var(--bg);color:var(--fg);font:13px/1.45 ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif}
canvas{position:fixed;inset:0;width:100vw;height:100vh;display:block;cursor:grab;touch-action:none}
canvas.dragging{cursor:grabbing}
.card{position:fixed;background:var(--panel);backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);border:1px solid var(--line);border-radius:var(--radius);box-shadow:var(--shadow)}
#head{top:16px;left:16px;padding:14px 16px;max-width:min(360px,calc(100vw - 32px))}
#head h1{font-size:15px;font-weight:650;margin:0 0 2px;letter-spacing:-.01em}
#head p{margin:0;color:var(--muted)}
.legend{display:flex;gap:14px;flex-wrap:wrap;margin-top:10px;color:var(--muted);font-size:12px}
.legend span{display:inline-flex;align-items:center;gap:6px}
.sw{width:9px;height:9px;border-radius:50%;display:inline-block}
.ring{width:10px;height:10px;border-radius:50%;border:2px solid var(--ring);display:inline-block}
#search{margin-top:12px;position:relative}
#search input{width:100%;padding:8px 10px;border-radius:8px;border:1px solid var(--line);background:var(--panel-solid);color:var(--fg);font:inherit;outline:none}
#search input:focus{border-color:var(--hit)}
#results{position:absolute;left:0;right:0;top:calc(100% + 4px);background:var(--panel-solid);border:1px solid var(--line);border-radius:8px;box-shadow:var(--shadow);overflow:hidden;display:none;z-index:5}
#results div{padding:7px 10px;cursor:pointer;display:flex;justify-content:space-between;gap:8px}
#results div:hover,#results div.on{background:var(--line)}
#results small{color:var(--muted);white-space:nowrap}
#side{top:16px;right:16px;bottom:16px;width:320px;display:flex;flex-direction:column;overflow:hidden}
#side header{padding:12px 14px;border-bottom:1px solid var(--line);display:flex;justify-content:space-between;align-items:center;gap:8px}
#side header b{font-size:13px}
#side header small{color:var(--muted)}
#list{overflow:auto;padding:6px}
.reg{padding:9px 10px;border-radius:8px;cursor:pointer;border:1px solid transparent}
.reg:hover{background:var(--line)}
.reg.on{border-color:var(--sel);background:var(--line)}
.reg .row{display:flex;justify-content:space-between;gap:8px;align-items:baseline}
.reg .t{font-weight:600}
.reg .k{color:var(--muted);font-size:12px}
.reg .ex{color:var(--muted);font-size:12px;margin-top:2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.badge{font-variant-numeric:tabular-nums;font-size:11px;padding:1px 6px;border-radius:999px;background:var(--line);color:var(--fg)}
.btn{all:unset;cursor:pointer;color:var(--muted);padding:4px 6px;border-radius:6px}
.btn:hover{color:var(--fg);background:var(--line)}
#zoom{left:16px;bottom:16px;display:flex;flex-direction:column;padding:4px}
#zoom button{all:unset;cursor:pointer;width:34px;height:34px;display:grid;place-items:center;font-size:18px;border-radius:8px;color:var(--fg)}
#zoom button:hover{background:var(--line)}
#zoom hr{border:0;border-top:1px solid var(--line);margin:2px 4px}
#tip{position:fixed;pointer-events:none;padding:9px 11px;max-width:300px;display:none;z-index:10;font-size:12px}
#tip b{font-size:13px}
#tip .k{color:var(--muted)}
#detail{display:none;padding:12px 14px;border-top:1px solid var(--line);font-size:12px}
#detail .grid{display:grid;grid-template-columns:auto 1fr;gap:3px 12px;margin-top:6px}
#detail .grid span:nth-child(odd){color:var(--muted)}
.toggle{display:flex;align-items:center;gap:7px;margin-top:10px;color:var(--muted);font-size:12px;cursor:pointer;user-select:none}
.toggle input{accent-color:var(--ring);margin:0}
#detail h4{margin:10px 0 4px;font-size:12px;color:var(--muted);font-weight:600}
#detail .link{cursor:pointer;display:flex;justify-content:space-between;gap:8px;padding:3px 0;border-radius:4px}
#detail .link:hover{color:var(--hit)}
#detail .link small{color:var(--muted);white-space:nowrap}
#hint{position:fixed;left:50%;bottom:16px;transform:translateX(-50%);padding:7px 12px;color:var(--muted);font-size:12px;white-space:nowrap}
#toggle{display:none}
@media (max-width:760px){
  #side{top:auto;left:16px;right:16px;bottom:16px;width:auto;height:42vh}
  #side.collapsed{height:46px}
  #toggle{display:inline-block}
  #zoom{bottom:calc(42vh + 28px)}
  #side.collapsed ~ #zoom{bottom:74px}
  #hint{display:none}
}
</style></head>
<body>
<canvas id="c" aria-label="Map of Steam games clustered by similarity"></canvas>

<div id="head" class="card">
  <h1>Steam Gap Map</h1>
  <p><span id="count"></span> Steam releases placed by similarity of tags and description.</p>
  <div class="legend">
    <span><i class="sw" style="background:var(--dot)"></i>game</span>
    <span><i class="sw" style="background:var(--hit)"></i>50+ reviews</span>
    <span><i class="ring"></i>open region</span>
    <span id="pinLegend" style="display:none"><i class="sw" style="background:var(--pin)"></i>analyst gap</span>
  </div>
  <label class="toggle"><input type="checkbox" id="links" checked> Show links between open regions</label>
  <div id="search"><input id="q" type="search" placeholder="Find a game…" autocomplete="off" aria-label="Find a game"><div id="results" role="listbox"></div></div>
</div>

<aside id="side" class="card">
  <header><div><b>Open regions</b><br><small>indie-reachable, by opportunity</small></div>
    <div><button class="btn" id="clear" title="Clear selection">Clear</button><button class="btn" id="toggle" aria-label="Toggle list">▾</button></div></header>
  <div id="list"></div>
  <div id="detail"></div>
</aside>

<div id="zoom" class="card">
  <button id="zin" title="Zoom in (+)" aria-label="Zoom in">+</button><hr>
  <button id="zout" title="Zoom out (−)" aria-label="Zoom out">−</button><hr>
  <button id="zreset" title="Reset view (0)" aria-label="Reset view">⤢</button>
</div>
<div id="hint" class="card">Scroll to zoom · drag to pan · click a game or region to see its links</div>
<div id="tip" class="card"></div>

<script>
const D=${JSON.stringify(data)};
const n=D.X.length, c=document.getElementById('c'), ctx=c.getContext('2d'), tip=document.getElementById('tip');
document.getElementById('count').textContent=n.toLocaleString();
if(D.pins.length) document.getElementById('pinLegend').style.display='';
const css=v=>getComputedStyle(document.documentElement).getPropertyValue(v).trim();
let C={};const readColors=()=>{C={dot:css('--dot'),hit:css('--hit'),ring:css('--ring'),pin:css('--pin'),sel:css('--sel'),fg:css('--fg'),bg:css('--bg'),muted:css('--muted')}};readColors();
matchMedia('(prefers-color-scheme: light)').addEventListener('change',()=>{readColors();draw()});

// Data extent and spatial grid for hover lookup.
let x0=Infinity,x1=-Infinity,y0=Infinity,y1=-Infinity;
for(let i=0;i<n;i++){if(D.X[i]<x0)x0=D.X[i];if(D.X[i]>x1)x1=D.X[i];if(D.Y[i]<y0)y0=D.Y[i];if(D.Y[i]>y1)y1=D.Y[i]}
const G=128,cell=new Map(),gk=(gx,gy)=>gx*4096+gy,gx=x=>Math.floor((x-x0)/(x1-x0+1e-9)*G),gy=y=>Math.floor((y-y0)/(y1-y0+1e-9)*G);
for(let i=0;i<n;i++){const k=gk(gx(D.X[i]),gy(D.Y[i]));(cell.get(k)||cell.set(k,[]).get(k)).push(i)}

// View: screen = (data - center) * scale + viewport center.
let W=0,H=0,dpr=1,cx=(x0+x1)/2,cy=(y0+y1)/2,scale=1,base=1;
function fit(){dpr=devicePixelRatio||1;W=innerWidth;H=innerHeight;c.width=W*dpr;c.height=H*dpr;ctx.setTransform(dpr,0,0,dpr,0,0);
  const side=W>760?352:0;base=Math.min((W-side-32)/(x1-x0),(H-32)/(y1-y0))*0.92;}
const sx=x=>(x-cx)*scale*base+W/2-(W>760?176:0), sy=y=>(y-cy)*scale*base+H/2;
const dx=X=>(X-W/2+(W>760?176:0))/(scale*base)+cx, dy=Y=>(Y-H/2)/(scale*base)+cy;
function reset(){cx=(x0+x1)/2;cy=(y0+y1)/2;scale=1;draw()}

let sel=null, hover=-1, pinned=-1, frame=0, showLinks=true;
document.getElementById('links').addEventListener('change',e=>{showLinks=e.target.checked;draw()});
function draw(){if(frame)return;frame=requestAnimationFrame(()=>{frame=0;render()})}
function render(){
  ctx.fillStyle=C.bg;ctx.fillRect(0,0,W,H);
  const s=Math.min(3.2,1.1+Math.log2(scale)*0.55), sh=s*1.35;
  const vx0=dx(-10),vx1=dx(W+10),vy0=dy(-10),vy1=dy(H+10);
  const inView=i=>D.X[i]>=vx0&&D.X[i]<=vx1&&D.Y[i]>=vy0&&D.Y[i]<=vy1;
  const pass=(filter,color,alpha,size)=>{ctx.fillStyle=color;ctx.globalAlpha=alpha;
    for(let i=0;i<n;i++){if(!filter(i)||!inView(i))continue;ctx.fillRect(sx(D.X[i])-size/2,sy(D.Y[i])-size/2,size,size)}};
  const dim=sel?0.25:1;
  pass(i=>!D.T[i],C.dot,0.45*dim,s);
  pass(i=>D.T[i],C.hit,0.75*dim,sh);
  if(sel){pass(i=>D.R[i]===sel.id&&!D.T[i],C.sel,0.55,s+0.6);pass(i=>D.R[i]===sel.id&&D.T[i],C.sel,0.95,sh+0.8)}
  ctx.globalAlpha=1;
  drawEdges();
  // Region rings; numbers once zoomed in.
  const labels=scale>=1.8;
  ctx.lineWidth=2;ctx.font='600 11px ui-sans-serif,system-ui,sans-serif';ctx.textAlign='center';ctx.textBaseline='middle';
  for(const r of D.top){const X=sx(r.xy[0]),Y=sy(r.xy[1]);if(X<-20||Y<-20||X>W+20||Y>H+20)continue;
    const on=sel&&sel.id===r.id, rad=labels?10:6.5;
    ctx.strokeStyle=on?C.sel:C.ring;ctx.beginPath();ctx.arc(X,Y,rad,0,7);ctx.stroke();
    if(labels){ctx.fillStyle=on?C.sel:C.ring;ctx.fillText(r.n,X,Y+0.5)}}
  for(const p of D.pins){const X=sx(p.xy[0]),Y=sy(p.xy[1]);ctx.fillStyle=C.pin;ctx.beginPath();ctx.arc(X,Y,5.5,0,7);ctx.fill();
    ctx.textAlign='left';ctx.fillText(p.rank+'. '+p.label,X+9,Y);ctx.textAlign='center'}
  if(hover>=0){ctx.strokeStyle=C.fg;ctx.lineWidth=1.5;ctx.beginPath();ctx.arc(sx(D.X[hover]),sy(D.Y[hover]),5,0,7);ctx.stroke()}
  if(pinned>=0){ctx.strokeStyle=C.sel;ctx.lineWidth=2;ctx.beginPath();ctx.arc(sx(D.X[pinned]),sy(D.Y[pinned]),6,0,7);ctx.stroke()}
}
const regById=new Map(D.regs.map(r=>[r.id,r]));
function line(ax,ay,bx,by,color,alpha,width,dash){ctx.strokeStyle=color;ctx.globalAlpha=alpha;ctx.lineWidth=width;ctx.setLineDash(dash||[]);ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.stroke();ctx.setLineDash([]);ctx.globalAlpha=1}
function label(text,X,Y,color){ctx.font='500 11px ui-sans-serif,system-ui,sans-serif';ctx.textAlign='left';ctx.textBaseline='middle';
  const w=ctx.measureText(text).width;ctx.globalAlpha=0.85;ctx.fillStyle=C.bg;ctx.fillRect(X+7,Y-8,w+8,16);ctx.globalAlpha=1;ctx.fillStyle=color;ctx.fillText(text,X+11,Y)}
function gameEdges(g,withLabels){if(!D.EK||g<0)return;const X=sx(D.X[g]),Y=sy(D.Y[g]);
  for(let j=0;j<D.EK;j++){const o=D.KN[g*D.EK+j];line(X,Y,sx(D.X[o]),sy(D.Y[o]),withLabels?C.sel:C.fg,withLabels?0.8:0.45,withLabels?1.6:1)}
  if(withLabels)for(let j=0;j<D.EK;j++){const o=D.KN[g*D.EK+j];label(D.N[o]+' · '+(D.KS[g*D.EK+j]/100).toFixed(2),sx(D.X[o]),sy(D.Y[o]),C.fg)}}
function drawEdges(){
  if(showLinks)for(const [a,b] of D.openEdges){const A=regById.get(a),B=regById.get(b);if(A&&B)line(sx(A.xy[0]),sy(A.xy[1]),sx(B.xy[0]),sy(B.xy[1]),C.ring,0.35,1.2)}
  if(sel){const A=regById.get(sel.id),X=sx(A.xy[0]),Y=sy(A.xy[1]);
    // spokes to the region's best-known games
    for(const g of sel.anchors||[]){line(X,Y,sx(D.X[g]),sy(D.Y[g]),C.sel,0.7,1.2);label(D.N[g],sx(D.X[g]),sy(D.Y[g]),C.fg)}
    // adjacent regions, open or not
    for(const [b,s] of A.adj){const B=regById.get(b);if(!B)continue;const bx=sx(B.xy[0]),by=sy(B.xy[1]);
      line(X,Y,bx,by,C.ring,0.8,1.5,[5,4]);
      if(!B.open){ctx.fillStyle=C.muted||C.fg;ctx.globalAlpha=0.9;ctx.fillRect(bx-4,by-4,8,8);ctx.globalAlpha=1}
      label((B.open?'#'+D.top.find(t=>t.id===b).n+' ':'')+B.tags.slice(0,2).join(' · ')+(B.score!=null?' · opp '+B.score.toFixed(2):'')+' · '+Math.round(B.traction*100)+'%',bx,by,C.fg)}}
  if(pinned>=0)gameEdges(pinned,true);else if(hover>=0)gameEdges(hover,false);
}

// Zoom about a screen point, with optional smooth animation.
function zoomAt(f,X,Y){const ax=dx(X),ay=dy(Y);scale=Math.max(0.6,Math.min(400,scale*f));cx=ax-(X-W/2+(W>760?176:0))/(scale*base);cy=ay-(Y-H/2)/(scale*base);draw()}
function flyTo(tx,ty,ts){const s0=scale,x0_=cx,y0_=cy,t0=performance.now(),dur=550;
  const step=t=>{const k=Math.min(1,(t-t0)/dur),e=k<.5?2*k*k:1-Math.pow(-2*k+2,2)/2;
    scale=Math.exp(Math.log(s0)+(Math.log(ts)-Math.log(s0))*e);cx=x0_+(tx-x0_)*e;cy=y0_+(ty-y0_)*e;render();if(k<1)requestAnimationFrame(step)};
  requestAnimationFrame(step)}
function flyToBox(b){const w=Math.max(b[2]-b[0],(x1-x0)*0.02),h=Math.max(b[3]-b[1],(y1-y0)*0.02);
  const side=W>760?352:0, ts=Math.min(60,Math.min((W-side-80)/(w*base),(H-120)/(h*base))*0.7);flyTo((b[0]+b[2])/2,(b[1]+b[3])/2,Math.max(1.5,ts))}

c.addEventListener('wheel',e=>{e.preventDefault();zoomAt(Math.exp(-e.deltaY*(e.ctrlKey?0.01:0.0018)),e.clientX,e.clientY)},{passive:false});
let drag=null,moved=false;const pointers=new Map();
c.addEventListener('pointerdown',e=>{c.setPointerCapture(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
  if(pointers.size===1){drag={x:e.clientX,y:e.clientY,cx,cy};moved=false;c.classList.add('dragging')}});
c.addEventListener('pointermove',e=>{
  if(pointers.has(e.pointerId)){const prev=pointers.get(e.pointerId);pointers.set(e.pointerId,{x:e.clientX,y:e.clientY});
    if(pointers.size===2){const [a,b]=[...pointers.values()];const pa=[...pointers.entries()].find(([k])=>k!==e.pointerId)[1];
      const d0=Math.hypot(prev.x-pa.x,prev.y-pa.y),d1=Math.hypot(a.x-b.x,a.y-b.y);if(d0>0)zoomAt(d1/d0,(a.x+b.x)/2,(a.y+b.y)/2);moved=true;return}
    if(drag){const mx=e.clientX-drag.x,my=e.clientY-drag.y;if(Math.abs(mx)+Math.abs(my)>3)moved=true;cx=drag.cx-mx/(scale*base);cy=drag.cy-my/(scale*base);draw();hideTip();return}}
  hoverAt(e.clientX,e.clientY)});
const end=e=>{pointers.delete(e.pointerId);if(!pointers.size){drag=null;c.classList.remove('dragging')}};
c.addEventListener('pointerup',e=>{const wasClick=!moved&&pointers.size===1;end(e);if(wasClick)clickAt(e.clientX,e.clientY)});
c.addEventListener('pointercancel',end);c.addEventListener('pointerleave',()=>{hover=-1;hideTip();draw()});
c.addEventListener('dblclick',e=>zoomAt(2,e.clientX,e.clientY));
addEventListener('keydown',e=>{if(e.target.tagName==='INPUT')return;if(e.key==='+'||e.key==='=')zoomAt(1.5,W/2,H/2);else if(e.key==='-')zoomAt(1/1.5,W/2,H/2);else if(e.key==='0')reset();else if(e.key==='Escape'){select(null);pinGame(-1)}});
document.getElementById('zin').onclick=()=>zoomAt(1.6,W/2-(W>760?176:0),H/2);
document.getElementById('zout').onclick=()=>zoomAt(1/1.6,W/2-(W>760?176:0),H/2);
document.getElementById('zreset').onclick=reset;

function nearestGame(X,Y,maxPx){const ax=dx(X),ay=dy(Y),r=Math.ceil(maxPx/(scale*base)/((x1-x0)/G))+1,cgx=gx(ax),cgy=gy(ay);let best=-1,bd=maxPx*maxPx;
  for(let i=-r;i<=r;i++)for(let j=-r;j<=r;j++){const a=cell.get(gk(cgx+i,cgy+j));if(!a)continue;for(const k of a){const d=(sx(D.X[k])-X)**2+(sy(D.Y[k])-Y)**2;if(d<bd){bd=d;best=k}}}return best}
function nearestRegion(X,Y){let best=null,bd=14*14;for(const r of D.top){const d=(sx(r.xy[0])-X)**2+(sy(r.xy[1])-Y)**2;if(d<bd){bd=d;best=r}}return best}
const esc=s=>String(s).replace(/[&<>"]/g,ch=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[ch]));
const pct=v=>Math.round(v*100)+'%';
function showTip(html,X,Y){tip.innerHTML=html;tip.style.display='block';const w=tip.offsetWidth,h=tip.offsetHeight;
  tip.style.left=Math.min(X+14,W-w-8)+'px';tip.style.top=Math.min(Y+14,H-h-8)+'px'}
function hideTip(){tip.style.display='none'}
function hoverAt(X,Y){const r=nearestRegion(X,Y);
  if(r){hover=-1;showTip('<b>'+r.n+'. '+esc(r.tags.slice(0,3).join(' · '))+'</b><br><span class="k">opportunity</span> '+r.score+' · '+r.supply+' releases · '+pct(r.traction)+' traction<br><span class="k">'+esc(r.examples.slice(0,3).join(', '))+'</span>',X,Y);draw();return}
  const g=nearestGame(X,Y,8);if(g!==hover){hover=g;draw()}
  if(g>=0)showTip('<b>'+esc(D.N[g])+'</b><br><span class="k">'+(D.YR[g]||'?')+' · '+D.V[g].toLocaleString()+' reviews · region '+D.R[g]+'</span>',X,Y);else hideTip()}
function clickAt(X,Y){const r=nearestRegion(X,Y);if(r){select(r,true);return}const g=nearestGame(X,Y,8);if(g>=0)pinGame(g);else{pinGame(-1)}}
function regionName(id){const r=regById.get(id);if(!r)return 'region '+id;const t=D.top.find(t=>t.id===id);return (t?'#'+t.n+' ':'')+r.tags.join(' · ')}
function pinGame(g){pinned=g;if(g<0){if(!sel)detail.style.display='none';draw();return}
  sel=null;for(const el of list.children)el.classList.remove('on');
  const t=D.top.find(t=>t.id===D.R[g]);
  let h='<b>'+esc(D.N[g])+'</b><div class="grid"><span>released</span><span>'+(D.YR[g]||'?')+'</span><span>reviews</span><span>'+D.V[g].toLocaleString()+'</span>'+
    '<span>region</span><span>'+esc(regionName(D.R[g]))+(t?' (open)':'')+'</span></div>';
  if(D.EK){h+='<h4>Most similar games</h4>';for(let j=0;j<D.EK;j++){const o=D.KN[g*D.EK+j];h+='<div class="link" data-g="'+o+'"><span>'+esc(D.N[o])+'</span><small>'+(D.KS[g*D.EK+j]/100).toFixed(2)+'</small></div>'}}
  if(t)h+='<h4>Its region</h4><div class="link" data-r="'+t.id+'"><span>'+esc(regionName(t.id))+'</span><small>open region →</small></div>';
  detail.innerHTML=h;detail.style.display='block';draw()}


// Region list + detail.
const list=document.getElementById('list'),detail=document.getElementById('detail');
detail.addEventListener('click',e=>{const el=e.target.closest('.link');if(!el)return;
  if(el.dataset.g){const g=+el.dataset.g;pinGame(g);flyTo(D.X[g],D.Y[g],Math.max(scale,25))}
  else if(el.dataset.r)select(D.top.find(t=>t.id===+el.dataset.r),true);
  else if(el.dataset.adj){const b=+el.dataset.adj,ot=D.top.find(t=>t.id===b);if(ot)select(ot,true);else{const B=regById.get(b);flyTo(B.xy[0],B.xy[1],Math.max(scale,6))}}});
list.innerHTML=D.top.map(r=>'<div class="reg" data-id="'+r.id+'" tabindex="0"><div class="row"><span class="t">'+r.n+'. '+esc(r.tags.slice(0,3).join(' · '))+'</span><span class="badge">'+r.score.toFixed(2)+'</span></div>'+
  '<div class="k">'+r.supply+' releases · '+pct(r.traction)+' traction · '+pct(r.indie)+' indie</div><div class="ex">'+esc(r.examples.join(', '))+'</div></div>').join('');
list.addEventListener('click',e=>{const el=e.target.closest('.reg');if(el)select(D.top.find(r=>r.id===+el.dataset.id),true)});
list.addEventListener('keydown',e=>{if(e.key==='Enter'){const el=e.target.closest('.reg');if(el)select(D.top.find(r=>r.id===+el.dataset.id),true)}});
function select(r,fly){sel=r;pinned=-1;for(const el of list.children)el.classList.toggle('on',!!r&&+el.dataset.id===r.id);
  if(!r){detail.style.display='none';draw();return}
  detail.style.display='block';
  detail.innerHTML='<b>'+r.n+'. '+esc(r.tags.join(' · '))+'</b><div class="grid">'+
    '<span>opportunity</span><span>'+r.score+' (rank '+r.rank+' of all regions)</span>'+
    '<span>in window</span><span>'+r.supply+' releases, '+pct(r.traction)+' got 50+ reviews, '+pct(r.hit)+' got 500+</span>'+
    '<span>since window</span><span>'+r.after+' new releases</span>'+
    '<span>size</span><span>'+r.size.toLocaleString()+' games, '+pct(r.indie)+' indie</span>'+
    '<span>examples</span><span>'+esc(r.examples.join(', '))+'</span></div>'+
    '<h4>Adjacent regions</h4>'+regById.get(r.id).adj.map(([b,s])=>{const B=regById.get(b);if(!B)return '';const ot=D.top.find(t=>t.id===b);
      return '<div class="link" data-adj="'+b+'"><span>'+esc((ot?'#'+ot.n+' ':'')+B.tags.join(' · '))+'</span><small>'+(B.score!=null?'opp '+B.score.toFixed(2)+' · ':'')+Math.round(B.traction*100)+'% · sim '+s.toFixed(2)+'</small></div>'}).join('');
  const el=[...list.children].find(x=>+x.dataset.id===r.id);if(el)el.scrollIntoView({block:'nearest'});
  if(fly)flyToBox(r.box);else draw()}
document.getElementById('clear').onclick=()=>{select(null);pinGame(-1)};
const side=document.getElementById('side');document.getElementById('toggle').onclick=()=>side.classList.toggle('collapsed');

// Search.
const q=document.getElementById('q'),res=document.getElementById('results');let hits=[],on=0;
const lower=D.N.map(s=>s.toLowerCase());
q.addEventListener('input',()=>{const s=q.value.trim().toLowerCase();if(s.length<2){res.style.display='none';return}
  hits=[];for(let i=0;i<n&&hits.length<200;i++)if(lower[i].includes(s))hits.push(i);
  hits.sort((a,b)=>(lower[a].startsWith(s)?0:1)-(lower[b].startsWith(s)?0:1)||D.V[b]-D.V[a]);hits=hits.slice(0,8);on=0;renderHits()});
function renderHits(){if(!hits.length){res.style.display='none';return}res.style.display='block';
  res.innerHTML=hits.map((i,k)=>'<div class="'+(k===on?'on':'')+'" data-i="'+i+'"><span>'+esc(D.N[i])+'</span><small>'+D.V[i].toLocaleString()+' reviews</small></div>').join('')}
res.addEventListener('mousedown',e=>{const el=e.target.closest('div[data-i]');if(el)goGame(+el.dataset.i)});
q.addEventListener('keydown',e=>{if(e.key==='ArrowDown'){on=Math.min(hits.length-1,on+1);renderHits();e.preventDefault()}else if(e.key==='ArrowUp'){on=Math.max(0,on-1);renderHits();e.preventDefault()}else if(e.key==='Enter'&&hits.length)goGame(hits[on]);else if(e.key==='Escape'){res.style.display='none';q.blur()}});
q.addEventListener('blur',()=>setTimeout(()=>res.style.display='none',150));
function goGame(i){res.style.display='none';q.value=D.N[i];pinGame(i);flyTo(D.X[i],D.Y[i],Math.max(scale,25));
  setTimeout(()=>showTip('<b>'+esc(D.N[i])+'</b><br><span class="k">'+(D.YR[i]||'?')+' · '+D.V[i].toLocaleString()+' reviews · region '+D.R[i]+'</span>',sx(D.X[i]),sy(D.Y[i])),600)}

addEventListener('resize',()=>{fit();draw()});fit();render();
setTimeout(()=>{const h=document.getElementById('hint');h.style.transition='opacity .6s';h.style.opacity='0'},6000);
</script></body></html>`;

const out = values.out ?? path.join(GAPMAP_DIR, "map.html");
writeFileSync(out, html);
console.log(`wrote ${out} (${(html.length / 1e6).toFixed(1)} MB, ${top.length} regions, ${openEdges.length} open-region links, ${hasEdges ? "game edges" : "no game edges (rebuild map)"}, ${pins.length} gaps)`);
