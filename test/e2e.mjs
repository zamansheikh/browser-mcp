// End-to-end test: serves test/fixture, launches a browser with the extension in a
// throwaway profile, starts the MCP server over stdio, and exercises every tool.
//
//   BROWSER_BIN=/path/to/chrome node test/e2e.mjs
//
// Branded Chrome/Brave 137+ ignore --load-extension; use Chrome for Testing or
// Chromium (npx @puppeteer/browsers install chrome@stable).

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtempSync, readFileSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, extname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = join(root, 'test/fixture');
const outDir = process.env.E2E_OUT || mkdtempSync(join(tmpdir(), 'browser-mcp-out-'));
const PORT = 18911;
const WS_PORT = Number(process.env.BROWSER_MCP_PORT) || 18800;
const BIN = process.env.BROWSER_BIN;
if (!BIN || !existsSync(BIN)) {
  console.error('Set BROWSER_BIN to a Chromium/Chrome-for-Testing binary that allows --load-extension.');
  process.exit(2);
}

// ------------------------------------------------------------ fixture server
const types = { '.html': 'text/html', '.css': 'text/css', '.json': 'application/json' };
const http = createServer((req, res) => {
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p === '/') p = '/index.html';
  const file = join(fixture, p);
  if (!file.startsWith(fixture) || !existsSync(file)) { res.writeHead(404); return res.end('not found'); }
  res.writeHead(200, { 'content-type': types[extname(file)] || 'application/octet-stream' });
  res.end(readFileSync(file));
});
await new Promise((r) => http.listen(PORT, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${PORT}`;

// ------------------------------------------------------------------ browser
const profile = mkdtempSync(join(tmpdir(), 'browser-mcp-profile-'));
// Pre-set the port the extension should use (it reads chrome.storage; default 18800).
const browser = spawn(BIN, [
  `--user-data-dir=${profile}`,
  `--load-extension=${join(root, 'extension')}`,
  `--disable-extensions-except=${join(root, 'extension')}`,
  '--no-first-run', '--no-default-browser-check', '--disable-search-engine-choice-screen',
  '--window-size=1280,900', 'about:blank',
], { stdio: 'ignore' });

// --------------------------------------------------------------- MCP client
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [join(root, 'server/index.js')],
  env: { ...process.env, BROWSER_MCP_PORT: String(WS_PORT), BROWSER_MCP_CONNECT_TIMEOUT: '40000' },
  stderr: 'inherit',
});
const client = new Client({ name: 'e2e', version: '0' });
await client.connect(transport);

let failures = 0;
let browser2;
const results = [];
async function call(name, args = {}) {
  const r = await client.callTool({ name, arguments: args });
  const txt = r.content.filter((c) => c.type === 'text').map((c) => c.text).join('\n');
  if (r.isError) throw new Error(txt);
  return { txt, raw: r };
}
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS ${name} (${Date.now() - t0}ms)`);
  } catch (e) {
    failures++;
    results.push(`FAIL ${name}: ${e.message.slice(0, 600)}`);
  }
  console.error(results.at(-1));
}
const expect = (cond, msg) => { if (!cond) throw new Error(msg); };

