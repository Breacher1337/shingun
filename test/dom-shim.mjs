/**
 * Minimal DOM shim: just enough of the browser object model for the real
 * dashboard module (web/dashboard.mjs) to boot and be driven end to end
 * inside a Node test process — no browser, no jsdom, no dependencies.
 *
 * Every element created here honors: className, attributes, style object
 * properties, value/checked/disabled on form controls, textContent reads
 * and writes (a getter that collects child text nodes), appendChild/append,
 * replaceChildren, remove, firstChild/children, querySelector(-All) for
 * simple selectors (#id, .class, tag), click() dispatch and property/on-
 * listener events (click, keydown, input, change).
 *
 * Notes: layout (clientWidth/Height), scrolling and focus are inert.
 */

class TextNode {
  constructor(text) {
    this.nodeType = 3;
    this._text = String(text);
    this.parentNode = null;
  }
  get textContent() { return this._text; }
  set textContent(v) { this._text = String(v); }
  remove() { this.parentNode?._detach(this); }
}

class Elem {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = String(tag).toUpperCase();
    this.attrs = {};
    this._children = [];
    this.parentNode = null;
    this.style = {};
    this.className = '';
    this._textOverride = null;
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.id = '';
    this.title = '';
    this.href = '';
    this.download = '';
    this.listeners = {};
    this.onclick = null;
    this.oninput = null;
    this.onchange = null;
    this.scrollHeight = 0;
    this.scrollTop = 0;
    this.clientWidth = 0;
    this.clientHeight = 0;
  }

  setAttribute(k, v) {
    this.attrs[k] = v === true ? '' : String(v);
    if (k === 'class') this.className = String(v);
    if (k === 'id') this.id = String(v);
    if (k === 'value') this.value = String(v);
    if (k === 'disabled') this.disabled = true;
    if (k === 'checked') this.checked = true;
    if (k === 'selected') this._selectedAttr = true;
    if (k === 'title') this.title = String(v);
  }
  getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; }

  get children() { return this._children.filter((c) => c.nodeType === 1); }
  get firstChild() { return this._children[0] ?? null; }

  get textContent() {
    if (this._textOverride !== null) return this._textOverride;
    const walk = (n) => n._children.map((c) => (c.nodeType === 3 ? c.textContent : walk(c))).join('');
    return walk(this);
  }
  set textContent(v) { this._textOverride = String(v); }

  _detach(node) {
    const i = this._children.indexOf(node);
    if (i >= 0) this._children.splice(i, 1);
    node.parentNode = null;
  }
  appendChild(node) {
    if (typeof node === 'string' || typeof node === 'number') node = new TextNode(String(node));
    node.parentNode?._detach(node);
    node.parentNode = this;
    this._children.push(node);
    if (this.tagName === 'SELECT') this._syncSelectValue();
    if (this.tagName === 'OPTION' && node.nodeType === 3 && this.value === '') this.value = this.textContent;
    return node;
  }
  append(...nodes) {
    for (const n of nodes.flat(Infinity)) this.appendChild(n);
  }
  replaceChildren(...nodes) {
    for (const c of [...this._children]) this._detach(c);
    this._textOverride = null;
    this.append(...nodes);
  }
  remove() { this.parentNode?._detach(this); }
  get isConnected() { return Boolean(this.parentNode); }

  _syncSelectValue() {
    const opts = this._children.filter((c) => c.nodeType === 1 && c.tagName === 'OPTION');
    const chosen = opts.find((o) => o._selectedAttr) ?? opts[0];
    this.value = chosen ? (chosen.attrs.value ?? '') : '';
  }

  focus() {}
  select() {}
  click() { this._emit('click', { target: this }); }
  addEventListener(type, fn) { (this.listeners[type] ??= []).push(fn); }
  _emit(type, ev) {
    for (const fn of this.listeners[type] ?? []) fn(ev);
    const prop = this[`on${type}`];
    if (typeof prop === 'function') prop(ev);
  }

  _matches(sel) {
    // "a b c" descendant chains, each part a simple selector.
    const parts = String(sel).trim().split(/\s+/);
    if (parts.length === 1) return matchesSimple(this, parts[0]);
    // candidate must match the LAST part; ancestors must cover the rest.
    if (!matchesSimple(this, parts[parts.length - 1])) return false;
    let idx = parts.length - 2;
    let node = this.parentNode;
    while (idx >= 0 && node) {
      if (node._matches && matchesSimple(node, parts[idx])) idx -= 1;
      node = node.parentNode;
    }
    return idx < 0;
  }
  querySelector(sel) { return walkFind(this, sel); }
  querySelectorAll(sel) { return walkAll(this, sel); }
}

