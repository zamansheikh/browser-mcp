import { writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve as resolvePath } from 'node:path';

const tabId = { type: 'integer', description: 'Tab to act on. Defaults to the tab last opened/selected by an agent, else the active tab.' };
const ref = { type: 'string', description: 'Element ref from browser_snapshot, e.g. "e12". Preferred over selector.' };
const selector = {
  type: 'string',
  description: 'CSS selector, "text=Sign in" (visible text), or "xpath=//button". Searches open shadow roots too.',
};
const target = { tabId, ref, selector };

const text = (t) => ({ content: [{ type: 'text', text: typeof t === 'string' ? t : JSON.stringify(t, null, 2) }] });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function save(path, data) {
  const full = resolvePath(process.cwd(), path);
  await mkdir(dirname(full), { recursive: true });
  await writeFile(full, data);
  return full;
}

function toCsv(rows) {
  const cols = [...new Set(rows.flatMap((r) => Object.keys(r)))];
  const cell = (v) => {
    if (v === null || v === undefined) return '';
    const s = Array.isArray(v) ? v.join(' | ') : typeof v === 'object' ? JSON.stringify(v) : String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.join(','), ...rows.map((r) => cols.map((c) => cell(r[c])).join(','))].join('\n') + '\n';
}

const fieldsSchema = {
  type: 'object',
  description:
    'Map of output field -> spec. Spec is a CSS selector string relative to each item ("h2", "a.title@href" to read an attribute, "." for the item itself) ' +
    'or an object {selector, attr: "text"|"html"|"href"|"src"|"value"|<attribute>, all: bool (return every match as an array), type: "number", regex: "capture (group)"}.',
  additionalProperties: { anyOf: [{ type: 'string' }, { type: 'object' }] },
};

