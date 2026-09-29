import { pageLib, PAGE_LIB_VERSION } from './page-lib.js';

const DEFAULT_PORT = 18800;
const MAX_LOG = 1000;
const MAX_REQUESTS = 1000;

// ------------------------------------------------------------------ state
let ws = null;
let connState = 'disconnected';
let lastError = null;
let reconnectTimer = null;
let reconnectDelay = 1000;
let keepaliveTimer = null;
let currentTabId = null; // tab the agent last opened/selected
let commandCount = 0;

/** tabId -> { attached, nav, console[], requests Map, sheets Map, cssReady, dialog } */
const tabs = new Map();

function tabState(tabId) {
  let st = tabs.get(tabId);
  if (!st) {
    st = { attached: false, nav: 0, console: [], requests: new Map(), sheets: new Map(), cssReady: false, dialog: { accept: true, promptText: '' } };
    tabs.set(tabId, st);
  }
  return st;
}

// ------------------------------------------------------------- connection
async function getPort() {
  const { port } = await chrome.storage.local.get('port');
  return Number(port) || DEFAULT_PORT;
}

function setState(s, err) {
  connState = s;
  if (err !== undefined) lastError = err;
  chrome.action.setBadgeText({ text: s === 'connected' ? 'ON' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ color: '#16a34a' }).catch(() => {});
  chrome.runtime.sendMessage({ type: 'statusChanged' }).catch(() => {});
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(reconnectTimer);
  const port = await getPort();
  let sock;
  try {
    sock = new WebSocket(`ws://127.0.0.1:${port}/extension`);
  } catch (e) {
    setState('disconnected', String(e.message || e));
    scheduleReconnect();
    return;
  }
  ws = sock;
  setState('connecting');
  sock.onopen = async () => {
    reconnectDelay = 1000;
    setState('connected', null);
    const ua = navigator.userAgentData;
    send({
      type: 'hello',
      extensionVersion: chrome.runtime.getManifest().version,
      browser: ua ? ua.brands.map((b) => `${b.brand} ${b.version}`).join(', ') : navigator.userAgent,
      platform: ua ? ua.platform : navigator.platform,
    });
    clearInterval(keepaliveTimer);
    keepaliveTimer = setInterval(() => send({ type: 'ping' }), 20000);
  };
  sock.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'pong') return;
    if (msg.id !== undefined && msg.method) handleCommand(msg);
  };
  sock.onerror = () => { lastError = `Cannot reach MCP server on port ${port}. Is an agent running browser-mcp?`; };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(keepaliveTimer);
    setState('disconnected');
    scheduleReconnect();
  };
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connect, reconnectDelay);
  reconnectDelay = Math.min(reconnectDelay * 1.5, 5000);
}

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

// The service worker may be suspended when idle; the alarm wakes it to retry.
chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'reconnect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

async function handleCommand({ id, method, params }) {
  const fn = METHODS[method];
  commandCount++;
  if (!fn) return send({ id, error: `Unknown method: ${method}` });
  try {
    const result = await fn(params || {});
    send({ id, result: result === undefined ? null : result });
  } catch (e) {
    send({ id, error: friendlyError(e) });
  }
}

function friendlyError(e) {
  const m = String((e && e.message) || e);
  if (/Cannot access a chrome|Cannot attach to this target|chrome-extension:\/\/|devtools:\/\//i.test(m)) {
    return `${m} — browser internal pages (chrome://, the Web Store, other extensions) can't be controlled. Navigate the tab to a normal http(s) page first.`;
  }
  if (/Another debugger is already attached/i.test(m)) {
    return `${m} — close DevTools on that tab, or detach the other debugging extension, then retry.`;
  }
  return m;
}

// ---------------------------------------------------------------- helpers
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function withTimeout(promise, ms, what) {
  let t;
  return Promise.race([
    promise.finally(() => clearTimeout(t)),
    new Promise((_, rej) => { t = setTimeout(() => rej(new Error(`${what} timed out after ${ms}ms`)), ms); }),
  ]);
}

function isRestrictedUrl(url) {
  return !url || /^(chrome|edge|brave|opera|vivaldi|about|chrome-extension|devtools|view-source|chrome-search):/i.test(url) && url !== 'about:blank'
    || /^https:\/\/(chrome\.google\.com\/webstore|chromewebstore\.google\.com|microsoftedge\.microsoft\.com\/addons)/i.test(url);
}

async function resolveTab(tabId) {
  if (tabId !== undefined && tabId !== null) {
    const t = await chrome.tabs.get(Number(tabId)).catch(() => null);
    if (!t) throw new Error(`Tab ${tabId} not found — use browser_tabs to list open tabs`);
    return t;
  }
  if (currentTabId !== null) {
    const t = await chrome.tabs.get(currentTabId).catch(() => null);
    if (t) return t;
    currentTabId = null;
  }
  let [t] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!t) [t] = await chrome.tabs.query({ active: true });
  if (!t) t = await chrome.tabs.create({ url: 'about:blank' });
  return t;
}

function cdp(tabId, method, params = {}) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

