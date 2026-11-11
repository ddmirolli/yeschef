import type { DemoKitchen } from './types.ts';

// Install before the generated app script. All actions stay in this iframe's made-up kitchen.
const listen = window.addEventListener.bind(window);
window.addEventListener = function (...args: Parameters<Window['addEventListener']>): void {
  if (args[0] !== 'beforeunload') listen(...args);
};
const free = document.createElement('style');
free.textContent = '*{overscroll-behavior:auto!important}';
document.head.appendChild(free);

let touched = false;
for (const type of ['pointerdown', 'keydown', 'touchstart']) listen(type, () => { touched = true; }, true);
const focus = HTMLElement.prototype.focus;
const into = Element.prototype.scrollIntoView;
HTMLElement.prototype.focus = function (options?: FocusOptions): void {
  if (touched) focus.call(this, options);
};
Element.prototype.scrollIntoView = function (options?: boolean | ScrollIntoViewOptions): void {
  if (touched) into.call(this, options);
};
window.__demoTouch = () => { touched = true; };

const memory = new Map<string, string>();
const storage: Storage = {
  getItem: (key) => memory.get(key) ?? null,
  setItem: (key, value) => { memory.set(key, String(value)); },
  removeItem: (key) => { memory.delete(key); },
  clear: () => { memory.clear(); },
  key: (index) => Array.from(memory.keys())[index] ?? null,
  get length() { return memory.size; },
};
try { Object.defineProperty(window, 'localStorage', { configurable: true, get: () => storage }); }
catch { /* The generated app handles blocked storage. */ }

let resolveKitchen: (kitchen: DemoKitchen) => void;
const ready = new Promise<DemoKitchen>((resolve) => { resolveKitchen = resolve; });
window.__demoReady = (kitchen) => { resolveKitchen(kitchen); };

const streams = new Set<DemoEventSource>();
class DemoEventSource extends EventTarget {
  readonly url: string;
  readyState = 1;
  onerror = null;
  constructor(url: string) {
    super();
    this.url = url;
    streams.add(this);
  }
  close(): void { this.readyState = 2; streams.delete(this); }
}
Object.defineProperty(window, 'EventSource', { configurable: true, writable: true, value: DemoEventSource });
window.__demoTick = () => {
  for (const stream of streams) {
    stream.dispatchEvent(new MessageEvent('tick', { data: JSON.stringify({ ok: true, at: Date.now(), error: null }) }));
  }
};
setInterval(window.__demoTick, 3000);

const realFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (/^\/app(\?|$)/.test(url)) {
    const kitchen = await ready;
    return new Response(kitchen.page(url.slice(4)), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
  }
  return realFetch(input, init);
};
window.yeschef = { act: async (body) => (await ready).act(String(body)) };

function here(): void {
  for (const anchor of document.querySelectorAll<HTMLAnchorElement>('.pmenu-l a[href]')) {
    const href = anchor.getAttribute('href');
    if (href && /^\/(\?|$)/.test(href)) anchor.setAttribute('href', location.pathname + href.slice(1));
  }
}
new MutationObserver(here).observe(document, { childList: true, subtree: true });
const push = history.pushState.bind(history);
history.pushState = (state: unknown, title: string, url?: string | URL | null) => {
  if (typeof url === 'string' && /^\/(\?|$)/.test(url)) url = location.pathname + url.slice(1);
  push(state, title, url);
};