export const TOOLS = [
  // ------------------------------------------------------------- status
  {
    name: 'browser_status',
    description: 'Check whether the browser extension is connected and which mode this server runs in (hub or relaying through another agent\'s hub).',
    inputSchema: { type: 'object', properties: {} },
    annotations: { readOnlyHint: true },
    async handler(_a, { bridge }) {
      const s = await bridge.remoteStatus();
      if (s.extensionConnected || s.mode === 'agent (via hub)') {
        try {
          const b = await bridge.call('status', {}, 10000);
          return text({ ...s, extensionConnected: true, ...b });
        } catch (e) {
          return text({ ...s, extensionConnected: false, error: e.message });
        }
      }
      return text(s);
    },
  },

  // --------------------------------------------------------- navigation
  {
    name: 'browser_tabs',
    description: 'List, open, select (focus) or close browser tabs. "new" opens a tab (optionally at url) and makes it the agent\'s current tab; "select" makes a tab current.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['list', 'new', 'select', 'close', 'current'], default: 'list' },
        tabId,
        url: { type: 'string', description: 'For action "new": page to open.' },
        background: { type: 'boolean', description: 'For "new"/"select": do not focus the tab.' },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('tabs', a));
    },
  },
  {
    name: 'browser_navigate',
    description: 'Open a URL in the current tab and wait for it to load, or go back/forward/reload. Returns final URL, title and HTTP status.',
    inputSchema: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to open (scheme optional).' },
        action: { type: 'string', enum: ['back', 'forward', 'reload'] },
        tabId,
        timeout: { type: 'integer', description: 'Max ms to wait for load (default 30000).' },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('navigate', a, (a.timeout || 30000) + 15000));
    },
  },

  // -------------------------------------------------------- observation
  {
    name: 'browser_snapshot',
    description:
      'Read the page as a compact accessibility-style tree: headings, text, and every interactive element with a [ref=eN] you can pass to click/type/inspect. ' +
      'Use this first to understand a page and find elements — it is cheaper and more precise than a screenshot.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        selector: { type: 'string', description: 'Only snapshot this subtree.' },
        interactiveOnly: { type: 'boolean', description: 'Only list interactive elements (smaller output).' },
        maxChars: { type: 'integer', description: 'Output budget (default 25000).' },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('snapshot', a);
      return text(
        `Tab ${r.tabId}: ${r.title}\nURL: ${r.url}\nViewport ${r.viewport.width}x${r.viewport.height}, scrolled to ${r.viewport.scrollY}, page ${r.pageSize.width}x${r.pageSize.height}\n\n${r.snapshot}`,
      );
    },
  },
  {
    name: 'browser_screenshot',
    description:
      'Capture what the page looks like: the viewport (default), the full scrollable page, or one element (ref/selector). ' +
      'Use it to check visual layout, spacing, alignment, and the result of CSS changes.',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        fullPage: { type: 'boolean' },
        format: { type: 'string', enum: ['png', 'jpeg', 'webp'], description: 'Default png; jpeg is much smaller for long pages.' },
        quality: { type: 'integer', minimum: 1, maximum: 100, description: 'jpeg/webp quality (default 80).' },
        scale: { type: 'string', enum: ['css', 'device'], description: '"css" (default) = 1 image px per CSS px; "device" = full retina resolution.' },
        maxHeight: { type: 'integer', description: 'Cap full-page height in CSS px (default 12000).' },
        savePath: { type: 'string', description: 'Also save the image to this file path.' },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('screenshot', a, 60000);
      const parts = [{ type: 'image', data: r.data, mimeType: r.mimeType }];
      let note = `Screenshot of tab ${r.tabId}: ${r.note}`;
      if (a.savePath) note += `\nSaved to ${await save(a.savePath, Buffer.from(r.data, 'base64'))}`;
      parts.push({ type: 'text', text: note });
      return { content: parts };
    },
  },
  {
    name: 'browser_get_content',
    description:
      'Get page content for reading or scraping: "markdown" (clean readable text with links), "text", "html", "links" (all links), ' +
      '"tables" (every <table> as JSON rows), or "meta" (title, description, OpenGraph, JSON-LD, headings).',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        format: { type: 'string', enum: ['markdown', 'text', 'html', 'links', 'tables', 'meta'], default: 'markdown' },
        selector: { type: 'string', description: 'Limit to this element.' },
        mainOnly: { type: 'boolean', description: 'Use <main>/<article> only, skipping nav and footer.' },
        maxChars: { type: 'integer', description: 'Default 60000.' },
        savePath: { type: 'string', description: 'Save the content to a file instead of returning all of it.' },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('content', { ...a, maxChars: a.savePath ? a.maxChars || 5e7 : a.maxChars });
      const body = typeof r.content === 'string' ? r.content : JSON.stringify(r.content, null, 2);
      if (a.savePath) {
        const p = await save(a.savePath, body);
        return text(`Saved ${r.format} of ${r.url} (${body.length} chars) to ${p}\n\nPreview:\n${body.slice(0, 1500)}`);
      }
      return text(`${r.title}\n${r.url}\n\n${body}`);
    },
  },

  // -------------------------------------------------------- interaction
  {
    name: 'browser_click',
    description:
      'Click an element with a real mouse event (scrolls it into view first). Target by ref (from browser_snapshot), selector, or x/y viewport coordinates. ' +
      'Reports navigation and any new tabs the click opened. Fails with an explanation if another element (e.g. a modal) covers the target.',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        x: { type: 'number' }, y: { type: 'number' },
        button: { type: 'string', enum: ['left', 'right', 'middle'] },
        doubleClick: { type: 'boolean' },
        force: { type: 'boolean', description: 'Click via element.click() even if covered/hidden.' },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('click', a));
    },
  },
  {
    name: 'browser_hover',
    description: 'Move the mouse over an element (to open hover menus or tooltips, or check :hover styles).',
    inputSchema: { type: 'object', properties: { ...target, x: { type: 'number' }, y: { type: 'number' } } },
    async handler(a, { bridge }) {
      return text(await bridge.call('hover', a));
    },
  },
  {
    name: 'browser_type',
    description:
      'Type text into an input, textarea or contenteditable. Replaces the current value by default (clear:false to append). ' +
      'Works with React/Vue controlled inputs. submit:true presses Enter afterwards.',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        text: { type: 'string' },
        clear: { type: 'boolean', default: true },
        submit: { type: 'boolean' },
        slowly: { type: 'boolean', description: 'Type one character at a time (for autocomplete widgets).' },
      },
      required: ['text'],
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('type', a));
    },
  },
  {
    name: 'browser_press_key',
    description: 'Press keys on the focused element: "Enter", "Escape", "Tab", "ArrowDown", "Control+A", "Meta+Shift+K". Space-separate to press several in order.',
    inputSchema: { type: 'object', properties: { tabId, key: { type: 'string' } }, required: ['key'] },
    async handler(a, { bridge }) {
      return text(await bridge.call('pressKey', a));
    },
  },
  {
    name: 'browser_select_option',
    description: 'Choose option(s) in a native <select> by value or visible label.',
    inputSchema: {
      type: 'object',
      properties: { ...target, values: { type: 'array', items: { type: 'string' } } },
      required: ['values'],
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('selectOption', a));
    },
  },
  {
    name: 'browser_scroll',
    description: 'Scroll the page or a scrollable element: by deltaY/deltaX pixels (real wheel events, triggers lazy loading), to "top"/"bottom", or scroll an element into view (ref/selector only).',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        deltaX: { type: 'number' }, deltaY: { type: 'number' },
        to: { type: 'string', enum: ['top', 'bottom', 'left', 'right'] },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('scroll', a));
    },
  },
  {
    name: 'browser_wait_for',
    description: 'Wait until a selector appears (or disappears with gone:true), text appears, or textGone disappears; or just wait `time` ms.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        selector: { type: 'string' },
        text: { type: 'string' },
        textGone: { type: 'string' },
        gone: { type: 'boolean' },
        time: { type: 'integer', description: 'Fixed wait in ms (max 60000).' },
        timeout: { type: 'integer', description: 'Default 10000 ms.' },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('waitFor', a, (a.timeout || 10000) + (a.time || 0) + 15000));
    },
  },
  {
    name: 'browser_upload_file',
    description: 'Set local files on an <input type=file>.',
    inputSchema: {
      type: 'object',
      properties: { ...target, paths: { type: 'array', items: { type: 'string' }, description: 'Absolute file paths.' } },
      required: ['paths'],
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('uploadFile', { ...a, paths: a.paths.map((p) => resolvePath(process.cwd(), p)) }));
    },
  },
  {
    name: 'browser_handle_dialogs',
    description: 'Set how alert/confirm/prompt dialogs are answered on a tab (they are auto-accepted by default and logged to browser_console).',
    inputSchema: { type: 'object', properties: { tabId, accept: { type: 'boolean' }, promptText: { type: 'string' } } },
    async handler(a, { bridge }) {
      return text(await bridge.call('dialogPolicy', a));
    },
  },
  {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the page and return the JSON result. Supports top-level await. Example: "document.querySelectorAll(\'a\').length". ' +
      'Not available when the extension was installed from the Chrome Web Store (browser_status shows evaluateAvailable); prefer the other tools.',
    inputSchema: { type: 'object', properties: { tabId, expression: { type: 'string' } }, required: ['expression'] },
    async handler(a, { bridge }) {
      const r = await bridge.call('evaluate', a);
      return text(r.type === 'undefined' ? 'undefined' : typeof r.result === 'string' ? r.result : r.result);
    },
  },

  // ---------------------------------------------------- frontend / debug
  {
    name: 'browser_inspect',
    description:
      'Explain an element\'s layout: box size and position, margin/border/padding, key computed styles, overflow, parent, ' +
      'and the CSS rules that style it with their source file and line — use it to find which rule to change when fixing the frontend.',
    inputSchema: {
      type: 'object',
      properties: {
        ...target,
        properties: { type: 'array', items: { type: 'string' }, description: 'Extra computed CSS properties to report.' },
        matchedRules: { type: 'boolean', default: true, description: 'Include matching CSS rules with source locations.' },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      return text(await bridge.call('inspect', a));
    },
  },
  {
    name: 'browser_audit_layout',
    description:
      'Scan the page for visual and layout bugs: horizontal overflow and the elements causing it, content sticking out of its container, clipped text, ' +
      'elements covered by others, broken/stretched/oversized images, low color contrast, tiny text and tap targets, unlabeled controls, plus console errors ' +
      'and failed requests. Each issue has a ref for browser_inspect/browser_screenshot. Run it at several viewports (browser_set_viewport).',
    inputSchema: { type: 'object', properties: { tabId, maxPerType: { type: 'integer', description: 'Default 8.' } } },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      return text(await bridge.call('audit', a));
    },
  },
  {
    name: 'browser_set_viewport',
    description:
      'Emulate a screen size to test responsive layouts: preset "mobile" (390x844), "mobile-small" (360x640), "tablet" (820x1180), "laptop" (1366x768), ' +
      '"desktop" (1440x900), "desktop-hd" (1920x1080), or custom width/height. reset:true restores the real window.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        preset: { type: 'string', enum: ['mobile', 'mobile-small', 'tablet', 'laptop', 'desktop', 'desktop-hd'] },
        width: { type: 'integer' }, height: { type: 'integer' },
        deviceScaleFactor: { type: 'number' }, mobile: { type: 'boolean' },
        reset: { type: 'boolean' },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('viewport', a));
    },
  },
  {
    name: 'browser_inject_css',
    description:
      'Live-test a CSS fix on the page without editing files: inject CSS (replaces the previous CSS with the same id), then screenshot/audit to verify. ' +
      'remove:true removes it. Once it looks right, apply the same change to the source code. Lost on reload.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        css: { type: 'string' },
        id: { type: 'string', description: 'Name of this style block (default "default").' },
        append: { type: 'boolean' },
        remove: { type: 'boolean' },
      },
    },
    async handler(a, { bridge }) {
      return text(await bridge.call('injectCss', a));
    },
  },
  {
    name: 'browser_console',
    description: 'Read console messages, uncaught errors, browser warnings (CSP, mixed content, failed loads) and auto-handled dialogs for the current page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        level: { type: 'string', enum: ['debug', 'log', 'warn', 'error'], description: 'Minimum level.' },
        search: { type: 'string' },
        currentPageOnly: { type: 'boolean', description: 'Only messages since the last navigation (default: recent history across pages, separated by NAV lines).' },
        limit: { type: 'integer', description: 'Default 100 (most recent).' },
        clear: { type: 'boolean' },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('console', a);
      if (!r.entries.length) return text(`No console messages on tab ${r.tabId} (messages are captured from the moment the agent first touched the tab; reload to capture page load).`);
      return text(`${r.total} message(s), showing ${r.entries.length}:\n` + r.entries.map((e) => `[${e.time}] ${e.level.toUpperCase()} ${e.text}${e.source ? `  (${e.source})` : ''}`).join('\n'));
    },
  },
  {
    name: 'browser_network',
    description:
      'List network requests made by the current page (method, status, type, size, timing). Filter by URL substring, type ("xhr,fetch", "document", "script", "image"…), or failedOnly. ' +
      'Great for finding the JSON API behind a page when scraping — then read it with browser_network_body.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        filter: { type: 'string' },
        type: { type: 'string' },
        failedOnly: { type: 'boolean' },
        includePrevious: { type: 'boolean', description: 'Include requests from pages before the last navigation.' },
        limit: { type: 'integer', description: 'Default 100 (most recent).' },
        clear: { type: 'boolean' },
      },
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('network', a);
      if (!r.requests.length) {
        const hint = r.earlierPageRequests ? ` ${r.earlierPageRequests} request(s) from earlier pages exist — pass includePrevious:true.` : ' Requests are captured once the agent has touched the tab; reload to capture the page load.';
        return text(`No matching requests for the current page on tab ${r.tabId}.${hint}`);
      }
      const kb = (n) => (n === undefined ? '' : n > 1024 ? `${(n / 1024).toFixed(1)}KB` : `${n}B`);
      return text(
        `${r.total} request(s), showing ${r.requests.length}:\n` +
          r.requests.map((q) => `[${q.requestId}] ${q.method} ${q.status} ${q.type}${q.mimeType ? ' ' + q.mimeType : ''} ${kb(q.size)} ${q.ms !== undefined ? q.ms + 'ms' : ''} ${q.url}${q.failed ? `  !! ${q.failed}` : ''}${q.postData ? `\n    body: ${q.postData}` : ''}`).join('\n'),
      );
    },
  },
  {
    name: 'browser_network_body',
    description: 'Get the response body of a request listed by browser_network (e.g. an API\'s JSON). Optionally save it to a file.',
    inputSchema: {
      type: 'object',
      properties: { tabId, requestId: { type: 'string' }, maxChars: { type: 'integer' }, savePath: { type: 'string' } },
      required: ['requestId'],
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('networkBody', { ...a, maxChars: a.savePath ? 5e8 : a.maxChars });
      if (a.savePath && r.body !== undefined) {
        const p = await save(a.savePath, r.body);
        return text(`Saved ${r.totalChars} chars from ${r.url} to ${p}`);
      }
      return text(r);
    },
  },

  // ----------------------------------------------------------- scraping
  {
    name: 'browser_extract',
    description:
      'Extract structured data from the current page. Give itemSelector (one element per record, e.g. ".product") and fields relative to each item, ' +
      'e.g. {"name": "h2", "price": {"selector": ".price", "type": "number"}, "url": "a@href", "image": "img@src"}. Without itemSelector, fields are read once from the whole page.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        itemSelector: { type: 'string' },
        fields: fieldsSchema,
        limit: { type: 'integer', description: 'Max items (default 1000).' },
        savePath: { type: 'string', description: 'Save results as .json or .csv.' },
      },
      required: ['fields'],
    },
    annotations: { readOnlyHint: true },
    async handler(a, { bridge }) {
      const r = await bridge.call('extract', a);
      let note = '';
      if (a.savePath) note = `\nSaved to ${await save(a.savePath, a.savePath.endsWith('.csv') ? toCsv(r.items) : JSON.stringify(r.items, null, 2))}`;
      const shown = r.items.slice(0, 100);
      return text(`${r.items.length} item(s) from ${r.url}${r.items.length > shown.length ? ` (showing first ${shown.length})` : ''}${note}\n${JSON.stringify(shown, null, 2)}`);
    },
  },
  {
    name: 'browser_scrape',
    description:
      'Scrape many records across pages in one call: optionally open url, extract items with itemSelector+fields, then follow pagination by clicking nextSelector ' +
      '(up to maxPages) and/or scroll to load more (infiniteScroll = number of scrolls). Deduplicates, and saves to .json/.csv with savePath. ' +
      'Uses your real logged-in browser session, so it works on sites that need login or run heavy JavaScript.',
    inputSchema: {
      type: 'object',
      properties: {
        tabId,
        url: { type: 'string' },
        itemSelector: { type: 'string' },
        fields: fieldsSchema,
        nextSelector: { type: 'string', description: 'Selector of the "next page" link/button.' },
        maxPages: { type: 'integer', default: 1 },
        infiniteScroll: { type: 'integer', description: 'Scroll to bottom this many times per page, extracting after each.' },
        delayMs: { type: 'integer', description: 'Pause after each page/scroll (default 1200). Be polite to servers.' },
        limit: { type: 'integer', description: 'Stop after this many items.' },
        savePath: { type: 'string' },
      },
      required: ['itemSelector', 'fields'],
    },
    async handler(a, ctx) {
      return text(await scrape(a, ctx));
    },
  },
];