async function attach(tabId) {
  const st = tabState(tabId);
  if (st.attached) return st;
  const tab = await chrome.tabs.get(tabId);
  if (isRestrictedUrl(tab.url || tab.pendingUrl)) {
    throw new Error(`Can't control ${tab.url || 'this page'} — browser internal pages can't be scripted. Use browser_navigate to open a normal page first.`);
  }
  try {
    await chrome.debugger.attach({ tabId }, '1.3');
  } catch (e) {
    if (!/already attached/i.test(e.message)) throw e;
    // Possibly our own session from before a service-worker restart.
    await chrome.debugger.detach({ tabId }).catch(() => {});
    await chrome.debugger.attach({ tabId }, '1.3');
  }
  st.attached = true;
  st.cssReady = false;
  await Promise.all([
    cdp(tabId, 'Page.enable'),
    cdp(tabId, 'Runtime.enable'),
    cdp(tabId, 'Network.enable', { maxResourceBufferSize: 20e6, maxTotalBufferSize: 100e6 }),
    cdp(tabId, 'Log.enable'),
  ]);
  if (st.viewport) await applyViewport(tabId, st.viewport).catch(() => {});
  return st;
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const st = tabs.get(source.tabId);
  if (st) { st.attached = false; st.cssReady = false; st.detachReason = reason; }
  chrome.runtime.sendMessage({ type: 'statusChanged' }).catch(() => {});
});

chrome.tabs.onRemoved.addListener((tabId) => {
  tabs.delete(tabId);
  if (currentTabId === tabId) currentTabId = null;
});

// Evaluate a page-lib function in the page and return its (JSON) result.
async function page(tabId, fn, args) {
  await attach(tabId);
  const expr = `(() => {
    if (!window.__browserMcp || window.__browserMcp.v !== ${PAGE_LIB_VERSION}) (${pageLib.toString()})(${PAGE_LIB_VERSION});
    return window.__browserMcp.${fn}(${JSON.stringify(args ?? {})});
  })()`;
  const r = await cdp(tabId, 'Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true });
  if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
  return r.result.value;
}

function exceptionText(d) {
  const desc = d.exception && (d.exception.description || d.exception.value);
  return String(desc || d.text || 'Evaluation failed').split('\n')[0].replace(/^Uncaught (Error: )?/, '');
}

// Wait for the tab to finish loading after something may have triggered a navigation.
function waitForLoad(tabId, timeout = 30000, expectNavigation = false) {
  return new Promise((resolve) => {
    let sawLoading = !expectNavigation;
    let done = false;
    const finish = (timedOut) => {
      if (done) return;
      done = true;
      chrome.tabs.onUpdated.removeListener(listener);
      clearTimeout(timer);
      resolve({ timedOut });
    };
    const listener = (id, info) => {
      if (id !== tabId) return;
      if (info.status === 'loading' || info.url) sawLoading = true;
      if (info.status === 'complete' && sawLoading) finish(false);
    };
    const timer = setTimeout(() => finish(true), timeout);
    chrome.tabs.onUpdated.addListener(listener);
    if (!expectNavigation) {
      chrome.tabs.get(tabId).then((t) => { if (t.status === 'complete') finish(false); }).catch(() => finish(false));
    }
  });
}

// After an input action: wait briefly, follow a navigation if one started, note new tabs.
async function settle(tabId, before, newTabs) {
  await sleep(150);
  let t = await chrome.tabs.get(tabId).catch(() => null);
  if (t && t.status === 'loading') {
    await waitForLoad(tabId, 20000);
    t = await chrome.tabs.get(tabId).catch(() => null);
  }
  const out = { tabId, url: t && t.url, title: t && t.title };
  if (before && t && t.url !== before) out.navigated = true;
  if (newTabs && newTabs.length) out.openedTabs = newTabs.map((n) => ({ tabId: n.id, url: n.pendingUrl || n.url }));
  return out;
}

function watchNewTabs(openerId) {
  const found = [];
  const l = (tab) => { if (tab.openerTabId === openerId) found.push(tab); };
  chrome.tabs.onCreated.addListener(l);
  return { found, stop: () => chrome.tabs.onCreated.removeListener(l) };
}

// ------------------------------------------------------------- CDP events
function pushLog(st, entry) {
  st.console.push({ ...entry, nav: st.nav, ts: Date.now() });
  if (st.console.length > MAX_LOG) st.console.splice(0, st.console.length - MAX_LOG);
}

function fmtRemote(o) {
  if (!o) return '';
  if (o.type === 'string') return o.value;
  if ('value' in o) return typeof o.value === 'object' ? JSON.stringify(o.value) : String(o.value);
  if (o.unserializableValue) return o.unserializableValue;
  if (o.preview && o.preview.properties) {
    const inner = o.preview.properties.map((p) => (o.subtype === 'array' ? p.value : `${p.name}: ${p.value}`)).join(', ');
    return o.subtype === 'array' ? `[${inner}${o.preview.overflow ? ', …' : ''}]` : `{${inner}${o.preview.overflow ? ', …' : ''}}`;
  }
  return o.description || o.type;
}

chrome.debugger.onEvent.addListener((source, method, p) => {
  const tabId = source.tabId;
  if (tabId === undefined) return;
  const st = tabState(tabId);
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const frame = p.stackTrace && p.stackTrace.callFrames[0];
      const level = { warning: 'warn', log: 'log', info: 'info', error: 'error', debug: 'debug', assert: 'error', trace: 'log' }[p.type] || p.type;
      pushLog(st, { level, text: p.args.map(fmtRemote).join(' '), source: frame ? `${frame.url}:${frame.lineNumber + 1}` : undefined });
      break;
    }
    case 'Runtime.exceptionThrown': {
      const d = p.exceptionDetails;
      const desc = (d.exception && d.exception.description) || d.text;
      pushLog(st, { level: 'error', text: `Uncaught ${String(desc).split('\n').slice(0, 4).join('\n')}`, source: d.url ? `${d.url}:${d.lineNumber + 1}` : undefined });
      break;
    }
    case 'Log.entryAdded': {
      const e = p.entry;
      pushLog(st, { level: e.level === 'warning' ? 'warn' : e.level, text: e.text, source: e.url ? `${e.url}${e.lineNumber !== undefined ? ':' + (e.lineNumber + 1) : ''}` : e.source });
      break;
    }
    case 'Page.frameNavigated':
      if (!p.frame.parentId) {
        st.nav++;
        st.sheets.clear();
        // The document request was sent before the commit; move it to the new page.
        const doc = st.requests.get(p.frame.loaderId);
        if (doc) doc.nav = st.nav;
        pushLog(st, { level: 'nav', text: `Navigated to ${p.frame.url}` });
      }
      break;
    case 'Page.javascriptDialogOpening': {
      const accept = p.type === 'beforeunload' ? true : st.dialog.accept;
      pushLog(st, { level: 'dialog', text: `${p.type}: "${p.message}" → ${accept ? 'accepted' : 'dismissed'} automatically` });
      cdp(tabId, 'Page.handleJavaScriptDialog', { accept, promptText: st.dialog.promptText || p.defaultPrompt || '' }).catch(() => {});
      break;
    }
    case 'Network.requestWillBeSent': {
      const prev = st.requests.get(p.requestId);
      const entry = {
        id: p.requestId, url: p.request.url, method: p.request.method, type: p.type || (prev && prev.type) || 'Other',
        start: p.timestamp, nav: st.nav, postData: p.request.postData ? p.request.postData.slice(0, 2000) : undefined,
        redirectedFrom: prev && p.redirectResponse ? prev.url : undefined,
      };
      st.requests.set(p.requestId, entry);
      if (st.requests.size > MAX_REQUESTS) st.requests.delete(st.requests.keys().next().value);
      break;
    }
    case 'Network.responseReceived': {
      const e = st.requests.get(p.requestId);
      if (e) {
        e.status = p.response.status; e.statusText = p.response.statusText; e.mimeType = p.response.mimeType;
        e.fromCache = p.response.fromDiskCache || p.response.fromServiceWorker || undefined;
        e.type = p.type || e.type;
      }
      break;
    }
    case 'Network.loadingFinished': {
      const e = st.requests.get(p.requestId);
      if (e) { e.size = p.encodedDataLength; e.ms = Math.round((p.timestamp - e.start) * 1000); e.done = true; }
      break;
    }
    case 'Network.loadingFailed': {
      const e = st.requests.get(p.requestId);
      if (e) { e.failed = p.blockedReason ? `blocked:${p.blockedReason}` : p.canceled ? 'canceled' : p.errorText; e.ms = Math.round((p.timestamp - e.start) * 1000); e.done = true; }
      break;
    }
    case 'CSS.styleSheetAdded':
      st.sheets.set(p.header.styleSheetId, p.header);
      break;
  }
});

