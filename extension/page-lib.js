// Code that runs inside the inspected page (main world) via Runtime.evaluate.
// pageLib is serialized with Function.prototype.toString, so it must stay
// self-contained: no imports, no references to anything outside its body.

export const PAGE_LIB_VERSION = 5;

export function pageLib(VERSION) {
  if (window.__browserMcp && window.__browserMcp.v === VERSION) return;

  // ---------------------------------------------------------------- refs
  // Refs map short ids (e12) to elements without touching the DOM. They stay
  // valid across snapshots until the element is removed or the page navigates.
  const prev = window.__browserMcp;
  const refs = prev && prev.refs ? prev.refs : new Map();
  const elRef = prev && prev.elRef ? prev.elRef : new WeakMap();
  let counter = prev && prev.counter ? prev.counter() : 0;

  function refFor(el) {
    let r = elRef.get(el);
    if (r && refs.get(r) && refs.get(r).deref() === el) return r;
    r = 'e' + ++counter;
    refs.set(r, new WeakRef(el));
    elRef.set(el, r);
    return r;
  }

  function get(ref) {
    const w = refs.get(ref);
    const el = w && w.deref();
    return el && el.isConnected ? el : null;
  }

  // ------------------------------------------------------------- queries
  function* allRoots(root) {
    yield root;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n) {
      if (n.shadowRoot) yield* allRoots(n.shadowRoot);
      n = walker.nextNode();
    }
  }

  function queryAll(selector, scope) {
    scope = scope || document;
    if (selector.startsWith('text=')) return findByText(selector.slice(5), scope);
    if (selector.startsWith('xpath=') || selector.startsWith('//')) {
      const xp = selector.startsWith('xpath=') ? selector.slice(6) : selector;
      const res = document.evaluate(xp, scope, null, XPathResult.ORDERED_NODE_SNAPSHOT_TYPE, null);
      const out = [];
      for (let i = 0; i < res.snapshotLength; i++) out.push(res.snapshotItem(i));
      return out;
    }
    const direct = [...scope.querySelectorAll(selector)];
    if (direct.length) return direct;
    // Fall back to searching open shadow roots.
    const out = [];
    for (const root of allRoots(scope)) {
      if (root === scope) continue;
      out.push(...root.querySelectorAll(selector));
    }
    return out;
  }

  function findByText(text, scope) {
    let exact = false;
    if (/^".*"$/.test(text)) { exact = true; text = text.slice(1, -1); }
    const needle = text.trim().toLowerCase();
    const matches = [];
    const walker = document.createTreeWalker(scope === document ? document.body : scope, NodeFilter.SHOW_ELEMENT);
    let n = walker.currentNode;
    while (n) {
      if (!SKIP_TAGS.has(n.tagName) && isShown(n)) {
        const t = (n.innerText || '').trim().toLowerCase();
        if (exact ? t === needle : t.includes(needle)) matches.push(n);
      }
      n = walker.nextNode();
    }
    // Keep the deepest matches (no descendant also matching).
    return matches.filter((m) => !matches.some((o) => o !== m && m.contains(o)));
  }

  function resolve(args) {
    if (args.ref) {
      const el = get(args.ref);
      if (!el) throw new Error(`Ref ${args.ref} not found (page changed or navigated) — take a new browser_snapshot`);
      return el;
    }
    if (args.selector) {
      const list = queryAll(args.selector);
      const el = list.find(isShown) || list[0];
      if (!el) throw new Error(`No element matches selector: ${args.selector}`);
      return el;
    }
    throw new Error('Provide a ref (from browser_snapshot) or a selector');
  }

  // ---------------------------------------------------------- visibility
  const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'TEMPLATE', 'HEAD', 'META', 'LINK', 'TITLE']);

  function isShown(el) {
    if (!el.isConnected) return false;
    if (el.checkVisibility) {
      if (!el.checkVisibility({ visibilityProperty: true, contentVisibilityAuto: false })) return false;
    } else {
      const s = getComputedStyle(el);
      if (s.display === 'none' || s.visibility === 'hidden') return false;
    }
    return true;
  }

  function hasBox(el) {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  function describe(el) {
    if (!el || el.nodeType !== 1) return String(el);
    let s = el.tagName.toLowerCase();
    if (el.id) s += '#' + el.id;
    const cls = [...el.classList].slice(0, 3);
    if (cls.length) s += '.' + cls.join('.');
    return s;
  }

  function cssPath(el) {
    if (!el || el.nodeType !== 1) return '';
    const doc = el.ownerDocument;
    const uniq = (sel) => { try { return doc.querySelectorAll(sel).length === 1; } catch { return false; } };
    if (el.id && uniq('#' + CSS.escape(el.id))) return '#' + CSS.escape(el.id);
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && cur !== doc.documentElement) {
      if (cur !== el && cur.id && uniq('#' + CSS.escape(cur.id))) {
        parts.unshift('#' + CSS.escape(cur.id));
        break;
      }
      let part = cur.tagName.toLowerCase();
      const cls = [...cur.classList].filter((c) => /^[a-zA-Z_-][\w-]*$/.test(c) && !/\d{4,}/.test(c)).slice(0, 2);
      if (cls.length) part += '.' + cls.map((c) => CSS.escape(c)).join('.');
      const parent = cur.parentElement;
      if (parent) {
        const sibs = [...parent.children].filter((s) => s.tagName === cur.tagName);
        if (sibs.length > 1) part += `:nth-of-type(${sibs.indexOf(cur) + 1})`;
      }
      parts.unshift(part);
      if (uniq(parts.join(' > '))) return parts.join(' > ');
      cur = parent;
    }
    return parts.join(' > ');
  }

  // ------------------------------------------------------ accessibility
  const INPUT_ROLES = {
    button: 'button', submit: 'button', reset: 'button', image: 'button',
    checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton',
    search: 'searchbox', file: 'filepicker', color: 'colorpicker', hidden: null,
  };
  const TAG_ROLES = {
    BUTTON: 'button', TEXTAREA: 'textbox', IMG: 'img', NAV: 'navigation', MAIN: 'main',
    HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog',
    SUMMARY: 'button', DETAILS: 'group', FIELDSET: 'group', UL: 'list', OL: 'list', LI: 'listitem',
    TABLE: 'table', TR: 'row', TH: 'columnheader', TD: 'cell', OPTION: 'option', IFRAME: 'iframe',
    P: 'paragraph', ARTICLE: 'article', FIGURE: 'figure', BLOCKQUOTE: 'blockquote', VIDEO: 'video',
    AUDIO: 'audio', LABEL: 'label', H1: 'heading', H2: 'heading', H3: 'heading', H4: 'heading',
    H5: 'heading', H6: 'heading', CANVAS: 'canvas', PRE: 'code',
  };
  const INTERACTIVE_ROLES = new Set([
    'button', 'link', 'textbox', 'searchbox', 'checkbox', 'radio', 'combobox', 'listbox', 'slider',
    'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option',
    'treeitem', 'filepicker', 'colorpicker',
  ]);
  const CONTAINER_ROLES = new Set([
    'navigation', 'main', 'banner', 'contentinfo', 'complementary', 'form', 'dialog', 'alertdialog',
    'group', 'list', 'listitem', 'table', 'row', 'cell', 'columnheader', 'rowheader', 'paragraph',
    'article', 'figure', 'blockquote', 'region', 'menu', 'menubar', 'tablist', 'tabpanel', 'toolbar',
    'grid', 'gridcell', 'tree', 'alert', 'status', 'search', 'label', 'code',
  ]);

  function roleOf(el) {
    const explicit = el.getAttribute('role');
    if (explicit && explicit !== 'presentation' && explicit !== 'none') return explicit.split(/\s+/)[0];
    const tag = el.tagName;
    if (tag === 'A') return el.hasAttribute('href') ? 'link' : null;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      return t in INPUT_ROLES ? INPUT_ROLES[t] : 'textbox';
    }
    if (tag === 'SELECT') return el.multiple || el.size > 1 ? 'listbox' : 'combobox';
    if (tag === 'SECTION') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return 'textbox';
    return TAG_ROLES[tag] || null;
  }

  function clean(s, max) {
    s = (s || '').replace(/\s+/g, ' ').trim();
    return max && s.length > max ? s.slice(0, max - 1) + '…' : s;
  }

  function accName(el) {
    const aria = el.getAttribute('aria-label');
    if (aria && aria.trim()) return clean(aria, 100);
    const lb = el.getAttribute('aria-labelledby');
    if (lb) {
      const t = lb.split(/\s+/).map((id) => { const n = el.ownerDocument.getElementById(id); return n ? n.innerText || n.textContent : ''; }).join(' ');
      if (t.trim()) return clean(t, 100);
    }
    const tag = el.tagName;
    if (tag === 'IMG' || (tag === 'INPUT' && el.type === 'image')) return clean(el.getAttribute('alt') || el.getAttribute('title'), 100);
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
      if (el.labels && el.labels.length) {
        const t = [...el.labels].map((l) => l.innerText).join(' ');
        if (t.trim()) return clean(t, 100);
      }
      if (['submit', 'button', 'reset'].includes(el.type)) return clean(el.value || el.type, 100);
      return clean(el.getAttribute('title') || el.getAttribute('placeholder') || '', 100);
    }
    const txt = clean(el.innerText, 100);
    if (txt) return txt;
    // Icon-only controls: take the name from a labelled descendant.
    for (const d of el.querySelectorAll ? el.querySelectorAll('img[alt], svg, [aria-label], [title]') : []) {
      const n = d.getAttribute('aria-label') || d.getAttribute('alt') || d.getAttribute('title') || (d.tagName.toLowerCase() === 'svg' && d.querySelector('title') ? d.querySelector('title').textContent : '');
      if (n && n.trim()) return clean(n, 100);
    }
    return clean(el.getAttribute('title') || el.textContent, 100);
  }

  function isInteractive(el, role) {
    if (role && INTERACTIVE_ROLES.has(role)) return true;
    if (el.isContentEditable && !(el.parentElement && el.parentElement.isContentEditable)) return true;
    if (el.hasAttribute('onclick') || typeof el.onclick === 'function') return true;
    const ti = el.getAttribute('tabindex');
    if (ti !== null && +ti >= 0 && !CONTAINER_ROLES.has(role)) return true;
    const cur = getComputedStyle(el).cursor;
    if (cur === 'pointer' && el.parentElement && getComputedStyle(el.parentElement).cursor !== 'pointer') return true;
    return false;
  }

  function shortHref(el) {
    const href = el.getAttribute('href');
    if (!href) return '';
    try {
      const u = new URL(el.href);
      if (u.origin === location.origin) return clean(u.pathname + u.search + u.hash, 80);
      return clean(u.href, 100);
    } catch { return clean(href, 80); }
  }

  function interactiveAttrs(el, role) {
    const a = [];
    const tag = el.tagName;
    if (tag === 'INPUT') {
      const t = (el.getAttribute('type') || 'text').toLowerCase();
      if (!['text', 'checkbox', 'radio', 'submit', 'button'].includes(t)) a.push(`type=${t}`);
      if (el.type === 'checkbox' || el.type === 'radio') { if (el.checked) a.push('checked'); }
      else if (!['submit', 'button', 'reset', 'image', 'file'].includes(el.type)) {
        a.push(`value=${JSON.stringify(el.type === 'password' && el.value ? '••••' : clean(el.value, 60))}`);
        if (el.placeholder && accName(el) !== clean(el.placeholder, 100)) a.push(`placeholder=${JSON.stringify(clean(el.placeholder, 40))}`);
      }
    } else if (tag === 'TEXTAREA') {
      a.push(`value=${JSON.stringify(clean(el.value, 60))}`);
    } else if (tag === 'SELECT') {
      const sel = [...el.selectedOptions].map((o) => clean(o.textContent, 40));
      a.push(`selected=${JSON.stringify(sel.join(', '))}`);
      const opts = [...el.options].slice(0, 25).map((o) => clean(o.textContent, 30));
      a.push(`options=${JSON.stringify(opts)}${el.options.length > 25 ? '+' + (el.options.length - 25) : ''}`);
    } else if (el.isContentEditable) {
      a.push(`value=${JSON.stringify(clean(el.innerText, 60))}`);
    }
    if (role === 'link') { const h = shortHref(el); if (h) a.push(`-> ${h}`); }
    if (el.disabled || el.getAttribute('aria-disabled') === 'true') a.push('disabled');
    const exp = el.getAttribute('aria-expanded'); if (exp) a.push(`expanded=${exp}`);
    if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-pressed') === 'true') a.push('checked');
    if (el.getAttribute('aria-selected') === 'true') a.push('selected');
    if (el.required) a.push('required');
    if (el === el.ownerDocument.activeElement) a.push('focused');
    return a;
  }

  // ----------------------------------------------------------- snapshot
  function childNodesOf(el) {
    if (el.tagName === 'SLOT') return el.assignedNodes({ flatten: true });
    if (el.shadowRoot) return [...el.shadowRoot.childNodes];
    if (el.tagName === 'IFRAME') {
      try { const d = el.contentDocument; if (d && d.body) return [d.body]; } catch {}
      return [];
    }
    return [...el.childNodes];
  }

  function build(el, opts, depth) {
    const items = [];
    if (depth > 60) return items;
    for (const node of childNodesOf(el)) {
      if (node.nodeType === 3) {
        if (opts.interactiveOnly) continue;
        const t = clean(node.textContent);
        if (t) items.push({ text: t });
        continue;
      }
      if (node.nodeType !== 1 || SKIP_TAGS.has(node.tagName)) continue;
      if (!isShown(node)) continue;
      if (node.tagName === 'svg' || node.tagName === 'SVG') {
        const n = node.getAttribute('aria-label') || (node.querySelector('title') || {}).textContent;
        if (n && !opts.interactiveOnly) items.push({ role: 'img', name: clean(n, 80) });
        continue;
      }
      const role = roleOf(node);
      if (isInteractive(node, role) && hasBox(node)) {
        const item = { role: role || 'clickable', ref: refFor(node), attrs: interactiveAttrs(node, role) };
        if (!role) {
          // Non-semantic clickable (div with a click handler / cursor:pointer).
          const kids = build(node, opts, depth + 1);
          const onlyText = kids.every((k) => k.text);
          const txt = kids.map((k) => k.text).join(' ');
          if (onlyText && txt.length <= 100) item.name = txt;
          else item.children = kids;
        } else {
          item.name = accName(node);
        }
        items.push(item);
        continue;
      }
      if (role === 'img') {
        if (!opts.interactiveOnly) items.push({ role: 'img', name: accName(node) || '(no alt)', attrs: [] });
        continue;
      }
      if (role === 'heading') {
        const level = node.getAttribute('aria-level') || (node.tagName.match(/^H(\d)$/) || [])[1];
        const kids = build(node, { ...opts, interactiveOnly: true }, depth + 1);
        items.push({ role: 'heading', name: clean(node.innerText, 150), attrs: level ? [`level=${level}`] : [], children: kids });
        continue;
      }
      if (role === 'iframe') {
        const kids = build(node, opts, depth + 1);
        items.push({ role: 'iframe', name: clean(node.title || node.name || node.src, 80), ref: refFor(node), attrs: [], children: kids, keep: true });
        continue;
      }
      if (role && CONTAINER_ROLES.has(role)) {
        const kids = build(node, opts, depth + 1);
        const name = ['navigation', 'region', 'dialog', 'form', 'group', 'table'].includes(role)
          ? clean(node.getAttribute('aria-label') || '', 60) : '';
        if (kids.length) items.push({ role, name, attrs: [], children: kids });
        continue;
      }
      items.push(...build(node, opts, depth + 1));
    }
    return items;
  }

  function serialize(items, indent, out, budget) {
    // Merge adjacent text items.
    const merged = [];
    for (const it of items) {
      const last = merged[merged.length - 1];
      if (it.text && last && last.text) last.text += ' ' + it.text;
      else merged.push(it.text ? { text: it.text } : it);
    }
    const pad = '  '.repeat(indent);
    for (const it of merged) {
      if (budget.used > budget.max) return;
      let line;
      if (it.text) {
        line = `${pad}- text: ${clean(it.text, 300)}`;
      } else {
        line = `${pad}- ${it.role}`;
        if (it.name) line += ` ${JSON.stringify(it.name)}`;
        if (it.attrs && it.attrs.length) line += ` [${it.attrs.join('] [')}]`;
        if (it.ref) line += ` [ref=${it.ref}]`;
        const kids = it.children || [];
        if (kids.length && kids.every((k) => k.text)) {
          line += ': ' + clean(kids.map((k) => k.text).join(' '), 300);
        } else if (kids.length) {
          line += ':';
          out.push(line);
          budget.used += line.length + 1;
          serialize(kids, indent + 1, out, budget);
          continue;
        }
      }
      out.push(line);
      budget.used += line.length + 1;
    }
  }

  function snapshot(args) {
    const root = args.selector ? resolve({ selector: args.selector }) : document.body;
    if (!root) return '(empty page)';
    const items = build(root, { interactiveOnly: !!args.interactiveOnly }, 0);
    const out = [];
    const budget = { used: 0, max: args.maxChars || 25000 };
    serialize(items, 0, out, budget);
    let text = out.join('\n');
    if (budget.used > budget.max) {
      text = text.slice(0, budget.max) + `\n… (truncated at ${budget.max} chars — pass selector to scope, interactiveOnly:true, or a larger maxChars)`;
    }
    return {
      url: location.href,
      title: document.title,
      viewport: { width: innerWidth, height: innerHeight, scrollX: Math.round(scrollX), scrollY: Math.round(scrollY) },
      pageSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
      snapshot: text || '(no visible content)',
    };
  }

  // ---------------------------------------------------------- geometry
  function frameOffset(el) {
    let x = 0, y = 0;
    let win = el.ownerDocument.defaultView;
    while (win && win.frameElement) {
      const fe = win.frameElement;
      const r = fe.getBoundingClientRect();
      x += r.left + fe.clientLeft;
      y += r.top + fe.clientTop;
      win = win.parent;
    }
    return { x, y };
  }

  // Scrolls the element into view and returns a viewport point to click.
  function point(args) {
    const el = resolve(args);
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    const rects = [...el.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const r = rects[0] || el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) throw new Error(`Element ${describe(el)} has no size (hidden?)`);
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const off = frameOffset(el);
    let obscuredBy = null;
    const hit = el.ownerDocument.elementFromPoint(cx, cy);
    if (hit && hit !== el && !el.contains(hit)) {
      const lbl = hit.closest && hit.closest('label');
      const labelled = lbl && el.labels && [...el.labels].includes(lbl);
      const shadowHost = el.getRootNode && el.getRootNode().host;
      if (!labelled && !(shadowHost && (hit === shadowHost || shadowHost.contains(hit))) && !(hit.contains(el) && getComputedStyle(el).pointerEvents === 'none')) {
        obscuredBy = describe(hit);
      }
    }
    // Input events use visual-viewport coordinates; they differ from layout
    // coordinates when the page is zoomed (e.g. mobile emulation zoomed out).
    const vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, scale: 1 };
    return {
      ref: refFor(el),
      x: Math.round((cx + off.x - vv.offsetLeft) * vv.scale),
      y: Math.round((cy + off.y - vv.offsetTop) * vv.scale),
      desc: describe(el),
      name: accName(el),
      disabled: !!(el.disabled || el.getAttribute('aria-disabled') === 'true'),
      obscuredBy,
    };
  }

  // Page-coordinate rect (for element screenshots).
  function pageRect(args) {
    const el = resolve(args);
    el.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
    const r = el.getBoundingClientRect();
    const off = frameOffset(el);
    return {
      x: r.left + off.x + scrollX, y: r.top + off.y + scrollY,
      width: r.width, height: r.height, desc: describe(el), ref: refFor(el),
    };
  }

  function jsClick(args) {
    const el = resolve(args);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.click();
    return { desc: describe(el), ref: refFor(el) };
  }

  function focusForTyping(args) {
    const el = resolve(args);
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    const doc = el.ownerDocument;
    if (args.clear) {
      if (typeof el.select === 'function' && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) {
        el.select();
      } else if (el.isContentEditable) {
        const range = doc.createRange();
        range.selectNodeContents(el);
        const sel = doc.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA') {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch {}
    }
    const focused = doc.activeElement === el || el.contains(doc.activeElement);
    return { ref: refFor(el), desc: describe(el), focused };
  }

  function valueOf(args) {
    const el = resolve(args);
    if ('value' in el && el.tagName !== 'BUTTON') return el.value;
    return el.isContentEditable ? el.innerText : null;
  }

  function selectOption(args) {
    const el = resolve(args);
    if (el.tagName !== 'SELECT') throw new Error(`${describe(el)} is not a <select>; click the custom dropdown instead`);
    const wanted = (Array.isArray(args.values) ? args.values : [args.values]).map(String);
    const chosen = [];
    for (const o of el.options) {
      const hit = wanted.some((w) => o.value === w || clean(o.textContent) === w || clean(o.label) === w);
      if (hit && (el.multiple || !chosen.length)) { o.selected = true; chosen.push(clean(o.textContent)); }
      else if (el.multiple) o.selected = false;
    }
    if (!chosen.length) throw new Error(`No option matches ${JSON.stringify(wanted)}. Options: ${JSON.stringify([...el.options].map((o) => clean(o.textContent)))}`);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { selected: chosen };
  }

  function scroll(args) {
    let target = null;
    if (args.ref || args.selector) target = resolve(args);
    const scroller = target && (target.scrollHeight > target.clientHeight + 1 || target.scrollWidth > target.clientWidth + 1) && getComputedStyle(target).overflowY !== 'visible'
      ? target : null;
    if (args.to) {
      const s = scroller || document.scrollingElement;
      if (args.to === 'top') s.scrollTo({ top: 0, behavior: 'instant' });
      else if (args.to === 'bottom') s.scrollTo({ top: s.scrollHeight, behavior: 'instant' });
      else if (args.to === 'left') s.scrollTo({ left: 0, behavior: 'instant' });
      else if (args.to === 'right') s.scrollTo({ left: s.scrollWidth, behavior: 'instant' });
    } else if (target && !args.deltaX && !args.deltaY) {
      target.scrollIntoView({ block: 'center', behavior: 'instant' });
    }
    return scrollState();
  }

  function scrollState() {
    const s = document.scrollingElement;
    return {
      scrollX: Math.round(scrollX), scrollY: Math.round(scrollY),
      pageHeight: s.scrollHeight, viewportHeight: innerHeight,
      atBottom: Math.ceil(scrollY + innerHeight) >= s.scrollHeight - 2,
    };
  }

  function check(args) {
    let ok = true;
    const res = {};
    if (args.selector) {
      const list = queryAll(args.selector).filter((e) => isShown(e) && hasBox(e));
      res.count = list.length;
      res.disabled = !!(list[0] && (list[0].disabled || list[0].getAttribute('aria-disabled') === 'true'));
      ok = args.gone ? list.length === 0 : list.length > 0;
    }
    if (args.text) {
      const has = (document.body.innerText || '').toLowerCase().includes(String(args.text).toLowerCase());
      ok = ok && (args.gone ? !has : has);
    }
    if (args.textGone) {
      const has = (document.body.innerText || '').toLowerCase().includes(String(args.textGone).toLowerCase());
      ok = ok && !has;
    }
    res.ok = ok;
    res.readyState = document.readyState;
    return res;
  }

  // ----------------------------------------------------------- inspect
  const STYLE_PROPS = [
    'display', 'position', 'top', 'right', 'bottom', 'left', 'z-index', 'float', 'box-sizing',
    'width', 'height', 'min-width', 'max-width', 'min-height', 'max-height',
    'margin', 'padding', 'border', 'border-radius', 'outline',
    'overflow-x', 'overflow-y', 'flex-direction', 'flex-wrap', 'flex', 'align-items', 'align-self',
    'justify-content', 'gap', 'grid-template-columns', 'grid-template-rows', 'grid-column', 'grid-row', 'order',
    'font-family', 'font-size', 'font-weight', 'line-height', 'letter-spacing', 'text-align',
    'white-space', 'text-overflow', 'word-break', 'color', 'background-color', 'background-image',
    'opacity', 'visibility', 'transform', 'box-shadow', 'cursor', 'pointer-events', 'object-fit', 'aspect-ratio',
  ];
  const BORING = new Set(['none', 'normal', 'auto', '0px', 'visible', 'rgba(0, 0, 0, 0)', 'baseline', '0', 'start']);

  function inspect(args) {
    const el = resolve(args);
    const cs = getComputedStyle(el);
    const r = el.getBoundingClientRect();
    const styles = {};
    const pcs = el.parentElement ? getComputedStyle(el.parentElement) : null;
    const isFlex = /flex/.test(cs.display), isGrid = /grid/.test(cs.display);
    const inFlexOrGrid = pcs && /flex|grid/.test(pcs.display);
    const relevant = (p, v) => {
      if (['display', 'position', 'width', 'height', 'overflow-x', 'overflow-y'].includes(p)) return true;
      if (!v || BORING.has(v)) return false;
      if (['flex-direction', 'flex-wrap'].includes(p)) return isFlex;
      if (['align-items', 'justify-content', 'gap'].includes(p)) return isFlex || isGrid;
      if (['grid-template-columns', 'grid-template-rows'].includes(p)) return isGrid;
      if (['flex', 'align-self', 'order', 'grid-column', 'grid-row'].includes(p)) return inFlexOrGrid;
      if (['object-fit', 'aspect-ratio'].includes(p)) return ['IMG', 'VIDEO', 'CANVAS', 'IFRAME'].includes(el.tagName) || p === 'aspect-ratio';
      if (['top', 'right', 'bottom', 'left', 'z-index'].includes(p)) return cs.position !== 'static';
      if (p === 'opacity') return v !== '1';
      if (p === 'text-overflow') return v !== 'clip';
      if (p === 'outline' || p === 'border') return !/\bnone\b|^0px/.test(v);
      if (p === 'float') return v !== 'none';
      return true;
    };
    for (const p of STYLE_PROPS) {
      const v = cs.getPropertyValue(p);
      if (relevant(p, v)) styles[p] = v;
    }
    for (const p of args.properties || []) styles[p] = cs.getPropertyValue(p);
    const attrs = {};
    for (const a of el.attributes) if (a.name !== 'style') attrs[a.name] = clean(a.value, 200);
    const parent = el.parentElement;
    const pr = parent && parent.getBoundingClientRect();
    const px = (v) => Math.round(parseFloat(v) * 10) / 10 || 0;
    const box = (pfx, sfx = '') => ['top', 'right', 'bottom', 'left'].map((s) => px(cs.getPropertyValue(`${pfx}-${s}${sfx}`)));
    return {
      ref: refFor(el),
      selector: cssPath(el),
      tag: el.tagName.toLowerCase(),
      role: roleOf(el),
      name: accName(el),
      attributes: attrs,
      inlineStyle: el.getAttribute('style') || undefined,
      text: clean(el.innerText, 300),
      visible: isShown(el) && hasBox(el),
      rect: {
        x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width * 10) / 10, height: Math.round(r.height * 10) / 10,
        pageX: Math.round(r.left + scrollX), pageY: Math.round(r.top + scrollY),
        inViewport: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
      },
      boxModel: { margin: box('margin'), border: box('border', '-width'), padding: box('padding') },
      scroll: {
        scrollWidth: el.scrollWidth, clientWidth: el.clientWidth, scrollHeight: el.scrollHeight, clientHeight: el.clientHeight,
        overflowsX: el.scrollWidth > el.clientWidth + 1, overflowsY: el.scrollHeight > el.clientHeight + 1,
      },
      computedStyle: styles,
      parent: parent ? {
        selector: cssPath(parent), display: getComputedStyle(parent).display,
        rect: { x: Math.round(pr.left), y: Math.round(pr.top), width: Math.round(pr.width), height: Math.round(pr.height) },
      } : null,
      children: el.children.length,
    };
  }

  // ------------------------------------------------------------- audit
  function parseColor(s) {
    const m = s && s.match(/rgba?\(([^)]+)\)/);
    if (!m) return null;
    const p = m[1].split(/[\s,\/]+/).filter(Boolean).map(Number);
    return { r: p[0], g: p[1], b: p[2], a: p.length > 3 ? p[3] : 1 };
  }
  function lum(c) {
    const f = (v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function blend(top, bottom) {
    const a = top.a + bottom.a * (1 - top.a);
    if (a === 0) return { r: 255, g: 255, b: 255, a: 0 };
    const mix = (t, b) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
    return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
  }
  function effectiveBg(el) {
    const layers = [];
    for (let cur = el; cur && cur.nodeType === 1; cur = cur.parentElement) {
      const cs = getComputedStyle(cur);
      if (cs.backgroundImage !== 'none') return null; // unknown (image/gradient)
      const c = parseColor(cs.backgroundColor);
      if (c && c.a > 0) { layers.push(c); if (c.a >= 1) break; }
    }
    let bg = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = layers.length - 1; i >= 0; i--) bg = blend(layers[i], bg);
    return bg;
  }

  function audit(args) {
    const maxPer = args.maxPerType || 8;
    const issues = [];
    const counts = {};
    const vw = document.documentElement.clientWidth;
    const vh = innerHeight;
    const add = (type, severity, el, detail) => {
      counts[type] = (counts[type] || 0) + 1;
      if (counts[type] > maxPer) return;
      issues.push({ type, severity, ...(el ? { ref: refFor(el), selector: cssPath(el) } : {}), detail });
    };
    const els = [...document.body.querySelectorAll('*')].filter((e) => !SKIP_TAGS.has(e.tagName)).slice(0, 8000);
    const shown = new Map();
    const vis = (e) => { if (!shown.has(e)) shown.set(e, isShown(e) && hasBox(e)); return shown.get(e); };

    // 1. Horizontal overflow of the page.
    const docW = document.documentElement.scrollWidth;
    if (docW > vw + 1) {
      add('horizontal-scroll', 'high', null, `Page is ${docW - vw}px wider than the viewport (${vw}px), causing a horizontal scrollbar`);
      const clipped = (e) => {
        for (let a = e.parentElement; a && a !== document.body; a = a.parentElement) {
          const s = getComputedStyle(a);
          if (s.overflowX !== 'visible' && a.getBoundingClientRect().right <= vw + 1) return true;
        }
        return false;
      };
      const culprits = els.filter((e) => vis(e) && e.getBoundingClientRect().right > vw + 1 && !clipped(e));
      const set = new Set(culprits);
      for (const e of culprits) {
        if (set.has(e.parentElement)) continue; // report the outermost offender
        const r = e.getBoundingClientRect();
        add('overflow-x-culprit', 'high', e, `Extends ${Math.round(r.right - vw)}px past the right edge (width ${Math.round(r.width)}px, css width: ${getComputedStyle(e).width})`);
      }
    }

    for (const e of els) {
      if (!vis(e)) continue;
      const cs = getComputedStyle(e);
      const r = e.getBoundingClientRect();
      const role = roleOf(e);
      const interactive = isInteractive(e, role);
      const ownText = [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
      // Visually-hidden (screen-reader only) elements: 1px boxes / clip rects.
      const srOnly = (r.width <= 2 || r.height <= 2) || (cs.clip && cs.clip !== 'auto') || /inset\(50%\)/.test(cs.clipPath);

      // 2. Content clipped inside its box.
      if (!srOnly && (['hidden', 'clip'].includes(cs.overflowX) || ['hidden', 'clip'].includes(cs.overflowY))) {
        const overX = cs.overflowX !== 'visible' && e.scrollWidth > e.clientWidth + 1;
        const overY = cs.overflowY !== 'visible' && e.scrollHeight > e.clientHeight + 1;
        if ((overX || overY) && clean(e.innerText)) {
          if (cs.textOverflow === 'ellipsis' || (cs.webkitLineClamp && cs.webkitLineClamp !== 'none')) add('truncated-text', 'low', e, `Text truncated with ellipsis: "${clean(e.innerText, 60)}"`);
          else add('clipped-content', 'medium', e, `Content is cut off (may be intentional for carousels): content ${e.scrollWidth}x${e.scrollHeight}px in a ${e.clientWidth}x${e.clientHeight}px box with overflow hidden — "${clean(e.innerText, 50)}"`);
        }
      }

      // 3. Child sticking out of a non-clipping parent.
      const p = e.parentElement;
      if (p && p !== document.body && !['absolute', 'fixed'].includes(cs.position) && r.width > 0) {
        const pr = p.getBoundingClientRect();
        const pcs = getComputedStyle(p);
        if (pcs.overflowX === 'visible' && pcs.display !== 'inline' && pcs.display !== 'contents' && r.right > pr.right + 2 && r.left >= pr.left - 2 && pr.width > 0) {
          add('overflows-parent', 'medium', e, `Sticks out ${Math.round(r.right - pr.right)}px past its parent ${describe(p)} (child ${Math.round(r.width)}px, parent ${Math.round(pr.width)}px)`);
        }
      }

      if (interactive) {
        // 4. Covered by another element.
        if (r.top >= 0 && r.left >= 0 && r.bottom <= vh && r.right <= vw) {
          const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
          if (hit && hit !== e && !e.contains(hit) && !hit.contains(e)) {
            const lbl = hit.closest && hit.closest('label');
            if (!(lbl && e.labels && [...e.labels].includes(lbl))) add('covered-element', 'medium', e, `Covered by ${describe(hit)} — clicks at its center hit the wrong element`);
          }
        }
        // 5. Small tap target (WCAG 2.2 target size, 24x24).
        const inlineLink = e.tagName === 'A' && cs.display === 'inline';
        if (!inlineLink && !srOnly && (r.width < 24 || r.height < 24) && !['INPUT'].includes(e.tagName)) {
          add('small-tap-target', 'low', e, `${Math.round(r.width)}x${Math.round(r.height)}px, below the 24x24px minimum`);
        }
        // 6. No accessible name.
        if (['button', 'link', 'textbox', 'combobox', 'checkbox', 'radio', 'searchbox'].includes(role) && !accName(e) && !(e.tagName === 'INPUT' && e.placeholder)) {
          add('missing-label', 'medium', e, `${role} has no accessible name (add text, aria-label, or <label>)`);
        }
      }

      // 7. Images.
      if (e.tagName === 'IMG') {
        if (e.complete && e.naturalWidth === 0 && e.getAttribute('src')) add('broken-image', 'high', e, `Image failed to load: ${clean(e.currentSrc || e.src, 120)}`);
        else if (e.naturalWidth) {
          if (!e.hasAttribute('alt')) add('missing-alt', 'medium', e, `Image has no alt attribute: ${clean(e.currentSrc, 100)}`);
          const fit = cs.objectFit;
          const nr = e.naturalWidth / e.naturalHeight, rr = r.width / r.height;
          if ((fit === 'fill' || !fit) && Math.abs(rr - nr) / nr > 0.05) add('distorted-image', 'medium', e, `Aspect ratio stretched: natural ${e.naturalWidth}x${e.naturalHeight}, rendered ${Math.round(r.width)}x${Math.round(r.height)} (use object-fit or fix width/height)`);
          if (e.naturalWidth > r.width * devicePixelRatio * 2.5 && e.naturalWidth > 800) add('oversized-image', 'low', e, `Downloaded ${e.naturalWidth}px wide but shown at ${Math.round(r.width)}px — serve a smaller image`);
        }
      }

      // 8. Text contrast and size.
      if (ownText) {
        const fs = parseFloat(cs.fontSize);
        if (fs < 12) add('small-text', 'low', e, `Font size ${cs.fontSize}: "${clean(e.innerText, 40)}"`);
        const fg = parseColor(cs.color);
        const bg = effectiveBg(e);
        if (fg && bg) {
          const f = blend(fg, bg);
          const l1 = lum(f), l2 = lum(bg);
          const ratio = (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
          const large = fs >= 24 || (fs >= 18.66 && +cs.fontWeight >= 700);
          const need = large ? 3 : 4.5;
          if (ratio < need) add('low-contrast', ratio < need - 1.5 ? 'high' : 'medium', e, `Contrast ${ratio.toFixed(2)}:1 (needs ${need}:1) — ${cs.color} on ${`rgb(${Math.round(bg.r)}, ${Math.round(bg.g)}, ${Math.round(bg.b)})`}: "${clean(e.innerText, 40)}"`);
        }
      }
    }

    const sevOrder = { high: 0, medium: 1, low: 2 };
    issues.sort((a, b) => sevOrder[a.severity] - sevOrder[b.severity]);
    return {
      url: location.href,
      viewport: { width: vw, height: vh, devicePixelRatio },
      pageSize: { width: docW, height: document.documentElement.scrollHeight },
      counts,
      issues,
      note: Object.values(counts).some((c) => c > maxPer) ? `Showing at most ${maxPer} per type; raise maxPerType for more.` : undefined,
    };
  }

  // ----------------------------------------------------------- content
  function toMarkdown(root) {
    const md = (node, listDepth) => {
      if (node.nodeType === 3) return node.textContent.replace(/\s+/g, ' ');
      if (node.nodeType !== 1) return '';
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag) || ['SVG', 'svg', 'CANVAS', 'IFRAME', 'INPUT', 'SELECT', 'TEXTAREA', 'BUTTON'].includes(tag)) {
        if (tag === 'BUTTON') return '';
        return '';
      }
      if (!isShown(node)) return '';
      const inner = () => childNodesOf(node).map((c) => md(c, listDepth)).join('');
      switch (tag) {
        case 'H1': case 'H2': case 'H3': case 'H4': case 'H5': case 'H6':
          return `\n\n${'#'.repeat(+tag[1])} ${clean(inner())}\n\n`;
        case 'P': case 'SECTION': case 'ARTICLE': case 'MAIN': case 'HEADER': case 'FOOTER':
        case 'ASIDE': case 'NAV': case 'FORM': case 'FIGURE': case 'DL': case 'ADDRESS':
          return `\n\n${inner()}\n\n`;
        case 'DIV': case 'FIGCAPTION': case 'DT': case 'DD':
          return `\n${inner()}\n`;
        case 'BR': return '\n';
        case 'HR': return '\n\n---\n\n';
        case 'A': {
          const t = clean(inner());
          const href = node.href;
          if (!t) return '';
          if (!href || href.startsWith('javascript:')) return t;
          return `[${t}](${href})`;
        }
        case 'IMG': {
          const alt = clean(node.alt);
          return alt ? `![${alt}](${node.currentSrc || node.src})` : '';
        }
        case 'STRONG': case 'B': { const t = inner(); return t.trim() ? `**${t.trim()}** ` : ''; }
        case 'EM': case 'I': { const t = inner(); return t.trim() ? `_${t.trim()}_ ` : ''; }
        case 'CODE': return node.closest('pre') ? node.textContent : `\`${node.textContent}\``;
        case 'PRE': return `\n\n\`\`\`\n${node.innerText.replace(/\n$/, '')}\n\`\`\`\n\n`;
        case 'BLOCKQUOTE':
          return '\n\n' + inner().trim().split('\n').map((l) => '> ' + l).join('\n') + '\n\n';
        case 'UL': case 'OL': {
          const items = [...node.children].filter((c) => c.tagName === 'LI' && isShown(c));
          const pad = '  '.repeat(listDepth);
          const lines = items.map((li, i) => {
            const body = childNodesOf(li).map((c) => md(c, listDepth + 1)).join('').replace(/\n{2,}/g, '\n').trim();
            return `${pad}${tag === 'OL' ? i + 1 + '.' : '-'} ${body}`;
          });
          return '\n\n' + lines.join('\n') + '\n\n';
        }
        case 'TABLE': {
          const rows = [...node.rows].map((row) => [...row.cells].map((c) => clean(c.innerText).replace(/\|/g, '\\|')));
          if (!rows.length) return '';
          const w = Math.max(...rows.map((r) => r.length));
          const fmt = (r) => '| ' + Array.from({ length: w }, (_, i) => r[i] || '').join(' | ') + ' |';
          return '\n\n' + [fmt(rows[0]), '|' + ' --- |'.repeat(w), ...rows.slice(1).map(fmt)].join('\n') + '\n\n';
        }
        default: return inner();
      }
    };
    return md(root, 0)
      .split('\n').map((l) => l.replace(/[ \t]+$/g, '').replace(/^[ \t]+(?![-\d])/, '')).join('\n')
      .replace(/\n{3,}/g, '\n\n').trim();
  }

  function tables(root) {
    return [...root.querySelectorAll('table')].filter(isShown).map((t) => {
      const rows = [...t.rows].map((r) => [...r.cells].map((c) => clean(c.innerText)));
      let headers = t.tHead && t.tHead.rows.length ? [...t.tHead.rows[t.tHead.rows.length - 1].cells].map((c) => clean(c.innerText)) : null;
      let body = rows;
      if (!headers && rows.length && t.rows[0] && [...t.rows[0].cells].every((c) => c.tagName === 'TH')) headers = rows[0];
      if (headers) body = rows.slice(t.tHead ? t.tHead.rows.length : 1);
      return {
        selector: cssPath(t),
        caption: t.caption ? clean(t.caption.innerText) : undefined,
        headers,
        rows: headers ? body.map((r) => Object.fromEntries(headers.map((h, i) => [h || `col${i + 1}`, r[i] ?? '']))) : body,
      };
    });
  }

  function meta() {
    const m = (sel) => { const e = document.querySelector(sel); return e ? e.getAttribute('content') || e.getAttribute('href') : undefined; };
    const og = {};
    for (const e of document.querySelectorAll('meta[property^="og:"], meta[name^="twitter:"]')) og[e.getAttribute('property') || e.getAttribute('name')] = e.getAttribute('content');
    const jsonLd = [];
    for (const s of document.querySelectorAll('script[type="application/ld+json"]')) {
      try { jsonLd.push(JSON.parse(s.textContent)); } catch {}
    }
    return {
      url: location.href, title: document.title, lang: document.documentElement.lang || undefined,
      description: m('meta[name="description"]'), canonical: m('link[rel="canonical"]'), robots: m('meta[name="robots"]'),
      openGraph: og, jsonLd,
      headings: [...document.querySelectorAll('h1, h2')].filter(isShown).slice(0, 30).map((h) => `${h.tagName.toLowerCase()}: ${clean(h.innerText, 120)}`),
      counts: { links: document.links.length, images: document.images.length, forms: document.forms.length },
    };
  }

  function content(args) {
    const fmt = args.format || 'markdown';
    let root = args.selector ? resolve({ selector: args.selector }) : document.body;
    if (!args.selector && args.mainOnly) root = document.querySelector('main, [role="main"], article') || document.body;
    let data;
    if (fmt === 'markdown') data = toMarkdown(root);
    else if (fmt === 'text') data = root.innerText;
    else if (fmt === 'html') data = root.outerHTML;
    else if (fmt === 'links') {
      const seen = new Set();
      data = [...root.querySelectorAll('a[href]')].filter((a) => isShown(a)).map((a) => ({ text: clean(a.innerText || a.getAttribute('aria-label') || a.title, 120), href: a.href }))
        .filter((l) => l.href && !l.href.startsWith('javascript:') && !seen.has(l.href + l.text) && seen.add(l.href + l.text));
    } else if (fmt === 'tables') data = tables(root);
    else if (fmt === 'meta') data = meta();
    else throw new Error(`Unknown format ${fmt}`);
    const max = args.maxChars || 60000;
    if (typeof data === 'string' && data.length > max) data = data.slice(0, max) + `\n… (truncated at ${max} of ${data.length} chars; pass maxChars or a selector)`;
    return { url: location.href, title: document.title, format: fmt, content: data };
  }

  // ----------------------------------------------------------- extract
  function extract(args) {
    const fields = args.fields || {};
    const scopes = args.itemSelector ? queryAll(args.itemSelector) : [document];
    const limit = args.limit || 1000;
    const readValue = (el, spec) => {
      const attr = spec.attr || 'text';
      let v;
      if (attr === 'text') v = clean(isShown(el) ? el.innerText : el.textContent);
      else if (attr === 'html') v = el.innerHTML.trim();
      else if (attr === 'outerHTML') v = el.outerHTML;
      else if (['href', 'src', 'action', 'currentSrc'].includes(attr) && el[attr]) v = el[attr];
      else if (attr === 'value') v = el.value;
      else v = el.getAttribute(attr);
      if (v != null && spec.regex) { const m = String(v).match(new RegExp(spec.regex)); v = m ? m[1] ?? m[0] : null; }
      if (v != null && spec.type === 'number') { const n = parseFloat(String(v).replace(/[^\d.\-]/g, '')); v = Number.isNaN(n) ? null : n; }
      return v;
    };
    const items = [];
    for (const scope of scopes.slice(0, limit)) {
      const item = {};
      for (const [key, raw] of Object.entries(fields)) {
        const spec = typeof raw === 'string' ? parseSpec(raw) : raw;
        const sel = spec.selector;
        let els;
        if (!sel || sel === '.' || sel === ':scope') els = [scope === document ? document.documentElement : scope];
        else els = queryAll(sel, scope);
        item[key] = spec.all ? els.map((e) => readValue(e, spec)) : els[0] ? readValue(els[0], spec) : null;
      }
      if (!Object.keys(fields).length) item.text = clean(scope.innerText, 500);
      items.push(item);
    }
    return { url: location.href, count: scopes.length, items };
  }

  // "a.title@href" -> {selector: 'a.title', attr: 'href'}
  function parseSpec(s) {
    const m = s.match(/^(.*?)@([\w:-]+)$/);
    return m ? { selector: m[1].trim(), attr: m[2] } : { selector: s };
  }

  function injectCss(args) {
    const id = args.id || 'default';
    let tag = document.querySelector(`style[data-browser-mcp="${CSS.escape(id)}"]`);
    if (args.remove) { if (tag) tag.remove(); return { removed: !!tag, id }; }
    if (!tag) { tag = document.createElement('style'); tag.dataset.browserMcp = id; (document.head || document.documentElement).appendChild(tag); }
    tag.textContent = args.append ? tag.textContent + '\n' + args.css : args.css;
    return { id, length: tag.textContent.length };
  }

  function refOf(args) { return refFor(resolve(args)); }

  window.__browserMcp = Object.freeze({
    v: VERSION, refs, elRef, counter: () => counter,
    get, refOf, snapshot, point, pageRect, jsClick, focusForTyping, valueOf, selectOption,
    scroll, scrollState, check, inspect, audit, content, extract, injectCss,
  });
  Object.defineProperty(window, '__browserMcp', { enumerable: false, writable: true, configurable: true, value: window.__browserMcp });
}