function matchesSimple(el, sel) {
  if (sel.startsWith('#')) return el.attrs.id === sel.slice(1);
  if (sel.startsWith('.')) {
    const cls = sel.slice(1);
    return String(el.className ?? '').split(/\s+/).includes(cls)
      || String(el.attrs.class ?? '').split(/\s+/).includes(cls);
  }
  return el.tagName === sel.toUpperCase();
}

function walkFind(root, sel) {
  for (const c of root._children ?? []) {
    if (c.nodeType === 1 && c._matches(sel)) return c;
    const hit = walkFind(c, sel);
    if (hit) return hit;
  }
  return null;
}
function walkAll(root, sel, out = []) {
  for (const c of root._children ?? []) {
    if (c.nodeType === 1) {
      if (c._matches(sel)) out.push(c);
      walkAll(c, sel, out);
    }
  }
  return out;
}

export function installDomShim({ baseUrl }) {
  const fetchLog = [];
  const memory = new Map();
  const nativeFetch = globalThis.fetch;

  const document = {
    nodeType: 9,
    body: new Elem('body'),
    createElement: (tag) => new Elem(tag === 'svg' || tag === 'path' ? tag : tag),
    createElementNS: (_ns, tag) => new Elem(tag),
    createTextNode: (t) => new TextNode(t)
  };
  document.documentElement = new Elem('html');
  document.documentElement.appendChild(document.body);
  // The static shell index.html provides: the app mount point.
  const appElem = new Elem('div');
  appElem.setAttribute('id', 'app');
  document.body.appendChild(appElem);
  document.querySelector = (sel) => walkFind(document.documentElement, sel);
  document.querySelectorAll = (sel) => walkAll(document.documentElement, sel);

  const location = { search: '', pathname: '/', hash: '' };
  // Node may already define some of these as getter-only globals
  // (navigator since v21, fetch, etc) — defineProperty steps over getters.
  const setGlobal = (name, value) =>
    Object.defineProperty(globalThis, name, { value, writable: true, configurable: true });
  setGlobal('document', document);
  setGlobal('window', { addEventListener() {} });
  setGlobal('location', location);
  setGlobal('history', { replaceState() {} });
  setGlobal('localStorage', {
    getItem: (k) => (memory.has(k) ? memory.get(k) : null),
    setItem: (k, v) => memory.set(String(k), String(v)),
    removeItem: (k) => memory.delete(k)
  });
  setGlobal('navigator', { clipboard: { writeText: async () => {} } });
  URL.createObjectURL ??= () => 'blob:shim-' + Math.random().toString(16).slice(2);
  URL.revokeObjectURL ??= () => {};

  // Relative dashboard fetches resolve against the real server under test.
  globalThis.fetch = async (url, opts) => {
    const full = new URL(String(url), baseUrl).toString();
    fetchLog.push(String(url));
    return nativeFetch(full, opts);
  };

  // Timers must never pin the test runner alive on their own.
  const nativeSetInterval = globalThis.setInterval;
  const nativeSetTimeout = globalThis.setTimeout;
  globalThis.setInterval = (fn, ms, ...a) => { const t = nativeSetInterval(fn, ms, ...a); t.unref?.(); return t; };
  globalThis.setTimeout = (fn, ms, ...a) => { const t = nativeSetTimeout(fn, ms, ...a); t.unref?.(); return t; };

  return {
    document,
    location,
    fetchLog,
    memory,
    restore() {
      globalThis.fetch = nativeFetch;
      globalThis.setInterval = nativeSetInterval;
      globalThis.setTimeout = nativeSetTimeout;
    }
  };
}