try {
  const { tools } = await client.listTools();
  console.error(`${tools.length} tools: ${tools.map((t) => t.name).join(', ')}`);

  await test('status (waits for extension)', async () => {
    const t0 = Date.now();
    let s;
    while (Date.now() - t0 < 45000) {
      s = JSON.parse((await call('browser_status')).txt);
      if (s.extensionConnected) break;
      await new Promise((r) => setTimeout(r, 1000));
    }
    expect(s.extensionConnected, 'extension never connected: ' + JSON.stringify(s));
  });

  await test('navigate', async () => {
    const r = JSON.parse((await call('browser_navigate', { url: BASE + '/' })).txt);
    expect(r.title === 'Fixture Shop' && r.status === 200, JSON.stringify(r));
  });

  let snap;
  await test('snapshot', async () => {
    snap = (await call('browser_snapshot')).txt;
    writeFileSync(join(outDir, 'snapshot.txt'), snap);
    expect(/heading "Products" \[level=1\]/.test(snap), 'no h1');
    expect(/textbox "Email".*\[ref=e\d+\]/.test(snap), 'no email textbox');
    expect(/button "Sign up"/.test(snap), 'no button');
  });
  const refOf = (re) => { const m = snap.match(new RegExp(re.source + '.*?\\[ref=(e\\d+)\\]')); if (!m) throw new Error('ref not found for ' + re); return m[1]; };

  await test('type + select + click checkbox + submit', async () => {
    await call('browser_type', { ref: refOf(/textbox "Email"/), text: 'ada@example.com' });
    await call('browser_select_option', { ref: refOf(/combobox "Plan"/), values: ['Pro'] });
    await call('browser_click', { ref: refOf(/checkbox "Newsletter"/) });
    await call('browser_click', { ref: refOf(/button "Sign up"/) });
    const r = (await call('browser_evaluate', { expression: "document.getElementById('result').textContent" })).txt;
    expect(r === 'Thanks ada@example.com (pro, news=true)', 'got ' + r);
  });

  await test('press_key + text selector', async () => {
    await call('browser_type', { selector: '#email', text: 'x' });
    await call('browser_press_key', { key: 'Control+A Backspace' });
    await call('browser_type', { selector: '#email', text: 'b@c.d', clear: false });
    const r = (await call('browser_evaluate', { expression: 'document.getElementById("email").value' })).txt;
    expect(r === 'b@c.d', 'value ' + r);
    await call('browser_hover', { selector: 'text=Red Kettle' });
  });

  await test('wait_for', async () => {
    const r = JSON.parse((await call('browser_wait_for', { text: 'Loaded later', timeout: 5000 })).txt);
    expect(r.ok, JSON.stringify(r));
  });

  await test('screenshot viewport/full/element', async () => {
    for (const [name, args] of [['viewport', {}], ['full', { fullPage: true, format: 'jpeg' }], ['element', { selector: '.products' }]]) {
      const { raw, txt } = await call('browser_screenshot', { ...args, savePath: join(outDir, `shot-${name}.${args.format || 'png'}`) });
      const img = raw.content.find((c) => c.type === 'image');
      expect(img && img.data.length > 1000, `${name}: no image`);
      console.error('   ', txt.split('\n')[0]);
    }
  });

  await test('audit_layout finds planted bugs', async () => {
    const r = JSON.parse((await call('browser_audit_layout')).txt);
    writeFileSync(join(outDir, 'audit.json'), JSON.stringify(r, null, 2));
    const types = new Set(r.issues.map((i) => i.type));
    for (const t of ['horizontal-scroll', 'overflow-x-culprit', 'low-contrast', 'broken-image', 'distorted-image', 'small-tap-target', 'missing-label', 'clipped-content']) {
      expect(types.has(t), `missing ${t}; got ${[...types]}`);
    }
    expect(r.consoleErrors.some((e) => /boom/.test(e)), 'console error missing');
    expect(r.failedRequests.some((e) => /missing\.png/.test(e)), 'failed request missing');
  });

  await test('console', async () => {
    const t = (await call('browser_console')).txt;
    expect(/fixture loaded/.test(t) && /WARN this is a warning/.test(t) && /boom from fixture/.test(t), t);
  });

  await test('network + body', async () => {
    const t = (await call('browser_network', { filter: 'products.json' })).txt;
    const id = t.match(/\[([^\]]+)\] GET 200/)?.[1];
    expect(id, t);
    const b = JSON.parse((await call('browser_network_body', { requestId: id })).txt);
    expect(JSON.parse(b.body).length === 3, JSON.stringify(b));
  });

  await test('inspect with CSS source rules', async () => {
    const r = JSON.parse((await call('browser_inspect', { selector: '.banner' })).txt);
    writeFileSync(join(outDir, 'inspect.json'), JSON.stringify(r, null, 2));
    const rule = r.cssRules && r.cssRules.find((x) => x.selector === '.banner');
    expect(rule && /style\.css:\d+/.test(rule.source) && rule.declarations.includes('width: 1600px'), JSON.stringify(r.cssRules || r.cssRulesError));
  });

  await test('inject_css fixes overflow', async () => {
    await call('browser_inject_css', { css: '.banner { width: auto; }' });
    const r = JSON.parse((await call('browser_audit_layout')).txt);
    expect(!r.issues.some((i) => i.type === 'horizontal-scroll'), 'still overflowing');
    await call('browser_inject_css', { remove: true });
  });

  await test('mobile viewport zoomed out by overflow: warning + clicks still land', async () => {
    const r = JSON.parse((await call('browser_set_viewport', { preset: 'mobile' })).txt);
    expect(r.warning && r.actual.zoom < 1, JSON.stringify(r));
    const c = JSON.parse((await call('browser_click', { selector: 'a.next' })).txt);
    expect(c.url.endsWith('/page2.html'), JSON.stringify(c));
    await call('browser_navigate', { action: 'back' });
    await call('browser_set_viewport', { reset: true });
  });

  await test('set_viewport mobile + reset', async () => {
    await call('browser_inject_css', { css: '.banner { width: auto; }' });
    const r = JSON.parse((await call('browser_set_viewport', { preset: 'mobile' })).txt);
    expect(r.actual.width === 390 && !r.warning, JSON.stringify(r));
    const cols = JSON.parse((await call('browser_inspect', { selector: '.products', properties: ['grid-template-columns'], matchedRules: false })).txt);
    expect(!/ /.test(cols.computedStyle['grid-template-columns'].trim()), 'media query not applied: ' + cols.computedStyle['grid-template-columns']);
    await call('browser_screenshot', { savePath: join(outDir, 'shot-mobile.png') });
    await call('browser_set_viewport', { reset: true });
    await call('browser_inject_css', { remove: true });
  });

  await test('get_content formats', async () => {
    const md = (await call('browser_get_content', { format: 'markdown', mainOnly: true })).txt;
    expect(/# Products/.test(md) && /\[View\]\(http/.test(md) && /\| Model \| Watts \|/.test(md), md.slice(0, 800));
    const tables = (await call('browser_get_content', { format: 'tables' })).txt;
    expect(/"Watts": "2200"/.test(tables), tables);
    const meta = (await call('browser_get_content', { format: 'meta' })).txt;
    expect(/Fixture shop for browser-mcp/.test(meta) && /"Store"/.test(meta), meta);
  });

  await test('extract', async () => {
    const t = (await call('browser_extract', {
      itemSelector: '.product',
      fields: { name: 'h2', price: { selector: '.price', type: 'number' }, url: 'a@href' },
      savePath: join(outDir, 'extract.csv'),
    })).txt;
    expect(/"price": 39/.test(t) && /\/p\/red-kettle/.test(t), t);
  });

  await test('scrape with pagination', async () => {
    const t = (await call('browser_scrape', {
      url: BASE + '/', itemSelector: '.product', fields: { name: 'h2', price: { selector: '.price', type: 'number' } },
      nextSelector: 'a.next', maxPages: 5, delayMs: 300, savePath: join(outDir, 'scrape.json'),
    })).txt;
    const items = JSON.parse(readFileSync(join(outDir, 'scrape.json'), 'utf8'));
    expect(items.length === 5 && items.some((i) => i.name === 'Black Pan'), t);
  });

  await test('tabs new/list/select/close', async () => {
    const n = JSON.parse((await call('browser_tabs', { action: 'new', url: BASE + '/page2.html' })).txt);
    expect(n.title.includes('page 2'), JSON.stringify(n));
    const l = JSON.parse((await call('browser_tabs')).txt);
    expect(l.tabs.some((t) => t.tabId === n.tabId && t.current), 'new tab not current');
    await call('browser_tabs', { action: 'close', tabId: n.tabId });
  });

  await test('console keeps history across navigations', async () => {
    const t = (await call('browser_console', { level: 'error' })).txt;
    expect(/boom from fixture/.test(t) && /NAV Navigated to/.test(t), t);
    const n = (await call('browser_network', { filter: 'products.json' })).txt;
    expect(/products\.json/.test(n) || /includePrevious/.test(n), n);
  });

  await test('navigate back', async () => {
    await call('browser_navigate', { url: BASE + '/' });
    await call('browser_navigate', { url: BASE + '/page2.html' });
    const r = JSON.parse((await call('browser_navigate', { action: 'back' })).txt);
    expect(r.url.endsWith(':' + PORT + '/'), JSON.stringify(r));
  });

  await test('second agent shares the browser through the hub', async () => {
    const t2 = new StdioClientTransport({ command: process.execPath, args: [join(root, 'server/index.js')], env: { ...process.env, BROWSER_MCP_PORT: String(WS_PORT) }, stderr: 'inherit' });
    const c2 = new Client({ name: 'e2e-2', version: '0' });
    await c2.connect(t2);
    const r = await c2.callTool({ name: 'browser_evaluate', arguments: { expression: 'document.title' } });
    await c2.close();
    expect(!r.isError && /Fixture Shop/.test(r.content[0].text), JSON.stringify(r));
  });

  await test('error for unknown ref is helpful', async () => {
    try { await call('browser_click', { ref: 'e99999' }); throw new Error('no error'); } catch (e) { expect(/take a new browser_snapshot/.test(e.message), e.message); }
  });

  // Keep last: kills the first browser.
  await test('second browser waits on standby, then takes over', async () => {
    const profile2 = mkdtempSync(join(tmpdir(), 'browser-mcp-profile-'));
    browser2 = spawn(BIN, [`--user-data-dir=${profile2}`, `--load-extension=${join(root, 'extension')}`, '--no-first-run', '--no-default-browser-check', 'about:blank'], { stdio: 'ignore' });
    const until = async (pred, ms) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) { const st = JSON.parse((await call('browser_status')).txt); if (pred(st)) return st; await new Promise((r) => setTimeout(r, 500)); }
      throw new Error('condition not reached: ' + (await call('browser_status')).txt);
    };
    await until((st) => st.standbyBrowsers && st.standbyBrowsers.length === 1, 40000);
    const title = (await call('browser_evaluate', { expression: 'document.title' })).txt;
    expect(/Fixture/.test(title), 'commands went to the standby browser: ' + title);
    browser.kill();
    await until((st) => st.extensionConnected && !st.standbyBrowsers && st.currentTabId !== undefined, 20000);
    const href = (await call('browser_evaluate', { expression: 'location.href' })).txt;
    expect(href === 'about:blank', 'expected the second browser, got ' + href);
  });
} finally {
  console.error('\n' + results.join('\n'));
  console.error(`\n${results.length - failures}/${results.length} passed. Artifacts in ${outDir}`);
  await client.close().catch(() => {});
  browser.kill();
  browser2?.kill();
  http.close();
  setTimeout(() => { rmSync(profile, { recursive: true, force: true }); process.exit(failures ? 1 : 0); }, 800);
}