// ------------------------------------------------------------------ input
const MOD = { Alt: 1, Control: 2, Ctrl: 2, Meta: 4, Cmd: 4, Command: 4, Shift: 8 };
const SPECIAL_KEYS = {
  Enter: [13, 'Enter', '\r'], Tab: [9, 'Tab'], Escape: [27, 'Escape'], Esc: [27, 'Escape'],
  Backspace: [8, 'Backspace'], Delete: [46, 'Delete'], Insert: [45, 'Insert'],
  ArrowUp: [38, 'ArrowUp'], ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'],
  Home: [36, 'Home'], End: [35, 'End'], PageUp: [33, 'PageUp'], PageDown: [34, 'PageDown'], Space: [32, 'Space', ' '],
};
for (let i = 1; i <= 12; i++) SPECIAL_KEYS['F' + i] = [111 + i, 'F' + i];
const EDIT_COMMANDS = { a: 'selectAll', c: 'copy', v: 'paste', x: 'cut', z: 'undo', y: 'redo' };

function keyDef(k) {
  if (SPECIAL_KEYS[k]) {
    const [code, name, text] = SPECIAL_KEYS[k];
    return { key: k === 'Space' ? ' ' : name, code: name, keyCode: code, text };
  }
  if (k.length === 1) {
    const up = k.toUpperCase();
    let code = '';
    if (/[a-z]/i.test(k)) code = 'Key' + up;
    else if (/\d/.test(k)) code = 'Digit' + k;
    return { key: k, code, keyCode: /[a-z0-9]/i.test(k) ? up.charCodeAt(0) : 0, text: k };
  }
  throw new Error(`Unknown key "${k}". Use names like Enter, Tab, Escape, ArrowDown, Backspace, or single characters, combined like "Control+A".`);
}

