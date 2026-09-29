// `browser-mcp check`: a self-test that needs no AI app. Waits for the
// extension, opens example.com in a new tab, reads it, and closes the tab.

import { Bridge } from './bridge.js';

export async function check() {
  const port = Number(process.env.BROWSER_MCP_PORT) || 18800;
  const bridge = new Bridge({ port, connectTimeout: 60000 });
  const step = (s) => process.stdout.write(s);
  step(`Starting on port ${port}… `);
  await bridge.start();
  console.log(bridge.mode === 'hub' ? 'ok' : 'ok (sharing a running agent\'s server)');
  let tabId;
  try {
    step('Waiting for the browser extension (open Chrome with Pagewright enabled)… ');
    await bridge.call('status', {}, 70000);
    console.log('connected' + (bridge.extensionInfo ? ` — ${bridge.extensionInfo.browser}` : ''));
    step('Opening https://example.com in a new tab… ');
    const nav = await bridge.call('tabs', { action: 'new', url: 'https://example.com', background: true });
    tabId = nav.tabId;
    console.log(`${nav.status || ''} "${nav.title}"`);
    step('Reading the page… ');
    const snap = await bridge.call('snapshot', { tabId, maxChars: 400 });
    console.log('ok\n\n' + snap.snapshot.split('\n').slice(0, 6).map((l) => '    ' + l).join('\n') + '\n');
    await bridge.call('tabs', { action: 'close', tabId });
    console.log(`All good. Your AI app can now use the browser_* tools.`);
    return 0;
  } catch (e) {
    console.log('failed\n\n' + e.message);
    if (tabId) await bridge.call('tabs', { action: 'close', tabId }).catch(() => {});
    return 1;
  } finally {
    bridge.close();
  }
}
