// Generates the Chrome Web Store images from real tool output:
//   BROWSER_BIN=<Chrome for Testing binary> node scripts/store-assets.mjs
// 1. Drives store/demo (a fictional shop with planted bugs) through the MCP tools.
// 2. Builds 1280x800 compositions around the real captures and outputs.
// 3. Renders them with the same tools into store/images/.

import { spawn, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const storeDir = join(root, 'store');
const build = join(storeDir, 'build');
const images = join(storeDir, 'images');
mkdirSync(join(build, 'art'), { recursive: true });
mkdirSync(images, { recursive: true });
const BIN = process.env.BROWSER_BIN;
if (!BIN || !existsSync(BIN)) { console.error('Set BROWSER_BIN to Chrome for Testing'); process.exit(2); }

const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png', '.json': 'application/json' };
const http = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(storeDir, p.endsWith('/') ? p + 'index.html' : p);
  if (!file.startsWith(storeDir) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => http.listen(18931, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:18931';

const profile = mkdtempSync(join(tmpdir(), 'pw-assets-'));
const browser = spawn(BIN, [`--user-data-dir=${profile}`, `--load-extension=${join(root, 'extension')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
const client = new Client({ name: 'store-assets', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/index.js')], env: { ...process.env, BROWSER_MCP_CONNECT_TIMEOUT: '60000' }, stderr: 'inherit' }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
};
const json = async (name, args) => JSON.parse(await call(name, args));
function parseCsv(text) {
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"' && text[i + 1] === '"') { cell += '"'; i++; }
      else if (c === '"') q = false;
      else cell += c;
    } else if (c === '"') q = true;
    else if (c === ',') { row.push(cell); cell = ''; }
    else if (c === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
    else if (c !== '\r') cell += c;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows;
}
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

try {
  // ------------------------------------------------------------ captures
  await call('browser_navigate', { url: `${BASE}/demo/index.html` });
  await call('browser_set_viewport', { width: 1280, height: 800, deviceScaleFactor: 2, mobile: false });
  await call('browser_screenshot', { scale: 'device', savePath: join(build, 'demo-desktop.png') });
  const snap = await call('browser_snapshot', { interactiveOnly: false });
  const inspect = await json('browser_inspect', { selector: '.promo' });

  await call('browser_set_viewport', { preset: 'mobile' });
  const mobile = await json('browser_set_viewport', { preset: 'mobile' });
  const audit = await json('browser_audit_layout', { maxPerType: 3 });
  await call('browser_screenshot', { scale: 'device', savePath: join(build, 'demo-mobile-before.png') });
  await call('browser_inject_css', { css: '.promo { width: auto; }' });
  const auditAfter = await json('browser_audit_layout', { maxPerType: 3 });
  await call('browser_screenshot', { scale: 'device', savePath: join(build, 'demo-mobile-after.png') });
  await call('browser_inject_css', { remove: true });

  await call('browser_set_viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const scrapeArgs = {
    url: `${BASE}/demo/index.html`, itemSelector: '.card',
    fields: { name: 'h2', price: { selector: '.price', type: 'number' }, details: '.desc' },
    nextSelector: '.pager a.next', maxPages: 5, delayMs: 400, savePath: join(build, 'products.csv'),
  };
  const scrapeOut = await call('browser_scrape', scrapeArgs);
  const products = parseCsv(readFileSync(join(build, 'products.csv'), 'utf8')).slice(1);
  // Real output of the self-test command (joins the running hub as a second agent).
  const checkOut = spawnSync(process.execPath, [join(root, 'server/index.js'), 'check'], { encoding: 'utf8', timeout: 90000 }).stdout
    .split('\n').filter((l) => l.trim() && !/^\s{4}/.test(l)).join('\n');
  writeFileSync(join(build, 'outputs.json'), JSON.stringify({ snap, inspect, mobile, audit, auditAfter, scrapeOut, checkOut }, null, 2));

  // -------------------------------------------------------- compositions
  const css = `
  * { box-sizing: border-box; margin: 0; }
  body { width: 1280px; height: 800px; overflow: hidden; font: 16px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #eef0ff;
         background: radial-gradient(1200px 700px at 85% 10%, #5b3fd6 0%, transparent 60%), linear-gradient(135deg, #14123a 0%, #231d63 55%, #3b1f7a 100%); }
  .wrap { display: grid; grid-template-columns: 400px 1fr; gap: 40px; padding: 56px 56px; height: 100%; }
  .eyebrow { display: flex; align-items: center; gap: 10px; font-weight: 700; letter-spacing: .12em; font-size: 13px; color: #b9b3ff; text-transform: uppercase; }
  .eyebrow img { width: 28px; height: 28px; }
  h1 { font-size: 44px; line-height: 1.08; letter-spacing: -.02em; margin: 22px 0 16px; color: #fff; }
  .lede { color: #c9c6ec; font-size: 18px; }
  ul.points { list-style: none; padding: 0; margin-top: 26px; display: grid; gap: 12px; }
  ul.points li { padding-left: 28px; position: relative; color: #e4e2fb; }
  ul.points li::before { content: ""; position: absolute; left: 0; top: 6px; width: 14px; height: 14px; border-radius: 4px; background: #8b7bff; }
  .browser { background: #fff; border-radius: 14px; overflow: hidden; box-shadow: 0 30px 80px rgba(0,0,0,.45); }
  .bar { height: 38px; background: #eceef3; display: flex; align-items: center; gap: 7px; padding: 0 14px; }
  .bar i { width: 11px; height: 11px; border-radius: 50%; background: #d4d6dd; display: block; }
  .bar .url { margin-left: 14px; flex: 1; height: 24px; border-radius: 12px; background: #fff; color: #5d6170; font-size: 12px; display: flex; align-items: center; padding: 0 12px; }
  .browser img.shot { display: block; width: 100%; }
  .panel { background: rgba(10, 9, 30, .82); border: 1px solid rgba(255,255,255,.12); border-radius: 14px; padding: 16px 18px; box-shadow: 0 20px 60px rgba(0,0,0,.4); backdrop-filter: blur(6px); }
  .panel h3 { font-size: 12px; letter-spacing: .1em; text-transform: uppercase; color: #a9a4e8; margin-bottom: 10px; }
  pre, code { font: 12.5px/1.55 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; color: #dfe3ff; }
  .k { color: #9d8cff; } .s { color: #7ee0b5; } .n { color: #ffcf7a; } .m { color: #8f93b8; } .bad { color: #ff8f9c; } .ok { color: #7ee0b5; }
  .phone { width: 214px; border-radius: 30px; padding: 9px; background: #0b0b14; box-shadow: 0 25px 60px rgba(0,0,0,.5); }
  .phone img { display: block; width: 100%; border-radius: 22px; }
  .tag { display: inline-block; font-size: 12px; font-weight: 700; padding: 3px 10px; border-radius: 999px; margin-bottom: 10px; }
  .tag.bad { background: #ffe1e5; color: #b4213a; } .tag.ok { background: #d8f7e9; color: #146c46; }
  table { border-collapse: collapse; width: 100%; font-size: 13px; }
  th, td { text-align: left; padding: 6px 10px; border-bottom: 1px solid rgba(255,255,255,.08); }
  th { color: #a9a4e8; font-weight: 600; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
  td.num { font-variant-numeric: tabular-nums; color: #ffcf7a; }
  `;
  const shell = (title, left, right, leftWidth = 400) => `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${css}</style></head><body>
    <div class="wrap" style="grid-template-columns:${leftWidth}px 1fr"><div>${left}</div><div style="position:relative; min-width:0">${right}</div></div></body></html>`;
  const lead = (h, p, pts) => `<div class="eyebrow"><img src="/icon.png" alt="">Pagewright</div><h1>${h}</h1><p class="lede">${p}</p><ul class="points">${pts.map((x) => `<li>${x}</li>`).join('')}</ul>`;
  writeFileSync(join(storeDir, 'icon.png'), readFileSync(join(root, 'extension/icons/icon128.png')));

  // 1. Hero
  const snapLines = snap.split('\n').filter((l) => /heading|button "Add"|link "Next|price|text: \$/.test(l)).slice(0, 9).map((l) => l.replace(/^\s{0,4}/, ''));
  const hero = shell('hero', lead('Let your AI agent use your real browser', 'Any AI app that supports MCP can read, click, type and take screenshots in the browser you are already logged into.', [
    'Works with any MCP-compatible AI app', 'Your sessions and cookies, no extra login', 'Runs locally: nothing leaves your machine except to your own agent']),
    `<div class="browser" style="width:760px"><div class="bar"><i></i><i></i><i></i><div class="url">127.0.0.1 · Loom &amp; Leaf demo shop</div></div><img class="shot" src="/build/demo-desktop.png" alt=""></div>
     <div class="panel" style="position:absolute; left:-30px; bottom:10px; width:560px">
       <h3>Agent → browser_snapshot</h3>
       <pre>${snapLines.map((l) => esc(l).replace(/"([^"]*)"/g, '<span class="s">"$1"</span>').replace(/\[ref=(e\d+)\]/g, '<span class="k">[ref=$1]</span>')).join('\n')}</pre>
     </div>`);

  // 2. Layout bugs
  const top = audit.issues.filter((i) => ['overflow-x-culprit', 'horizontal-scroll', 'low-contrast', 'distorted-image'].includes(i.type)).slice(0, 4);
  const rule = (inspect.cssRules || []).find((r) => r.selector === '.promo');
  const layout = shell('layout', lead('Find and fix layout bugs', 'Audits the page for overflow, clipped or covered elements, contrast and image problems — then shows the exact CSS rule to change.', [
    'Test mobile, tablet and desktop sizes', 'Box model, computed styles and CSS file:line', 'Try a fix live, verify, then edit your code']),
    `<div style="display:flex; gap:18px; align-items:flex-start">
       <div><span class="tag bad">Before · ${esc(mobile.warning ? `zoomed out to ${Math.round(mobile.actual.zoom * 100)}%` : 'mobile')}</span><div class="phone"><img src="/build/demo-mobile-before.png" alt=""></div></div>
       <div><span class="tag ok">After · ${auditAfter.issues.some((i) => i.type === 'horizontal-scroll') ? 'still overflowing' : 'fits the screen'}</span><div class="phone"><img src="/build/demo-mobile-after.png" alt=""></div></div>
       <div style="display:grid; gap:14px; width:322px">
         <div class="panel"><h3>browser_audit_layout</h3><pre>${top.map((i) => `<span class="${i.severity === 'high' ? 'bad' : 'n'}">${i.severity}</span> ${esc(i.type)}\n<span class="m">${esc(i.detail.length > 84 ? i.detail.slice(0, 83) + '…' : i.detail)}</span>`).join('\n')}</pre></div>
         <div class="panel"><h3>browser_inspect .promo</h3><pre><span class="m">${esc(rule ? rule.source : '')}</span>\n<span class="k">${esc(rule ? rule.selector : '')}</span> {\n${(rule ? rule.declarations : []).map((d) => '  ' + esc(d).replace('width: 1200px', '<span class="bad">width: 1200px</span>')).join('\n')}\n}</pre></div>
       </div>
     </div>`, 340);

  // 3. Scraping
  const scrapeCall = JSON.stringify({ itemSelector: '.card', fields: scrapeArgs.fields, nextSelector: scrapeArgs.nextSelector, maxPages: 5, savePath: 'products.csv' }, null, 2);
  const scraping = shell('scraping', lead('Scrape pages into CSV or JSON', 'Describe the data once; Pagewright follows pagination or infinite scroll and saves clean records.', [
    'Markdown, links, tables and metadata from any page', 'Read the JSON APIs a page calls', 'Works on JavaScript-heavy and logged-in sites']),
    `<div style="display:grid; grid-template-columns: 330px 1fr; gap:22px">
       <div class="panel"><h3>browser_scrape</h3><pre>${esc(scrapeCall).replace(/"([^"]+)":/g, '<span class="k">"$1"</span>:').replace(/: "([^"]*)"/g, ': <span class="s">"$1"</span>').replace(/: (\d+)/g, ': <span class="n">$1</span>')}</pre></div>
       <div class="panel"><h3>products.csv · ${esc(scrapeOut.split('\n')[0])}</h3>
         <table><tr><th>name</th><th>price</th><th>details</th></tr>${products.map((p) => `<tr><td>${esc(p[0])}</td><td class="num">${esc(p[1])}</td><td class="m">${esc(p[2])}</td></tr>`).join('')}</table>
         <pre class="m" style="margin-top:12px">${esc(scrapeOut.split('\n').slice(1, 3).join('\n'))}</pre></div>
     </div>`);

  // 4. Setup / multi-agent
  const setup = shell('setup', lead('Connected in a minute', 'Install the small local server with one command. The extension finds it automatically.', [
    'Several agents can share one browser', 'Only local connections are accepted', 'Release any tab from the popup at any time']),
    `<div style="display:grid; gap:22px; width:720px">
       <div class="panel"><h3>Terminal</h3><pre><span class="m">$</span> npx -y github:zamansheikh/browser-mcp check
${esc(checkOut).replace(/… (ok|connected)/g, '… <span class="ok">$1</span>').replace(/(200)/, '<span class="n">$1</span>')}</pre></div>
       <div style="display:flex; gap:22px; align-items:flex-start">
         <div style="width:320px; background:#fff; color:#111827; border-radius:12px; padding:14px; font-size:13px; box-shadow:0 25px 60px rgba(0,0,0,.45)">
           <div style="display:flex; gap:8px; align-items:center; margin-bottom:12px"><img src="/icon.png" width="20" height="20" alt=""><b style="font-size:15px">Pagewright</b></div>
           <div style="display:flex; gap:10px"><span style="width:10px;height:10px;border-radius:50%;background:#16a34a;margin-top:4px"></span><div><b>Connected to MCP server</b><div style="color:#6b7280;font-size:12px">ws://127.0.0.1:18800</div></div></div>
           <div style="border-top:1px solid #e5e7eb; margin-top:12px; padding-top:10px; color:#6b7280; font-size:12px; text-transform:uppercase; letter-spacing:.04em">Controlled tabs</div>
           <div style="display:flex; justify-content:space-between; align-items:center; margin-top:6px"><span>Home goods · Loom &amp; Leaf</span><span style="border:1px solid #e5e7eb; border-radius:6px; padding:2px 8px; font-size:12px">Release</span></div>
         </div>
         <div class="panel" style="flex:1"><h3>Private by design</h3><pre>Local connection only (127.0.0.1)
Websites cannot connect
No analytics or tracking
Open source, MIT licensed</pre></div>
       </div>
     </div>`);

  const tile = (w, h, big) => `<!doctype html><html><head><meta charset="utf-8"><style>${css}
    body { width:${w}px; height:${h}px; display:flex; align-items:center; ${big ? 'justify-content:space-between; padding:0 70px' : 'justify-content:center; text-align:center'}; }
    </style></head><body>
    <div style="${big ? 'max-width:560px' : ''}">
      <img src="/icon.png" width="${big ? 72 : 56}" height="${big ? 72 : 56}" alt="" style="${big ? '' : 'display:block;margin:0 auto 12px'}">
      <div style="font-weight:800; font-size:${big ? 54 : 34}px; letter-spacing:-.02em; margin-top:${big ? 18 : 0}px; color:#fff">Pagewright</div>
      <div style="font-size:${big ? 22 : 15}px; color:#c9c6ec; margin-top:6px">AI browser control for MCP agents</div>
      ${big ? '<div style="font-size:17px; color:#a9a4e8; margin-top:18px">Read · click · screenshot · fix layouts · scrape</div>' : ''}
    </div>
    ${big ? '<div class="browser" style="width:620px; transform:rotate(-2deg)"><div class="bar"><i></i><i></i><i></i><div class="url">Loom &amp; Leaf</div></div><img class="shot" src="/build/demo-desktop.png" alt=""></div>' : ''}
    </body></html>`;

  const pages = { 'screenshot-1-hero': hero, 'screenshot-2-layout': layout, 'screenshot-3-scraping': scraping, 'screenshot-4-setup': setup };
  for (const [name, html] of Object.entries(pages)) writeFileSync(join(build, 'art', `${name}.html`), html);
  writeFileSync(join(build, 'art', 'promo-small-440x280.html'), tile(440, 280, false));
  writeFileSync(join(build, 'art', 'promo-marquee-1400x560.html'), tile(1400, 560, true));

  // ------------------------------------------------------------- render
  const render = async (name, w, h) => {
    await call('browser_set_viewport', { width: w, height: h, deviceScaleFactor: 1, mobile: false });
    await call('browser_navigate', { url: `${BASE}/build/art/${name}.html` });
    await call('browser_wait_for', { time: 300 });
    await call('browser_screenshot', { format: 'jpeg', quality: 92, savePath: join(images, `${name}.jpg`) });
    console.error('rendered', name);
  };
  for (const name of Object.keys(pages)) await render(name, 1280, 800);
  await render('promo-small-440x280', 440, 280);
  await render('promo-marquee-1400x560', 1400, 560);
} finally {
  await client.close().catch(() => {});
  browser.kill();
  http.close();
  rmSync(join(storeDir, 'icon.png'), { force: true });
  setTimeout(() => { rmSync(profile, { recursive: true, force: true }); process.exit(0); }, 500);
}
