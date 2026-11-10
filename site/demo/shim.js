// The site demo's stand-ins for the Pass server, loaded before the app's own page script (demo/app.html).
// The app page is client/server.mjs page() as is. Here it reads its board from the made-up kitchen in
// kitchen.mjs, which boot.mjs starts, instead of from a server:
// - fetch('/app?...') renders the board in this page; every other fetch goes out as usual.
// - EventSource('/events') is a timer that says "tick" every 3 s, and at once when the kitchen changes.
// - window.yeschef.act is the desktop app's door for actions; here it hands them to the kitchen.
// - localStorage is a plain object for this page only: the site uses the same key (yc.view) for its own toggle.
// - The app's project links ("/?p=Fernpay") point at this page, however they are opened.
// - Until the visitor clicks or types in the demo, the app cannot move focus or scroll the site around it.
// - A scroll that reaches the end of one of the app's panes goes on to scroll the site, as a page would.
// - The app's "leave this page?" guard, for a send still inside its Undo window, is dropped: a frame's
//   guard would stop the visitor leaving the site itself, and the demo's sends are make-believe.
(function () {
  var listen = window.addEventListener;
  window.addEventListener = function (type) { if (type !== 'beforeunload') return listen.apply(this, arguments); };

  var free = document.createElement('style');
  free.textContent = '*{overscroll-behavior:auto!important}';
  document.head.appendChild(free);

  var touched = false;
  ['pointerdown', 'keydown', 'touchstart'].forEach(function (t) { window.addEventListener(t, function () { touched = true; }, true); });
  var focus = HTMLElement.prototype.focus, into = Element.prototype.scrollIntoView;
  HTMLElement.prototype.focus = function () { if (touched) return focus.apply(this, arguments); };
  Element.prototype.scrollIntoView = function () { if (touched) return into.apply(this, arguments); };
  // A click on the site's buttons that drive the demo counts as the visitor's own (site.js inDemo).
  window.__demoTouch = function () { touched = true; };

  var mem = Object.create(null);
  var storage = {
    getItem: function (k) { return k in mem ? mem[k] : null; },
    setItem: function (k, v) { mem[k] = String(v); },
    removeItem: function (k) { delete mem[k]; },
    clear: function () { mem = Object.create(null); },
    key: function (i) { return Object.keys(mem)[i] || null; },
    get length() { return Object.keys(mem).length; },
  };
  try { Object.defineProperty(window, 'localStorage', { configurable: true, get: function () { return storage; } }); } catch (e) { /* the app wraps every read and write */ }

  var resolve;
  var ready = new Promise(function (r) { resolve = r; });
  window.__demoReady = function (kitchen) { resolve(kitchen); };

  var streams = [];
  function FakeEventSource(url) { this.url = url; this.readyState = 1; this.onerror = null; this.ls = {}; streams.push(this); }
  FakeEventSource.prototype.addEventListener = function (type, fn) { (this.ls[type] = this.ls[type] || []).push(fn); };
  FakeEventSource.prototype.removeEventListener = function (type, fn) { this.ls[type] = (this.ls[type] || []).filter(function (f) { return f !== fn; }); };
  FakeEventSource.prototype.close = function () { this.readyState = 2; };
  window.EventSource = FakeEventSource;
  window.__demoTick = function () {
    var ev = { data: JSON.stringify({ ok: true, at: Date.now(), error: null }) };
    streams.forEach(function (s) { if (s.readyState !== 2) (s.ls.tick || []).forEach(function (fn) { fn(ev); }); });
  };
  setInterval(window.__demoTick, 3000);

  var realFetch = window.fetch.bind(window);
  window.fetch = function (input, init) {
    var url = typeof input === 'string' ? input : input && input.url;
    if (typeof url === 'string' && /^\/app(\?|$)/.test(url)) {
      return ready.then(function (k) {
        return new Response(k.page(url.slice(4)), { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' } });
      });
    }
    return realFetch(input, init);
  };

  window.yeschef = { act: function (body) { return ready.then(function (k) { return k.act(String(body)); }); } };

  // The app's project links are root addresses ("/?p=Fernpay"), and this page is /demo/app.html. Each link is pointed at
  // this page as soon as it is drawn, so a click, a middle-click and "Open Link in New Tab" all stay in the demo, and the
  // app's check for the project it already shows compares like with like (PR-Agent r5 and r6 on #61).
  function here() {
    document.querySelectorAll('.pmenu-l a[href]').forEach(function (a) {
      var h = a.getAttribute('href');
      if (/^\/(\?|$)/.test(h)) a.setAttribute('href', location.pathname + h.slice(1));
    });
  }
  new MutationObserver(here).observe(document, { childList: true, subtree: true });

  var push = history.pushState.bind(history);
  history.pushState = function (state, title, url) {
    if (typeof url === 'string' && /^\/(\?|$)/.test(url)) url = location.pathname + url.slice(1);
    return push(state, title, url);
  };
})();
