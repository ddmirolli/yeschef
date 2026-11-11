type ActionKind = 'go' | 'refire' | 'reply' | 'hold' | 'fine' | 'course';
interface CardAction { k: ActionKind; primary?: boolean; more?: boolean; note?: string; }
interface Card {
  flag: string; cls: string; age: string; who: string[][]; to: string;
  title: string; body: string; meta: string; read: string; acts: CardAction[]; brigade?: boolean;
}
interface Draft { i: number; value?: string; note?: string; }
function actionKind(value: string): ActionKind {
  switch (value) {
    case 'go': case 'refire': case 'reply': case 'hold': case 'fine': case 'course': return value;
    default: throw new Error(`Unknown demo action: ${value}`);
  }
}

(function () {
  function $<K extends keyof HTMLElementTagNameMap>(selector: K, root?: ParentNode | null): HTMLElementTagNameMap[K] | null;
  function $<T extends Element = HTMLElement>(selector: string, root?: ParentNode | null): T | null;
  function $(selector: string, root?: ParentNode | null): Element | null { return (root || document).querySelector(selector); }
  function must<T extends Element = HTMLElement>(selector: string, root?: ParentNode | null): T {
    const element = $<T>(selector, root);
    if (!element) throw new Error(`Missing team demo element: ${selector}`);
    return element;
  }
  const $$ = (selector: string, root?: ParentNode) => Array.from((root || document).querySelectorAll<HTMLElement>(selector));
  var esc = function (s: unknown) { return String(s).replace(/[&<>"]/g, function (c) { return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] ?? c); }); };
  // Until the visitor clicks or types here, nothing moves focus (the site page around this frame stays put).
  var touched = false;
  ['pointerdown', 'keydown', 'touchstart', 'focusin'].forEach(function (t) { window.addEventListener(t, function () { touched = true; }, true); });
  function focusIn(el: HTMLElement | null) { if (touched && el) el.focus({ preventScroll: true }); }

  var mini = function (av: string, c: string, name: string, stage: string, dot: string, title: string, text: string, course: string, cname: string) {
    return '<div class="mini"><div class="mh"><span class="av ' + c + '">' + av + '</span><b>' + name + '</b><span class="st"><span class="dot ' + dot + '"></span>' + stage + '</span></div>'
      + '<h4>' + title + '</h4><p>' + text + '</p><div class="cs"><span class="course ' + course + '"></span>' + cname + '</div></div>';
  };
  // What lands at a lead's pass in Open (S6), and, in Brigade, every ticket ready to merge.
  var CARDS: Record<string, Card> = {
    coll: { flag: 'Overlap', cls: 'f-coll', age: '4 min', who: [['KM', 'c3'], ['JP', 'c2']], to: 'Kai and Jon',
      title: 'Kai and Jon both change orchestration.ts',
      body: 'Kai’s thread pins are in review. Jon’s thread groups are in progress. Both edit the same file.',
      meta: 'app · found 4 min ago from the files each thread changed',
      read: '<div class="pair">'
        + mini('KM', 'c3', 'Kai', 'In review', 'd-tasting', 'Pin threads to the top of the sidebar', 'PR #412 is open. Adds <span class="mono">pinned</span> to the thread shell and a pin action. Review passed.', 'k3', 'Desktop polish')
        + mini('JP', 'c2', 'Jon', 'In progress', 'd-fire', 'Group threads by parent in the sidebar', 'Draft PR #415. Adds <span class="mono">groupId</span> to the thread shell. Checks are running.', 'k1', 'Mobile v1')
        + '</div><div class="files"><div class="fh">Files both threads change</div>'
        + '<div class="f both"><span class="mono">packages/contracts/src/orchestration.ts</span><span class="by">Kai +18 −2 · Jon +31 −6</span></div>'
        + '<div class="f both"><span class="mono">apps/web/src/sidebar/ThreadList.tsx</span><span class="by">Kai +40 −11 · Jon +72 −30</span></div>'
        + '<div class="fh" style="padding-top:12px">Contracts are shared code in this kitchen. Whoever merges second rebases on the first.</div></div>',
      acts: [{ k: 'reply', note: 'Kai merges first. Jon, rebase on #412 before your PR leaves draft.', primary: true }, { k: 'fine' }] },
    shared: { flag: 'Shared code', cls: 'f-sauce', age: '22 min', who: [['MR', 'c1']], to: 'Maya',
      title: 'Maya changes the shell stream protocol',
      body: 'Kai’s, Jon’s and Sam’s tickets all build on it, so it waits for you to merge it.',
      meta: 'relay · shared code: packages/contracts/src/shell/**',
      read: mini('MR', 'c1', 'Maya', 'In progress', 'd-fire', 'Shell stream protocol v3', 'PR #418 is open and the checks passed. Adds a <span class="mono">seq</span> field to every shell event so a client can resume after a drop. Old clients still read v2.', 'k2', 'Team relay')
        + '<div class="files"><div class="fh">Shared code it changes</div>'
        + '<div class="f"><span class="mono">packages/contracts/src/shell/stream.ts</span><span class="by">+64 −12</span></div>'
        + '<div class="f"><span class="mono">packages/contracts/src/shell/events.ts</span><span class="by">+21 −3</span></div>'
        + '<div class="fh" style="padding-top:12px">Tickets that build on it: Kai’s Pin threads, Jon’s Thread groups, Sam’s Mobile sign-in copy.</div></div>',
      acts: [{ k: 'go', primary: true }, { k: 'refire', note: 'Keep v2 events for one more release.' }, { k: 'hold' }] },
    unplanned: { flag: 'Unplanned', cls: 'f-off', age: '3 h', who: [['SO', 'c4']], to: 'Sam',
      title: 'Sam is building a pricing page',
      body: 'It is not part of Mobile v1, Team relay or Desktop polish, and it has been in progress for 3 hours.',
      meta: 'site · no project matches it',
      read: mini('SO', 'c4', 'Sam', 'In progress', 'd-fire', 'Pricing page', 'Three plans in a table and a monthly or yearly switch. 2 commits on a draft branch, no PR yet.', 'k0', 'Unplanned')
        + '<p class="say">Sam’s agent, 10 min ago: <span class="q">“The plan names are placeholders. Should Teams cost per seat or per kitchen?”</span></p>',
      acts: [{ k: 'course', primary: true }, { k: 'reply', note: 'Park this until Mobile v1 ships. Per seat for now.' }, { k: 'fine' }] },
    nc: { flag: 'Not checked', cls: 'f-nc', age: '2 h', who: [['LA', 'c0']], to: 'Lee',
      title: 'Lee’s Mac has not reported for 2 hours',
      body: 'Last seen in progress on “Relay retries”. Lee’s tickets show “Not checked” until the Mac wakes.',
      meta: 'relay · last report at 9:40',
      read: mini('LA', 'c0', 'Lee', 'Not checked', 'd-order', 'Relay retries', 'Last seen in progress, with a draft PR. Yes Chef shows no stage for it until Lee’s Mac reports again.', 'k2', 'Team relay')
        + '<p class="say">Your calls to Lee’s agents wait until the Mac is back. Nothing older is shown as live.</p>',
      acts: [{ k: 'hold', primary: true }, { k: 'fine' }] },
    tray: { flag: 'Ready to merge', cls: 'f-plate', age: '6 min', who: [['KM', 'c3']], to: 'Kai', brigade: true,
      title: 'Kai’s tray icon states are ready',
      body: 'PR #409 passed its checks and review. In Brigade it waits for you or Maya to merge it.',
      meta: 'app · Ready to merge · Desktop polish',
      read: mini('KM', 'c3', 'Kai', 'Ready to merge', 'd-plating', 'Tray icon states', 'PR #409. The tray icon shows idle, working and needs-you, in light and dark. Checks and review passed.', 'k3', 'Desktop polish')
        + '<p class="say">Kai’s agent: <span class="q">“Ready to merge. Merge it or request changes?”</span></p>',
      acts: [{ k: 'go', primary: true }, { k: 'refire', note: 'The needs-you dot is hard to see in light mode.' }, { k: 'hold' }, { k: 'course', more: true }] },
  };
  var ORDER = ['coll', 'shared', 'unplanned', 'nc', 'tray'];
  // The bar's actions, as the app names them (Dan, 2026-11-10): a word on the button, the full name and its key in the
  // tooltip. A labelled one has a word; Hold is an icon unless it is the blue one.
  var P: Record<string, string> = {
    merge: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="12" r="2.2"/><path d="M6.5 7.7v8.6"/><path d="M6.5 7.7c0 2.8 2.3 4.3 5 4.3h3.8"/>',
    changes: '<path d="M12 4.5v8M8 8.5h8M8 18.5h8"/>',
    reply: '<path d="M10 7 5 12l5 5"/><path d="M5 12h9a5 5 0 0 1 5 5v1.5"/>',
    hold: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8"/><path d="M5 4.5 3 6.5M19 4.5l2 2"/>',
    more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
    note: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="m13 7 4 4"/>',
    out: '<path d="M8.5 15.5 16 8"/><path d="M9.5 8H16v6.5"/>',
    dismiss: '<path d="M7 7l10 10M17 7 7 17"/>',
    project: '<rect x="4" y="4" width="16" height="16" rx="3"/><path d="M12 8.5v7M8.5 12h7"/>'
  };
  var svg = function (n: string) { return '<svg class="ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + P[n] + '</svg>'; };
  var ACT: Record<ActionKind, { ic: string; w: string; name: string; key: string }> = {
    go: { ic: 'merge', w: 'Merge', name: 'Merge: the agent merges it', key: 'M' },
    refire: { ic: 'changes', w: 'Changes', name: 'Request changes: say what to fix', key: 'F' },
    reply: { ic: 'reply', w: 'Reply', name: 'Reply to {to}', key: 'R' },
    hold: { ic: 'hold', w: 'Hold', name: 'Hold until 8:00 tomorrow', key: 'H' },
    fine: { ic: 'dismiss', w: 'Dismiss', name: 'It’s fine: no action', key: 'E' },
    course: { ic: 'project', w: 'Add', name: 'Add to a project', key: '' }
  };
  var state: { view: string; sel: string | null; brigade: boolean; done: Record<string, boolean>; staff: string | null; course: string; armed: ActionKind | null } = { view: 'pass', sel: null, brigade: false, done: {}, staff: null, course: '', armed: null };
  var app = must('#app'), list = must('#list'), reader = must('#reader');
  var open = function () { return ORDER.filter(function (id) { return !state.done[id] && (!CARDS[id].brigade || state.brigade); }); };

  function renderList() {
    var ids = open();
    $$('[data-count]').forEach(function (n) { n.textContent = String(ids.length); });
    if (!ids.length) {
      list.innerHTML = '<div class="clear"><b>All clear.</b>Nothing needs a lead right now.<button class="btn" type="button" data-reset>Start over</button></div>';
      return;
    }
    list.innerHTML = ids.map(function (id) {
      var c = CARDS[id];
      return '<button class="card' + (state.sel === id ? ' sel' : '') + '" type="button"' + (state.sel === id ? ' aria-current="true"' : '') + ' data-open="' + id + '"><div class="top"><span class="flag ' + c.cls + '">' + c.flag + '</span><span class="age">' + c.age + '</span></div>'
        + '<h3>' + c.title + '</h3><p class="body">' + c.body + '</p><div class="who">' + c.who.map(function (w) { return '<span class="av ' + w[1] + '">' + w[0] + '</span>'; }).join('') + '</div></button>';
    }).join('');
  }
  function renderReader() {
    var c = CARDS[state.sel ?? ''];
    if (!c || state.done[state.sel ?? '']) { reader.innerHTML = '<p class="empty">' + (open().length ? 'Pick a ticket to read it here.' : 'Nothing needs a lead.') + '</p>'; app.classList.remove('open-r'); return; }
    state.armed = null;
    reader.innerHTML = '<div class="head"><button class="back" type="button" data-back>‹ The Pass</button><span class="flag ' + c.cls + '">' + c.flag + '</span><h2>' + c.title + '</h2><p class="meta">' + c.meta + '</p></div>'
      + '<div class="body">' + c.read + '</div><form class="acts" data-form><div data-extra></div><div class="abar" data-bar>' + bar(c) + '</div></form>';
  }
  // The bar: the blue action, the one-word actions, the icons after a thin divider, then More (its key is ".", as in
  // Gmail). While Reply, Request changes or Add is armed, that one is blue and takes ⌘↵.
  function bar(c: Card) {
    var lab = '', icons = '', rows = '', phone = '';
    var keys = function (list: string[]) { return list.filter(Boolean).map(function (k, i) { return (i ? '<span class="or">or</span>' : '') + '<kbd>' + k + '</kbd>'; }).join(''); };
    c.acts.forEach(function (a, i) {
      var d = ACT[a.k], name = d.name.replace('{to}', c.to), blue = state.armed ? state.armed === a.k : !!a.primary;
      if (a.more) { rows += '<button class="mi" type="button" role="menuitem" data-act="' + i + '">' + svg(d.ic) + '<span>' + name + '</span>' + (d.key ? '<kbd>' + d.key + '</kbd>' : '') + '</button>'; return; }
      var icon = a.k === 'hold' && !a.primary;
      var b = '<button class="' + (icon ? 'ib' : 'ab') + (blue ? ' fill' : '') + (a.primary ? ' primary' : '') + '" type="button" data-act="' + i + '"'
        + (state.armed === a.k ? ' data-send="' + a.k + '"' : '') + (icon ? ' aria-label="' + esc(name) + '"' : '') + '>' + svg(d.ic) + (icon ? '' : '<span>' + d.w + '</span>')
        + '<span class="tip" aria-hidden="true"><span>' + name + '</span>' + keys([d.key, blue ? '⌘↵' : '']) + '</span></button>';
      if (icon) { icons += b; phone += '<button class="mi ph" type="button" role="menuitem" data-act="' + i + '">' + svg(d.ic) + '<span>' + name + '</span></button>'; }
      else lab += b;
    });
    var id = 'more-' + state.sel;
    return lab + (icons ? '<span class="vr" aria-hidden="true"></span>' + icons : '')
      + '<button class="ib more-b" type="button" data-more popovertarget="' + id + '" aria-label="More" aria-haspopup="menu">' + svg('more') + '<span class="mw">More</span><span class="tip" aria-hidden="true"><span>More</span><kbd>.</kbd></span></button>'
      + '<div class="menu" id="' + id + '" popover role="menu" aria-label="More actions">' + phone + rows + (phone || rows ? '<span class="mh' + (rows ? '' : ' ph') + '"></span>' : '')
      + '<button class="mi" type="button" role="menuitem" data-note>' + svg('note') + '<span>Add a note</span><kbd>N</kbd></button>'
      + '<button class="mi" type="button" role="menuitem" data-t3>' + svg('out') + '<span>Open in T3</span><kbd>O</kbd></button>'
      + '<button class="mi-x" type="button" popovertarget="' + id + '" popovertargetaction="hide">Cancel</button></div>';
  }
  function redrawBar() { var b = $('[data-bar]', reader), c = CARDS[state.sel ?? '']; if (b && c) b.innerHTML = bar(c); }
  function shut() { $$('.menu').forEach(function (m) { try { m.hidePopover(); } catch (x) {} }); }
  function note(c: Card | undefined, a?: CardAction) {
    if (!c) return;
    var extra = must('[data-extra]', reader), ta = $('textarea', extra);
    if (!ta) {
      // Beside a project pick, never in its place: an armed Add still finds its select (PR-Agent r1 on #72).
      extra.insertAdjacentHTML('beforeend', '<textarea aria-label="Note to ' + esc(c.to) + '"></textarea><p class="hint">Goes to ' + esc(c.to) + '’s agent' + (c.to.indexOf(' and ') > 0 ? 's' : '') + ', in their own T3 Code. ⌘↵ sends the blue action.</p>');
      ta = must<HTMLTextAreaElement>('textarea', extra);
    }
    ta.placeholder = a && a.note ? a.note : 'What should the agent know?';
    // The sample reply fills only an empty field: a draft the visitor typed stays.
    if (a && a.note && !ta.value.trim()) ta.value = a.note;
    focusIn(ta);
  }
  function render() { renderList(); renderReader(); }
  function pick(id: string | null) {
    state.sel = id; render();
    app.classList.toggle('open-r', !!id);
    focusIn($('.reader .abar .primary'));
  }
  function setView(v: string) {
    state.view = v;
    app.classList.toggle('v-pass', v === 'pass'); app.classList.toggle('v-kitchen', v === 'kitchen');
    filterGrid();
  }
  function filterGrid() {
    $$('.passbtn[data-go]').forEach(function (b) { b.setAttribute('aria-pressed', String(b.dataset.go === state.view)); });
    $$('.ri[data-staff]').forEach(function (b) {
      var on = state.view === 'kitchen' && b.dataset.staff === state.staff;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    $$('.ri[data-course]').forEach(function (b) {
      var on = state.view === 'kitchen' && b.dataset.course === state.course && !!state.course;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    $$('.fchip').forEach(function (b) {
      var on = b.dataset.course === state.course;
      b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on));
    });
    $$('#grid [data-row]').forEach(function (n) { n.classList.toggle('row-hi', !!state.staff && n.dataset.row === state.staff && n.dataset.row !== 'lee'); n.classList.toggle('dimmed', !!state.staff && n.dataset.row !== state.staff); });
    $$('#grid .tk').forEach(function (t) { t.classList.toggle('dimmed', !!state.course && t.dataset.k !== state.course); });
    var tray = must('#tray-tk'); tray.classList.toggle('wait', state.brigade);
    must('[data-fb-legend]').hidden = !state.brigade;
  }

  // Acting: as in the app, a send waits four seconds with Undo, then goes. Here "goes" means the card leaves the pass.
  var toastEl = must('#toast');
  var pending: { id: string; until: number; draft: Draft | null } | null = null;
  var toastTimer: ReturnType<typeof setTimeout> | undefined;
  function toast(msg: string, undo = false) {
    clearTimeout(toastTimer);
    must('[data-msg]', toastEl).textContent = msg;
    must('[data-undo]', toastEl).hidden = !undo;
    toastEl.classList.add('on');
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, undo ? 4000 : 3200);
  }
  function settle(id: string | null, msg: string, draft?: Draft | null) {
    if (!id) return;
    var next = open().filter(function (x) { return x !== id; })[0] || null;
    state.done[id] = true;
    pending = { id: id, until: Date.now() + 4000, draft: draft || null };
    state.sel = matchMedia('(max-width:760px)').matches ? null : next;
    render(); app.classList.toggle('open-r', false);
    toast(msg, true);
  }
  function act(i: number): void {
    var c = CARDS[state.sel ?? ''], a = c && c.acts[i], extra = must('[data-extra]', reader);
    if (!c || !a) return;
    var typed = $('textarea', reader)?.value ?? '', withNote = typed ? ', with your note' : '';
    // Undo brings back a note written beside Merge or Hold (PR-Agent r3 on #72).
    var kept = typed ? { i: -1, note: typed } : null;
    if (a.k === 'fine') return settle(state.sel, 'Marked fine. ' + c.to + ' keep' + (c.to.indexOf(' and ') > 0 ? '' : 's') + ' cooking.');
    if (a.k === 'go') return settle(state.sel, 'Merge sent to ' + c.to + '’s agent' + withNote + '. It merges in their T3 Code.', kept);
    if (a.k === 'hold') return settle(state.sel, 'On hold until 8:00 tomorrow' + withNote + '.', kept);
    // Reply, Request changes and Add open their field above the bar and take the blue; pressed again, or ⌘↵, they send.
    if (state.armed === a.k) return send(a.k);
    state.armed = a.k; redrawBar();
    // Arming another action puts the project pick away, with its own Add: ⌘↵ then sends what is armed (PR-Agent r2 on
    // #72). A note already written stays.
    if (a.k !== 'course') { var pk = $('.row', extra); if (pk) pk.remove(); }
    if (a.k === 'course') {
      // From More there is no Add on the bar, so the pick gets its own blue Add. It goes above a note already written,
      // which stays.
      var was = $('.row', extra); if (was) was.remove();
      extra.insertAdjacentHTML('afterbegin', '<div class="row"><select aria-label="Project"><option value="Mobile v1">Mobile v1</option><option value="Team relay">Team relay</option><option value="Desktop polish">Desktop polish</option></select>'
        + (a.more ? '<button class="btn primary" type="button" data-send="course">Add</button><span class="hint">or ⌘↵</span>' : '<span class="hint">Pick a project, then Add again or ⌘↵.</span>') + '</div>');
      focusIn($('select', extra)); return;
    }
    note(c, a);
  }
  function send(kind: ActionKind): void {
    var c = CARDS[state.sel ?? ''];
    if (!c) return;
    var i = c.acts.map(function (a) { return a.k; }).indexOf(kind);
    // No pick on screen means Add is not really armed: it arms again, and the pick comes back.
    if (kind === 'course' && !$('[data-extra] select', reader)) { state.armed = null; return act(i); }
    if (kind === 'course') { var to = must<HTMLSelectElement>('[data-extra] select', reader).value; return settle(state.sel, 'Added to ' + to + '. It leaves ' + (state.sel === 'unplanned' ? 'Unplanned' : 'the pass') + '.', { i: i, value: to, note: $<HTMLTextAreaElement>('[data-extra] textarea', reader)?.value ?? '' }); }
    var note = $('textarea', reader)?.value ?? '';
    if (!note.trim()) { toast(kind === 'refire' ? 'Request changes needs a note: what should the agent fix?' : 'Write the reply first.'); return; }
    settle(state.sel, (kind === 'refire' ? 'Request changes sent to ' : 'Sent to ') + c.to + '.', { i: i, value: note });
  }
  function undo() {
    if (!pending || Date.now() > pending.until) { pending = null; return; }
    var p = pending; pending = null;
    delete state.done[p.id];
    clearTimeout(toastTimer); toastEl.classList.remove('on');
    pick(p.id);
    // An undone reply, change request or project pick comes back as the visitor left it, ready to fix and send again.
    if (p.draft && p.draft.i >= 0) {
      act(p.draft.i);
      var field = $<HTMLTextAreaElement | HTMLSelectElement>('[data-extra] textarea, [data-extra] select', reader);
      if (field) field.value = p.draft.value ?? '';
    }
    // A note written beside Merge, Hold or Add comes back too.
    if (p.draft && p.draft.note) {
      var ta = $<HTMLTextAreaElement>('[data-extra] textarea', reader);
      if (!ta) { note(CARDS[p.id]); ta = $<HTMLTextAreaElement>('[data-extra] textarea', reader); }
      if (ta && !ta.value) ta.value = p.draft.note;
    }
  }

  document.addEventListener('click', function (ev) {
    var t = ev.target instanceof Element ? ev.target.closest('button') : null; if (!t) return;
    if (t.dataset.open) return pick(t.dataset.open);
    if (t.dataset.send) return send(actionKind(t.dataset.send));
    if (t.hasAttribute('data-act')) { shut(); return act(Number(t.dataset.act)); }
    if (t.hasAttribute('data-note')) { shut(); return note(CARDS[state.sel ?? '']); }
    if (t.hasAttribute('data-t3')) { shut(); toast('In the app, this opens ' + (CARDS[state.sel ?? '']?.to ?? 'the agent') + '’s thread in T3 Code. These threads are made up.'); return; }
    if (t.hasAttribute('data-undo')) return undo();
    if (t.hasAttribute('data-back')) { app.classList.remove('open-r'); state.sel = null; renderList(); return; }
    if (t.hasAttribute('data-reset')) { state.done = {}; state.sel = matchMedia('(max-width:760px)').matches ? null : open()[0]; render(); return; }
    if (t.dataset.go) { state.staff = null; state.course = ''; return setView(t.dataset.go); }
    if (t.dataset.staff) { state.staff = state.staff === t.dataset.staff && state.view === 'kitchen' ? null : t.dataset.staff; state.course = ''; return setView('kitchen'); }
    if (t.dataset.course !== undefined && (t.classList.contains('ri') || t.classList.contains('fchip'))) { state.course = t.dataset.course; state.staff = null; return setView('kitchen'); }
    if (t.dataset.card) {
      var id = t.dataset.card;
      if (id === 'tray' && !state.brigade) { toast('Open: Kai’s own look is enough. In Brigade it waits for you to merge it.'); return; }
      if (state.done[id]) { toast('You handled that one. It left the pass.'); return; }
      setView('pass'); return pick(id);
    }
    if (t.hasAttribute('data-mode')) {
      state.brigade = !state.brigade;
      $$('[data-mode]').forEach(function (m) { must<SVGUseElement>('use', m).setAttribute('href', state.brigade ? '#toque' : '#skillet'); });
      $$('[data-mode-name]').forEach(function (n) { n.textContent = state.brigade ? 'Brigade' : 'Open'; });
      if (state.brigade) { delete state.done.tray; }
      var was = state.sel;
      if (!state.brigade && state.sel === 'tray') state.sel = open()[0] || null;
      // The open ticket stays open as it was, with any note and action form: only the list and counts change.
      if (state.sel && state.sel === was) renderList(); else render();
      filterGrid();
      toast(state.brigade ? 'Brigade: every ticket ready to merge waits for you or Maya to merge it.' : 'Open: each dev ships under the repo’s own rules. Only exceptions reach you.');
    }
  });
  // More opens above its button, left-aligned with it; on a phone, CSS makes it a sheet from the bottom.
  var wideQ = matchMedia('(min-width:761px)');
  document.addEventListener('beforetoggle', function (ev) {
    var m = ev.target; if (!(m instanceof HTMLElement) || !m.classList.contains('menu') || ('newState' in ev ? ev.newState : undefined) !== 'open') return;
    var b = $('[data-more][popovertarget="' + m.id + '"]');
    if (!b || !wideQ.matches) { m.style.left = ''; m.style.bottom = ''; return; }
    var r = b.getBoundingClientRect();
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - 244)) + 'px';
    m.style.bottom = Math.max(8, innerHeight - r.top + 8) + 'px';
  }, true);
  document.addEventListener('toggle', function (ev) {
    var m = ev.target; if (!(m instanceof HTMLElement) || !m.classList.contains('menu')) return;
    var b = $('[data-more][popovertarget="' + m.id + '"]'); if (b) b.classList.toggle('on', ('newState' in ev ? ev.newState : undefined) === 'open');
  }, true);
  function openMenu() { try { return $('.menu:popover-open'); } catch (x) { return null; } }
  function menuStep(m: HTMLElement | null, d: number) {
    if (!m) return;
    var rows = $$('.mi', m).filter(function (x) { return x.getClientRects().length; }); if (!rows.length) return;
    var i = rows.findIndex((row) => row === document.activeElement);
    rows[i < 0 ? (d > 0 ? 0 : rows.length - 1) : (i + d + rows.length) % rows.length].focus();
  }
  document.addEventListener('keydown', function (ev) {
    var om = openMenu();
    if (om) {
      if (ev.key === 'Escape' || ev.key === '.') { ev.preventDefault(); shut(); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); menuStep(om, ev.key === 'ArrowDown' ? 1 : -1); return; }
      if (/^(Shift|Meta|Control|Alt|Tab|Enter| )$/.test(ev.key) && !(ev.metaKey || ev.ctrlKey)) return;
      shut();
    }
    var typing = /^(TEXTAREA|SELECT|INPUT)$/.test(ev.target instanceof Element ? ev.target.tagName : '');
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') {
      if (state.view !== 'pass' || ev.repeat) return;
      // What is armed sends; with nothing armed, the blue action.
      if (state.armed) { ev.preventDefault(); send(state.armed); return; }
      var b = $('[data-act].primary', reader); if (b) { ev.preventDefault(); b.click(); } return;
    }
    if (typing || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // The bar's keys, as in the app: each action's letter, . for More, N for a note, O for T3.
    var c = state.view === 'pass' && !state.done[state.sel ?? ''] && CARDS[state.sel ?? ''];
    if (c && reader.querySelector('[data-bar]') && !ev.repeat) {
      var key = ev.key.length === 1 ? ev.key.toUpperCase() : '';
      var ai = key ? c.acts.map(function (a) { return a.more ? '' : ACT[a.k].key; }).indexOf(key) : -1;
      if (ai >= 0) { ev.preventDefault(); return act(ai); }
      if (ev.key === '.') { ev.preventDefault(); var mn = $('.menu', reader); try { mn?.showPopover(); } catch (x) {} return menuStep(mn, 1); }
      if (key === 'N') { ev.preventDefault(); return note(c); }
      if (key === 'O') { toast('In the app, this opens ' + c.to + '’s thread in T3 Code. These threads are made up.'); return; }
    }
    var ids = open(), i = ids.indexOf(state.sel ?? '');
    if (ev.key === 'j' || ev.key === 'k') { if (ids.length) pick(ids[Math.max(0, Math.min(ids.length - 1, (i < 0 ? 0 : i + (ev.key === 'j' ? 1 : -1))))]); }
    else if (ev.key === 'v') setView(state.view === 'pass' ? 'kitchen' : 'pass');
    // preventDefault: Undo can focus a restored note, and the z must not land in it.
    else if (ev.key === 'z') { ev.preventDefault(); undo(); }
    else if (ev.key === 'Escape') { app.classList.remove('open-r'); if (matchMedia('(max-width:760px)').matches) { state.sel = null; renderList(); } }
  });

  state.sel = matchMedia('(max-width:760px)').matches ? null : open()[0];
  render(); filterGrid();
})();