async function pressKey(tabId, combo) {
  const parts = combo.split('+').map((s) => s.trim()).filter(Boolean);
  const main = parts.pop() || '+';
  let modifiers = 0;
  for (const m of parts) {
    if (!(m in MOD)) throw new Error(`Unknown modifier "${m}" (use Control, Shift, Alt, Meta)`);
    modifiers |= MOD[m];
  }
  const d = keyDef(main === 'Plus' ? '+' : main);
  const hasCmd = modifiers & (2 | 4);
  const text = hasCmd ? undefined : (modifiers & 8 && d.text && d.text.length === 1 ? d.text.toUpperCase() : d.text);
  const commands = hasCmd && EDIT_COMMANDS[main.toLowerCase()] ? [EDIT_COMMANDS[main.toLowerCase()]] : undefined;
  await cdp(tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', modifiers, key: d.key, code: d.code,
    windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode, text, unmodifiedText: text, commands,
  });
  await cdp(tabId, 'Input.dispatchKeyEvent', { type: 'keyUp', modifiers, key: d.key, code: d.code, windowsVirtualKeyCode: d.keyCode, nativeVirtualKeyCode: d.keyCode });
}

async function mouse(tabId, x, y, { button = 'left', clickCount = 1, move = true } = {}) {
  if (move) await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  const buttons = { left: 1, right: 2, middle: 4 }[button] || 1;
  for (let i = 1; i <= clickCount; i++) {
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button, buttons, clickCount: i });
    await cdp(tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button, buttons: 0, clickCount: i });
  }
}

// -------------------------------------------------------------- viewport
const VIEWPORT_PRESETS = {
  mobile: { width: 390, height: 844, deviceScaleFactor: 3, mobile: true },
  'mobile-small': { width: 360, height: 640, deviceScaleFactor: 2, mobile: true },
  tablet: { width: 820, height: 1180, deviceScaleFactor: 2, mobile: true },
  laptop: { width: 1366, height: 768, deviceScaleFactor: 1, mobile: false },
  desktop: { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false },
  'desktop-hd': { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false },
};

async function applyViewport(tabId, v) {
  await cdp(tabId, 'Emulation.setDeviceMetricsOverride', {
    width: v.width, height: v.height, deviceScaleFactor: v.deviceScaleFactor || 0, mobile: !!v.mobile,
  });
  await cdp(tabId, 'Emulation.setTouchEmulationEnabled', { enabled: !!v.mobile, maxTouchPoints: v.mobile ? 5 : 1 });
}

// --------------------------------------------------------------- methods
function tabInfo(t) {
  return { tabId: t.id, windowId: t.windowId, active: t.active, title: t.title, url: t.url || t.pendingUrl, status: t.status, controlled: !!(tabs.get(t.id) || {}).attached, current: t.id === currentTabId };
}

async function objectIdFor(tabId, args) {
  const ref = await page(tabId, 'refOf', args);
  const r = await cdp(tabId, 'Runtime.evaluate', { expression: `window.__browserMcp.get(${JSON.stringify(ref)})` });
  if (!r.result.objectId) throw new Error('Element is gone');
  return { ref, objectId: r.result.objectId };
}

async function doNavigate(tab, url, timeout) {
  // Attach before navigating so console/network capture covers the page load.
  if (isRestrictedUrl(tab.url || tab.pendingUrl) && tab.url !== 'about:blank') {
    const p = waitForLoad(tab.id, 5000, true);
    await chrome.tabs.update(tab.id, { url: 'about:blank' });
    await p;
  }
  await attach(tab.id).catch(() => {});
  const p = waitForLoad(tab.id, timeout, true);
  await chrome.tabs.update(tab.id, { url });
  const { timedOut } = await p;
  await attach(tab.id).catch(() => {});
  const t = await chrome.tabs.get(tab.id);
  const st = tabState(tab.id);
  const doc = [...st.requests.values()].reverse().find((r) => r.type === 'Document' && r.nav === st.nav);
  return {
    tabId: t.id, url: t.url, title: t.title,
    status: doc ? doc.status : undefined,
    error: doc && doc.failed ? doc.failed : undefined,
    timedOut: timedOut || undefined,
  };
}

function normalizeUrl(url) {
  if (/^[a-z][\w+.-]*:/i.test(url)) return url;
  if (/^(localhost|127\.|\[::1\]|0\.0\.0\.0)/.test(url)) return 'http://' + url;
  return 'https://' + url;
}

