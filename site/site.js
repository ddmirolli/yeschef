/* Yes Chef marketing site. Plain JS, no build, no requests. */
(function () {
  "use strict";

  /* Nav: a hairline once the page has scrolled. */
  var nav = document.querySelector(".nav");
  function onScroll() {
    if (!nav) return;
    nav.classList.toggle("is-scrolled", window.scrollY > 12);
  }
  window.addEventListener("scroll", onScroll, { passive: true });
  onScroll();

  /*
   * Hero motion, ported from T3 Code's marketing site (apps/marketing/src/lib/homeMotion.ts).
   * MIT License. Copyright (c) 2026 T3 Tools Inc.
   * Permission is hereby granted, free of charge, to any person obtaining a copy of this software and
   * associated documentation files (the "Software"), to deal in the Software without restriction,
   * including without limitation the rights to use, copy, modify, merge, publish, distribute,
   * sublicense, and/or sell copies of the Software, and to permit persons to whom the Software is
   * furnished to do so, subject to the following conditions: The above copyright notice and this
   * permission notice shall be included in all copies or substantial portions of the Software.
   * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT
   * NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
   * NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM,
   * DAMAGES OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
   * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.
   *
   * Changes: plain JS; the gated list takes any element that reads --home-motion-state.
   */
  function startHomeMotion(hero, field, extra) {
    if (typeof IntersectionObserver === "undefined") return function () {};
    var marks = Array.prototype.slice.call(field.querySelectorAll(".hero-float-mark"));
    var gated = marks.concat(extra || []);
    var visible = new Set();
    var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    var finePointer = window.matchMedia("(pointer: fine)");
    var disposed = false;
    var pointerFrame;
    var pointer = null;

    function canMove(element) {
      return !disposed && visible.has(element) && document.visibilityState === "visible" && !reducedMotion.matches;
    }
    function canParallax() {
      return finePointer.matches && marks.some(canMove);
    }
    function resetPointer() {
      if (pointerFrame !== undefined) cancelAnimationFrame(pointerFrame);
      pointerFrame = undefined;
      pointer = null;
      field.style.setProperty("--px", "0px");
      field.style.setProperty("--py", "0px");
    }
    function update() {
      gated.forEach(function (element) {
        element.style.setProperty("--home-motion-state", canMove(element) ? "running" : "paused");
      });
      var parallax = canParallax();
      field.style.setProperty("--parallax-duration", parallax ? "0.7s" : "0s");
      if (!parallax) resetPointer();
    }
    var observer = new IntersectionObserver(function (entries) {
      if (disposed) return;
      entries.forEach(function (entry) {
        if (entry.isIntersecting) visible.add(entry.target);
        else visible.delete(entry.target);
      });
      update();
    });
    gated.forEach(function (element) { observer.observe(element); });

    hero.addEventListener("pointermove", function (event) {
      if (!canParallax()) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (pointerFrame !== undefined) return;
      pointerFrame = requestAnimationFrame(function () {
        pointerFrame = undefined;
        if (!pointer || !canParallax()) return;
        var bounds = hero.getBoundingClientRect();
        if (bounds.width === 0 || bounds.height === 0) return;
        field.style.setProperty("--px", (((pointer.x - bounds.left) / bounds.width - 0.5) * 36).toFixed(1) + "px");
        field.style.setProperty("--py", (((pointer.y - bounds.top) / bounds.height - 0.5) * 28).toFixed(1) + "px");
      });
    });
    hero.addEventListener("pointerleave", resetPointer);
    document.addEventListener("visibilitychange", update);
    reducedMotion.addEventListener("change", update);
    finePointer.addEventListener("change", update);
    update();
    return function () {
      if (disposed) return;
      disposed = true;
      observer.disconnect();
      update();
    };
  }

  /*
   * The "I run" toggle (Dan, 2026-11-09): solo or team (the default), the same words as ?view=. The script in the
   * page head sets html[data-view] before the first paint. This keeps both controls (the hero's and the one
   * docked in the nav) and the tab title in step, and remembers each pick in localStorage and in ?view=.
   * Both views have the same sections in the same order, so a flip moves nothing on the page.
   */
  var root = document.documentElement;
  var titles = {
    solo: "Yes Chef | The French Brigade layer for agentic coding",
    team: "Yes Chef | The French Brigade layer for agentic dev teams"
  };
  // The two lower hero marks sit level with the button. offsetTop ignores the rise animation's transform.
  function seat() {
    var float = document.querySelector(".hero-float");
    var button = document.querySelector(".hero-actions .btn");
    if (!float || !button) return;
    var y = button.offsetHeight / 2, el = button;
    while (el && el !== float.offsetParent) { y += el.offsetTop; el = el.offsetParent; }
    if (!el) return;
    float.style.setProperty("--cta-y", y + "px");
    float.classList.add("seated");
  }
  // The hero demo (Dan, 2026-11-09): the app on a made-up kitchen for agents, the Teams mock for devs. The
  // frame for the view on screen loads at once and the other on the first flip, so a visitor who never
  // flips loads one demo.
  function loadDemo(view) {
    var frame = document.querySelector('.demo [data-swap="' + view + '"] iframe[data-src]');
    if (frame && !frame.getAttribute("src")) frame.setAttribute("src", frame.getAttribute("data-src"));
    return frame;
  }
  function pick(view) {
    root.setAttribute("data-view", view);
    loadDemo(view);
    document.title = titles[view];
    var buttons = document.querySelectorAll(".persona-seg button");
    for (var i = 0; i < buttons.length; i++) {
      buttons[i].setAttribute("aria-pressed", String(buttons[i].getAttribute("data-view") === view));
    }
    seat();
  }
  function choose(view) {
    pick(view);
    try { localStorage.setItem("yc.view", view); } catch (e) {}
    var url = new URL(location.href);
    url.searchParams.set("view", view);
    history.replaceState(null, "", url);
  }
  pick(root.getAttribute("data-view") === "solo" ? "solo" : "team");
  window.addEventListener("resize", seat);
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(seat);
  document.addEventListener("click", function (event) {
    var button = event.target.closest && event.target.closest(".persona-seg button");
    if (button) choose(button.getAttribute("data-view"));
  });
  // Left and right arrows move the pick, as on a segmented control.
  document.addEventListener("keydown", function (event) {
    var button = event.target.closest && event.target.closest(".persona-seg button");
    if (!button || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    var view = event.key === "ArrowLeft" ? "solo" : "team";
    choose(view);
    var next = button.parentNode.querySelector('button[data-view="' + view + '"]');
    if (next) next.focus();
    event.preventDefault();
  });

  // The buttons under the modes drive the demo: back up to it, then set it to what the card describes. The
  // demo pages are on this site, so the page reaches into them directly.
  var reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  function inDemo(act) {
    var frame = loadDemo(root.getAttribute("data-view"));
    if (!frame) return;
    frame.scrollIntoView({ behavior: reducedMotion.matches ? "auto" : "smooth", block: "center" });
    var run = function () {
      try {
        if (frame.contentWindow.__demoTouch) frame.contentWindow.__demoTouch();
        act(frame.contentDocument);
      } catch (e) {}
    };
    var doc = frame.contentDocument;
    if (doc && doc.readyState === "complete" && doc.URL !== "about:blank") run();
    else frame.addEventListener("load", run, { once: true });
  }
  document.addEventListener("click", function (event) {
    var link = event.target.closest && event.target.closest("[data-demo-mode], [data-demo-rules]");
    if (!link) return;
    var mode = link.getAttribute("data-demo-mode");
    inDemo(function (doc) {
      if (mode) {
        // The mode chip flips between Open and Brigade (Open kitchen and French Brigade until 2026-11-10); click it only
        // to change.
        var name = doc.querySelector("[data-mode-name]");
        var now = name && /Brigade/.test(name.textContent) ? "brigade" : "open";
        if (now !== mode) doc.querySelector("[data-mode]").click();
      } else {
        // Settings, then its Rules tab, as a visitor would open them.
        var open = doc.querySelector("[data-settings]");
        if (open) open.click();
        var tab = doc.querySelector('.set-tab[data-tab="rules"]');
        if (tab) { tab.click(); tab.focus({ preventScroll: true }); }
      }
    });
  });

  // The nav's toggle shows once the hero's toggle has scrolled up under the nav (rulings 2B and 3C).
  // Checked on scroll, once a frame: a jump from above the toggle to below it never crosses the
  // viewport, so an IntersectionObserver would not fire.
  var heroToggle = document.querySelector(".hero .persona");
  if (heroToggle && nav) {
    var dockFrame = 0;
    var checkDock = function () {
      dockFrame = 0;
      root.classList.toggle("persona-docked", heroToggle.getBoundingClientRect().bottom <= nav.offsetHeight);
    };
    var queueDock = function () {
      if (!dockFrame) dockFrame = requestAnimationFrame(checkDock);
    };
    window.addEventListener("scroll", queueDock, { passive: true });
    window.addEventListener("resize", queueDock);
    checkDock();
  }

  var hero = document.querySelector(".hero");
  var field = document.querySelector(".hero-float");
  var feeds = Array.prototype.slice.call(document.querySelectorAll(".noise-feed"));
  if (hero && field) startHomeMotion(hero, field, feeds);
})();