async function scrape(a, { bridge, progress }) {
  const delay = a.delayMs ?? 1200;
  const maxPages = Math.max(1, a.maxPages || 1);
  let tab = a.tabId;
  if (a.url) tab = (await bridge.call('navigate', { tabId: tab, url: a.url }, 45000)).tabId;
  else tab = (await bridge.call('tabs', { action: 'current', tabId: tab })).tabId;

  const items = [];
  const seen = new Set();
  const log = [];
  const take = (list) => {
    let added = 0;
    for (const it of list) {
      const key = JSON.stringify(it);
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(it);
      added++;
      if (a.limit && items.length >= a.limit) break;
    }
    return added;
  };
  const extract = async () => (await bridge.call('extract', { tabId: tab, itemSelector: a.itemSelector, fields: a.fields })).items;
  const full = () => a.limit && items.length >= a.limit;

  let page = 1;
  for (; page <= maxPages && !full(); page++) {
    await bridge.call('waitFor', { tabId: tab, selector: a.itemSelector, timeout: 10000 }, 30000).catch(() => {});
    let added = take(await extract());
    for (let s = 0; s < (a.infiniteScroll || 0) && !full(); s++) {
      const st = await bridge.call('scroll', { tabId: tab, to: 'bottom' });
      await sleep(delay);
      const n = take(await extract());
      added += n;
      if (n === 0 && st.atBottom) break;
    }
    const url = (await bridge.call('tabs', { action: 'current', tabId: tab })).url;
    log.push(`page ${page}: +${added} (${url})`);
    progress?.(page, maxPages, `page ${page}: ${items.length} items`);
    if (page === maxPages || !a.nextSelector || full()) break;
    const next = await bridge.call('check', { tabId: tab, selector: a.nextSelector }).catch(() => ({ count: 0 }));
    if (!next.count || next.disabled) { log.push('no enabled next-page control; stopping'); break; }
    await bridge.call('click', { tabId: tab, selector: a.nextSelector });
    await sleep(delay);
  }

  let saved = '';
  if (a.savePath) saved = await save(a.savePath, a.savePath.endsWith('.csv') ? toCsv(items) : JSON.stringify(items, null, 2));
  const preview = items.slice(0, saved ? 10 : 200);
  return (
    `Scraped ${items.length} unique item(s) over ${Math.min(page, maxPages)} page(s).\n${log.join('\n')}` +
    (saved ? `\nSaved to ${saved}` : '') +
    `\n\n${preview.length < items.length ? `First ${preview.length}:\n` : ''}${JSON.stringify(preview, null, 2)}`
  );
}
