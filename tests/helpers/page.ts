// Runs a board page's own scripts against an in-process handler, with just
// enough DOM to render, and no dependency. The point is to assert on what the
// page actually draws, not on its source text: a grep for a string cannot see
// a row that never renders.
//
// The DOM is permissive on purpose. getElementById returns the element the
// page's markup declares if it can find the id in the HTML (with the markup's
// own `hidden` attribute), and a fresh element otherwise, so the page's setup
// code runs unchanged. Only what the render path needs is implemented.
import { readFileSync } from 'fs';

type Listener = (e: any) => void;

export class El {
  tagName: string;
  children: El[] = [];
  parent: El | null = null;
  attrs: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  style: any = { setProperty() {}, background: '' };
  hidden = false;
  disabled = false;
  value = '';
  checked = false;
  type = '';
  href = '';
  title = '';
  id = '';
  name = '';
  open = false;
  placeholder = '';
  autocomplete = '';
  selected = false;
  private text = '';
  constructor(tag: string) { this.tagName = tag.toUpperCase(); }

  get className() { return this.attrs.class || ''; }
  set className(v: string) { this.attrs.class = v; }
  get classList() {
    const self = this;
    const list = () => self.className.split(/\s+/).filter(Boolean);
    return {
      add: (...c: string[]) => { self.className = [...new Set([...list(), ...c])].join(' '); },
      remove: (...c: string[]) => { self.className = list().filter((x) => !c.includes(x)).join(' '); },
      toggle: (c: string, on?: boolean) => {
        const has = list().includes(c);
        const want = on === undefined ? !has : on;
        if (want && !has) self.classList.add(c);
        if (!want && has) self.classList.remove(c);
        return want;
      },
      contains: (c: string) => list().includes(c),
    };
  }
  get options() { return this.children.filter((c) => c.tagName === 'OPTION'); }
  get textContent(): string { return this.text + this.children.map((c) => c.textContent).join(''); }
  set textContent(v: string) { this.children = []; this.text = String(v); }
  set innerHTML(v: string) { this.children = []; this.text = String(v).replace(/<[^>]+>/g, ''); }
  get innerHTML() { return this.text; }
  setAttribute(k: string, v: string) { this.attrs[k] = String(v); if (k === 'id') this.id = String(v); }
  getAttribute(k: string) { return this.attrs[k] ?? null; }
  appendChild(c: El | string) { const n = typeof c === 'string' ? textNode(c) : c; n.parent = this; this.children.push(n); return n; }
  append(...cs: (El | string)[]) { for (const c of cs) this.appendChild(c); }
  replaceChildren(...cs: (El | string)[]) { this.children = []; this.text = ''; this.append(...cs); }
  addEventListener(t: string, f: Listener) { (this.listeners[t] ||= []).push(f); }
  dispatchEvent(e: { type: string }) { for (const f of this.listeners[e.type] || []) f({ ...e, target: this, preventDefault() {}, stopPropagation() {} }); return true; }
  focus() {}
  setSelectionRange() {}
  requestSubmit() { this.dispatchEvent({ type: 'submit' }); }
  /** Every descendant, depth first. */
  all(): El[] { return this.children.flatMap((c) => [c, ...c.all()]); }
  /** Descendants carrying a class. */
  byClass(c: string): El[] { return this.all().filter((e) => e.classList.contains(c)); }
}

function textNode(t: string): El { const n = new El('#text'); n.textContent = t; return n; }

export type Rendered = { doc: any; byId: (id: string) => El; win: any };

/**
 * Load `page` (e.g. 'project.html') at `path`, with fetch answered by
 * `handler`, and wait for the first render.
 */
export async function renderPage(
  handler: (req: Request) => Promise<Response>,
  page: string,
  path: string,
  /** Replaces globals the page sees, e.g. a navigator whose clipboard refuses. */
  overrides: Record<string, unknown> = {}
): Promise<Rendered> {
  const html = readFileSync(new URL(`../../public/${page}`, import.meta.url), 'utf8');
  const ids = new Map<string, El>();
  const byId = (id: string): El => {
    if (!ids.has(id)) {
      const m = html.match(new RegExp(`<(\\w+)[^>]*\\bid="${id}"[^>]*>`));
      const el = new El(m ? m[1] : 'div');
      el.id = id;
      if (m && /\shidden(\s|>|=)/.test(m[0])) el.hidden = true;
      // A static <select> keeps its options, so the page's option loops run.
      if (m && m[1] === 'select') {
        const body = html.slice(html.indexOf(m[0]) + m[0].length, html.indexOf('</select>', html.indexOf(m[0])));
        for (const o of body.matchAll(/<option value="([^"]*)"/g)) { const opt = new El('option'); opt.value = o[1]; el.appendChild(opt); }
      }
      ids.set(id, el);
    }
    return ids.get(id)!;
  };
  const doc: any = {
    getElementById: byId,
    createElement: (t: string) => new El(t),
    createTextNode: (t: string) => textNode(t),
    createDocumentFragment: () => new El('#fragment'),
    querySelector: () => new El('div'),
    querySelectorAll: () => [],
    activeElement: null,
    documentElement: new El('html'),
    // Page-wide listeners (app.js delegates image clicks and Escape here),
    // kept so a test can fire one.
    listeners: {} as Record<string, Listener[]>,
    addEventListener(type: string, fn: Listener) { (doc.listeners[type] ||= []).push(fn); },
    body: new El('body'),
  };
  const store: Record<string, string> = {};
  const fetchFn = async (url: string, init?: any) => handler(new Request(new URL(url, 'http://localhost').toString(), init));
  const win: any = {};
  const env = {
    window: win,
    document: doc,
    location: { pathname: path, reload() {} },
    localStorage: { getItem: (k: string) => store[k] ?? null, setItem: (k: string, v: string) => { store[k] = v; }, removeItem: (k: string) => { delete store[k]; } },
    fetch: fetchFn,
    setInterval: () => 0,
    setTimeout: (f: () => void) => { f(); return 0; },
    clearTimeout: () => {},
    confirm: () => true,
    navigator: { clipboard: { writeText: async () => {} } },
    ...overrides,
  };
  const scripts: string[] = [];
  for (const m of html.matchAll(/<script(?: src="([^"]+)")?>([\s\S]*?)<\/script>/g)) {
    if (m[1]) {
      const res = await fetchFn(m[1]);
      scripts.push(await res.text());
    } else scripts.push(m[2]);
  }
  for (const src of scripts) {
    // `WB` and any other window globals the page reads are passed as names.
    const names = Object.keys(env);
    new Function(...names, 'WB', 'WB_GROUPS', 'MD', src)(...names.map((n) => (env as any)[n]), win.WB, win.WB_GROUPS, win.MD);
  }
  // The page's load() is async: let its fetches and the render settle.
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0));
  return { doc, byId, win };
}
