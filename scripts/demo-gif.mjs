// Records docs/demo.gif: a real agent session against store/demo, shown as a
// transcript of tool calls (with their actual output) next to the browser.
//   BROWSER_BIN=<Chrome for Testing binary> npm run demo:gif      (needs ffmpeg)

import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const storeDir = join(root, 'store');
const work = join(storeDir, 'build', 'demo');
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const BIN = process.env.BROWSER_BIN;
if (!BIN || !existsSync(BIN)) { console.error('Set BROWSER_BIN to Chrome for Testing'); process.exit(2); }

const http = createServer((req, res) => {
  const p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  const file = join(storeDir, p);
  if (!file.startsWith(storeDir) || !existsSync(file)) { res.writeHead(404); return res.end(); }
  const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.png': 'image/png' };
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream', 'cache-control': 'no-store' });
  res.end(readFileSync(file));
});
await new Promise((r) => http.listen(18932, '127.0.0.1', r));
const BASE = 'http://127.0.0.1:18932';

const profile = mkdtempSync(join(tmpdir(), 'pw-demo-'));
const browser = spawn(BIN, [`--user-data-dir=${profile}`, `--load-extension=${join(root, 'extension')}`, '--no-first-run', '--no-default-browser-check', '--window-size=1500,1000', 'about:blank'], { stdio: 'ignore' });
const client = new Client({ name: 'demo-gif', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/index.js')], env: { ...process.env, BROWSER_MCP_CONNECT_TIMEOUT: '60000' }, stderr: 'inherit' }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  const t = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(`${name}: ${t}`);
  return t;
};
const json = async (name, args) => JSON.parse(await call(name, args));
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const shot = (name) => call('browser_screenshot', { scale: 'device', savePath: join(work, name) });

try {
  // ------------------------------------------------------- the session
  await call('browser_set_viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const nav = await json('browser_navigate', { url: `${BASE}/demo/index.html` });
  await shot('desktop.png');
  const vp = await json('browser_set_viewport', { preset: 'mobile' });
  await shot('mobile-before.png');
  const audit = await json('browser_audit_layout', { maxPerType: 2 });
  const culprit = audit.issues.find((i) => i.type === 'overflow-x-culprit');
  const contrast = audit.issues.find((i) => i.type === 'low-contrast');
  await call('browser_inject_css', { id: 'highlight', css: '.promo { outline: 14px solid #ef4444; outline-offset: -14px; }' });
  await shot('mobile-highlight.png');
  await call('browser_inject_css', { id: 'highlight', remove: true });
  const inspect = await json('browser_inspect', { ref: culprit.ref });
  const rule = inspect.cssRules.find((r) => r.declarations.some((d) => d.startsWith('width')));
  await call('browser_inject_css', { css: '.promo { width: auto; }' });
  const after = await json('browser_audit_layout', { maxPerType: 2 });
  await shot('mobile-after.png');
  await call('browser_set_viewport', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  const scrape = await call('browser_scrape', {
    url: `${BASE}/demo/index.html`, itemSelector: '.card', fields: { name: 'h2', price: { selector: '.price', type: 'number' } },
    nextSelector: '.pager a.next', maxPages: 5, delayMs: 300, savePath: join(work, 'products.csv'),
  });
  const rows = readFileSync(join(work, 'products.csv'), 'utf8').trim().split('\n').slice(1).map((l) => l.split(','));

  // ------------------------------------------------------------ frames
  const user = (t) => ({ kind: 'user', t });
  const tool = (name, args, out, cls = '') => ({ kind: 'tool', name, args, out, cls });
  const say = (t) => ({ kind: 'say', t });
  const overflowPx = culprit.detail.match(/(\d+)px past/)[1];
  const steps = [
    { add: [user('Check the shop on mobile and fix whatever is broken.')], view: { blank: true }, hold: 1.6 },
    { add: [tool('browser_navigate', 'url: "…/demo/index.html"', `${nav.status} "${nav.title}"`)], view: { desktop: 'desktop.png' }, hold: 1.8 },
    { add: [tool('browser_set_viewport', 'preset: "mobile"', `⚠ zoomed out to ${Math.round(vp.actual.zoom * 100)}%: the page is wider than the phone`, 'warn')], view: { phone: 'mobile-before.png', tag: 'bad' }, hold: 2.2 },
    { add: [tool('browser_audit_layout', '', `high  overflow-x-culprit ${culprit.selector}\n      extends ${overflowPx}px past the right edge\nhigh  low-contrast ${contrast ? contrast.detail.split(' —')[0].replace('Contrast ', '') : ''}`, 'warn')], view: { phone: 'mobile-highlight.png', tag: 'bad' }, hold: 2.6 },
    { add: [tool('browser_inspect', `ref: "${culprit.ref}"`, `${rule.source}\n${rule.selector} { ${rule.declarations.find((d) => d.startsWith('width'))} }`)], view: { phone: 'mobile-highlight.png', tag: 'bad' }, hold: 2.4 },
    { add: [tool('browser_inject_css', `css: "${rule.selector} { width: auto }"`, after.issues.some((i) => i.type === 'horizontal-scroll') ? 'still overflowing' : '✓ fits the screen: no overflow issues left', 'ok')], view: { phone: 'mobile-after.png', tag: 'ok' }, hold: 2.4 },
    { add: [say(`Found it: ${rule.selector} has a fixed width (${rule.source.split('/').pop()}). width: auto fixes it, so I'll make that change in the stylesheet.`), user('Now export every product to CSV.')], view: { phone: 'mobile-after.png', tag: 'ok' }, hold: 2.2 },
    { add: [tool('browser_scrape', 'itemSelector: ".card", nextSelector: ".pager a.next"', `${scrape.split('\n')[0]}\nSaved to products.csv`, 'ok')], view: { table: rows }, hold: 3.6 },
  ];

  const css = `
    * { box-sizing: border-box; margin: 0; }
    body { width: 1200px; height: 675px; overflow: hidden; display: grid; grid-template-columns: 560px 1fr; gap: 28px; padding: 28px;
           font: 15px/1.45 -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif; color: #e8e9f7;
           background: radial-gradient(900px 500px at 90% 0%, #4d36c9 0%, transparent 60%), linear-gradient(135deg, #12112e, #221c5c 60%, #331c6e); }
    .chat { background: rgba(8, 8, 24, .78); border: 1px solid rgba(255,255,255,.1); border-radius: 16px; padding: 18px; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; overflow: hidden; }
    .head { position: absolute; top: 40px; left: 46px; display: flex; gap: 8px; align-items: center; font-weight: 700; font-size: 13px; letter-spacing: .1em; color: #b3adff; text-transform: uppercase; }
    .head img { width: 20px; height: 20px; }
    .user { align-self: flex-end; background: #5b47e0; color: #fff; padding: 9px 13px; border-radius: 14px 14px 4px 14px; max-width: 85%; }
    .say { color: #d9dbf3; }
    .tool { border-left: 3px solid #6f63c9; padding: 2px 0 2px 10px; }
    .tool .n { font: 600 13px ui-monospace, "SF Mono", Menlo, monospace; color: #b3adff; }
    .tool .a { font: 12.5px ui-monospace, "SF Mono", Menlo, monospace; color: #8e92b8; }
    .tool pre { font: 12.5px/1.5 ui-monospace, "SF Mono", Menlo, monospace; white-space: pre-wrap; color: #cfd2ee; margin-top: 3px; }
    .tool.warn pre { color: #ffb4a8; } .tool.ok pre { color: #8ce8bf; }
    .tool.new { border-left-color: #a99bff; }
    .stage { position: relative; display: flex; align-items: center; justify-content: center; }
    .browser { width: 100%; background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 25px 60px rgba(0,0,0,.45); }
    .bar { height: 30px; background: #eceef3; display: flex; align-items: center; gap: 6px; padding: 0 12px; }
    .bar i { width: 9px; height: 9px; border-radius: 50%; background: #d4d6dd; display: block; }
    .browser img { display: block; width: 100%; }
    .blank { height: 330px; background: #f6f6f8; }
    .phone { width: 262px; border-radius: 34px; padding: 10px; background: #0b0b14; box-shadow: 0 25px 60px rgba(0,0,0,.5); }
    .phone img { display: block; width: 100%; border-radius: 25px; }
    .tag { position: absolute; top: 6px; left: 50%; transform: translateX(-50%); font-size: 12px; font-weight: 700; padding: 4px 12px; border-radius: 999px; }
    .tag.bad { background: #ffe1e5; color: #b4213a; } .tag.ok { background: #d8f7e9; color: #146c46; }
    table { width: 100%; border-collapse: collapse; background: rgba(8,8,24,.78); border-radius: 14px; overflow: hidden; font-size: 14px; }
    th, td { text-align: left; padding: 8px 14px; border-bottom: 1px solid rgba(255,255,255,.08); }
    th { color: #b3adff; font-size: 12px; text-transform: uppercase; letter-spacing: .06em; }
    td.num { color: #ffd27f; font-variant-numeric: tabular-nums; }`;

  const history = [];
  const frames = [];
  steps.forEach((step, i) => {
    history.push(...step.add.map((a) => ({ ...a, step: i })));
    const msgs = history.slice(-7).map((m) => {
      if (m.kind === 'user') return `<div class="user">${esc(m.t)}</div>`;
      if (m.kind === 'say') return `<div class="say">${esc(m.t)}</div>`;
      return `<div class="tool ${m.cls} ${m.step === i ? 'new' : ''}"><span class="n">${m.name}</span> <span class="a">${esc(m.args)}</span><pre>${esc(m.out)}</pre></div>`;
    }).join('');
    const v = step.view;
    let stage = '';
    if (v.blank) stage = '<div class="browser"><div class="bar"><i></i><i></i><i></i></div><div class="blank"></div></div>';
    if (v.desktop) stage = `<div class="browser"><div class="bar"><i></i><i></i><i></i></div><img src="/build/demo/${v.desktop}"></div>`;
    if (v.phone) stage = `<span class="tag ${v.tag}">${v.tag === 'ok' ? 'After' : 'Before'}</span><div class="phone"><img src="/build/demo/${v.phone}"></div>`;
    if (v.table) stage = `<table><tr><th>name</th><th>price</th></tr>${v.table.map((r) => `<tr><td>${esc(r[0])}</td><td class="num">${esc(r[1])}</td></tr>`).join('')}</table>`;
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>
      <div class="head"><img src="/build/demo/icon.png">Pagewright</div>
      <div class="chat"><div style="height:34px"></div>${msgs}</div><div class="stage">${stage}</div></body></html>`;
    writeFileSync(join(work, `frame-${i}.html`), html);
    frames.push({ i, hold: step.hold });
  });
  writeFileSync(join(work, 'icon.png'), readFileSync(join(root, 'extension/icons/icon48.png')));

  await call('browser_set_viewport', { width: 1200, height: 675, deviceScaleFactor: 1, mobile: false });
  for (const f of frames) {
    await call('browser_navigate', { url: `${BASE}/build/demo/frame-${f.i}.html` });
    await call('browser_wait_for', { time: 250 });
    await call('browser_screenshot', { savePath: join(work, `frame-${f.i}.png`) });
  }

  // ------------------------------------------------------------ encode
  const list = frames.map((f) => `file 'frame-${f.i}.png'\nduration ${f.hold}`).join('\n') + `\nfile 'frame-${frames.at(-1).i}.png'\n`;
  writeFileSync(join(work, 'frames.txt'), list);
  mkdirSync(join(root, 'docs'), { recursive: true });
  const out = join(root, 'docs', 'demo.gif');
  execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-f', 'concat', '-safe', '0', '-i', join(work, 'frames.txt'),
    '-vf', 'fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=192:stats_mode=diff[p];[b][p]paletteuse=dither=sierra2_4a:diff_mode=rectangle',
    '-loop', '0', out]);
  console.error(`wrote ${out}`);
} finally {
  await client.close().catch(() => {});
  browser.kill();
  http.close();
  setTimeout(() => { rmSync(profile, { recursive: true, force: true }); process.exit(0); }, 500);
}