const METHODS = {
  async status() {
    return { connected: true, currentTabId, controlledTabs: [...tabs.entries()].filter(([, s]) => s.attached).map(([id]) => id) };
  },

  async tabs({ action = 'list', tabId, url, background }) {
    if (action === 'list') {
      const all = await chrome.tabs.query({});
      return { tabs: all.map(tabInfo) };
    }
    if (action === 'current') return tabInfo(await resolveTab(tabId));
    if (action === 'new') {
      const t = await chrome.tabs.create({ url: 'about:blank', active: !background });
      currentTabId = t.id;
      if (url) return doNavigate(t, normalizeUrl(url), 30000);
      return tabInfo(await chrome.tabs.get(t.id));
    }
    if (action === 'select') {
      const t = await resolveTab(tabId);
      currentTabId = t.id;
      if (!background) {
        await chrome.tabs.update(t.id, { active: true });
        await chrome.windows.update(t.windowId, { focused: true }).catch(() => {});
      }
      return tabInfo(await chrome.tabs.get(t.id));
    }
    if (action === 'close') {
      const t = await resolveTab(tabId);
      await chrome.tabs.remove(t.id);
      return { closed: t.id };
    }
    throw new Error(`Unknown tabs action ${action}`);
  },

  async navigate({ tabId, url, action, timeout = 30000 }) {
    const tab = await resolveTab(tabId);
    if (action) {
      await attach(tab.id);
      const p = waitForLoad(tab.id, timeout, true);
      if (action === 'reload') await chrome.tabs.reload(tab.id);
      else if (action === 'back') await chrome.tabs.goBack(tab.id);
      else if (action === 'forward') await chrome.tabs.goForward(tab.id);
      else throw new Error(`Unknown action ${action}`);
      const { timedOut } = await p;
      const t = await chrome.tabs.get(tab.id);
      return { tabId: t.id, url: t.url, title: t.title, timedOut: timedOut || undefined };
    }
    if (!url) throw new Error('Provide url or action');
    return doNavigate(tab, normalizeUrl(url), timeout);
  },

  async snapshot({ tabId, selector, interactiveOnly, maxChars }) {
    const tab = await resolveTab(tabId);
    const r = await page(tab.id, 'snapshot', { selector, interactiveOnly, maxChars });
    return { tabId: tab.id, ...r };
  },

  async screenshot({ tabId, fullPage, ref, selector, format = 'png', quality, maxHeight = 12000, scale = 'css' }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    if (!tab.active) {
      // Background tabs don't paint; bring it to the front first.
      await chrome.tabs.update(tab.id, { active: true });
      await sleep(250);
    }
    const metrics = await cdp(tab.id, 'Page.getLayoutMetrics');
    const vp = metrics.cssVisualViewport || metrics.visualViewport;
    const dpr = (await cdp(tab.id, 'Runtime.evaluate', { expression: 'devicePixelRatio', returnByValue: true })).result.value || 1;
    const s = scale === 'device' ? 1 : 1 / dpr;
    let clip;
    let note;
    if (ref || selector) {
      const r = await page(tab.id, 'pageRect', { ref, selector });
      await sleep(50);
      clip = { x: r.x, y: r.y, width: Math.max(1, r.width), height: Math.max(1, Math.min(r.height, maxHeight)), scale: s };
      note = `element ${r.desc} [ref=${r.ref}]`;
    } else if (fullPage) {
      const size = metrics.cssContentSize || metrics.contentSize;
      const h = Math.min(size.height, maxHeight);
      clip = { x: 0, y: 0, width: size.width, height: h, scale: s };
      note = `full page ${Math.round(size.width)}x${Math.round(size.height)}${size.height > maxHeight ? ` (cut at ${maxHeight}px)` : ''}`;
    } else {
      clip = { x: vp.pageX, y: vp.pageY, width: vp.clientWidth, height: vp.clientHeight, scale: s };
      note = `viewport ${Math.round(vp.clientWidth)}x${Math.round(vp.clientHeight)} at scroll ${Math.round(vp.pageX)},${Math.round(vp.pageY)}`;
    }
    const params = { format, clip, captureBeyondViewport: !!(fullPage || ref || selector), fromSurface: true };
    if (format !== 'png') params.quality = quality || 80;
    const { data } = await withTimeout(cdp(tab.id, 'Page.captureScreenshot', params), 30000, 'Screenshot');
    return { tabId: tab.id, url: tab.url, data, mimeType: `image/${format}`, note };
  },

  async click({ tabId, ref, selector, x, y, button = 'left', doubleClick, force }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const watcher = watchNewTabs(tab.id);
    let target;
    try {
      if (x !== undefined && y !== undefined) {
        await mouse(tab.id, x, y, { button, clickCount: doubleClick ? 2 : 1 });
        target = { desc: `point (${x}, ${y})` };
      } else if (force) {
        target = await page(tab.id, 'jsClick', { ref, selector });
      } else {
        target = await page(tab.id, 'point', { ref, selector });
        if (target.obscuredBy) {
          throw new Error(`${target.desc} "${target.name}" is covered by ${target.obscuredBy}, so a real click would hit that instead. Close the overlay/popup first, or pass force:true to click via JavaScript.`);
        }
        await sleep(30);
        await mouse(tab.id, target.x, target.y, { button, clickCount: doubleClick ? 2 : 1 });
      }
      const res = await settle(tab.id, tab.url, watcher.found);
      return { clicked: `${target.desc}${target.name ? ` "${target.name}"` : ''}`, ref: target.ref, ...(target.disabled ? { warning: 'element is disabled' } : {}), ...res };
    } finally {
      watcher.stop();
    }
  },

  async hover({ tabId, ref, selector, x, y }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    let pt = { x, y, desc: `point (${x}, ${y})` };
    if (x === undefined || y === undefined) pt = await page(tab.id, 'point', { ref, selector });
    await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: pt.x, y: pt.y });
    await sleep(100);
    return { hovered: pt.desc, ref: pt.ref, x: pt.x, y: pt.y };
  },

  async type({ tabId, ref, selector, text = '', clear = true, submit, slowly }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const info = await page(tab.id, 'focusForTyping', { ref, selector, clear });
    if (!info.focused) {
      const pt = await page(tab.id, 'point', { ref: info.ref });
      await mouse(tab.id, pt.x, pt.y);
      if (clear) await page(tab.id, 'focusForTyping', { ref: info.ref, clear });
    }
    if (clear && !text) await pressKey(tab.id, 'Backspace');
    if (text) {
      if (slowly) {
        for (const ch of text) {
          if (ch === '\n') await pressKey(tab.id, 'Enter');
          else await cdp(tab.id, 'Input.insertText', { text: ch });
          await sleep(30);
        }
      } else {
        await cdp(tab.id, 'Input.insertText', { text });
      }
    }
    const value = await page(tab.id, 'valueOf', { ref: info.ref }).catch(() => undefined);
    let res = {};
    if (submit) {
      const watcher = watchNewTabs(tab.id);
      await pressKey(tab.id, 'Enter');
      res = await settle(tab.id, tab.url, watcher.found);
      watcher.stop();
    }
    return { typedInto: info.desc, ref: info.ref, value: typeof value === 'string' && /password/i.test(info.desc) ? '••••' : value, ...res };
  },

  async pressKey({ tabId, key }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const watcher = watchNewTabs(tab.id);
    for (const k of String(key).split(/\s+/).filter(Boolean)) await pressKey(tab.id, k);
    const res = await settle(tab.id, tab.url, watcher.found);
    watcher.stop();
    return { pressed: key, ...res };
  },

  async selectOption({ tabId, ref, selector, values }) {
    const tab = await resolveTab(tabId);
    return page(tab.id, 'selectOption', { ref, selector, values });
  },

  async scroll({ tabId, ref, selector, deltaX = 0, deltaY = 0, to }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    if (deltaX || deltaY) {
      let x, y;
      if (ref || selector) ({ x, y } = await page(tab.id, 'point', { ref, selector }));
      else {
        const m = await cdp(tab.id, 'Page.getLayoutMetrics');
        const vp = m.cssLayoutViewport || m.layoutViewport;
        x = vp.clientWidth / 2; y = vp.clientHeight / 2;
      }
      await cdp(tab.id, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX, deltaY });
      await sleep(300);
      return page(tab.id, 'scrollState', {});
    }
    const r = await page(tab.id, 'scroll', { ref, selector, to });
    await sleep(200);
    return r;
  },

  async waitFor({ tabId, selector, text, textGone, gone, timeout = 10000, time }) {
    const tab = await resolveTab(tabId);
    if (time) await sleep(Math.min(time, 60000));
    if (!selector && !text && !textGone) return { waited: time || 0 };
    const start = Date.now();
    let last;
    while (true) {
      try {
        last = await withTimeout(page(tab.id, 'check', { selector, text, textGone, gone }), 3000, 'check');
        if (last.ok) return { ok: true, waitedMs: Date.now() - start, ...last };
      } catch { /* page is navigating; retry */ }
      if (Date.now() - start > timeout) {
        const what = [selector && `selector ${selector}${gone ? ' to disappear' : ''}`, text && `text "${text}"${gone ? ' to disappear' : ''}`, textGone && `text "${textGone}" to disappear`].filter(Boolean).join(' and ');
        throw new Error(`Timed out after ${timeout}ms waiting for ${what}`);
      }
      await sleep(250);
    }
  },

  async evaluate({ tabId, expression }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const r = await cdp(tab.id, 'Runtime.evaluate', {
      expression, returnByValue: true, awaitPromise: true, userGesture: true, replMode: true, allowUnsafeEvalBlockedByCSP: true,
    });
    if (r.exceptionDetails) throw new Error(exceptionText(r.exceptionDetails));
    const v = r.result;
    if (v.type === 'undefined') return { tabId: tab.id, result: undefined, type: 'undefined' };
    if (v.subtype === 'node' || v.subtype === 'error' || (v.value === undefined && v.description)) return { tabId: tab.id, result: v.description, type: v.subtype || v.type };
    return { tabId: tab.id, result: v.value ?? v.unserializableValue, type: v.subtype || v.type };
  },

  async inspect({ tabId, ref, selector, properties, matchedRules = true }) {
    const tab = await resolveTab(tabId);
    const info = await page(tab.id, 'inspect', { ref, selector, properties });
    if (matchedRules) {
      try { info.cssRules = await getMatchedRules(tab.id, info.ref); } catch (e) { info.cssRulesError = e.message; }
    }
    return info;
  },

  async audit({ tabId, maxPerType }) {
    const tab = await resolveTab(tabId);
    const r = await page(tab.id, 'audit', { maxPerType });
    const st = tabState(tab.id);
    const errors = st.console.filter((c) => c.nav === st.nav && c.level === 'error');
    const failed = [...st.requests.values()].filter((q) => q.nav === st.nav && (q.failed || q.status >= 400));
    r.consoleErrors = errors.slice(-10).map((c) => c.text.slice(0, 300));
    r.failedRequests = failed.slice(-10).map((q) => `${q.method} ${q.status || q.failed} ${q.url.slice(0, 200)}`);
    return { tabId: tab.id, ...r };
  },

  async injectCss({ tabId, css, remove, id, append }) {
    const tab = await resolveTab(tabId);
    return page(tab.id, 'injectCss', { css, remove, id, append });
  },

  async viewport({ tabId, preset, width, height, deviceScaleFactor, mobile, reset }) {
    const tab = await resolveTab(tabId);
    const st = await attach(tab.id);
    if (reset) {
      st.viewport = null;
      await cdp(tab.id, 'Emulation.clearDeviceMetricsOverride');
      await cdp(tab.id, 'Emulation.setTouchEmulationEnabled', { enabled: false });
    } else {
      const base = preset ? VIEWPORT_PRESETS[preset] : {};
      if (preset && !base) throw new Error(`Unknown preset ${preset}. Options: ${Object.keys(VIEWPORT_PRESETS).join(', ')}`);
      const v = { ...base };
      if (width) v.width = width;
      if (height) v.height = height;
      if (deviceScaleFactor) v.deviceScaleFactor = deviceScaleFactor;
      if (mobile !== undefined) v.mobile = mobile;
      if (!v.width || !v.height) throw new Error('Provide a preset or width and height');
      st.viewport = v;
      await applyViewport(tab.id, v);
    }
    await sleep(200);
    const r = await cdp(tab.id, 'Runtime.evaluate', {
      // Mobile browsers zoom out when content is wider than the device: innerWidth grows past the device width.
      expression: '({width: innerWidth, height: innerHeight, dpr: devicePixelRatio, zoom: +Math.min(1, document.documentElement.clientWidth / innerWidth).toFixed(3)})',
      returnByValue: true,
    });
    const actual = r.result.value;
    const out = { tabId: tab.id, emulated: st.viewport || 'none (real window size)', actual };
    if (st.viewport && st.viewport.mobile && actual.zoom < 0.95) {
      out.warning = `The page is wider than the ${st.viewport.width}px device, so the mobile browser zoomed out to ${Math.round(actual.zoom * 100)}% to fit it. ` +
        'Real phones do the same: this is a horizontal-overflow bug — run browser_audit_layout to find the element causing it.';
    }
    return out;
  },

  async console({ tabId, level, clear, currentPageOnly, limit = 100, search }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const st = tabState(tab.id);
    const order = { debug: 0, log: 1, info: 1, dialog: 2, warn: 2, error: 3 };
    let list = st.console.filter((c) => !currentPageOnly || c.nav === st.nav);
    if (level) list = list.filter((c) => c.level === 'nav' || (order[c.level] ?? 1) >= (order[level] ?? 0));
    if (search) list = list.filter((c) => c.text.toLowerCase().includes(search.toLowerCase()));
    const total = list.length;
    list = list.slice(-limit);
    if (clear) st.console = [];
    return { tabId: tab.id, total, entries: list.map((c) => ({ level: c.level, text: c.text.length > 2000 ? c.text.slice(0, 2000) + '…' : c.text, source: c.source, time: new Date(c.ts).toISOString().slice(11, 23) })) };
  },

  async network({ tabId, filter, type, failedOnly, clear, includePrevious, limit = 100 }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const st = tabState(tab.id);
    let list = [...st.requests.values()].filter((r) => includePrevious || r.nav === st.nav);
    if (filter) list = list.filter((r) => r.url.toLowerCase().includes(filter.toLowerCase()));
    if (type) {
      const types = type.toLowerCase().split(',').map((s) => s.trim());
      list = list.filter((r) => types.includes(r.type.toLowerCase()));
    }
    if (failedOnly) list = list.filter((r) => r.failed || r.status >= 400);
    const earlier = includePrevious ? 0 : [...st.requests.values()].filter((r) => r.nav !== st.nav).length;
    const total = list.length;
    list = list.slice(-limit);
    if (clear) st.requests.clear();
    return {
      tabId: tab.id, total, earlierPageRequests: earlier,
      requests: list.map((r) => ({
        requestId: r.id, method: r.method, status: r.status ?? (r.failed ? 'FAILED' : r.done ? '?' : 'pending'), type: r.type,
        mimeType: r.mimeType, size: r.size, ms: r.ms, url: r.url.length > 300 ? r.url.slice(0, 300) + '…' : r.url,
        failed: r.failed, fromCache: r.fromCache, postData: r.postData ? r.postData.slice(0, 300) : undefined,
      })),
    };
  },

  async networkBody({ tabId, requestId, maxChars = 100000 }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const st = tabState(tab.id);
    const req = st.requests.get(requestId);
    const r = await cdp(tab.id, 'Network.getResponseBody', { requestId }).catch((e) => {
      throw new Error(`${e.message} — the body is only kept while the page that made the request is loaded; reload and retry if it was evicted.`);
    });
    let body = r.body;
    if (r.base64Encoded) {
      if (!/json|text|xml|javascript|html|csv/.test((req && req.mimeType) || '')) return { requestId, base64Encoded: true, mimeType: req && req.mimeType, length: body.length, note: 'Binary body not returned as text.' };
      body = new TextDecoder().decode(Uint8Array.from(atob(body), (c) => c.charCodeAt(0)));
    }
    const total = body.length;
    if (total > maxChars) body = body.slice(0, maxChars);
    return { requestId, url: req && req.url, mimeType: req && req.mimeType, status: req && req.status, totalChars: total, truncated: total > maxChars || undefined, body };
  },

  async content({ tabId, format, selector, mainOnly, maxChars }) {
    const tab = await resolveTab(tabId);
    const r = await page(tab.id, 'content', { format, selector, mainOnly, maxChars });
    return { tabId: tab.id, ...r };
  },

  async extract({ tabId, itemSelector, fields, limit }) {
    const tab = await resolveTab(tabId);
    const r = await page(tab.id, 'extract', { itemSelector, fields, limit });
    return { tabId: tab.id, ...r };
  },

  async check({ tabId, selector, text }) {
    const tab = await resolveTab(tabId);
    return page(tab.id, 'check', { selector, text });
  },

  async uploadFile({ tabId, ref, selector, paths }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    const { ref: r, objectId } = await objectIdFor(tab.id, { ref, selector });
    await cdp(tab.id, 'DOM.setFileInputFiles', { files: paths, objectId });
    return { ref: r, files: paths };
  },

  async dialogPolicy({ tabId, accept = true, promptText = '' }) {
    const tab = await resolveTab(tabId);
    await attach(tab.id);
    tabState(tab.id).dialog = { accept, promptText };
    return { tabId: tab.id, accept, promptText };
  },
};

