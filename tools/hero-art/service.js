// Moved here from site/service.js on 2026-11-09, when the site's demo became the app itself (site/demo/).
// It stays only to redraw the made-up payouts plates: tools/hero-art/plates.html lifts its drawing code.
/*
 * "Run the pass": a small simulated service for the Yes Chef site, and the ticket sheet that opens
 * from it. Written for Yes Chef (not from T3 Code).
 *
 * Tickets walk Order, Prep, Fire, Tasting, Plating, Sent. The line moves them on its own as far as
 * Plating. Plating waits at the pass until the chef calls Go or Refire. When the pass is full the
 * line stops plating, so nothing leaves without a call. Until the visitor makes a call of their own,
 * a demo chef makes one after the pass has been full for a few seconds, so the board never freezes.
 *
 * Any ticket opens full screen: its stage, the agent's last words, Tasting, the pull request, and
 * the plate, before and after, light and dark. The plates are drawn here as SVG; they are a demo.
 *
 * The clock is simulated: it advances only while the demo is on screen, the tab is visible, the
 * sheet is closed and the visitor has not paused it. With reduced motion the demo starts paused.
 */
(function () {
  "use strict";

  var root = document.getElementById("service");
  if (!root) return;

  var STATIONS = [
    { name: "Saucier", agent: "Claude Code", icon: "claude-ai-icon.svg" },
    { name: "Garde manger", agent: "Codex", icon: "openai_dark.svg" },
    { name: "Pâtissier", agent: "Cursor", icon: "cursor_light.svg" },
    { name: "Rôtisseur", agent: "OpenCode", icon: "opencode-dark.svg" },
    { name: "Poissonnier", agent: "Grok", icon: "grok-dark.svg" },
    { name: "Entremetier", agent: "Antigravity", icon: "antigravity.svg" }
  ];
  var STAGES = ["Order", "Prep", "Fire", "Tasting", "Plating", "Sent"];
  var NOTES = ["tighten the empty state", "handle the timeout", "match the spacing", "add the missing test"];
  // How many tickets each stage holds before the line waits. Plating is the pass: three plates and it is full.
  var CAP = { order: 2, fire: 4, tasting: 3, plating: 3, sent: 3 };
  var LANE_SHOW = 4;

  /*
   * The menu. Each dish has a page, the screen before, the screen after, and the agent's summary.
   * Blocks: [type, options]. `hl` marks what the agent changed; it is outlined on the after screen.
   */
  var DISHES = {
    "Team invites": { page: "Members", did: "Invites go out by email with a role picker; pending invites list under the team.",
      before: [["head", { title: "Members", button: "" }], ["table", { rows: 4, cols: 3 }]],
      after: [["head", { title: "Members", button: "Invite", hl: true }], ["table", { rows: 4, cols: 3 }], ["list", { items: 2, tag: "Pending", hl: true }]] },
    "Search by phone": { page: "Customers", did: "Search matches phone numbers in any format, digits only.",
      before: [["search", { text: "Search name or email" }], ["empty", { text: "No results for 555 0142" }]],
      after: [["search", { text: "555 0142", hl: true }], ["table", { rows: 2, cols: 3, hl: true }]] },
    "Retry failed payouts": { page: "Payouts", did: "Failed payouts retry three times with backoff; each row shows its retry state.",
      before: [["banner", { text: "3 payouts failed", tone: "red" }], ["table", { rows: 5, cols: 4, status: "Failed" }]],
      after: [["banner", { text: "3 payouts retried and paid", tone: "green", hl: true }], ["table", { rows: 5, cols: 4, status: "Paid", hl: true }]] },
    "Rate limits on webhooks": { page: "Webhooks", did: "Webhooks back off on 429 and the log shows the wait.",
      before: [["chart", { spike: true }], ["table", { rows: 4, cols: 3, status: "429" }]],
      after: [["chart", { spike: false, hl: true }], ["table", { rows: 4, cols: 3, status: "Delivered", hl: true }]] },
    "Empty states": { page: "Projects", did: "Every empty list now says what goes there and offers the first step.",
      before: [["head", { title: "Projects", button: "" }], ["blank", {}]],
      after: [["head", { title: "Projects", button: "" }], ["empty", { text: "No projects yet", button: "New project", hl: true }]] },
    "Weekly digest email": { page: "Email", did: "A Monday digest: the week's numbers and the three items that need a look.",
      before: [["email", { branded: false }]],
      after: [["email", { branded: true, title: "Your week", button: "Open dashboard", hl: true }]] },
    "Dark mode tokens": { page: "Settings", did: "Colours come from tokens, so dark mode covers every screen.",
      before: [["head", { title: "Appearance", button: "" }], ["cards", { n: 3, odd: true }], ["form", { fields: 2 }]],
      after: [["head", { title: "Appearance", button: "" }], ["cards", { n: 3, hl: true }], ["form", { fields: 2 }]] },
    "CSV export": { page: "Reports", did: "Any report exports to CSV with the filters you set.",
      before: [["head", { title: "Reports", button: "" }], ["table", { rows: 5, cols: 4 }]],
      after: [["head", { title: "Reports", button: "Export CSV", hl: true }], ["table", { rows: 5, cols: 4 }]] },
    "Audit log": { page: "Audit log", did: "Every admin change lands in the audit log with who, what and when.",
      before: [["empty", { text: "No audit trail" }]],
      after: [["search", { text: "Filter by person or action" }], ["list", { items: 5, tag: "Admin", hl: true }]] },
    "Fix login redirect": { page: "Sign in", did: "After sign-in you land on the page you asked for, not the dashboard.",
      before: [["login", {}], ["banner", { text: "Redirected to /dashboard", tone: "amber" }]],
      after: [["login", {}], ["banner", { text: "Back to /reports/q3", tone: "green", hl: true }]] },
    "Invoice PDFs": { page: "Billing", did: "Each invoice downloads as a PDF with your logo and tax details.",
      before: [["head", { title: "Invoices", button: "" }], ["table", { rows: 5, cols: 3 }]],
      after: [["head", { title: "Invoices", button: "" }], ["table", { rows: 5, cols: 3, action: "PDF", hl: true }]] },
    "Two-factor sign-in": { page: "Sign in", did: "Sign-in asks for a six-digit code when two-factor is on.",
      before: [["login", {}]],
      after: [["login", { code: true, hl: true }]] },
    "Slow orders query": { page: "Orders", did: "The orders list loads in 180 ms; one index and one fewer join.",
      before: [["timing", { text: "4.2 s", tone: "red" }], ["skeleton", { rows: 5 }]],
      after: [["timing", { text: "0.18 s", tone: "green", hl: true }], ["table", { rows: 5, cols: 4 }]] },
    "Keyboard shortcuts": { page: "Inbox", did: "Press ? for shortcuts; j and k move, e archives.",
      before: [["list", { items: 5 }]],
      after: [["list", { items: 5 }], ["modal", { title: "Keyboard shortcuts", hl: true }]] },
    "Avatar uploads": { page: "Profile", did: "Upload a photo, crop it, and it shows everywhere your name does.",
      before: [["profile", { photo: false }], ["form", { fields: 2 }]],
      after: [["profile", { photo: true, hl: true }], ["form", { fields: 2 }]] },
    "Billing settings": { page: "Billing", did: "Change plan, card and billing email on one page.",
      before: [["form", { fields: 3 }]],
      after: [["cards", { n: 3, price: true, hl: true }], ["form", { fields: 2 }]] },
    "Password reset email": { page: "Email", did: "The reset email has one button, a 30-minute expiry and your brand.",
      before: [["email", { branded: false }]],
      after: [["email", { branded: true, title: "Reset your password", button: "Reset password", hl: true }]] },
    "Onboarding checklist": { page: "Home", did: "New teams see four steps to set up, ticked as they go.",
      before: [["stats", { n: 3 }], ["chart", {}]],
      after: [["checklist", { items: 4, hl: true }], ["stats", { n: 3 }]] },
    "Pricing page under 1 s": { page: "Pricing", did: "Pricing renders on the server; first paint is 0.8 s.",
      before: [["timing", { text: "2.8 s", tone: "red" }], ["skeleton", { rows: 3 }]],
      after: [["timing", { text: "0.8 s", tone: "green", hl: true }], ["cards", { n: 3, price: true }]] },
    "Webhook retries": { page: "Webhooks", did: "Failed deliveries retry and you can resend one by hand.",
      before: [["table", { rows: 5, cols: 3, status: "Failed" }]],
      after: [["table", { rows: 5, cols: 3, status: "Retried", action: "Resend", hl: true }]] },
    "Usage alerts": { page: "Usage", did: "Set a limit and get an alert at 80 percent.",
      before: [["stats", { n: 3 }], ["chart", {}]],
      after: [["banner", { text: "You have used 82% of your plan", tone: "amber", hl: true }], ["chart", { limit: true }]] },
    "Archive old projects": { page: "Projects", did: "Projects idle for 90 days can be archived and restored later.",
      before: [["list", { items: 6 }]],
      after: [["list", { items: 3 }], ["list", { items: 2, tag: "Archived", hl: true }]] }
  };
  var MENU = ["Invoice PDFs", "Two-factor sign-in", "Slow orders query", "Keyboard shortcuts", "Avatar uploads",
    "Billing settings", "Password reset email", "Onboarding checklist", "Pricing page under 1 s",
    "Webhook retries", "Usage alerts", "Archive old projects"];

  var reduce = window.matchMedia("(prefers-reduced-motion: reduce)");
  var lanes = Array.prototype.map.call(root.querySelectorAll(".lane"), function (lane) {
    return { el: lane, cards: lane.querySelector(".lane-cards"), n: lane.querySelector("[data-n]") };
  });
  var passList = root.querySelector("[data-pass-list]");
  var passClear = root.querySelector("[data-pass-clear]");
  var passTitle = root.querySelector("#pass-title");
  var callEl = root.querySelector("[data-call]");
  var announceEl = root.querySelector("[data-announce]");
  var toggle = root.querySelector("[data-toggle]");

  var now = 0;             // simulated milliseconds
  var seq = 0;             // entry order, so each lane lists oldest first
  var nextId = 119;
  var menuAt = 0;
  var sentTotal = 0;
  var tickets = [];
  var els = new Map();     // ticket -> card element
  var callEls = new Map(); // ticket -> pass entry element
  var paused = reduce.matches;
  var onScreen = false;
  var sheetOpen = false;
  var timer = null;
  var last = 0;
  var started = false;
  var chefHasCalled = false; // once the visitor calls, the demo chef stops
  var fullSince = null;    // simulated time the pass filled up

  function rand(a, b) { return a + Math.random() * (b - a); }
  function live(t) { return !t.gone; }
  function count(stage) { return tickets.filter(function (t) { return t.stage === stage && live(t); }).length; }
  function waitingList() {
    return tickets.filter(function (t) { return live(t) && t.stage === 4 && !t.walking; })
      .sort(function (a, b) { return a.waitingSince - b.waitingSince; });
  }

  function make(n, title, st, stage, due, extra) {
    var t = { n: n, id: "APP-" + n, title: title, st: st, stage: stage, due: due, seq: seq++, commits: 0,
      refires: 0, walking: false, waitingSince: 0, gone: false, note: "", tests: 30 + (n * 7) % 60 };
    for (var k in extra) t[k] = extra[k];
    return t;
  }

  // A mid-service board, so the first look is a working kitchen.
  tickets = [
    make(118, "Team invites", 3, 0, 1800),
    make(117, "Search by phone", 0, 1, 2600),
    make(112, "Retry failed payouts", 1, 2, 3800, { commits: 4, nextCommit: 1400 }),
    make(114, "Rate limits on webhooks", 5, 2, 6200, { commits: 2, nextCommit: 900 }),
    make(115, "Empty states", 4, 2, 8200, { commits: 1, nextCommit: 1900 }),
    make(110, "Weekly digest email", 0, 3, 4600, { commits: 5 }),
    make(108, "Dark mode tokens", 2, 4, 0, { waitingSince: -9000, commits: 7, refires: 1, note: "match the spacing" }),
    make(109, "CSV export", 1, 4, 0, { waitingSince: -4000, commits: 3 }),
    make(104, "Audit log", 5, 5, 0, { commits: 6 }),
    make(106, "Fix login redirect", 3, 5, 0, { commits: 2 })
  ];
  sentTotal = 2;

  /*
   * The "Last call" line moves slowly on purpose: only Fire, At the pass, Service and the chef's own
   * calls show, and each line holds for at least DWELL ms. The chef's calls show at once; the line's
   * calls wait their turn, and only the newest waiting one shows.
   */
  var DWELL = 2400, shownAt = 0, pending = null, pendingTimer = null;
  function show(text) { callEl.textContent = text; shownAt = Date.now(); }
  function call(text, chef) {
    if (chef) { pending = null; clearTimeout(pendingTimer); pendingTimer = null; show(text); return; }
    var wait = DWELL - (Date.now() - shownAt);
    if (wait <= 0 && !pendingTimer) { show(text); return; }
    if (!(pending && pending.indexOf("Service") === 0)) pending = text;
    if (!pendingTimer) pendingTimer = setTimeout(function () { pendingTimer = null; if (pending) { show(pending); pending = null; } }, Math.max(wait, 0));
  }
  function announce(text) { announceEl.textContent = ""; setTimeout(function () { announceEl.textContent = text; }, 30); }

  function status(t) {
    switch (t.stage) {
      case 0: return { text: "New", cls: "" };
      case 1: return { text: "Assigned", cls: "" };
      case 2:
        if (t.refires && t.commits < 2 && t.note) return { text: "Refired", cls: "red" };
        return { text: t.commits ? t.commits + (t.commits === 1 ? " commit" : " commits") : "Heard", cls: "fire" };
      case 3: return { text: t.due <= now ? "Reviews passed" : "Reviews running", cls: "tasting" };
      case 4: return { text: t.walking ? "Walking out" : "Your look", cls: "plating" };
      default: return { text: "Merged", cls: "sent" };
    }
  }

  var CLOCHE = '<svg class="cloche" viewBox="0 0 24 24" aria-hidden="true"><path d="M4.25 17.4a7.75 7.75 0 0 1 15.5 0" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="7.4" r="1.75" fill="currentColor"/><path d="M2.75 19h18.5l-1.5 1.5H4.25z" fill="currentColor"/></svg>';

  function settle(el) {
    // Entrance classes come off once played, so moving the node never replays them.
    el.addEventListener("animationend", function () { el.classList.remove("is-new"); }, { once: true });
  }

  function card(t) {
    var el = document.createElement("button");
    el.type = "button";
    el.className = "tk";
    var s = STATIONS[t.st];
    el.innerHTML =
      '<span class="tk-st"><span></span></span>' +
      '<span class="tk-t"></span><span class="tk-m"><img src="assets/' + s.icon + '" alt=""><span class="tk-id"></span><span class="tk-s"></span></span>';
    el.querySelector(".tk-st span").textContent = s.name;
    el.querySelector(".tk-t").textContent = t.title;
    el.querySelector(".tk-id").textContent = t.id;
    el.addEventListener("click", function () { openSheet(t, el); });
    return el;
  }

  function fill(el, t) {
    var s = status(t);
    var at = t.stage === 4 && !t.walking;
    el.classList.toggle("at-pass", at);
    var sEl = el.querySelector(".tk-s");
    sEl.textContent = s.text;
    sEl.className = "tk-s" + (s.cls ? " " + s.cls : "");
    var c = el.querySelector(".cloche");
    if (at && !c) el.insertAdjacentHTML("beforeend", CLOCHE);
    if (!at && c) c.remove();
    var st = STATIONS[t.st];
    el.setAttribute("aria-label", "Open " + t.id + ", " + t.title + ". " + st.agent + " at " + st.name.toLowerCase() + ". " + STAGES[t.stage] + ": " + s.text + (at ? ". At the pass." : "."));
  }

  function passEntry(t) {
    var li = document.createElement("li");
    li.className = "call";
    var st = STATIONS[t.st];
    li.innerHTML =
      '<p class="call-top"><span class="tk-id"></span><span></span></p><button type="button" class="call-q"></button>' +
      '<div class="call-actions"><button type="button" class="call-go">Go</button><button type="button" class="call-refire">Refire</button></div>';
    li.querySelector(".tk-id").textContent = t.id;
    li.querySelector(".call-top span:last-child").textContent = st.agent + " · " + st.name;
    li.querySelector(".call-q").textContent = t.title + ": send it out or refire?";
    li.querySelector(".call-q").setAttribute("aria-label", "Open " + t.id + ", " + t.title + ", to see the plate");
    li.querySelector(".call-go").setAttribute("aria-label", "Go: send " + t.id + ", " + t.title + ", out");
    li.querySelector(".call-refire").setAttribute("aria-label", "Refire " + t.id + ", " + t.title);
    li.querySelector(".call-q").addEventListener("click", function (e) { openSheet(t, e.currentTarget); });
    li.querySelector(".call-go").addEventListener("click", function () { chefHasCalled = true; go(t); });
    li.querySelector(".call-refire").addEventListener("click", function () { chefHasCalled = true; refire(t); });
    return li;
  }

  /* Put `el` at position `i` in `parent`, moving it only if it is not already there. */
  function place(parent, el, i) {
    var at = parent.children[i];
    if (at !== el) parent.insertBefore(el, at || null);
  }

  /* Render with FLIP: note where each card was, move the DOM, then slide each card from old to new. */
  function render() {
    var animate = !reduce.matches;
    var first = new Map();
    if (animate) els.forEach(function (el) { first.set(el, el.getBoundingClientRect()); });

    // Moving a node drops its focus; remember the focused card so it keeps it.
    var focusedCard = document.activeElement && document.activeElement.classList && document.activeElement.classList.contains("tk") ? document.activeElement : null;
    var lostCard = false;

    // Cards for tickets that left the board come out first, so the rest place around them cleanly.
    els.forEach(function (el, t) {
      if (!t.gone) return;
      if (el === focusedCard) lostCard = true;
      els.delete(t);
      el.remove();
    });
    tickets = tickets.filter(live);

    lanes.forEach(function (lane, i) {
      var list = tickets.filter(function (t) { return t.stage === i && live(t); }).sort(function (a, b) { return a.seq - b.seq; });
      list.forEach(function (t, j) {
        var el = els.get(t);
        if (!el) {
          el = card(t);
          if (animate && started) { el.classList.add("is-new"); settle(el); }
          els.set(t, el);
        }
        fill(el, t);
        // A lane shows at most four tickets, so a refire never makes the board grow. The count shows all;
        el.classList.toggle("spill", j < list.length - LANE_SHOW); // the oldest step out of sight first
        place(lane.cards, el, j);
      });
      lane.n.textContent = list.length ? String(list.length) : "";
    });
    if (focusedCard && focusedCard.isConnected && document.activeElement !== focusedCard && !focusedCard.classList.contains("spill")) {
      focusedCard.focus({ preventScroll: true });
    } else if ((lostCard || (focusedCard && focusedCard.classList.contains("spill"))) && !sheetOpen) {
      passTitle.focus({ preventScroll: true });
    }


    if (animate) {
      first.forEach(function (r, el) {
        if (!el.isConnected) return;
        var n = el.getBoundingClientRect();
        var dx = r.left - n.left, dy = r.top - n.top;
        // A card that was out of sight has no last place: it fades in where it lands instead of sliding.
        if (!r.width || !n.width) { el.classList.add("is-new"); settle(el); return; }
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
        el.animate([{ transform: "translate(" + dx + "px," + dy + "px)" }, { transform: "none" }],
          { duration: 620, easing: "cubic-bezier(0.2, 0.7, 0.2, 1)" });
      });
    }

    renderPass(animate);

    var active = tickets.filter(function (t) { return t.stage < 5; }).length;
    var waiting = waitingList().length;
    root.querySelectorAll('[data-count="active"]').forEach(function (e) { e.textContent = active; });
    root.querySelectorAll('[data-count="waiting"]').forEach(function (e) { e.textContent = waiting; });
    root.querySelectorAll('[data-count="sent"]').forEach(function (e) { e.textContent = sentTotal; });
  }

  function renderPass(animate) {
    var waiting = waitingList();
    var focused = document.activeElement;
    var lostFocus = false;
    callEls.forEach(function (li, t) {
      if (waiting.indexOf(t) !== -1) return;
      if (li.contains(focused)) lostFocus = true;
      li.remove();
      callEls.delete(t);
    });
    waiting.forEach(function (t, i) {
      var li = callEls.get(t);
      if (!li) {
        li = passEntry(t);
        if (animate && started) { li.classList.add("is-new"); settle(li); }
        callEls.set(t, li);
      }
      place(passList, li, i);
    });
    if (lostFocus && !sheetOpen) {
      var next = passList.querySelector(".call-go");
      (next || passTitle).focus({ preventScroll: true });
    }
    passClear.hidden = waiting.length > 0;
    // The line under the title stays put; a full pass shows in its three calls.
  }

  /* The chef's calls. These finish even while the demo is paused. */
  function go(t, demo) {
    if (!t || t.stage !== 4 || t.walking) return;
    t.walking = true;
    call("Go " + t.id + (demo ? " (demo Chef)" : ""), !demo);
    announce("Go. " + t.id + " is walking out.");
    render();
    if (sheetOpen && sheetTicket === t) fillSheet();
    setTimeout(function () {
      t.stage = 5; t.walking = false; t.seq = seq++;
      sentTotal++;
      var sent = tickets.filter(function (x) { return x.stage === 5 && live(x); }).sort(function (a, b) { return a.seq - b.seq; });
      while (sent.length > CAP.sent) sent.shift().gone = true;
      call("Service: " + t.id + " merged");
      render();
      if (sheetOpen && sheetTicket === t) fillSheet();
    }, 1700);
  }

  function refire(t, demo) {
    if (!t || t.stage !== 4 || t.walking) return;
    t.stage = 2; t.seq = seq++; t.refires++; t.commits = 0; t.due = now + rand(4200, 6000); t.nextCommit = now + 1500;
    t.note = NOTES[t.refires % NOTES.length];
    call("Refire " + t.id + ": " + t.note + (demo ? " (demo Chef)" : ""), !demo);
    announce("Refired " + t.id + ". It goes back to Fire.");
    render();
  }

  /* The line, on the simulated clock. */
  var demoCalls = 0;
  function step(dt) {
    now += dt;
    var changed = false;
    var sorted = tickets.slice().sort(function (a, b) { return a.seq - b.seq; });
    sorted.forEach(function (t) {
      if (t.gone) return;
      if (t.stage === 2 && t.nextCommit && now >= t.nextCommit && now < t.due) {
        t.commits++; t.nextCommit = now + rand(1100, 1700); changed = true;
      }
      if (now < t.due) return;
      if (t.stage === 0) {
        t.stage = 1; t.seq = seq++; t.due = now + rand(1400, 2200); changed = true;
      } else if (t.stage === 1 && count(2) < CAP.fire) {
        t.stage = 2; t.seq = seq++; t.due = now + rand(4200, 6800); t.nextCommit = now + 1300; changed = true;
        call("Fire " + t.id);
      } else if (t.stage === 2 && count(3) < CAP.tasting) {
        t.stage = 3; t.seq = seq++; t.due = now + rand(2600, 3600); t.note = ""; t.passed = false; changed = true;
      } else if (t.stage === 3 && count(4) < CAP.plating) {
        t.stage = 4; t.seq = seq++; t.waitingSince = now; changed = true;
        call("At the pass: " + t.id);
      } else if (t.stage === 3 && !t.passed) {
        t.passed = true; changed = true; // shows "Reviews passed" while it waits for room at the pass
      }
    });
    // New orders while the line has room.
    var active = tickets.filter(function (t) { return live(t) && t.stage < 5; }).length;
    if (count(0) < CAP.order && active < 12 && now >= step.nextOrder) {
      var title = MENU[menuAt++ % MENU.length];
      tickets.push(make(nextId, title, nextId % STATIONS.length, 0, now + rand(1600, 2400)));
      nextId++;
      step.nextOrder = now + rand(2600, 3600);
      changed = true;
    }
    // The demo chef: only until the visitor makes a call, and only once the pass has been full a while.
    var waiting = waitingList();
    if (waiting.length >= CAP.plating) {
      if (fullSince === null) fullSince = now;
      if (!chefHasCalled && now - fullSince > 5200) {
        demoCalls++;
        if (demoCalls % 3 === 0 && count(2) < CAP.fire) refire(waiting[0], true); else go(waiting[0], true);
        fullSince = null;
      }
    } else {
      fullSince = null;
    }
    if (changed) render();
  }
  step.nextOrder = 2400;

  function running() { return !paused && !sheetOpen && onScreen && document.visibilityState === "visible"; }

  function loop(ts) {
    if (!running()) { timer = null; return; }
    var dt = last ? Math.min(ts - last, 250) : 0;
    last = ts;
    if (dt) step(dt);
    timer = requestAnimationFrame(loop);
  }

  function sync() {
    if (running() && timer === null) { last = 0; timer = requestAnimationFrame(loop); }
    root.dataset.state = paused ? "paused" : "running";
    toggle.textContent = paused ? "Play" : "Pause";
    toggle.setAttribute("aria-label", paused ? "Play the demo" : "Pause the demo");
  }

  toggle.addEventListener("click", function () { paused = !paused; sync(); });
  document.addEventListener("visibilitychange", sync);
  if (typeof IntersectionObserver !== "undefined") {
    new IntersectionObserver(function (entries) {
      onScreen = entries[entries.length - 1].isIntersecting;
      sync();
    }, { threshold: 0.15 }).observe(root);
  } else {
    onScreen = true;
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* The plate: a drawn app screen, before or after, light or dark.                                  */

  var THEMES = {
    dark: { bg: "#111214", side: "#16171a", panel: "#1c1d21", panel2: "#24252a", rule: "#2c2d33", ink: "#e9eaee", ink2: "#9a9ca5", ink3: "#5d5f68", blue: "#3b9bff", blueT: "rgba(59,155,255,.16)", red: "#ff6b61", redT: "rgba(255,107,97,.14)", green: "#30d158", greenT: "rgba(48,209,88,.14)", amber: "#ffb340", amberT: "rgba(255,179,64,.14)", odd: "#f2f2f2" },
    light: { bg: "#f6f6f4", side: "#eeeeeb", panel: "#ffffff", panel2: "#f1f1ef", rule: "#e2e2de", ink: "#16171a", ink2: "#62656d", ink3: "#a3a6ad", blue: "#0a6fe0", blueT: "rgba(10,111,224,.1)", red: "#d1242f", redT: "rgba(209,36,47,.08)", green: "#1f8a3c", greenT: "rgba(31,138,60,.1)", amber: "#b26200", amberT: "rgba(178,98,0,.1)", odd: "#1c1d21" }
  };

  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }
  function R(x, y, w, h, r, fill, extra) { return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" fill="' + fill + '"' + (extra || "") + "/>"; }
  function T(x, y, text, size, fill, weight, anchor) {
    return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + fill + '" font-weight="' + (weight || 500) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + esc(text) + "</text>";
  }
  function bar(x, y, w, c) { return R(x, y, w, 6, 3, c); }

  // Each block draws itself at (x, y) with width w and returns [svg, height].
  var BLOCKS = {
    head: function (o, c, x, y, w) {
      var s = T(x, y + 16, o.title, 15, c.ink, 650);
      if (o.button) s += R(x + w - 96, y + 2, 96, 24, 6, c.blue) + T(x + w - 48, y + 18, o.button, 10.5, "#fff", 650, "middle");
      return [s, 34];
    },
    table: function (o, c, x, y, w) {
      var rows = o.rows, cols = o.cols, rh = 26, s = R(x, y, w, 24 + rows * rh, 8, c.panel) ;
      s += R(x, y, w, 24, 8, c.panel2) + R(x, y + 16, w, 8, 0, c.panel2);
      var cw = (w - 24) / cols;
      for (var k = 0; k < cols; k++) s += bar(x + 12 + k * cw, y + 9, cw * 0.4, c.ink3);
      for (var i = 0; i < rows; i++) {
        var ry = y + 24 + i * rh;
        if (i) s += R(x + 12, ry, w - 24, 1, 0, c.rule);
        for (var j = 0; j < cols; j++) {
          var last = j === cols - 1;
          if (last && o.status) {
            var tone = /Fail|429/.test(o.status) ? "red" : /Paid|Delivered|Retried/.test(o.status) ? "green" : "amber";
            s += R(x + 12 + j * cw, ry + 7, 58, 13, 6.5, c[tone + "T"]) + T(x + 12 + j * cw + 29, ry + 16.5, o.status, 8, c[tone], 650, "middle");
          } else if (last && o.action) {
            s += R(x + w - 12 - 50, ry + 6, 50, 15, 5, c.blueT) + T(x + w - 12 - 25, ry + 16.5, o.action, 8.5, c.blue, 650, "middle");
          } else {
            s += bar(x + 12 + j * cw, ry + 10, cw * (0.35 + ((i * 7 + j * 3) % 5) / 10), j ? c.ink3 : c.ink2);
          }
        }
      }
      return [s, 24 + rows * rh];
    },
    list: function (o, c, x, y, w) {
      var s = "", h = 30;
      if (o.tag) s += T(x, y + 10, o.tag, 9.5, c.ink2, 650), y += 16;
      for (var i = 0; i < o.items; i++) {
        var ry = y + i * (h + 6);
        s += R(x, ry, w, h, 7, c.panel) + R(x + 10, ry + 9, 12, 12, 6, c.panel2) + bar(x + 30, ry + 9, 120 + (i * 37) % 90, c.ink2) + bar(x + 30, ry + 18, 70 + (i * 23) % 60, c.ink3);
        if (o.tag) s += R(x + w - 70, ry + 8, 58, 14, 7, o.tag === "Archived" ? c.panel2 : c.blueT) + T(x + w - 41, ry + 18, o.tag, 8, o.tag === "Archived" ? c.ink2 : c.blue, 650, "middle");
      }
      return [s, (o.tag ? 16 : 0) + o.items * (h + 6)];
    },
    search: function (o, c, x, y, w) {
      return [R(x, y, w, 30, 8, c.panel, ' stroke="' + c.rule + '"') + '<circle cx="' + (x + 16) + '" cy="' + (y + 15) + '" r="4.5" fill="none" stroke="' + c.ink3 + '" stroke-width="1.5"/>' + T(x + 28, y + 19, o.text, 10, o.hl ? c.ink : c.ink3, 500), 38];
    },
    empty: function (o, c, x, y, w) {
      var h = 150, s = R(x, y, w, h, 10, c.panel, ' stroke="' + c.rule + '" stroke-dasharray="4 4"');
      s += '<circle cx="' + (x + w / 2) + '" cy="' + (y + 50) + '" r="16" fill="' + c.panel2 + '"/>' + T(x + w / 2, y + 90, o.text, 12, c.ink, 650, "middle");
      if (o.button) s += bar(x + w / 2 - 80, y + 102, 160, c.ink3) + R(x + w / 2 - 50, y + 116, 100, 22, 6, c.blue) + T(x + w / 2, y + 131, o.button, 9.5, "#fff", 650, "middle");
      return [s, h];
    },
    blank: function (o, c, x, y, w) { return [R(x, y, w, 150, 10, c.panel), 150]; },
    banner: function (o, c, x, y, w) {
      return [R(x, y, w, 30, 8, c[o.tone + "T"]) + '<circle cx="' + (x + 15) + '" cy="' + (y + 15) + '" r="4" fill="' + c[o.tone] + '"/>' + T(x + 26, y + 19, o.text, 10.5, c[o.tone], 650), 38];
    },
    chart: function (o, c, x, y, w) {
      var h = 120, s = R(x, y, w, h, 10, c.panel), pts = [];
      for (var i = 0; i <= 12; i++) {
        var v = 0.35 + 0.18 * Math.sin(i * 0.9) + i * 0.025;
        if (o.spike && (i === 7 || i === 8)) v = 0.95;
        pts.push((x + 14 + i * (w - 28) / 12).toFixed(1) + "," + (y + h - 14 - v * (h - 34)).toFixed(1));
      }
      if (o.limit) s += R(x + 12, y + 30, w - 24, 1, 0, c.amber) + T(x + w - 14, y + 26, "Limit", 8.5, c.amber, 650, "end");
      s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + (o.spike ? c.red : c.blue) + '" stroke-width="2"/>';
      return [s, h];
    },
    stats: function (o, c, x, y, w) {
      var s = "", cw = (w - (o.n - 1) * 10) / o.n;
      for (var i = 0; i < o.n; i++) s += R(x + i * (cw + 10), y, cw, 56, 8, c.panel) + bar(x + i * (cw + 10) + 12, y + 14, cw * 0.4, c.ink3) + R(x + i * (cw + 10) + 12, y + 28, cw * 0.5, 14, 4, c.ink2);
      return [s, 64];
    },
    cards: function (o, c, x, y, w) {
      var s = "", cw = (w - 20) / 3, h = o.price ? 110 : 70;
      for (var i = 0; i < o.n; i++) {
        var cx = x + i * (cw + 10), fill = o.odd && i === 1 ? c.odd : c.panel;
        s += R(cx, y, cw, h, 9, fill, i === 1 && o.price ? ' stroke="' + c.blue + '" stroke-width="1.5"' : "");
        s += bar(cx + 12, y + 14, cw * 0.45, o.odd && i === 1 ? c.ink3 : c.ink2) + bar(cx + 12, y + 26, cw * 0.65, c.ink3);
        if (o.price) s += T(cx + 12, y + 62, ["$0", "$24", "$79"][i], 18, c.ink, 700) + R(cx + 12, y + 80, cw - 24, 18, 5, i === 1 ? c.blue : c.panel2);
      }
      return [s, h + 8];
    },
    form: function (o, c, x, y, w) {
      var s = "";
      for (var i = 0; i < o.fields; i++) s += bar(x, y + i * 46, 80, c.ink3) + R(x, y + i * 46 + 12, Math.min(w, 300), 26, 6, c.panel, ' stroke="' + c.rule + '"');
      return [s, o.fields * 46];
    },
    skeleton: function (o, c, x, y, w) {
      var s = "";
      for (var i = 0; i < o.rows; i++) s += R(x, y + i * 30, w, 22, 6, c.panel2);
      return [s, o.rows * 30];
    },
    timing: function (o, c, x, y, w) {
      return [T(x, y + 14, "First paint", 10, c.ink2, 500) + R(x + 70, y + 2, 54, 18, 9, c[o.tone + "T"]) + T(x + 97, y + 15, o.text, 9.5, c[o.tone], 700, "middle"), 30];
    },
    email: function (o, c, x, y, w) {
      var ew = Math.min(w, 340), ex = x + (w - ew) / 2, s = R(ex, y, ew, 260, 10, c.panel);
      if (o.branded) {
        s += R(ex, y, ew, 44, 10, c.blue) + R(ex, y + 34, ew, 10, 0, c.blue) + T(ex + 18, y + 27, o.title, 12, "#fff", 700);
        s += bar(ex + 18, y + 64, ew * 0.6, c.ink2) + bar(ex + 18, y + 78, ew * 0.75, c.ink3) + bar(ex + 18, y + 92, ew * 0.5, c.ink3);
        s += R(ex + 18, y + 112, ew - 36, 50, 8, c.panel2) + R(ex + 18, y + 176, 120, 26, 6, c.blue) + T(ex + 78, y + 193, o.button, 9.5, "#fff", 650, "middle");
      } else {
        for (var i = 0; i < 9; i++) s += bar(ex + 18, y + 22 + i * 14, ew * (0.4 + ((i * 13) % 5) / 10), c.ink3);
      }
      return [s, 268];
    },
    login: function (o, c, x, y, w) {
      var lw = 240, lx = x + (w - lw) / 2, h = o.code ? 200 : 176, s = R(lx, y, lw, h, 12, c.panel);
      s += T(lx + lw / 2, y + 30, o.code ? "Enter your code" : "Sign in", 13, c.ink, 700, "middle");
      if (o.code) {
        for (var i = 0; i < 6; i++) s += R(lx + 24 + i * 33, y + 52, 27, 34, 6, c.panel2, i < 3 ? ' stroke="' + c.blue + '"' : "") + (i < 3 ? T(lx + 37.5 + i * 33, y + 74, String((i * 4 + 3) % 10), 13, c.ink, 650, "middle") : "");
        s += bar(lx + 24, y + 104, 150, c.ink3) + R(lx + 24, y + 130, lw - 48, 30, 7, c.blue) + T(lx + lw / 2, y + 149, "Verify", 10.5, "#fff", 650, "middle");
      } else {
        s += R(lx + 24, y + 48, lw - 48, 28, 6, c.panel2) + R(lx + 24, y + 86, lw - 48, 28, 6, c.panel2) + R(lx + 24, y + 128, lw - 48, 30, 7, c.blue) + T(lx + lw / 2, y + 147, "Continue", 10.5, "#fff", 650, "middle");
      }
      return [s, h + 10];
    },
    profile: function (o, c, x, y, w) {
      var s = R(x, y, w, 84, 10, c.panel) + '<circle cx="' + (x + 44) + '" cy="' + (y + 42) + '" r="26" fill="' + (o.photo ? "url(#ph)" : c.panel2) + '"/>';
      if (!o.photo) s += T(x + 44, y + 47, "DM", 13, c.ink2, 700, "middle");
      s += bar(x + 84, y + 30, 110, c.ink2) + bar(x + 84, y + 44, 80, c.ink3);
      if (o.photo) s += R(x + w - 108, y + 29, 92, 26, 6, c.blueT) + T(x + w - 62, y + 46, "Change photo", 9, c.blue, 650, "middle");
      return [s, 94];
    },
    checklist: function (o, c, x, y, w) {
      var s = R(x, y, w, 30 + o.items * 26, 10, c.panel) + T(x + 14, y + 20, "Set up your team", 11.5, c.ink, 700);
      for (var i = 0; i < o.items; i++) {
        var done = i < 2, ry = y + 34 + i * 26;
        s += '<circle cx="' + (x + 22) + '" cy="' + (ry + 6) + '" r="7" fill="' + (done ? c.green : "none") + '" stroke="' + (done ? c.green : c.ink3) + '" stroke-width="1.5"/>';
        if (done) s += '<path d="M' + (x + 18.5) + " " + (ry + 6) + "l2.5 2.5 4.5-5" + '" fill="none" stroke="#fff" stroke-width="1.6"/>';
        s += bar(x + 38, ry + 3, 120 + i * 24, done ? c.ink3 : c.ink2);
      }
      return [s, 38 + o.items * 26];
    },
    modal: function (o, c, x, y, w) { return [null, 0, o]; } // drawn last, over the screen
  };

  function screen(spec, which, theme) {
    var c = THEMES[theme], W = 640, H = 400, cx = 148, cw = W - cx - 24;
    var s = '<svg viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg" font-family="Figtree, system-ui, sans-serif" role="img" aria-label="' + esc(spec.page + ", " + which) + '">';
    s += '<defs><linearGradient id="ph" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb36b"/><stop offset="1" stop-color="#d9480f"/></linearGradient></defs>';
    s += R(0, 0, W, H, 0, c.bg) + R(0, 0, 128, H, 0, c.side);
    s += R(16, 16, 18, 18, 5, c.blue) + bar(42, 22, 50, c.ink2);
    var nav = ["Home", "Inbox", "Reports", "Settings"];
    if (nav.indexOf(spec.page) === -1) nav.splice(2, 0, spec.page);
    nav.forEach(function (n, i) {
      var y = 60 + i * 26, on = n === spec.page;
      if (on) s += R(10, y - 6, 108, 22, 6, c.panel2);
      s += T(22, y + 9, n, 10, on ? c.ink : c.ink2, on ? 650 : 500);
    });
    s += T(cx, 34, spec.page, 11, c.ink2, 600) + '<circle cx="' + (W - 36) + '" cy="30" r="10" fill="' + c.panel2 + '"/>' + R(cx, 48, cw, 1, 0, c.rule);
    var y = 64, overlay = null, outlines = "";
    (which === "after" ? spec.after : spec.before).forEach(function (b) {
      var out = BLOCKS[b[0]](b[1], c, cx, y, cw);
      if (out[0] === null) { overlay = out[2]; return; }
      if (b[1].hl && which === "after") {
        outlines += R(cx - 5, y - 5, cw + 10, out[1] + 4, 10, "none", ' stroke="' + c.blue + '" stroke-width="1.5" stroke-dasharray="5 4"');
        outlines += R(cx + cw - 30, y - 12, 36, 14, 7, c.blue) + T(cx + cw - 12, y - 2, "New", 8, "#fff", 700, "middle");
      }
      s += out[0];
      y += out[1] + 12;
    });
    s += outlines;
    if (overlay) {
      s += R(0, 0, W, H, 0, "rgba(0,0,0,.45)");
      var mw = 300, mx = (W - mw) / 2, my = 80, keys = [["?", "Show shortcuts"], ["j / k", "Next / previous"], ["e", "Archive"], ["/", "Search"]];
      s += R(mx, my, mw, 200, 12, c.panel, ' stroke="' + c.blue + '" stroke-width="1.5"') + T(mx + 18, my + 30, overlay.title, 13, c.ink, 700);
      keys.forEach(function (k, i) {
        s += R(mx + 18, my + 50 + i * 34, 44, 22, 5, c.panel2) + T(mx + 40, my + 65 + i * 34, k[0], 10, c.ink, 700, "middle") + T(mx + 74, my + 65 + i * 34, k[1], 10.5, c.ink2, 500);
      });
    }
    return s + "</svg>";
  }

  /* ---------------------------------------------------------------------------------------------- */
  /* The sheet.                                                                                       */

  var sheet = document.getElementById("sheet");
  var sheetTicket = null, sheetReturn = null, sheetView = "split", sheetTheme = "dark";
  function q(sel) { return sheet.querySelector(sel); }

  function drawPlate() {
    var t = sheetTicket, plate = q("[data-plate]"), empty = q("[data-plate-empty]");
    var spec = DISHES[t.title];
    plate.dataset.view = sheetView;
    q(".plate-bar").hidden = t.stage < 2 || !spec;
    if (t.stage < 2 || !spec) {
      plate.innerHTML = "";
      plate.hidden = true;
      empty.hidden = false;
      empty.textContent = t.stage === 0 ? "No brief yet. Nothing is plated until an agent fires." : "Brief locked and an agent assigned. The plate appears once it fires.";
      return;
    }
    plate.hidden = false;
    empty.hidden = true;
    var afterLabel = t.stage === 2 ? "After (draft, still cooking)" : t.stage === 5 ? "After (merged)" : "After";
    plate.innerHTML =
      '<figure class="shot shot-before"><figcaption>Before</figcaption>' + screen(spec, "before", sheetTheme) + "</figure>" +
      '<figure class="shot shot-after"><figcaption>' + afterLabel + "</figcaption>" + screen(spec, "after", sheetTheme) + "</figure>";
  }

  function checksFor(t) {
    var list = [];
    if (t.stage < 3) {
      list.push(["wait", t.stage === 2 ? "Checks run as the agent pushes" : "Nothing to taste yet"]);
    } else if (t.stage === 3 && t.due > now) {
      list.push(["run", "Tests running"], ["run", "Review running"]);
    } else {
      list.push(["ok", "Tests: " + t.tests + " passed"], ["ok", "Lint and types: clean"], ["ok", "Review: no blocking findings"]);
    }
    if (t.refires) list.push(["refire", "Refired " + t.refires + "×" + (t.note ? ": " + t.note : "")]);
    return list;
  }

  function fillSheet() {
    var t = sheetTicket, st = STATIONS[t.st], spec = DISHES[t.title];
    q("[data-sheet-station]").innerHTML = '<img src="assets/' + st.icon + '" alt="">';
    q("[data-sheet-station]").appendChild(document.createTextNode(st.agent + " · " + st.name));
    q("[data-sheet-id]").textContent = t.id;
    var stageEl = q("[data-sheet-stage]");
    stageEl.textContent = t.stage === 4 && !t.walking ? "At the pass" : STAGES[t.stage];
    stageEl.dataset.stage = t.stage;
    q("[data-sheet-title]").textContent = t.title;
    q("[data-sheet-track]").innerHTML = STAGES.map(function (name, i) {
      return '<li class="' + (i < t.stage ? "done" : i === t.stage ? "now" : "") + '"' + (i === t.stage ? ' aria-current="step"' : "") + ">" + name + "</li>";
    }).join("");
    var words = t.stage < 2 ? "Not started. The order is: " + t.title.toLowerCase() + "." :
      t.stage === 2 ? "Building. " + (t.commits ? t.commits + " commit" + (t.commits === 1 ? "" : "s") + " so far." : "Heard, Chef.") + (t.note ? " Fixing: " + t.note + "." : "") :
      (spec ? spec.did : "Done.") + (t.stage === 4 ? " Ready for your look." : t.stage === 5 ? " Merged." : "");
    q("[data-sheet-words]").textContent = words;
    q("[data-sheet-checks]").innerHTML = checksFor(t).map(function (c) { return '<li class="' + c[0] + '">' + esc(c[1]) + "</li>"; }).join("");
    var prBlock = q("[data-sheet-pr-block]");
    prBlock.hidden = t.stage < 2;
    if (t.stage >= 2) {
      var plus = 40 + (t.n * 37) % 260, minus = 5 + (t.n * 11) % 90;
      q("[data-sheet-pr]").innerHTML = '<span class="mono">#' + (180 + t.n) + "</span> · " + Math.max(t.commits, 1) + " commits · <span class=\"plus\">+" + plus + '</span> <span class="minus">−' + minus + "</span>" +
        (t.stage === 5 ? " · merged" : t.stage === 2 ? " · draft" : " · open");
    }
    q("[data-sheet-actions]").hidden = !(t.stage === 4 && !t.walking);
    drawPlate();
  }

  function setPressed(attr, value) {
    sheet.querySelectorAll("button[" + attr + "]").forEach(function (b) { b.setAttribute("aria-pressed", String(b.getAttribute(attr) === value)); });
  }

  function openSheet(t, from) {
    if (!sheet || typeof sheet.showModal !== "function") return;
    sheetTicket = t;
    sheetReturn = from || null;
    sheetView = window.matchMedia("(max-width: 820px)").matches ? "after" : "split";
    setPressed("data-view", sheetView);
    fillSheet();
    sheetOpen = true;
    sync();
    sheet.showModal();
    q("[data-sheet-close]").focus();
  }

  if (sheet) {
    sheet.addEventListener("close", function () {
      sheetOpen = false;
      sync();
      if (sheetReturn && sheetReturn.isConnected) sheetReturn.focus({ preventScroll: true });
      else passTitle.focus({ preventScroll: true });
    });
    sheet.addEventListener("click", function (e) { if (e.target === sheet) sheet.close(); });
    q("[data-sheet-close]").addEventListener("click", function () { sheet.close(); });
    sheet.querySelectorAll("button[data-view]").forEach(function (b) {
      b.addEventListener("click", function () { sheetView = b.getAttribute("data-view"); setPressed("data-view", sheetView); drawPlate(); });
    });
    sheet.querySelectorAll("button[data-theme]").forEach(function (b) {
      b.addEventListener("click", function () { sheetTheme = b.getAttribute("data-theme"); setPressed("data-theme", sheetTheme); drawPlate(); });
    });
    q("[data-sheet-go]").addEventListener("click", function () { chefHasCalled = true; var t = sheetTicket; sheet.close(); go(t); });
    q("[data-sheet-refire]").addEventListener("click", function () { chefHasCalled = true; var t = sheetTicket; sheet.close(); refire(t); });
  }

  // The "ready to rule" card above the demo shows the same drawn plates, before and after.
  document.querySelectorAll("[data-plate-demo]").forEach(function (el) {
    var spec = DISHES[el.getAttribute("data-plate-demo")];
    if (!spec) return;
    el.innerHTML = '<figure><figcaption>Before</figcaption>' + screen(spec, "before", "dark") + '</figure>' +
      '<figure class="after"><figcaption>After</figcaption>' + screen(spec, "after", "dark") + "</figure>";
  });

  render();
  started = true;
  call("Fire APP-115");
  sync();
})();