// "/w/load.php?modules=…long…:12" -> keep the path, trim the query, keep the line.
function shortSource(src) {
  src = src.replace(/^https?:\/\/[^/]+/, '');
  const m = src.match(/^([^?]*)(\?[^:]*)?(:\d+.*)?$/);
  if (!m || !m[2] || m[2].length < 60) return src;
  return m[1] + m[2].slice(0, 40) + '…' + (m[3] || '');
}

async function getMatchedRules(tabId, ref) {
  const st = tabState(tabId);
  if (!st.cssReady) {
    await cdp(tabId, 'DOM.enable');
    await cdp(tabId, 'CSS.enable'); // replays CSS.styleSheetAdded for existing sheets
    st.cssReady = true;
  }
  await cdp(tabId, 'DOM.getDocument', { depth: 0 });
  const r = await cdp(tabId, 'Runtime.evaluate', { expression: `window.__browserMcp.get(${JSON.stringify(ref)})` });
  if (!r.result.objectId) throw new Error('element gone');
  const { nodeId } = await cdp(tabId, 'DOM.requestNode', { objectId: r.result.objectId });
  const m = await cdp(tabId, 'CSS.getMatchedStylesForNode', { nodeId });
  const decl = (style) => (style.cssProperties || []).filter((p) => p.text && !p.disabled).map((p) => `${p.name}: ${p.value}${p.important ? ' !important' : ''}`);
  const out = [];
  if (m.inlineStyle) {
    const d = decl(m.inlineStyle);
    if (d.length) out.push({ selector: 'element.style (inline)', declarations: d });
  }
  for (const match of [...(m.matchedCSSRules || [])].reverse()) {
    const rule = match.rule;
    if (rule.origin === 'user-agent') continue;
    const d = decl(rule.style);
    if (!d.length) continue;
    const header = st.sheets.get(rule.styleSheetId);
    let source = header ? header.sourceURL || '(inline <style>)' : rule.origin;
    if (header && rule.style.range) source += `:${rule.style.range.startLine + 1}`;
    if (header && header.isInline) source += ' (inline <style>)';
    const media = (rule.media || []).map((x) => x.text).filter(Boolean);
    out.push({
      selector: rule.selectorList.text,
      ...(media.length ? { media: media.join(' and ') } : {}),
      source: shortSource(source),
      declarations: d.slice(0, 40),
    });
    if (out.length >= 25) break;
  }
  return out;
}

// ------------------------------------------------------------- popup API
chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
  (async () => {
    if (msg.type === 'getStatus') {
      const controlled = [];
      for (const [id, st] of tabs) {
        if (!st.attached) continue;
        const t = await chrome.tabs.get(id).catch(() => null);
        if (t) controlled.push({ tabId: id, title: t.title, url: t.url });
      }
      return { state: connState, lastError, port: await getPort(), controlled, commandCount };
    }
    if (msg.type === 'setPort') {
      await chrome.storage.local.set({ port: Number(msg.port) || DEFAULT_PORT });
      if (ws) ws.close();
      ws = null;
      reconnectDelay = 1000;
      connect();
      return { ok: true };
    }
    if (msg.type === 'reconnect') {
      reconnectDelay = 1000;
      connect();
      return { ok: true };
    }
    if (msg.type === 'detach') {
      const ids = msg.tabId ? [msg.tabId] : [...tabs.keys()];
      for (const id of ids) {
        await chrome.debugger.detach({ tabId: id }).catch(() => {});
        const st = tabs.get(id);
        if (st) st.attached = false;
      }
      return { ok: true };
    }
  })().then(reply, (e) => reply({ error: e.message }));
  return true;
});
