/// <reference path="./bridge.ts" />
// The board page's script (client/server.ts serves it). It runs in the browser, not in Node: page() in server.ts puts
// passScript's source in a <script> after keysCore, barCore and installBar, so this module's scope is the page's scope.
// Those three are imported here only so the page is typed against them; the page itself never imports anything.
import { barCore, installBar } from './bar.ts';
import type { BarApi } from './bar.ts';
import { keysCore } from './keys.ts';
import type { Rules, RuleSet } from './kitchen.ts';
import type { Command, FixedKey, KeyState } from './keys.ts';

// The page script's own types. Node strips them with the rest, so they cost the served page nothing.
/** Which view and list the page shows, and what the Pass keeps for its return. */
interface PageState { view: string; folder: string; sel: string | null | undefined; listKey?: string | null; passSel?: string | null; passFolder?: string; passScroll?: number }
/** The named fields the script reads on a ticket's form of actions or the new-thread form. */
interface PageFields extends HTMLFormControlsCollection {
  nonce?: HTMLInputElement; note?: HTMLTextAreaElement; pr?: HTMLInputElement; request?: HTMLInputElement;
  project?: HTMLSelectElement; prompt?: HTMLTextAreaElement; title?: HTMLInputElement;
}
/** The new-thread form's fields: it always has these four (page() in client/server.ts). */
interface LaunchFields extends PageFields { nonce: HTMLInputElement; project: HTMLSelectElement; prompt: HTMLTextAreaElement; title: HTMLInputElement }
/** The new-thread form's fields, as a draft keeps them. */
interface LaunchSnap { prompt: string; title: string; project: string; workspace: string; nonce?: string; sig?: string; at?: number }
/** A ticket form's draft, as snap() takes it and saveDraft keeps it: its note, picks and armed action, and its one-time
 *  id and kind once a send went on the way out. */
interface Draft {
  note: string; picks: Record<string, string>; custom: Record<string, string>; intent?: string;
  latest?: string; at?: number; nonce?: string; kind?: string; sig?: string; sentBefore?: boolean; wroteBefore?: boolean;
}
/** A draft as saved: it always has its time and the hand-back it was written against. */
type SavedDraft = Draft & { at: number; latest: string };
/** A form on the board, with what the script keeps on it: the launch it queued, and whether a draft is being put back. */
interface PageForm extends HTMLFormElement { readonly elements: PageFields; _sent?: LaunchSnap; _restoring?: boolean }
/** The new-thread form. */
interface LaunchForm extends PageForm { readonly elements: LaunchFields }
/** A ticket element, with the question set last picked in it. */
interface Plate extends HTMLElement { _lastSet?: HTMLFieldSetElement }
/** A send T3 may or may not have taken: the ticket offers Retry, the same bytes. */
interface Unconfirmed { body: string; what: string; text: string; form: PageForm; refused?: string; flying?: boolean }
/** A toast's button: its label, what it does, and the command whose key it shows. */
type ToastAct = [label: string, run: () => void, command?: string];
/** A control a send locks while it waits. */
type Control = HTMLInputElement | HTMLTextAreaElement | HTMLButtonElement | HTMLSelectElement;
/** The kitchen rules as the page has them, with the revision that orders saves (client/server.ts rulesNow). */
type KitchenRules = Rules & { rev: number };
/** A keydown as onKey reads it: the real one, or one keysCore's synth made for a changed key. */
interface PageKey { key: string; code: string; metaKey: boolean; ctrlKey: boolean; altKey: boolean; shiftKey: boolean; repeat: boolean; target: EventTarget | null; synthetic?: boolean; preventDefault(): void }
/** A key Settings → Shortcuts asks about before it takes it: the command, the key, and what taking it would do. */
interface KxClash { id: string; key: string; other: string; text: string; canTake: boolean; gives: string[] }
/** A send waiting out its Undo. */
interface PendingSend { label: string; title: string; until: number; done: boolean; timer: ReturnType<typeof setTimeout>; fire(leaving: boolean): void; undo(): void }

/** The board page's script. It runs in the browser: page() in client/server.ts serves its source inside a function
 *  that holds the inlined keysCore, barCore and installBar (client/keys.ts, client/bar.ts), and passes MINI, the
 *  Settings pictures for the bar's Appearance and Density steps. Node strips its types, so it holds only types Node can
 *  strip, and it names nothing but browser globals, its own declarations and those three. */
export function passScript(MINI: Readonly<Record<string, string>>): void {
  var root = document.documentElement, app = document.getElementById('app') as HTMLElement;
  var sheet = document.getElementById('sheet') as HTMLDialogElement, viewer = document.getElementById('viewer') as HTMLDialogElement, toastEl = document.getElementById('toast') as HTMLElement, setDlg = document.getElementById('settings') as HTMLDialogElement, launchDlg = document.getElementById('launch') as HTMLDialogElement, barDlg = document.getElementById('bar') as HTMLDialogElement;
  var reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
  // No phone build (Dan, 2026-11-11): at phone width CSS shows only the screen that points to the Mac app. A dialog
  // left open would keep the page inert under it, so narrowing to that width closes every open dialog.
  var phoneQ = window.matchMedia('(max-width: 760px)');
  phoneQ.addEventListener('change', function(){ if (phoneQ.matches) $$<HTMLDialogElement>('dialog[open]').forEach(function(d){ d.close(); }); });
  function store(k: string, v?: string): string | null | undefined { try { if (v === undefined) return window.localStorage.getItem(k); window.localStorage.setItem(k, v); } catch (x) { return null; } }
  // The pass is the normal view; the full kitchen is one click on the logo away. The choice is remembered.
  var state: PageState = { view: store('yc.view') === 'kitchen' ? 'kitchen' : 'pass', folder: 'pass', sel: null };
  var acted: Record<string, number> = {};   // plate id -> time: tickets you just sent from the pass, hidden until the board catches up
  var unconfirmed: Record<string, Unconfirmed> = {}; // plate id -> { body, what, text, form }: sends T3 may or may not have taken; the ticket offers Retry
  var actedLatest: Record<string, string> = {}; // plate id -> the hand-back it had when sent: a newer hand-back brings it back at once (Opus)
  var mounted: Plate | null = null; // the ticket element now open in the reader or the sheet
  var bar: BarApi | null = null; // the Cmd+K action bar, once installed at the end
  // Shortcuts (client/keys.ts, ⌘K bar PR 4): the keys in use, as Settings → Shortcuts set them. The browser keeps the
  // list under yc.keys; the Mac app keeps it in keybindings.json in its data folder and reads it at start and on focus.
  var K = keysCore(/Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || ''));
  var KFILE = window.yeschef && window.yeschef.keys && typeof window.yeschef.keys.read === 'function' ? window.yeschef.keys : null;
  var KST = K.build(readKeys()), kxSeen: string | null = null, kxFileNote = '';
  function readKeys(): unknown[] { var t = store('yc.keys'); if (!t) return []; try { return JSON.parse(t); } catch (x) { return []; } }
  // A command's first key as one label ("⌘↵"), or '' with none. SK is the suggested action's: the board's send key.
  function keyLabel(id: string): string { var k = K.keysOf(KST, id)[0]; return k ? K.label(k) : ''; }
  function SK(){ return keyLabel('ticket.suggested'); }
  function $<E extends Element = HTMLElement>(sel: string, el?: ParentNode | null): E | null { return (el || document).querySelector<E>(sel); }
  function $$<E extends Element = HTMLElement>(sel: string, el?: ParentNode | null): E[] { return Array.prototype.slice.call((el || document).querySelectorAll<E>(sel)); }
  function focusView(){ return state.view === 'pass'; }

  // ----- Views -----
  function setView(v: string): void {
    // Read the reading position before the layout changes: hiding the reader drops its scroll.
    if (v === 'kitchen' && state.view === 'pass') { var rs0 = mounted && $('.plate-scroll', mounted); state.passScroll = rs0 ? rs0.scrollTop : 0; }
    state.view = v; store('yc.view', v);
    root.classList.toggle('v-pass', v === 'pass'); root.classList.toggle('v-kitchen', v === 'kitchen'); fades();
    var fl = $('.flip'); if (fl) fl.style.transform = '';
    var b = $('[data-view-toggle]'); if (b) b.setAttribute('aria-label', v === 'pass' ? 'Show the full kitchen' : 'Focus on the pass');
    // Neither view opens a ticket by itself: the reader stays blank until you pick one (Dan, 2026-11-08).
    // Leaving the pass remembers its open ticket; coming back reopens it if it is still in the list (Astra).
    if (v === 'kitchen') {
      // (Where you were reading was saved above, before the layout changed; Sol.)
      if (state.sel) state.passSel = state.sel; state.passFolder = state.folder; state.sel = null; state.listKey = null; setFolder('pass');
    }
    else {
      setFolder(state.passFolder || state.folder);
      var back = state.passSel && tiles().filter(function(t){ return t.dataset.plate === state.passSel; })[0];
      if (back) state.sel = state.passSel;
    }
    place();
    // Set after the view has laid out (the switch runs inside a view transition), on the next frames.
    if (v === 'pass' && back && state.passScroll) {
      var want = state.passScroll, again = function(){ var ps = mounted && $('.plate-scroll', mounted); if (ps && ps.scrollTop !== want) ps.scrollTop = want; };
      requestAnimationFrame(function(){ again(); requestAnimationFrame(again); }); setTimeout(again, 120);
    }
  }
  var flipping = false;
  // Dan, 2026-11-07: the logo turns while the views morph, both at once, on one smooth curve.
  // The logo has its own live layer in the view transition (view-transition-name: logo), so its turn shows
  // through the transition instead of a frozen snapshot. Three half turns: each shows the other colour, and the
  // last lands on the new view's face, which is the angle setView's class gives it, so nothing snaps at the end.
  var MOTION_MS = 700, MOTION_EASE = 'cubic-bezier(.65,0,.35,1)';
  function toggleView(){
    if (flipping) return;
    var next = state.view === 'pass' ? 'kitchen' : 'pass';
    var f = $('.flip');
    if (reduce.matches) { setView(next); return; }
    flipping = true;
    var from = state.view === 'pass' ? 0 : 180;
    if (f && f.animate) f.animate([{ transform: 'rotateY(' + from + 'deg)' }, { transform: 'rotateY(' + (from + 540) + 'deg)' }], { duration: MOTION_MS, easing: MOTION_EASE });
    if (document.startViewTransition) {
      var vt = document.startViewTransition(function(){ setView(next); });
      vt.finished.then(function(){ flipping = false; }, function(){ flipping = false; });
    } else { setView(next); }
    setTimeout(function(){ flipping = false; }, MOTION_MS + 300);
  }

  // ----- You or Your team (Dan, 2026-11-10) -----
  // Only a user with reports can switch: the page carries #yc-team only then. Until the team connection lands no one
  // has it, so the scope stays You. viewsNow and setScope are what the Cmd+K bar's View actions read and call.
  function teamNow(){ var j = $('#yc-team'); if (!j) return null; try { return JSON.parse(j.textContent); } catch (x) { return null; } }
  var scope = store('yc.scope') === 'team' ? 'team' : 'you';
  function applyScope(){
    if (!teamNow()) scope = 'you'; root.classList.toggle('s-team', scope === 'team');
    $$('.vmenu .seg [data-scope]').forEach(function(b){ b.setAttribute('aria-checked', String(b.dataset.scope === scope)); });
  }
  function viewsNow(){ var t = teamNow(); return { hasReports: !!t, current: scope, team: t }; }
  function setScope(next: string): void {
    if ((next !== 'you' && next !== 'team') || (next === 'team' && !teamNow())) return;
    var was = scope; scope = next; store('yc.scope', next); applyScope();
    // Your team shows none of your own tickets, so the one open in the reader closes, and the one the Pass kept for
    // its return is forgotten too, even when none is open now (PR-Agent r6 on #74). The reader is cleared even when
    // nothing is selected: a project pick in the same open menu drops the selection before the reader redraws.
    // Coming back to You does the same for a team call (step 4): neither view opens the other's.
    if (next !== was) { state.passSel = null; state.sel = null; place(); }
  }

  // Your team, expanded: a card in The Pass column, a bar in Who's on what or a file row goes back to The Pass with
  // that call open. The card's suggestion also puts focus on its action there: nothing sends from Your team yet.
  function openTeamCall(id: string | undefined, act?: string | null): void {
    if (scope !== 'team' || !id || !plateNode(id)) return;
    state.passFolder = 'pass'; state.passSel = id;
    if (focusView()) select(id); else toggleView();
    if (act) setTimeout(function(){ var p = plateNode(id), b = p && $('form.act button[name=kind][value="' + act + '"]', p); if (b) b.focus(); }, reduce.matches ? 0 : MOTION_MS + 60);
  }

  // ----- Folders (the stage list) and selection -----
  // In Your team the list is the team's calls (folder "team"), never one of your own folders.
  function folderEl(){ if (scope === 'team') return $('.head-b .folder[data-folder="team"]'); return $('.head-b .folder[data-folder="' + state.folder + '"]') || $('.head-b .folder[data-folder="pass"]'); }
  function setFolder(name: string): void {
    if (name === 'team' || !$('.head-b .folder[data-folder="' + name + '"]')) name = 'pass';
    state.folder = name;
    $$('.head-b .folder:not([data-folder="team"])').forEach(function(d){ d.hidden = d.dataset.folder !== name; });
    // The stage list marks the open list in the pass view only: You, expanded shows every stage at once.
    $$('.stagenav .nf').forEach(function(b){ if (b.dataset.folder === name && focusView()) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    var label = name === 'pass' ? 'The Pass' : name, h = $('.head-name'); if (h && focusView()) h.textContent = label; else if (h) h.textContent = 'The Pass';
    $$('.head .badge, .head-h > .muted').forEach(function(x){ x.hidden = focusView() && name !== 'pass'; });
    fades();
  }
  function tiles(){ var f = folderEl(); return f ? $$('[data-plate]', f).filter(function(t){ return !t.classList.contains('gone'); }) : []; }
  function plateNode(id: string | null | undefined): Plate | null { return id ? document.getElementById(id) : null; }
  function mark(){ $$('[data-plate].sel').forEach(function(t){ t.classList.remove('sel'); }); if (state.sel) $$('[data-plate="' + state.sel + '"]').forEach(function(t){ if (t.tagName !== 'FORM') t.classList.add('sel'); }); }
  function unmount(){
    if (mounted && mounted.parentNode !== $('#plates')) { var store_ = $('#plates'); if (store_) store_.appendChild(mounted); }
    mounted = null;
  }
  function emptyReader(){ var r = $('.reader'); if (!r) return; $$('.plate', r).forEach(function(p){ $('#plates')!.appendChild(p); }); var e = $('.reader-empty', r); if (e) e.hidden = false; }
  // Put the selected ticket where the view shows it: beside the list (pass view, wide) or in the sheet.
  function place(){
    var p = plateNode(state.sel);
    if (focusView()) {
      if (sheet.open) sheet.close();
      var r = $('.reader'); if (!r) return;
      if (!p) { unmount(); emptyReader(); mark(); return; }
      if (p.parentNode !== r) { var same = mounted === p; if (!same) unmount(); $$('.plate', r).forEach(function(x){ if (x !== p) $('#plates')!.appendChild(x); }); r.appendChild(p); mounted = p; $$('textarea', p).forEach(grow); if (!same) { var s = $('.plate-scroll', p); if (s) s.scrollTop = 0; } }
      var e = $('.reader-empty', r); if (e) e.hidden = true;
    } else {
      emptyReader();
      if (!p) { if (sheet.open) sheet.close(); unmount(); mark(); return; }
      if (p.parentNode !== sheet) { var same2 = mounted === p; if (!same2) unmount(); sheet.appendChild(p); mounted = p; $$('textarea', p).forEach(grow); if (!same2) { var s2 = $('.plate-scroll', p); if (s2) s2.scrollTop = 0; } }
      if (!sheet.open) { sheet.showModal(); liftToast(); requestAnimationFrame(fades); }
    }
    mark(); fades(); yieldKey(); watchHead();
    // Every question form in the ticket gets its label, not only the first (Fable r5).
    if (mounted) $$('form.act', mounted).forEach(primaryLabel);
  }
  function select(id: string | null | undefined): void { state.sel = id; place(); }
  // The ticket's head pins only while it leaves the message at least half the reader: a long title, PR chips and
  // screenshots in a short window scroll away with the message instead of covering it (PR-Agent r1 on #45).
  // It is measured again whenever the reader or the head changes size (the window, the dock, a note growing).
  var headRO = window.ResizeObserver ? new ResizeObserver(function(){ fitHead(); }) : null, headWatched: Element | null = null;
  function fitHead(){
    if (!mounted) return;
    var sc = $('.plate-scroll', mounted), h = $('.plate-head', mounted); if (!sc || !h) return;
    h.classList.remove('unpin');
    if (getComputedStyle(h).position === 'sticky' && h.offsetHeight > sc.clientHeight / 2) h.classList.add('unpin');
  }
  function watchHead(){
    var sc = mounted && $('.plate-scroll', mounted), h = mounted && $('.plate-head', mounted);
    if (headRO && sc !== headWatched) { headRO.disconnect(); headWatched = sc || null; if (sc) { headRO.observe(sc); if (h) headRO.observe(h); } }
    fitHead();
  }
  // The list the open ticket came from, by name, so a refresh keeps it.
  function listKeyOf(t: Element): string | null {
    var folder = t.closest<HTMLElement>('.folder');
    return folder ? 'folder:' + folder.dataset.folder : null;
  }
  // You, expanded has no lists of its own since the chart (client/flow.ts), so J/K move in The Pass there too.
  function step(dir: number): void {
    var list = tiles(); if (!list.length) return;
    var i = list.findIndex(function(t){ return t.dataset.plate === state.sel; });
    var t = list[i < 0 ? 0 : Math.max(0, Math.min(list.length - 1, i + dir))]!;
    // Focus moves with the selection, so Enter or Space on a card never reopens the one you left (hill climb 2 r2, Opus).
    var onTile = document.activeElement && document.activeElement.closest && document.activeElement.closest('[data-plate].tile');
    select(t.dataset.plate); t.scrollIntoView({ block: 'nearest' });
    if (onTile && t !== onTile && document.contains(t)) t.focus({ preventScroll: true });
  }
  // After a send from the pass, the next ticket at the pass opens. With none left, the pass shows all clear.
  function advance(fromId: string | undefined): void {
    // In Your team the next one is the team's next call, never one of your own tickets.
    var box = $('.head-b .folder[data-folder="' + (scope === 'team' ? 'team' : focusView() ? state.folder : 'pass') + '"]');
    var list = (box ? $$('[data-plate]', box) : []).filter(function(t){ return !t.classList.contains('gone') || t.dataset.plate === fromId; });
    var i = list.findIndex(function(t){ return t.dataset.plate === fromId; });
    var rest = list.filter(function(t){ return t.dataset.plate !== fromId && !t.classList.contains('gone'); });
    var nextT = i < 0 ? rest[0] : (list.slice(i + 1).filter(function(t){ return !t.classList.contains('gone'); })[0] || rest[rest.length - 1]);
    if (nextT) select(nextT.dataset.plate);
    else { state.sel = null; if (sheet.open) sheet.close(); place(); }
  }
  // A ticket you just sent leaves every list at once, and the pass count drops with it (council 1b).
  function hideActed(){
    var now = Date.now();
    Object.keys(acted).forEach(function(id){ if (now - acted[id]! > 90000) delete acted[id]; });
    $$('.head-b .tile[data-plate]').forEach(function(t){ t.classList.toggle('gone', !!acted[t.dataset.plate!]); });
    var n = $$('.head-b .folder[data-folder="pass"] .tile[data-plate]').filter(function(t){ return !t.classList.contains('gone'); }).length;
    var badge = $('.head .badge'), nc = $('.nf[data-folder="pass"] .n');
    // [0-9], not a backslash class: this script sits in a template string, which would eat the backslash.
    if (badge && /^[0-9]+$/.test(badge.textContent)) badge.textContent = String(n);
    if (nc && /^[0-9]+$/.test(nc.textContent)) nc.textContent = String(n);
  }

  // ----- Fades and scroll bars -----
  // A list fades at its foot only while real content waits below: the message's own bottom padding (about
  // 34 px) does not count, so its last line never dims over empty space (hill climb r5, Fable and Sol).
  function moreBelow(el: Element): boolean { return el.scrollHeight - el.scrollTop - el.clientHeight > (el.classList.contains('plate-scroll') ? 40 : 4); }
  function fades(){
    $$('.head-b, .stagenav, .plate-scroll, .set-panes').forEach(function(el){ el.classList.toggle('fade-end', moreBelow(el)); });
    $$('.atts, .stagenav').forEach(railEdge);
  }
  // A ticket's attachments and the stage list fade at the right edge while more wait off screen (hill climb 2 r1).
  function railEdge(el: Element): void { el.classList.toggle('fade-right', el.scrollWidth - el.scrollLeft - el.clientWidth > 4); }
  // ----- You, expanded: the chart (client/flow.ts) -----
  // The server draws the projects the header picker shows: one project as its threads, more as every project. A click
  // on a project picks it there (Dan, 2026-11-12: a second "All projects" over the chart); the picker goes back.
  // clear: a fresh page, so nothing stays lit. A refresh keeps what the pointer lit, on the fresh chart.
  function applyFlow(clear: boolean): void {
    var keep = clear || !fxKeys ? [] : fxKeys.filter(function(k){ return k.indexOf('fl:') !== 0; });
    fxNow = null; flowFocus(keep.length ? keep : null);
    watchFlow();
  }
  // The chart fills its column down to the foot of The Pass beside it (Dan, 2026-11-12: half the page sat empty). The
  // river stretches to the height that is free, never below its own; strokes keep their width (CSS), and each name
  // moves with its node at its own size. Measured again whenever the column changes size.
  var flowRO = window.ResizeObserver ? new ResizeObserver(function(){ fitFlow(); }) : null, flowWatched: Element | null = null;
  function watchFlow(): void {
    var sc = $('.you .you-b');
    if (flowRO && sc !== flowWatched) { flowRO.disconnect(); flowWatched = sc || null; if (sc) flowRO.observe(sc); }
    fitFlow();
  }
  function fitFlow(): void {
    var sc = $('.you .you-b'), svg = $('.you .fx-view:not([hidden]) svg.fx') as SVGSVGElement | null;
    var body = svg && svg.querySelector<SVGGElement>('.fx-body');
    if (!sc || !svg || !body || !svg.viewBox || !svg.viewBox.baseVal) return;
    var top = +(body.dataset.top || 0), span = +(body.dataset.span || 0), vw = svg.viewBox.baseVal.width, w = svg.getBoundingClientRect().width;
    if (!span || !vw || !w) return;
    var foot = 18, own = top + span + foot, wrap = svg.closest('.fx-wrap'), cs = getComputedStyle(sc);
    // What else shares the column: its own padding (the key sits in the header).
    var rest = (wrap ? wrap.getBoundingClientRect().height : 0) - svg.getBoundingClientRect().height + (parseFloat(cs.paddingTop) || 0) + (parseFloat(cs.paddingBottom) || 0);
    var free = Math.floor(sc.clientHeight - rest) - 1;
    var vh = Math.max(own, free * vw / w), k = (vh - top - foot) / span;
    svg.setAttribute('viewBox', '0 0 ' + vw + ' ' + vh.toFixed(1));
    if (k > 1.001) body.setAttribute('transform', 'translate(0 ' + top + ') scale(1 ' + k.toFixed(4) + ') translate(0 ' + (-top) + ')');
    else body.removeAttribute('transform');
    svg.querySelectorAll<SVGTextElement>('.fx-names [data-y]').forEach(function(t){
      t.setAttribute('y', (top + (+(t.dataset.y || 0) - top) * Math.max(1, k) + (+(t.dataset.dy || 0))).toFixed(1));
    });
  }
  // Hover links the chart and The Pass both ways (Dan, 2026-11-11). A chart part lights what it names (data-f) in the
  // chart: every element that belongs to one of those keys (data-k). Its Pass cards light too: the cards of the threads
  // in what lit. A Pass card lights its thread's band. Only bands step back; nodes, names and cards never fade.
  var fxNow: string | null = null, fxKeys: string[] | null = null;
  function flowFocus(keys: string[] | null): void {
    var board = $('.board'); if (!board) return;
    fxKeys = keys;
    var key = keys ? keys.join(' ') : ''; if (key === fxNow) return; fxNow = key;
    board.classList.toggle('fx-focus', !!keys);
    var lit: Record<string, boolean> = {};
    $$('.you .fx-view:not([hidden]) [data-k]').forEach(function(n){
      var mine = (n.dataset.k || '').split(' '), on = !!keys && keys.some(function(k){ return mine.indexOf(k) >= 0; });
      n.classList.toggle('lit', on);
      if (on) mine.forEach(function(k){ if (k.indexOf('t:') === 0) lit[k.slice(2)] = true; });
    });
    if (keys) keys.forEach(function(k){ if (k.indexOf('t:') === 0) lit[k.slice(2)] = true; });
    $$('.head-b .folder[data-folder="pass"] .call-tile[data-plate]').forEach(function(t){ t.classList.toggle('lit', !!keys && !!lit[t.dataset.plate!]); });
  }
  function flowTip(n: Element | null, ev: MouseEvent): void {
    var box = $('.you .fx-tip'), wrap = $('.you .fx-wrap'); if (!box || !wrap) return;
    var html = n && n.getAttribute('data-tip');
    box.hidden = !html; if (!html) return;
    box.innerHTML = html;
    // Beside the pointer, inside the part of the chart you can see: it flips left or up at the scroller's edge (PR-Agent
    // r1 on #49: a narrow window clipped it).
    var r = wrap.getBoundingClientRect(), sc = (wrap.closest('.you-b') || wrap).getBoundingClientRect();
    var x = ev.clientX + 14, y = ev.clientY + 14, w = box.offsetWidth, h = box.offsetHeight;
    if (x + w > sc.right) x = Math.max(sc.left, ev.clientX - 14 - w);
    if (y + h > sc.bottom) y = Math.max(sc.top, ev.clientY - 14 - h);
    box.style.left = (x - r.left) + 'px';
    box.style.top = (y - r.top) + 'px';
  }
  document.addEventListener('mouseover', function(ev){
    if (!root.classList.contains('v-kitchen')) return;
    var t = ev.target as Element, part = t.closest && t.closest<Element>('.you .fx-view [data-f]');
    var card = !part && t.closest && t.closest<HTMLElement>('.head-b .folder[data-folder="pass"] .call-tile[data-plate]');
    flowFocus(part ? (part.getAttribute('data-f') || '').split(' ') : card ? ['t:' + card.dataset.plate] : null);
    flowTip(part || null, ev);
  });
  // A keyboard reaches each project's name and, opened, each thread's band: focus lights them as hover does, and Enter
  // or Space acts as a click (PR-Agent r1 on #49). Capture, so the board's own Enter never also runs.
  document.addEventListener('focusin', function(ev){
    var part = (ev.target as Element).closest && (ev.target as Element).closest<Element>('.you .fx-view [data-f][tabindex]');
    if (part) flowFocus((part.getAttribute('data-f') || '').split(' '));
  });
  document.addEventListener('focusout', function(ev){
    var part = (ev.target as Element).closest && (ev.target as Element).closest('.you .fx-view [tabindex]');
    if (part) flowFocus(null);
  });
  document.addEventListener('keydown', function(ev){
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var part = (ev.target as Element).closest && (ev.target as Element).closest('.you .fx-view [tabindex][role=button]');
    if (!part || ev.metaKey || ev.ctrlKey || ev.altKey) return;
    ev.preventDefault(); ev.stopPropagation();
    part.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
  }, true);
  // The tip follows the pointer, and comes back on the next move after a refresh drew a fresh chart under it.
  document.addEventListener('mousemove', function(ev){
    var box = $('.you .fx-tip'), t = ev.target as Element, part = t.closest && t.closest<Element>('.you .fx-view [data-f]');
    if (box && (!box.hidden || part)) flowTip(part, ev);
  });
  var timers = new WeakMap<Element, ReturnType<typeof setTimeout>>();
  document.addEventListener('scroll', function(ev){
    var el = ev.target as HTMLElement | null; if (!el || !el.classList) return; // the document scrolls too: it has no classList
    el.classList.add('scrolling');
    clearTimeout(timers.get(el)); timers.set(el, setTimeout(function(){ el!.classList.remove('scrolling'); }, 900));
    if (el.matches && el.matches('.head-b, .stagenav, .plate-scroll, .set-panes')) el.classList.toggle('fade-end', moreBelow(el));
    if (el.matches && el.matches('.atts, .stagenav')) railEdge(el);
    // The ticket's head shows a rule under it once the message scrolls beneath it (Dan, 2026-11-08).
    if (el.matches && el.matches('.plate-scroll')) { var ph = $('.plate-head', el); if (ph) ph.classList.toggle('stuck', el.scrollTop > 0); }
  }, true);
  window.addEventListener('resize', function(){ fades(); placeNavMenu(); });
  // The stage list's project menu opens under its button, or above it when there is more room there, and scrolls
  // inside itself when it is still too tall. The stage list can scroll, so the menu is fixed, not clipped by it (PR-Agent on #44).
  function placeNavMenu(){
    var d = $('.stagenav details.pmenu[open]'); if (!d) return;
    var l = $('.pmenu-l', d), sm = $('summary', d); if (!l || !sm || getComputedStyle(l).position !== 'fixed') return;
    var r = sm.getBoundingClientRect(), gap = 6, edge = 12;
    l.style.maxHeight = '';
    var h = l.offsetHeight, below = window.innerHeight - r.bottom - gap - edge, above = r.top - gap - edge;
    var up = h > below && above > below, room = Math.max(120, Math.floor(up ? above : below));
    l.style.left = Math.round(r.left) + 'px';
    l.style.top = up ? '' : Math.round(r.bottom + gap) + 'px';
    l.style.bottom = up ? Math.round(window.innerHeight - r.top + gap) + 'px' : '';
    if (h > room) l.style.maxHeight = room + 'px';
  }
  document.addEventListener('toggle', function(ev){ var d = ev.target as HTMLDetailsElement | null; if (d && d.open && d.matches && d.matches('.stagenav details.pmenu')) placeNavMenu(); }, true);
  document.addEventListener('scroll', function(ev){ if (ev.target && (ev.target as Element).classList && (ev.target as Element).classList.contains('nav-scroll')) placeNavMenu(); }, true);

  // ----- Refresh: swap each region; never the ticket you are working on -----
  // pendingFor: the address pendingHtml was read for. A project pick or Back changes the address while the menu is
  // open, so a page read before it is not replayed when the menu closes (PR-Agent r1 on the view menu).
  var last = Date.now(), pendingHtml: string | null = null, pendingFor: string | null = null;
  // Missing data renders "not checked": the lists, counts and "Live" go; only a ticket you are writing in stays.
  function lost(why: string): void {
    var msg = why + ' at ' + new Date().toLocaleTimeString() + '. The board returns with the next update.';
    net(false, msg); app.classList.add('is-stale'); drawn = {};
    // The red strip says why; each Live dot (the stage list's and the top bar's) turns to "Not checked".
    $$('.lamps li', app).forEach(function(l){ l.className = 'bad'; l.textContent = ''; l.appendChild(document.createElement('i')); l.appendChild(document.createTextNode('Not checked')); });
  }
  // The bar's More menu (Dan, 2026-11-10): a popover, so it sits in the top layer and the dock's scroll never clips it.
  function openMenu(el?: ParentNode | null): HTMLElement | null { try { return $('.abar .menu:popover-open', el); } catch (x) { return null; } }
  function shut(el: Element | null | undefined): void { var mn = el && el.closest && el.closest<HTMLElement>('.menu'); if (mn) { try { mn.hidePopover(); } catch (x) {} } }
  function menuStep(mn: ParentNode, d: number): void {
    var rows = $$<HTMLButtonElement>('.mi', mn).filter(function(x){ return !x.disabled && x.getClientRects().length; });
    if (!rows.length) return;
    var i = rows.indexOf(document.activeElement as HTMLButtonElement);
    rows[i < 0 ? (d > 0 ? 0 : rows.length - 1) : (i + d + rows.length) % rows.length]!.focus();
  }
  // It opens above its button, left-aligned with it. Toggle events
  // do not bubble, so these listen on the way down.
  function moreOf(mn: Element): HTMLElement | null { return $('.abar [data-more][popovertarget="' + mn.id + '"]'); }
  document.addEventListener('beforetoggle', function(ev){
    var mn = ev.target as HTMLElement; if (!mn.classList || !mn.classList.contains('menu') || ev.newState !== 'open') return;
    var b = moreOf(mn);
    if (!b) { mn.style.left = ''; mn.style.bottom = ''; return; }
    var r = b.getBoundingClientRect();
    mn.style.left = Math.max(8, Math.min(r.left, innerWidth - 244)) + 'px';
    mn.style.bottom = Math.max(8, innerHeight - r.top + 8) + 'px';
  }, true);
  document.addEventListener('toggle', function(ev){
    var mn = ev.target as HTMLElement; if (!mn.classList || !mn.classList.contains('menu')) return;
    var b = moreOf(mn), on = ev.newState === 'open';
    if (b) b.classList.toggle('on', on);
    if (on && mn.offsetWidth) mn.style.left = Math.max(8, Math.min(parseFloat(mn.style.left) || 8, innerWidth - mn.offsetWidth - 8)) + 'px';
  }, true);
  function dirty(p: Plate | null): boolean {
    if (!p) return false;
    if (p.contains(document.activeElement) && document.activeElement !== p) return true;
    if (p.querySelector('form.act[data-busy], form.act[data-touched]')) return true;
    // An open More menu stays put: a refresh would close it under the pointer.
    if (openMenu(p)) return true;
    return $$<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type=text]', p).some(function(x){ return x.value.trim(); });
  }
  // The app blinked every 5 s (Dan, 2026-11-10): each refresh put in a new copy of every list, and the open ticket's
  // card drew without its blue bar for a moment, then faded it back in. Now a list whose HTML has not changed since the
  // last refresh stays as it is. drawn holds that HTML; lost() and a project pick clear it, since both change a list
  // in place. The Live lamp's tooltip names the time of each read, so it is left out of the compare.
  var drawn: Record<string, string> = {};
  // Each ticket's HTML as the refresh that brought it drew it, before the page marked it up (sync() compares it),
  // without what every draw makes up anew: each form's one-time send id and the More menu's id.
  var plateSrc = new WeakMap<Element, string>();
  function plateKey(html: string): string { return html.replace(/(name="nonce" value=")[^"]*"/g, '$1"').replace(/(id|popovertarget)="m-[^"]*"/g, '$1="m-"'); }
  function plain(html: string): string { return html.replace(/(<li class="ok") title="[^"]*"/g, '$1'); }
  // A list that did change comes in with the open ticket's mark already on it, so no card animates to it, and its
  // cards skip their hover shadow's fade while the pointer finds them again.
  function prime(el: HTMLElement): void {
    if (state.sel) $$('[data-plate="' + CSS.escape(state.sel) + '"]', el).forEach(function(t){ if (t.tagName !== 'FORM') t.classList.add('sel'); });
    $$('.head-b .tile[data-plate]', el).forEach(function(t){ if (acted[t.dataset.plate!]) t.classList.add('gone'); });
    el.classList.add('fresh'); setTimeout(function(){ el.classList.remove('fresh'); }, 300);
  }
  function swap(sel: string, fresh: DocumentFragment, keepScroll?: string): void {
    var old = $(sel, app), nu = fresh.querySelector<HTMLElement>(sel);
    if (!old || !nu) return;
    var html = plain(nu.outerHTML);
    if (drawn[sel] === html) {
      var tips = $$('.lamps li', nu); $$('.lamps li', old).forEach(function(l, i){ if (tips[i]) l.title = tips[i].title; });
      return;
    }
    drawn[sel] = html;
    prime(nu);
    var st = keepScroll ? $$(keepScroll, old).map(function(x){ return x.scrollTop; }) : [];
    old.replaceWith(nu);
    if (keepScroll) $$(keepScroll, nu).forEach(function(x, i){ x.scrollTop = st[i] || 0; });
  }
  // A part only one side has: #yc-team and Your team's panel come and go with the team connection.
  function swapAny(sel: string, fresh: DocumentFragment, before: string, keepScroll?: string): void {
    var old = $(sel, app), nu = fresh.querySelector<HTMLElement>(sel);
    // keepScroll: the selectors whose scroll, down and across, survives the swap (each matched by its own order).
    if (old && nu) {
      // Unchanged since the last draw: kept as it is, so nothing blinks (as swap does, #14).
      var html = plain(nu.outerHTML);
      if (drawn[sel] === html) return;
      drawn[sel] = html;
      prime(nu);
      var keep = keepScroll ? keepScroll.split(',').map(function(s): [string, [number, number][]] { s = s.trim(); return [s, $$(s, old).map(function(x): [number, number] { return [x.scrollTop, x.scrollLeft]; })]; }) : [];
      old.replaceWith(nu);
      keep.forEach(function(k){ $$(k[0], nu).forEach(function(x, i){ var p = k[1][i] || [0, 0]; x.scrollTop = p[0]; x.scrollLeft = p[1]; }); });
    }
    else if (old) { old.remove(); delete drawn[sel]; }
    else if (nu) { var b = $(before, app); if (b) b.before(nu); }
  }
  function sync(html: string): void {
    if ($('details.pmenu[open]')) { pendingHtml = html; pendingFor = location.search; return; }
    pendingHtml = null;
    // Keep keyboard focus on the same card or stage across the refresh (hill climb r5, Sol).
    var ae = document.activeElement as HTMLElement | null, focusSel: string | null = null;
    if (ae && ae.closest && !ae.closest('.plate')) {
      var region = ae.closest('.head-b') ? '.head-b ' : ae.closest('.you') ? '.you ' : ae.closest('.stagenav') ? '.stagenav ' : null;
      var key = ae.dataset && ae.dataset.plate ? '[data-plate="' + ae.dataset.plate + '"]:not(form)' : ae.dataset && ae.dataset.folder ? '.nf[data-folder="' + ae.dataset.folder + '"]' : null;
      if (region && key) focusSel = region + key;
      // Settings sits in the stage list, which a refresh replaces, so its focus is kept too.
      if (!focusSel && ae.matches && ae.matches('[data-settings]')) focusSel = (ae.closest('.stagenav') ? '.stagenav ' : '.bar ') + '[data-settings]';
      // A focused fold (the project menu) keeps focus too (hill climb 2 r5, Sol).
      var fold = ae.tagName === 'SUMMARY' && ae.parentNode && (ae.parentNode as Element).classList && (ae.parentNode as Element).classList[0];
      // The project menu shows in several places (stage list, top bar, the expanded view's header), so focus returns to
      // the same one.
      if (!focusSel && fold) focusSel = (fold === 'pmenu' ? (ae.closest('.stagenav') ? '.stagenav ' : ae.closest('.you') ? '.you ' : ae.closest('.tboard') ? '.tboard ' : ae.closest('.team-wait') ? '.team-wait ' : '.bar ') : '') + 'details.' + fold + ' > summary';
    }
    var t = document.createElement('template'); t.innerHTML = html; var fresh = t.content;
    swap('.stats', fresh); swap('.pmenu', fresh); swap('.bar .lamps', fresh); swap('.stagenav', fresh, '.nav-scroll');
    // You, expanded: its columns come fresh when they change, and each keeps where you scrolled.
    swap('.you', fresh, '.you-b'); swapAny('.team-wait', fresh, '.head'); swapAny('.tboard', fresh, '.head', '.you-b, .tl-s'); swap('.head', fresh, '.head-b');
    swap('#yc-projects', fresh); swapAny('#yc-team', fresh, '#plates'); swap('#yc-rules-now', fresh); if (typeof krLive === 'function') krLive();
    // A card's "Not confirmed" line is the page's own. A list kept from the last refresh still has it, so it goes here,
    // and decorate() and markSent() put back the ones still true, as they did on a new copy.
    $$('.tile > .th.nc', app).forEach(function(m){ m.remove(); });
    $$('.strip:not(.netstrip)', app).forEach(function(s){ s.remove(); });
    var strip = fresh.querySelector('.strip'); if (strip) $('.bar', app)!.after(strip);
    // Tickets: every one is replaced, except the open one while you pick, type or send in it.
    var store_ = $('#plates')!, nuStore = fresh.querySelector('#plates')!;
    var keep = mounted && dirty(mounted);
    var gone = mounted && !nuStore.querySelector('#' + CSS.escape(mounted.id));
    $$('.plate', nuStore).forEach(function(p){
      if (mounted && p.id === mounted.id) {
        if (keep) return;
        // The open ticket stays as it is while the refresh draws it the same: a new copy dropped the focus and the
        // text you had selected in it every 5 s (Dan, 2026-11-10). Only while nothing is being sent from it: a send in
        // flight or not confirmed is replaced as before, so its one-time id follows the rules it always did. A kept
        // ticket takes the new copy's one-time ids, as the new copy would have brought them.
        var was = plateSrc.get(mounted), now = plateKey(p.outerHTML);
        var sending = $('form.act[data-busy], form.act[data-touched], form[data-sent-sig]', mounted) || unconfirmed[mounted.id];
        if (was === now && !sending) {
          var ids = $$<HTMLInputElement>('input[name=nonce]', p); $$<HTMLInputElement>('input[name=nonce]', mounted).forEach(function(x, i){ if (ids[i]) x.value = ids[i].value; });
          return;
        }
        plateSrc.set(p, now);
        var s = $('.plate-scroll', mounted), d = $('.dock', mounted), top = s ? s.scrollTop : 0, dtop = d ? d.scrollTop : 0;
        $$<HTMLDetailsElement>('details.more', mounted).forEach(function(x, i){ var y = $$<HTMLDetailsElement>('details.more', p)[i]; if (y) y.open = x.open; });
        // The question card you were reading stays in front through a refresh.
        $$('form.act', mounted).forEach(function(x, i){ var y = $$('form.act', p)[i]; if (y && qAt(x) > 0) qShow(y, qAt(x)); });
        mounted.replaceWith(p); mounted = p;
        var s2 = $('.plate-scroll', p), d2 = $('.dock', p); if (s2) s2.scrollTop = top; if (d2) d2.scrollTop = dtop;
      }
    });
    // A ticket with a send waiting (Undo), in flight, or not confirmed keeps its own form: its picks and note stay.
    var held: Record<string, boolean> = {};
    // So does a ticket you left mid-draft (a pick or a note): it waits for you, untouched (council 1b).
    $$('.plate', store_).forEach(function(p){ if (p.querySelector('form.act[data-busy], form.act[data-touched]') || unconfirmed[p.id] || $$<HTMLTextAreaElement>('textarea', p).some(function(x){ return x.value.trim(); })) held[p.id] = true; else p.remove(); });
    $$('.plate', nuStore).forEach(function(p){ if ((!mounted || p.id !== mounted.id) && !held[p.id]) { plateSrc.set(p, plateKey(p.outerHTML)); store_.appendChild(p); } });
    // A ticket sent from the pass comes back as soon as the agent hands it back again, not after 90 s.
    Object.keys(acted).forEach(function(aid){ var np = nuStore.querySelector<HTMLElement>('#' + CSS.escape(aid)) || document.getElementById(aid); if (np && actedLatest[aid] !== undefined && (np.dataset.latest || '') !== actedLatest[aid]) { delete acted[aid]; delete actedLatest[aid]; } });
    hideActed(); setFolder(state.folder); applyScope(); normalizePicked(); applyFlow(false); fades(); if (KST.changed || !K.mac) relabel(document); restoreDrafts(app); restoreDrafts($('#plates'));
    if (focusSel && document.activeElement !== null && (document.activeElement === document.body || !document.activeElement.isConnected)) { var back = $(focusSel); if (back) back.focus({ preventScroll: true }); }
    // The open ticket left the board on its own: show the next one, unless you are working in it.
    if (gone && !keep) { var id = mounted!.id; mounted!.remove(); mounted = null; if (acted[id]) { state.sel = null; place(); } else advance(id); return; }
    // The open ticket left the list you are working (an agent picked it up, or it moved stage): the next one opens,
    // unless you are typing or picking in it. The list's own order decides "next".
    if (focusView() && state.sel && !keep && !acted[state.sel] && !tiles().some(function(x){ return x.dataset.plate === state.sel; })) {
      var nextT = tiles()[0]; state.sel = nextT ? nextT.dataset.plate : null;
    }
    place();
  }
  function replayPending(){
    if (!pendingHtml) return;
    if (pendingFor !== location.search) { pendingHtml = null; return; }
    sync(pendingHtml);
  }
  document.addEventListener('toggle', function(ev){ if ((ev.target as HTMLDetailsElement).matches && (ev.target as HTMLDetailsElement).matches('details.pmenu') && !(ev.target as HTMLDetailsElement).open) replayPending(); }, true);
  var es = new EventSource('/events');
  function net(ok: boolean, msg?: string): void {
    $$('.netstrip').forEach(function(n){ n.remove(); });
    if (ok) return;
    var html = '<div class="strip netstrip" role="status"><b>Not checked</b> ' + msg + '</div>';
    var bar = $('.bar', app); if (bar) bar.insertAdjacentHTML('afterend', html); else document.body.insertAdjacentHTML('afterbegin', html);
    if (mounted) { var s = $('.plate-head', mounted) || $('.plate-scroll', mounted); if (s) s.insertAdjacentHTML('afterbegin', html); }
  }
  es.addEventListener('tick', function(ev){
    var t: { ok?: boolean; error?: unknown } = {}; try { t = JSON.parse(ev.data); } catch (x) {}
    net(t.ok !== false, 'T3 did not answer: ' + String(t.error || '').replace(/[<>&]/g, ''));
    var q = location.search;
    fetch('/app' + q, { cache: 'no-store' }).then(function(r){ if (!r.ok) throw 0; return r.text(); })
      .then(function(html){ if (q !== location.search) return; if (t.ok !== false) { last = Date.now(); app.classList.remove('is-stale'); } sync(html); Object.keys(unconfirmed).forEach(decorate); markSent(); }, function(){ lost('the Pass did not answer'); });
  });
  es.onerror = function(){ lost('lost the connection to the Pass'); };
  setInterval(function(){ if (Date.now() - last > 15000) { lost('no update for 15 s'); last = Date.now(); } }, 5000);

  // ----- Acting: no confirm; a few seconds with Undo, then it goes -----
  function post(body: string, keep?: boolean): Promise<[number, string]> {
    if (window.yeschef && typeof window.yeschef.act === 'function') return window.yeschef.act(body);
    return fetch('/act', { method: 'POST', body: body, keepalive: !!keep }).then(function(r){ return r.text().then(function(t): [number, string] { return [r.status, t]; }); });
  }
  function uuid(): string { return window.crypto && crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + String(Math.random()).slice(2); }
  var toastTimer: ReturnType<typeof setTimeout> | undefined;
  // acts: [label, run, command]. A button with a command shows that command's key now (relabel follows a change).
  function toast(msg: string, acts?: ToastAct[] | null, ms?: number, bad?: boolean, forId?: string | null): void {
    clearTimeout(toastTimer); toastEl.classList.remove('counting');
    // Over an open ticket sheet the toast lives inside it, so its buttons stay clickable above the modal.
    var host = [barDlg, launchDlg, setDlg, sheet].filter(function(d){ return d && d.open; })[0] || document.body;
    if (toastEl.parentNode !== host) { try { toastEl.hidePopover(); } catch (x) {} host.appendChild(toastEl); }
    $('.t-msg', toastEl)!.textContent = msg; toastEl.classList.toggle('bad', !!bad);
    var box = $('.t-acts', toastEl)!; box.textContent = ''; toastKey = null;
    (acts || []).forEach(function(a){ var b = document.createElement('button'); b.type = 'button'; b.textContent = a[0]; if (a[2]) { var kb = document.createElement('kbd'); kb.dataset.cmd = a[2]; kb.textContent = keyLabel(a[2]); kb.classList.toggle('nokey', !kb.textContent); b.appendChild(kb); } b.onclick = function(){ hideToast(); a[1](); }; if (a[2] === 'ticket.suggested') toastKey = b.onclick as () => void; box.appendChild(b); }); yieldKey();
    try { if (toastEl.matches(':popover-open')) toastEl.hidePopover(); toastEl.showPopover(); } catch (x) {}
    if (ms) toastTimer = setTimeout(hideToast, ms);
    toastFor = forId || null; yieldKey();
  }
  // A toast already showing stays clickable above a dialog opened after it (Opus).
  function liftToast(){
    try {
      if (!toastEl.matches(':popover-open')) return;
      // Only a toast with a button (Undo, Retry, Open) follows a dialog; a plain one steps aside (Opus r6).
      if (!$('.t-acts button', toastEl)) { hideToast(); return; }
      var host = [barDlg, launchDlg, setDlg, sheet].filter(function(d){ return d && d.open; })[0] || document.body;
      toastEl.hidePopover(); if (toastEl.parentNode !== host) host.appendChild(toastEl); toastEl.showPopover();
    } catch (x) {}
  }
  // A toast that shows ⌘↵ (Retry) owns that key while it shows, so the key does what the toast says, never the
  // next ticket's action (hill climb 2 r2, Sol).
  var toastKey: (() => void) | null = null, toastFor: string | null = null;
  function hideToast(){ toastKey = null; toastFor = null; yieldKey(); toastEl.classList.remove('counting'); clearTimeout(toastTimer); try { toastEl.hidePopover(); } catch (x) {} }
  // While a toast owns Cmd+Enter, the open ticket stops showing that key, so only one place offers it (hill climb 2 r3, Opus).
  // The ⌘↵ hint shows where the key goes: the toast's Retry, unless you are writing in a ticket's note (hill climb 2 r4, Astra).
  // The open ticket holds a Retry box of its own (not New thread, which retries from its dialog).
  function ownRetry(): boolean { return !!(mounted && unconfirmed[mounted.id] && $('.retry', mounted)); }
  // The open ticket's form the keys go to: the free form you are in, else the free form you last picked in, else the
  // first free one. A pick in question 2 makes Cmd+Enter send question 2 (r14, Sol and Astra).
  // What an option letter does from target, as onKey does it, and as the router asks before it routes the letter:
  // { radio }, the option it picks; { held }, a question waiting on its Retry that has that letter; or null.
  function letterAt(target: Element | null, k: string): { radio: HTMLInputElement; held?: undefined } | { held: HTMLFieldSetElement; radio?: undefined } | null {
    if (!mounted) return null;
    var here = target && target.closest ? target.closest('form.act') : null, form = keyForm(here);
    if (!form) return null;
    // Letters go to the form Cmd+Enter sends (keyForm), the one that shows the keys (r15, Opus). In it: the question
    // you are in, else the first unanswered, else the last one you picked in.
    // Only a question whose form can send takes a letter: a form waiting on its send or Retry keeps what it sent
    // (hill climb 2 r11, Astra).
    var free = function(fs: HTMLFieldSetElement | null | undefined): boolean { var ff = fs && fs.closest<HTMLElement>('form.act'); return !!fs && !fs.disabled && !(ff && ff.dataset.busy); };
    var inSet = target && target.closest ? target.closest<HTMLFieldSetElement>('fieldset.q-set') : null; if (!free(inSet)) inSet = null;
    // The last question you picked in is waiting on its Retry: a letter meant for it does not spill into another
    // question; the held form says why (hill climb 2 r12, Opus). Only the form that holds the Retry: one waiting out
    // its Undo lets the letter go to the next free question, as before (r13, Opus).
    // Focus anywhere in a free form (its Send button too) means the letter is for that form (r16, Astra).
    var uc = unconfirmed[mounted.id];
    var held = !inSet && form !== here && uc && mounted._lastSet && mounted.contains(mounted._lastSet) && !free(mounted._lastSet) && mounted._lastSet.closest('form.act') === uc.form ? mounted._lastSet : null;
    if (held && $('input[type=radio][data-key="' + k + '"]', held)) return { held: held };
    var lastSet = mounted._lastSet && form.contains(mounted._lastSet) && free(mounted._lastSet) ? mounted._lastSet : null;
    if (inSet && !form.contains(inSet)) inSet = null;
    var sets = $$<HTMLFieldSetElement>('fieldset.q-set', form).filter(free);
    // With the questions as cards, a letter answers the card in front (Dan, 2026-11-08).
    var shown = sets.filter(function(fs){ return fs.classList.contains('q-on'); })[0];
    var open = inSet || shown || sets.filter(function(fs){ return !$('input[type=radio]:checked', fs); })[0] || lastSet || sets[0];
    var r = open && $<HTMLInputElement>('input[type=radio][data-key="' + k + '"]', open);
    return r && !r.disabled ? { radio: r } : null;
  }
  function keyForm(here: Element | null | undefined): PageForm | null {
    if (!mounted) return null;
    var ok = function(f: Element | null | undefined): f is PageForm { return !!f && mounted!.contains(f) && !(f as PageForm).dataset.busy; };
    if (ok(here)) return here;
    var ls = mounted._lastSet && mounted.contains(mounted._lastSet) ? mounted._lastSet.closest('form.act') : null;
    return ok(ls) ? ls : $<PageForm>('form.act:not([data-busy])', mounted);
  }
  function yieldKey(): void {
    var a = document.activeElement, w = a && a.closest && a.closest('textarea, input[type=text]'), wf = w && w.closest('form.act');
    // While the open ticket holds its Retry, focus in one of its free forms sends that form, else the Retry box does:
    // the hint shows on the one the key sends, as the key handler decides (r13, Astra and Sol).
    var own = ownRetry(), af = own && a && a.closest && a.closest<HTMLElement>('form.act'), ff = af && mounted!.contains(af) && !af.dataset.busy ? af : null;
    $$('.plate kbd').forEach(function(kb){
      if (kb.textContent !== SK()) return;
      var rt = kb.closest('[data-retry]');
      if (own && mounted!.contains(kb)) kb.classList.toggle('yield', rt ? !!ff : !(ff && kb.closest('form.act') === ff));
      else if (!rt) kb.classList.toggle('yield', !!toastKey && !(wf && kb.closest('form.act') === wf));
    });
    // A ticket with more than one free form: the one the keys go to (keyForm, as the key handler picks) keeps the blue
    // and its key hints; the others step aside (r14, Sol and Astra).
    $$('.plate form.act.aside, .plate form.act.keyto').forEach(function(f){ f.classList.remove('aside', 'keyto'); });
    // With the Retry held, the free form you are in takes the blue from the Retry box, with its key (r15, Astra).
    if (ff) ff.classList.add('keyto');
    if (mounted && !own) {
      var open = $$('form.act:not([data-busy])', mounted);
      if (open.length > 1) { var to = keyForm(a && a.closest && a.closest('form.act')); open.forEach(function(f){ if (f !== to) f.classList.add('aside'); }); }
    }
    // While you write, ⌘↵ sends what you are writing, so the toast stops showing it (hill climb 2 r4, Opus).
    // Settings, New thread, the action bar and the screenshot viewer take the keys first, so the toast shows none over them (hill climb 2 r5, Astra).
    var modal = [barDlg, setDlg, launchDlg, viewer].some(function(d){ return d && d.open; });
    $$('#toast button kbd').forEach(function(kb){ kb.classList.toggle('yield', !!w || modal || !!ownRetry()); });
    // The toast steps aside while its own ticket is open with its Retry box, which says the same and owns the key (r12, Opus, Sol). New thread's dialog says it too, with Launch again (r13, Astra and Sol).
    toastEl.classList.toggle('mine', (!!toastFor && !!mounted && mounted.id === toastFor && !!ownRetry()) || (toastFor === 'launch' && !!launchDlg && launchDlg.open && !!unconfirmed.launch));
    // A letter an option takes (E on a fifth option, H on an eighth) is not shown on Settle or Hold (hill climb 2 r4, Opus).
    $$('.plate form.act').forEach(function(f){
      var taken: Record<string, number> = {}; $$('fieldset.q-set:not([disabled]) input[data-key]', f).forEach(function(r){ if (r.dataset.key) taken[r.dataset.key.toUpperCase()] = 1; });
      $$('button[name=kind] kbd', f).forEach(function(kb){ kb.classList.toggle('taken', kb.textContent.length === 1 && !!taken[kb.textContent]); });
    });
  }
  document.addEventListener('focusin', yieldKey);
  [setDlg, launchDlg, viewer].forEach(function(d){ if (d) d.addEventListener('close', yieldKey); });
  document.addEventListener('focusout', function(){ setTimeout(yieldKey, 0); });
  // "Not confirmed: …" becomes "Not confirmed for “Ticket”: …"; any other result starts with the ticket.
  function named(f: HTMLElement | null | undefined, text: string): string {
    var n = f && f.dataset.named; if (!n) return text;
    return /^Not confirmed: /.test(text) ? text.replace(/^Not confirmed: /, 'Not confirmed for ' + n + ': ') : n + ': ' + text;
  }
  // The project select locks too, so a send waiting out its Undo cannot be saved under its id with another project
  // (hill climb 2 r8, Sol).
  function lock(f: ParentNode, on: boolean): void { $$<Control>('input, textarea, button, select', f).forEach(function(x){ if (on) { x.dataset.was = x.disabled ? '1' : ''; x.disabled = true; } else { x.disabled = x.dataset.was === '1'; } }); }
  function say(f: ParentNode | null | undefined, text: string, tone?: string): void { var r = $('.result', f); if (r) { r.textContent = text; r.className = 'result ' + (tone || ''); } }
  function picks(f: ParentNode): (string | null)[] { return $$('fieldset.q-set', f).map(function(fs, i){ var c = $<HTMLInputElement>('input[type=radio]:checked', fs); return c ? c.value : null; }); }
  // The picks as words for a toast or a Retry: a call's option text, not its letter ("Yes, merge once CI is…", not "a"),
  // without the "(Recommended)" tag, cut at a word near 32 characters (r15, Opus; 32 so a short option ends whole, r16, Astra).
  function pickNames(f: ParentNode): string {
    return $$('fieldset.q-set', f).map(function(fs){
      var c = $<HTMLInputElement>('input[type=radio]:checked', fs); if (!c) return null;
      var x = c.value, t = /^c:/.test(c.name) && c.parentNode ? $('.opt-t', c.parentNode) : null;
      if (t) { var b = $('b', t), rc = $('.rec', t); x = t.textContent; if (b) x = x.replace(b.textContent, ''); if (rc) x = x.replace(rc.textContent, ''); x = x.trim() || c.value; }
      x = x.replace(/ *[(]recommended[)] *$/i, '');
      if (x.length <= 32) return x;
      var cut = x.slice(0, 31), sp = cut.lastIndexOf(' ');
      return (sp > 12 ? cut.slice(0, sp) : cut).replace(/[ ,.;:]+$/, '') + '…';
    }).filter(Boolean).join(', ');
  }
  function validate(f: PageForm, kind: string, btn?: HTMLElement | null): string | null {
    if (kind === 'call' || kind === 'answer') {
      var need = $$<HTMLFieldSetElement>('fieldset.q-set', f).filter(function(fs){ return $('input[data-need]', fs) && !$('input[type=radio]:checked', fs); });
      // The first unanswered question comes forward, so the message points at something you can see.
      if (need.length && !$('fieldset.q-set[disabled]', f)) { qShow(f, qSets(f).indexOf(need[0]!)); return need.length > 1 ? 'Answer every decision first.' : 'Pick an answer first.'; }
      // An empty answer of your own: its card comes forward (PR-Agent r1 on #50).
      var custom = $$('input[data-custom]:checked', f).filter(function(r){ return !$<HTMLInputElement>('.custom', r.parentNode)!.value.trim(); })[0];
      if (custom) { qShow(f, qSets(f).indexOf(custom.closest('fieldset') as HTMLFieldSetElement)); return 'Write your own answer first.'; }
    }
    // Hold and Settle send the agent nothing: a written note would be lost, so they wait (council 3, Opus).
    if ((kind === 'hold' || kind === 'settle') && f.elements.note && f.elements.note.tagName === 'TEXTAREA' && f.elements.note.value.trim()) return (kind === 'hold' ? 'Hold' : 'Settle') + ' sends the agent nothing, so your note would be lost. Send it with Reply (R) first, or clear it.';
    if (btn && btn.hasAttribute('data-note') && !(f.elements.note && f.elements.note.value.trim())) return kind === 'refire' ? 'Request changes needs a note: what should the agent fix?' : 'Write the reply first.';
    if (kind === 'launch') {
      if (!f.elements.project!.value) return 'Pick a project.';
      if (!f.elements.prompt!.value.trim()) return 'Write what the agent should do.';
    }
    return null;
  }
  // Several questions show one at a time, as cards (Dan, 2026-11-08). The server marks the first one; these move
  // between them and fill a dot for each one answered. Dan picked cards over a Gmail-style stack (2026-11-08).
  function qSets(f: ParentNode): HTMLFieldSetElement[] { return $$<HTMLFieldSetElement>('fieldset.q-set', f); }
  function qAt(f: ParentNode): number { var s = qSets(f); for (var i = 0; i < s.length; i++) if (s[i]!.classList.contains('q-on')) return i; return 0; }
  function qShow(f: Element, i: number): void {
    var s = qSets(f); if (s.length < 2) return;
    i = Math.max(0, Math.min(s.length - 1, i | 0));
    var moved = qAt(f) !== i, ae = document.activeElement, was = ae && ae.closest ? ae.closest('fieldset.q-set') : null;
    s.forEach(function(x, n){ x.classList.toggle('q-on', n === i); });
    // Focus in the card that hides goes to the card that shows, its pick or its first option (PR-Agent r7 on #50).
    if (moved && was && f.contains(was) && was !== s[i]) { var fo = $('input[type=radio]:checked', s[i]) || $('input[type=radio]', s[i]); if (fo) fo.focus({ preventScroll: true }); }
    // A new card opens at its top: a dock scrolled down the last card scrolls back to "1 of 3" (PR-Agent r2 on #50).
    var d = f.closest('.dock'), nav = $('.q-nav', f);
    if (moved && d && nav) { var over = nav.getBoundingClientRect().top - d.getBoundingClientRect().top; if (over < 0) d.scrollTop += over; }
    var pos = $('.q-pos', f); if (pos) pos.textContent = (i + 1) + ' of ' + s.length;
    $$('.q-dot', f).forEach(function(d, n){ d.classList.toggle('on', n === i); d.classList.toggle('done', !!$('input[type=radio]:checked', s[n])); if (n === i) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current'); });
    var pv = $<HTMLButtonElement>('[data-qgo="-1"]', f), nx = $<HTMLButtonElement>('[data-qgo="1"]', f); if (pv) pv.disabled = i === 0; if (nx) nx.disabled = i === s.length - 1;
  }
  // After a pick, the next question you have not answered comes forward; with all answered, the card stays.
  function qNext(f: Element): void { var s = qSets(f), at = qAt(f); for (var n = 1; n < s.length; n++) { var j = (at + n) % s.length; if (!$('input[type=radio]:checked', s[j])) { qShow(f, j); return; } } qShow(f, at); }
  document.addEventListener('click', function(ev){
    var b = (ev.target as Element).closest && (ev.target as Element).closest<HTMLElement>('[data-qgo], [data-qto]'); if (!b) return;
    var f = b.closest('form.act'); if (!f) return;
    ev.preventDefault();
    qShow(f, b.hasAttribute('data-qto') ? +b.dataset.qto! : qAt(f) + (+b.dataset.qgo!));
  });
  // The primary is the recommended action: with nothing picked, each decision takes the option the agent recommends.
  function recPick(f: ParentNode): void { $$('fieldset.q-set:not([disabled])', f).forEach(function(fs){ if ($('input[type=radio]:checked', fs)) return; var r = $<HTMLInputElement>('input[data-rec]', fs); if (r) r.checked = true; }); }
  function primaryLabel(f: Element | null): void {
    var b = f && $('button.primary[value=call], button.primary[value=answer]', f); if (!b || !$('.bl', b)) return;
    // A retry form keeps its "Send again" label: the answer is fixed (Fable r6).
    if ($('fieldset.q-set[disabled]', f)) return;
    // One form for both question kinds, by letter: "Send b" (hill climb r4, Fable). The bar keeps one word or two
    // (Dan, 2026-11-10), so "(recommended)" moved to the tooltip: "Send your answer, a (recommended)" while the
    // agent's pick stands. Your own typed answer reads "Send your answer".
    var plan = $$('fieldset.q-set', f).map(function(fs){
      var c = $<HTMLInputElement>('input[type=radio]:checked', fs), x = c || $<HTMLInputElement>('input[data-rec]', fs);
      if (!x) return null;
      return { key: x.hasAttribute('data-custom') ? '' : (x.dataset.key || x.value), rec: !c };
    });
    var picks = plan.every(Boolean) && !plan.some(function(p){ return !p!.key; })
      ? (plan.length > 1 ? plan.map(function(p, i){ return (i + 1) + p!.key; }).join(', ') : plan[0]!.key) : '';
    // The button names two picks at most ("Send 1a, 2b"); three or more read "Send all", so the label fits the phone's
    // pill (PR-Agent r2 on #72). The tooltip keeps every pick.
    var txt = !plan.every(Boolean) ? 'Send answer' : picks ? (plan.length > 2 ? 'Send all' : 'Send ' + picks) : 'Send your answer';
    $('.bl', b)!.textContent = txt;
    var tn = $('.tn', b);
    if (tn) tn.textContent = 'Send your answer' + (picks ? ', ' + picks + (plan.some(function(p){ return p!.rec; }) ? ' (recommended)' : '') : '');
  }
  // Settings (Gmail-style): density for the lists. Saved on this Mac only. Every ticket's actions sit in one bar at
  // its foot (Dan, 2026-11-10): the Side panel layout is gone, and a stored yc.layout2 is no longer read.
  // System until applyPrefs, which runs before anything reads it, puts the saved one in place.
  var prefs = { density: store('yc.density') || 'default', theme: store('yc.theme') || 'system' };
  function applyPrefs(){
    if (!/^(default|comfortable|compact)$/.test(prefs.density)) prefs.density = 'default';
    ['default', 'comfortable', 'compact'].forEach(function(d){ root.classList.toggle('d-' + d, prefs.density === d); });
    $$<HTMLInputElement>('#settings input[name=density]').forEach(function(r){ r.checked = r.value === prefs.density; });
    applyTheme();
    fades();
  }
  // Appearance (PR 3 of the action bar): System, Light or Dark, saved on this Mac. System stores nothing.
  // In the desktop app the window's own parts (title bar, menus, the update card) follow too, through the preload bridge.
  var THEME_NAME: Record<string, string> = { system: 'System', light: 'Light', dark: 'Dark' };
  function applyTheme(){
    if (!/^(light|dark)$/.test(prefs.theme)) prefs.theme = 'system';
    if (prefs.theme === 'system') root.removeAttribute('data-theme'); else root.setAttribute('data-theme', prefs.theme);
    $$<HTMLInputElement>('#settings input[name=theme]').forEach(function(r){ r.checked = r.value === prefs.theme; });
    try { if (window.yeschef && typeof window.yeschef.theme === 'function') window.yeschef.theme(prefs.theme); } catch (x) {}
  }
  function setTheme(t: string): void {
    prefs.theme = t; if (t === 'light' || t === 'dark') store('yc.theme', t); else forget('yc.theme');
    applyTheme();
  }
  // The order of T3 Code's appearance.cycle: System, Light, Dark.
  function cycleTheme(){ setTheme(({ system: 'light', light: 'dark', dark: 'system' } as Record<string, string>)[prefs.theme] || 'system'); toast('Appearance: ' + THEME_NAME[prefs.theme], null, 2000); }
  // Settings has sections (Dan, 2026-11-07): Layout and Shortcuts. Cmd+, opens Layout; ? opens Shortcuts.
  function openSettings(tab?: string): void {
    applyPrefs(); if (typeof krRender === 'function') { krProjects(); krLive(); krRender(); krSay(krErr, !!krErr); }
    tab = tab || 'layout';
    // Each tab opens at its top.
    var was = $('#settings .set-tab[aria-current]'), panes = $('#settings .set-panes');
    if (panes && (!setDlg.open || !was || was.dataset.tab !== tab)) panes.scrollTop = 0;
    $$('#settings .set-tab').forEach(function(b){ if (b.dataset.tab === tab) b.setAttribute('aria-current', 'true'); else b.removeAttribute('aria-current'); });
    $$('#settings .set-pane').forEach(function(p){ p.hidden = p.dataset.pane !== tab; });
    if (tab === 'keys') kxRender();
    // showModal focuses the first tab, Layout; the open section's tab takes focus, so ? never rings Layout.
    if (!setDlg.open) { setDlg.showModal(); liftToast(); yieldKey(); var curTab = $('#settings .set-tab[aria-current]'); if (curTab) curTab.focus(); }
    fades();
  }
  setDlg.addEventListener('click', function(ev){ var t = (ev.target as Element).closest && (ev.target as Element).closest<HTMLElement>('.set-tab'); if (t) openSettings(t.dataset.tab); });
  // Kitchen rules (Dan, 2026-11-08): each change saves at once, like T3 Code's settings. "Applies to" shows All projects
  // or one project; a change there is that project's own value, and Reset gives it back to All projects.
  var KR: KitchenRules | null = null; try { KR = JSON.parse(($('#yc-rules') || {} as Partial<HTMLElement>).textContent || 'null'); } catch (x) { KR = null; }
  // A failed save keeps saying so until one works; the menus go back to what is saved (PR-Agent on #49).
  var krErr = (($('#settings [data-pane=rules]') || {} as Partial<HTMLElement>).dataset || {} as DOMStringMap).krError || '', krBusy = 0, krSeq = 0;
  // Notes that failed to save stay as a draft, per scope, until a save of them works (PR-Agent r3 on #49).
  var krDraft: Record<string, string> = {};
  // A saved set, from a save's answer or a refresh, is taken only when its revision is the newest seen, whatever order
  // they arrive in (PR-Agent r10 on #49). Another window's change comes in this way too.
  var krRev = 0;
  function krAccept(text: string): boolean {
    var o: KitchenRules | null | undefined; try { o = JSON.parse(text); } catch (x) { return false; }
    if (!o || !o.all || !(o.rev >= krRev)) return false;
    krRev = o.rev; KR = o;
    var now = $('#yc-rules-now'); if (now && now.textContent !== text) now.textContent = text;
    return true;
  }
  function krLive(){
    var el = $('#yc-rules-now'); if (!el) return;
    if (krAccept(el.textContent) && setDlg.open) krRender();
  }
  function krScope(): string { var s = $<HTMLSelectElement>('#kr-scope'); return s ? s.value : ''; }
  function krRender(){
    if (!KR) return;
    var sc = krScope(), own: Record<string, string | undefined> = sc ? (KR.projects[sc] || {}) : {}, val = function(k: string): string | undefined { return Object.prototype.hasOwnProperty.call(own, k) ? own[k] : (KR!.all as Record<string, string>)[k]; };
    $$<HTMLInputElement>('#settings [data-kr]').forEach(function(el){
      var k = el.dataset.kr!, v = val(k);
      // Menus always show the saved value, so a failed choice can be picked again (PR-Agent r2 on #49). The notes box
      // keeps what you are typing, and keeps it after a failed save, so nothing you wrote is lost.
      if (el.tagName === 'TEXTAREA' && Object.prototype.hasOwnProperty.call(krSending, sc)) v = krSending[sc];
      else if (el.tagName === 'TEXTAREA' && Object.prototype.hasOwnProperty.call(krDraft, sc)) v = krDraft[sc];
      if (el.type === 'checkbox') el.checked = v === 'on'; else if (el.tagName !== 'TEXTAREA' || document.activeElement !== el) el.value = v == null ? '' : v;
      var row = el.closest('.kr-row'); if (row) row.classList.toggle('kr-over', !!sc && Object.prototype.hasOwnProperty.call(own, k));
    });
    var m = $('#settings .kr-row[data-row=missing]'); if (m) m.classList.toggle('kr-off', val('screens') !== 'on');
  }
  // "Applies to" follows T3's project list, which comes with each board refresh (PR-Agent on #49).
  function krProjects(){
    var s = $<HTMLSelectElement>('#kr-scope'), src = $('#yc-projects'); if (!s || !src) return;
    var keep = s.value;
    while (s.options.length > 1) s.options[1]!.parentNode!.removeChild(s.options[1]!);
    $$('option', src).forEach(function(o){ s!.appendChild(o.cloneNode(true)); });
    s.value = keep; if (s.value !== keep) s.value = '';
  }
  // Its word shows in the footer, where "Saved on this Mac." sits; it goes back to that when Settings opens again.
  function krSay(t: string, bad?: boolean): void { var s = $('#settings .set-done span'); if (s) { s.textContent = t || 'Saved on this Mac.'; s.classList.toggle('bad', !!bad); } }
  // Sends one change at once, with keepalive, so nothing waits in the page when it closes (PR-Agent r7 on #49). Each
  // answer is the whole saved set; only the newest one sent updates the page, whatever order they come back in.
  // The page and the count go with each save: Yes Chef skips a save older than one it already took from this page,
  // so two saves that cross on the way land in the order you made them (PR-Agent r8 on #49).
  // krSending: notes on their way, per project, shown until their own save answers (PR-Agent r11 on #49).
  var krPage = uuid(), krNotesLast: Record<string, number> = {}, krSending: Record<string, string> = {};
  function krSave(q: string, notes?: string | null): void {
    var sc = krScope(), my = ++krSeq;
    if (notes != null) { krNotesLast[sc] = my; krSending[sc] = notes; }
    krSay('Saving…'); krBusy++;
    // Only the newest notes save for a project decides whether its draft stays (PR-Agent r8 on #49).
    function noteResult(ok: boolean): void { if (notes == null || krNotesLast[sc] !== my) return; delete krSending[sc]; if (ok) delete krDraft[sc]; else krDraft[sc] = notes; }
    post('kind=rules&nonce=' + encodeURIComponent(uuid()) + '&page=' + encodeURIComponent(krPage) + '&seq=' + my + '&' + q, true)
      .then(function(r){
        krBusy--;
        if (r[0] === 200) {
          // The page's copy of the saved rules moves with the save, so an older copy never comes back (PR-Agent r6 on #49).
          krAccept(r[1]);
          noteResult(true);
          // Notes still unsaved somewhere keep the footer red, so "Saved" never stands beside them (PR-Agent r5 on #49);
          // and "Saved" waits until no save is still on its way (r10).
          krErr = Object.keys(krDraft).length ? 'House notes not saved yet. Change them to try again.' : '';
          krRender(); krSay(krErr || (krNotesT ? 'Not saved yet…' : krBusy ? 'Saving…' : 'Saved. New threads get these rules.'), !!krErr);
        }
        else { noteResult(false); krFail(String(r[1] || 'Not saved.')); }
      }, function(){ krBusy--; noteResult(false); krFail('Not saved: Yes Chef did not answer.'); });
  }
  function krFail(t: string): void { krErr = t; krRender(); krSay(t, true); }
  function krSet(k: string, v: string): void {
    krSave('scope=' + encodeURIComponent(krScope()) + '&key=' + encodeURIComponent(k) + '&value=' + encodeURIComponent(v), k === 'notes' ? v : null);
  }
  // House notes save while you type, a moment after you stop, and at once when you leave the box or close the
  // window, so notes never sit unsaved beside "Saved" (PR-Agent r6 on #49). Saving the same text twice is harmless.
  var krNotesT: ReturnType<typeof setTimeout> | undefined;
  function krNotes(){
    clearTimeout(krNotesT); krNotesT = undefined;
    var t = $<HTMLTextAreaElement>('#settings [data-kr=notes]'); if (!t || !KR) return;
    krSet('notes', t.value);
  }
  setDlg.addEventListener('input', function(ev){
    if (!ev.target || !(ev.target as HTMLElement).dataset || (ev.target as HTMLElement).dataset.kr !== 'notes') return;
    krSay('Not saved yet…'); clearTimeout(krNotesT); krNotesT = setTimeout(krNotes, 800);
  });
  window.addEventListener('pagehide', function(){ if (krNotesT) krNotes(); });
  setDlg.addEventListener('change', function(ev){
    var el = ev.target as HTMLInputElement | null; if (!KR || !el) return;
    if (el.id === 'kr-scope') { krRender(); krSay(krErr, !!krErr); return; }
    if (!el.dataset || !el.dataset.kr) return;
    if (el.dataset.kr === 'notes') { krNotes(); return; }
    krSet(el.dataset.kr, el.type === 'checkbox' ? (el.checked ? 'on' : 'off') : el.value);
  });
  setDlg.addEventListener('click', function(ev){
    var b = (ev.target as Element).closest && (ev.target as Element).closest<HTMLElement>('[data-kr-reset]'), sc = krScope();
    if (!b || !KR || !sc) return;
    // Reset drops the draft, and no notes save still on its way can bring it back (PR-Agent r9 on #49).
    if (b.dataset.krReset === 'notes') { delete krDraft[sc]; delete krSending[sc]; krNotesLast[sc] = -1; clearTimeout(krNotesT); krNotesT = undefined; }
    krSave('scope=' + encodeURIComponent(sc) + '&key=' + encodeURIComponent(b.dataset.krReset!) + '&reset=1');
  });
  // The Pass's flag: "Ask for them" fills Reply with the ask. Cmd+Enter sends it, with its Undo; you can change it first.
  document.addEventListener('click', function(ev){
    var b = (ev.target as Element).closest && (ev.target as Element).closest<HTMLElement>('[data-ask-shots]'); if (!b) return;
    var p = b.closest('.plate'), f = p && $<PageForm>('form.act', p); if (!f || !f.elements.note) return;
    setIntent(f, 'reply');
    // A reply you already started stays; the ask goes under it (PR-Agent r5 on #49).
    var cur = f.elements.note.value.trimEnd(), add = cur ? cur + '\n\n' + b.dataset.askShots : b.dataset.askShots!;
    // A reply holds 4,000 characters (client/actions.ts MAX_NOTE). Past that, say so; never send a cut ask (PR-Agent r6 on #49).
    if (cur.indexOf(b.dataset.askShots!) < 0 && add.length > 4000) { toast('Your reply is too long to add the ask. Shorten it first.', null, 5000, true); f.elements.note.focus(); return; }
    if (cur.indexOf(b.dataset.askShots!) < 0) f.elements.note.value = add;
    f.elements.note.dispatchEvent(new Event('input', { bubbles: true }));
    f.elements.note.focus();
  });
  // A new thread in T3 Code from here (Cmd+T or Cmd+N; Cmd+K is the action bar, Dan 2026-11-10). The project list comes
  // with each board refresh.
  function openLaunch(): void {
    var f = $<LaunchForm>('form.launch', launchDlg)!, sel = f.elements.project, src = $('#yc-projects');
    var keep = sel.value;
    sel.textContent = '';
    if (src) $$('option', src).forEach(function(o){ sel.appendChild(o.cloneNode(true)); });
    // Start in the project of the ticket you are looking at, else the last one used. A draft in progress keeps
    // the project it was written for (hill climb 2 r6, Astra). The name comes from data-project: the label's
    // text also holds the letter avatar.
    var here = mounted && ($('.plate-bar .proj', mounted) || { dataset: {} as DOMStringMap }).dataset.project;
    var pick = $$<HTMLOptionElement>('option', sel).filter(function(o){ return o.textContent === here; })[0];
    var drafting = (f.elements.prompt.value || f.elements.title.value) && keep && $$<HTMLOptionElement>('option', sel).some(function(o){ return o.value === keep; });
    sel.value = drafting ? keep : pick ? pick.value : (keep || store('yc.launchProject') || sel.value);
    // A draft whose project T3 no longer lists has no project picked, so it never launches in another one
    // (PR-Agent r4 on #38).
    if (f.dataset.lost && (f.elements.prompt.value || f.elements.title.value)) sel.selectedIndex = -1;
    restoreLaunch(f);
    if (!f.elements.nonce.value) f.elements.nonce.value = uuid();
    say(f, f.dataset.sentSig ? 'Not confirmed: this thread may already have started. Check T3 Code; launching it unchanged is the same request.' : f.dataset.lost && sel.selectedIndex < 0 ? 'Pick a project. The one this draft was for is no longer in T3 Code.' : '', f.dataset.sentSig || f.dataset.lost ? 'bad' : '');
    if (!launchDlg.open) { launchDlg.showModal(); liftToast(); yieldKey(); }
    f.elements.prompt.focus();
  }
  launchDlg.addEventListener('click', function(ev){ if (ev.target === launchDlg || ((ev.target as Element).closest && (ev.target as Element).closest('[data-launch-cancel]'))) launchDlg.close(); });
  setDlg.addEventListener('change', function(ev){
    var r = ev.target as HTMLInputElement;
    if (r.name === 'theme') { setTheme(r.value); return; }
    if (r.name !== 'density') return;
    prefs.density = r.value; store('yc.density', r.value); applyPrefs();
  });
  // The action bar's Density rows set it the way Settings does.
  function setDensity(d: string): void { prefs.density = d; store('yc.density', d); applyPrefs(); }
  setDlg.addEventListener('click', function(ev){ if (ev.target === setDlg || (ev.target as Element).closest('[data-settings-done]')) setDlg.close(); });
  // The note unfolds when asked for, and folds again once sent or left empty.
  function noting(f: PageForm | null | undefined, on: boolean): void { if (!f) return; f.classList.toggle('noting', !!on); if (on && f.elements.note && f.elements.note.focus) f.elements.note.focus(); }
  // One intent per form: a click on Reply or Request changes with no note yet, or R / F, arms it; Cmd+Enter then sends it.
  function setIntent(f: PageForm | null | undefined, kind?: string | null): void {
    if (!f) return;
    if (kind) noting(f, true);
    if (kind) f.dataset.intent = kind; else delete f.dataset.intent;
    // The blue button is always what Cmd+Enter sends: the armed Reply or Request changes takes the fill and the Cmd+Enter
    // key while armed; the recommended action gets them back when the intent clears (hill climb r1, Astra).
    $$<HTMLButtonElement>('button[name=kind]', f).forEach(function(b){
      var kb = $('kbd', b);
      if (b.dataset.fill === undefined) { b.dataset.fill = b.classList.contains('fill') ? '1' : ''; if (kb) b.dataset.key = kb.textContent; }
      var on = !!kind && b.value === kind, lead = kind ? on : b.dataset.fill === '1';
      b.classList.toggle('armed', on);
      b.classList.toggle('fill', lead);
      if (kb) { kb.textContent = on ? SK() : b.dataset.key!; kb.classList.toggle('nokey', !kb.textContent); kb.hidden = !!kind && !on && b.dataset.key === SK(); }
      // The blue action's tooltip says "M or ⌘↵": while another action is armed, Cmd+Enter is that one's.
      $$('kbd', b).slice(1).forEach(function(k2){ k2.hidden = !!kind && !on; });
    });
    var lab = f.querySelector<HTMLElement>('.note > span');
    if (lab) { if (!lab.dataset.base) lab.dataset.base = lab.innerHTML; if (kind === 'reply') lab.textContent = 'Your reply'; else if (kind === 'refire') lab.textContent = 'Request changes: what should the agent fix?'; else lab.innerHTML = lab.dataset.base!; }
    var note = f.elements.note;
    if (note && note.tagName === 'TEXTAREA') note.placeholder = kind === 'reply' ? 'For example: go with b, and add a test for it.' : kind === 'refire' ? 'For example: the button overlaps on phones. Fix it and shoot it again.' : 'What should the agent know?';
    // The armed action is part of the draft, so a reload never turns a Reply into the recommended answer (hill climb 2 r3, Sol).
    if (f.dataset.restored && !f._restoring) saveDraft(f);
    noteKey(f);
  }
  // With a note written and nothing armed or recommended, Cmd+Enter sends a Reply, so Reply shows the key then
  // (hill climb 2 r6, Opus).
  // A note that went to the agent before its latest message, still unchanged. Cmd+Enter does not send it again, and
  // no answer or Go carries it; Reply (R or its button) sends it on purpose (hill climb 2 r8, Opus).
  function stale(f: PageForm | null | undefined): boolean { return !!f && f.dataset.stale !== undefined && !!f.elements.note && f.elements.note.value === f.dataset.stale; }
  function noteKey(f: PageForm | null | undefined): void {
    var b = f && $('button[name=kind][value=reply]', f), kb = b && $('kbd', b);
    if (f && b && kb) { // kb is found only in b, and b only in f
      if (b.dataset.fill === undefined) { b.dataset.fill = b.classList.contains('fill') ? '1' : ''; b.dataset.key = kb.textContent; }
      var free = !f.dataset.intent && !$('button.primary', f), wrote = !!(f.elements.note && f.elements.note.value && f.elements.note.value.trim()) && !stale(f);
      if (!f.dataset.intent) { kb.textContent = free && wrote ? SK() : b.dataset.key!; kb.classList.toggle('nokey', !kb.textContent); }
      // The button Cmd+Enter sends is the blue one, so Reply fills while it owns the key (r16, Astra).
      if (!f.dataset.intent) b.classList.toggle('fill', b.dataset.fill === '1' || (free && wrote));
    }
    yieldKey();
  }
  // Sends waiting out their Undo, newest last. Z and the toast always undo the newest; an older send never hides it.
  var pendingSends: PendingSend[] = [];
  function showUndo(): boolean {
    var p = pendingSends[pendingSends.length - 1]; if (!p) return false;
    var n = pendingSends.length;
    var left = Math.max(600, p.until - Date.now());
    toast((n > 1 ? n + ' sends waiting. ' : '') + p.label, [['Undo', p.undo, 'send.undo']], left);
    toastEl.style.setProperty('--undo-ms', left + 'ms'); toastEl.classList.remove('counting'); void toastEl.offsetWidth; toastEl.classList.add('counting');
    return true;
  }
  // Reload and a project switch never leave the page (council 3). Quit, closing the window and Force Reload wait for
  // __ycBusy to turn false (desktop/main.ts): each send keeps its full Undo, goes, and T3 answers before the page goes
  // (hill climb 2 r1, Sol). Only a page that leaves without asking (a crash, a browser tab) sends what was waiting
  // on its way out, rather than dropping it.
  // Busy while any send waits out its Undo, or one sent less than 10 s ago has no answer yet. The app asks again and
  // again, so a send queued while it waits still gets its full four seconds (hill climb 2 r2, Astra).
  var flights: number[] = [];
  window.__ycBusy = function(){ var now = Date.now(); return pendingSends.length > 0 || flights.some(function(t){ return now - t < 10000; }); };
  // Every post that waits on T3's answer is in flight, a Retry too, so Quit waits for it (PR-Agent r3 on #38).
  function fly(body: string, keep?: boolean): Promise<[number, string]> {
    var t = Date.now(); flights.push(t);
    var done = function(){ var i = flights.indexOf(t); if (i >= 0) flights.splice(i, 1); };
    return post(body, keep).then(function(r){ done(); return r; }, function(e){ done(); throw e; });
  }
  // A browser tab asks before it leaves while a send waits out its Undo, so Undo stays possible (hill climb 2 r2).
  // The desktop app skips the question: its drain has already let every send finish (desktop/main.ts).
  window.addEventListener('beforeunload', function(ev){ if (pendingSends.length) { ev.preventDefault(); ev.returnValue = ''; } });
  window.addEventListener('pagehide', function(){ pendingSends.slice().forEach(function(p){ p.fire(true); }); });
  function send(f: PageForm, btn: HTMLButtonElement): void {
    // Your team's actions wait for the team connection: nothing a teammate's agent could act on leaves this Mac yet.
    if (f.classList.contains('team-act')) { say(f, 'Not sent: Yes Chef does not have the team connection yet.', 'bad'); return; }
    // A send waiting on its answer goes nowhere, but one that is not confirmed goes again, the same bytes.
    if (f.dataset.busy) { var uid = f.classList.contains('launch') ? 'launch' : f.dataset.plate!; if (unconfirmed[uid]) retry(uid); return; }
    if ((btn.value === 'call' || btn.value === 'answer') && btn.classList.contains('primary')) recPick(f);
    var kind = btn.value, why = validate(f, kind, btn);
    if (why) {
      // A refusal keeps a not-confirmed send's warning on the form (hill climb 2 r12, Astra).
      say(f, why + (f.dataset.sentSig ? ' The first send is still not confirmed: sending it unchanged is the same request.' : ''), 'bad');
      // Reply or Request changes with no note yet: arm it and put you in the note.
      if (btn.hasAttribute('data-note') && f.elements.note) { setIntent(f, kind); f.elements.note.focus(); }
      return;
    }
    if (stale(f) && kind !== 'reply' && kind !== 'refire') { say(f, 'You sent this note before the agent’s latest message, so it may have reached the agent. Send it again with Reply (R), change it, or clear it.', 'bad'); return; }
    // A restored send repeated as another kind, or changed, is a new send (PR-Agent r2 on #38). Only a send that
    // goes gets a new id: a refused Hold or Settle keeps the restored one (hill climb 2 r8, Astra).
    if (f.dataset.sentSig && (!sameKind(sendKind(f, btn.value), f.dataset.sentKind || '') || !sameSent(f))) freshNonce(f);
    var fd = new FormData(f); fd.set('kind', kind);
    $$<HTMLInputElement>('input[data-custom]:checked', f).forEach(function(r){ fd.set(r.name, $<HTMLInputElement>('.custom', r.parentNode)!.value); });
    if (kind !== 'call' && kind !== 'answer') $$<HTMLInputElement>('fieldset.q-set input[type=radio]', f).forEach(function(r){ fd.delete(r.name); });
    var body = new URLSearchParams(fd as unknown as Record<string, string>).toString();
    var isLaunch = kind === 'launch';
    var id = isLaunch ? 'launch' : f.dataset.plate!, p = isLaunch ? null : plateNode(id);
    var title = isLaunch ? (f.elements.title!.value.trim() || f.elements.prompt!.value.trim().split(String.fromCharCode(10))[0]!) : p ? ($('.plate-t', p) || {} as Partial<HTMLElement>).textContent || '' : '';
    if (isLaunch) { store('yc.launchProject', f.elements.project!.value); launchDlg.close(); }
    // An answer names its picks, so a Retry says what it sends again: "Send your answer (Monday) again" (hill climb 2 r11, Opus).
    var what = kind === 'call' || kind === 'answer' ? 'your answer (' + pickNames(f) + ')' : (btn.dataset.what || kind);
    // A ticket with more than one question to answer stays at the pass until the last one is answered.
    var fromPass = !!(p && p.hasAttribute('data-at')) && !(kind === 'answer' && $$('form.act', p).length > 1);
    f.dataset.busy = '1'; lock(f, true); say(f, '', '');
    // A launch saved on the way out keeps the fields it was queued with, so its id never goes with other ones.
    if (f.classList.contains('launch')) f._sent = lsnap(f as LaunchForm);
    // Only the open ticket moves you on: a note the action bar sends to another thread leaves you where you are.
    if (fromPass) { acted[id] = Date.now(); actedLatest[id] = p!.dataset.latest || ''; hideActed(); if (mounted && mounted.id === id) advance(id); } else if (sheet.open && kind !== 'reply') { /* stays open until it lands */ }
    // The toast names the action, then the ticket (hill climb r2, Fable).
    // One sentence per action, naming the ticket: "Holding “X” until 8:00 tomorrow" (hill climb r3, Opus).
    var shortT = title ? '“' + title.slice(0, 60) + (title.length > 60 ? '…' : '') + '”' : 'this ticket';
    // Result toasts name the ticket too, since the next ticket is already open (hill climb 2 r3, Opus).
    f.dataset.named = title ? '“' + title.slice(0, 32) + (title.length > 32 ? '…' : '') + '”' : '';
    // The Undo toast names the pick without its "(Recommended)" tag, as the Retry does (r14, Opus).
    var pk = pickNames(f);
    var tpl = kind === 'launch' ? 'Launching {t}' : (btn.dataset.toast || 'Sending {t}');
    var verb = tpl.replace('{p}', pk ? ' (' + pk + ')' : '').replace('{t}', shortT);
    var entry = { label: verb, title: shortT, until: Date.now() + 4000, done: false } as PendingSend;
    var drop = function(){ var i = pendingSends.indexOf(entry); if (i >= 0) pendingSends.splice(i, 1); };
    entry.fire = function(leaving){
      if (entry.done) return; entry.done = true; clearTimeout(entry.timer); drop();
      // Every send saves its one-time id with the draft, so a resend after a reload is the same request to T3, never a
      // second message (hill climb 2 r3, Astra). A confirmed send clears the draft; a refused one drops the id.
      saveDraft(f, true, btn.value);
      if (!leaving && !showUndo()) toast('Sending ' + what + (f.dataset.named ? ' for ' + f.dataset.named : '') + '…', [], 0);
      fly(body, leaving).then(function(r){ landed(f, id, body, what, r[0], r[1]); }, function(){ landed(f, id, body, what, 0, 'Not confirmed: no answer from the Pass. Safe to repeat.'); });
    };
    entry.undo = function(){
      if (entry.done) return; entry.done = true; clearTimeout(entry.timer); drop();
      delete acted[id]; hideActed(); delete f.dataset.busy; lock(f, false);
      if (isLaunch) openLaunch(); else select(id);
      // Say it as what Dan did, not as a failure (Astra r5).
      if (!showUndo()) toast('Undone: ' + entry.title + '.', [], 2500);
    };
    entry.timer = setTimeout(function(){ entry.fire(false); }, 4000);
    pendingSends.push(entry);
    showUndo();
  }
  function landed(f: PageForm, id: string, body: string, what: string, status: number, text: string): void {
    // A ticket with two question forms has one record: only the form that holds it settles it (hill climb 2 r9, Opus).
    var mine = !!unconfirmed[id] && unconfirmed[id].form === f;
    if (status === 200) {
      delete f.dataset.busy;
      // A mark restored after a reload has no record in memory, so it goes unless another form holds the record.
      if (mine || !unconfirmed[id]) $$('.tile[data-plate="' + id + '"] .nc').forEach(function(m){ m.remove(); });
      if (mine) {
        settledUnconfirmed(id);
        // A confirmed Retry leaves the pass the way a first send does (hill climb 2 r5, Opus).
        var pn = plateNode(id), rk = new URLSearchParams(body).get('kind');
        if (pn && pn.hasAttribute('data-at') && !acted[id] && !(rk === 'answer' && $$('form.act', pn).length > 1)) {
          acted[id] = Date.now(); actedLatest[id] = pn.dataset.latest || ''; hideActed();
          if (mounted && mounted.id === id) advance(id);
        }
      }
      // The form is free again and holds no draft, so the next refresh can replace the ticket.
      lock(f, false); delete f.dataset.touched; setIntent(f, null); noting(f, false); clearDraft(f);
      if (f.elements.note && f.elements.note.tagName === 'TEXTAREA') { f.elements.note.value = ''; grow(f.elements.note); }
      if (id === 'launch') { f.elements.prompt!.value = ''; f.elements.title!.value = ''; delete f.dataset.lost; }
      if (f.elements.nonce) f.elements.nonce.value = uuid();
      delete f.dataset.sentSig; delete f.dataset.sentKind;
      if (!pendingSends.length) toast(named(f, text), [], 3500);
      say(f, text, 'ok');
      // A note that reached its thread makes that thread the action bar's "your last note went here" suggestion.
      if (id !== 'launch' && bar && (new URLSearchParams(body).get('note') || '').trim()) bar.noted(id);
      if (!acted[id] && sheet.open && mounted && mounted.id === id) { sheet.close(); }
      wake();
      return;
    }
    // 503 is the Pass refusing before it acts (the board is not checked), so it is a refusal too (hill climb 2 r7, Fable).
    if ((status >= 400 && status < 500) || status === 503) {
      delete acted[id]; hideActed();
      // A Retry the Pass refused with 503 still owns the form: it stays locked, so a changed note never sits beside a
      // Retry that would send the old one and then clear it (hill climb 2 r10, Opus and Astra).
      var hold = status === 503 && mine;
      if (!hold) { delete f.dataset.busy; lock(f, false); }
      // A refused repeat of a send that may have reached T3 says nothing about that first send, unless the Pass says
      // it landed. So it keeps its one-time id, and the same send again is the same request (hill climb 2 r9, Sol).
      var again = mine || !!f.dataset.sentSig, first = status === 409 && /^(Already answered|That retry changed the answer)/.test(text);
      if (again && !first) {
        if (!f.dataset.sentSig) { f.dataset.sentSig = sig(f); f.dataset.sentKind = kindOf(body); }
        // A 503 is the Pass not checking the board yet, so Retry stays. Any other refusal means the board moved and
        // a Retry cannot go, so its box goes and the card says to check.
        if (hold) { unconfirmed[id]!.refused = text; decorate(id); }
        else if (mine || !unconfirmed[id]) { if (mine) settledUnconfirmed(id); $$('.tile[data-plate="' + id + '"] .nc').forEach(function(m){ m.innerHTML = '<i></i>Not confirmed. Open it to check.'; }); }
        saveDraft(f);
        var more = text + ' The first send is still not confirmed: sending it unchanged is the same request.';
        // The Retry box says it once for a held form; the form's own line stays empty (hill climb 2 r10, Opus).
        say(f, hold && id !== 'launch' ? '' : more, hold && id !== 'launch' ? '' : 'bad');
        if (id === 'launch') { openLaunch(); say(f, more, 'bad'); }
        var keep = mine && unconfirmed[id]; toast(named(f, text), ((keep ? [['Retry', function(){ retry(id); }, 'ticket.suggested']] : []) as ToastAct[]).concat([['Open', function(){ if (id === 'launch') openLaunch(); else select(id); }]]), keep ? 0 : 8000, true, keep ? id : null);
        return;
      }
      // A refused Retry that the Pass says landed ends the not-confirmed state (a 409 "Already answered"), so its
      // Retry box and list mark go (hill climb 2 r8, Fable).
      if (mine || !unconfirmed[id]) { if (mine) settledUnconfirmed(id); $$('.tile[data-plate="' + id + '"] .nc').forEach(function(m){ m.remove(); }); }
      // Refused, so nothing reached T3: the next send is a new one, and the saved draft keeps no old id.
      freshNonce(f); saveDraft(f);
      say(f, text, 'bad');
      if (id === 'launch') { openLaunch(); say(f, text, 'bad'); }
      toast(named(f, text), [['Open', function(){ if (id === 'launch') openLaunch(); else select(id); }]], 8000, true);
      return;
    }
    // Not confirmed: T3 may have taken it. Retry repeats the same bytes, so T3 keeps one. The ticket comes back to
    // the list and carries its own Retry, so a later toast never strands the send (PR-Agent r1 on #27).
    delete acted[id]; hideActed();
    // Another form on the ticket that held the record keeps its own id: it is freed, says it is not confirmed, and
    // sent unchanged it is the same request (hill climb 2 r9, Opus).
    var prev = unconfirmed[id];
    if (prev && prev.form !== f) {
      var pf = prev.form; pf.classList.remove('held');
      if (!pf.dataset.sentSig) { pf.dataset.sentSig = sig(pf); pf.dataset.sentKind = kindOf(prev.body); }
      // A form whose Retry is still on its way stays locked until that Retry lands, so an edit made meanwhile is never
      // cleared by its answer (PR-Agent r3 on #38).
      if (!prev.flying) {
        delete pf.dataset.busy; lock(pf, false);
        // One full line per ticket: the box says it; the freed form says only what a resend is (hill climb 2 r11, Fable).
        saveDraft(pf); say(pf, 'Not confirmed. Sending it unchanged is the same request.', 'bad');
      }
    }
    unconfirmed[id] = { body: body, what: what, text: text, form: f };
    decorate(id);
    say(f, id === 'launch' ? text : '', id === 'launch' ? 'bad' : '');
    toast(named(f, text), [['Retry', function(){ retry(id); }, 'ticket.suggested'], ['Open', function(){ if (id === 'launch') openLaunch(); else select(id); }]], 0, true, id);
  }
  function settledUnconfirmed(id: string): void {
    if (unconfirmed[id] && unconfirmed[id]!.form) unconfirmed[id]!.form.classList.remove('held');
    delete unconfirmed[id]; var rb =document.querySelector('#' + CSS.escape(id) + ' .retry'); if (rb) rb.remove();
    if (id === 'launch') { var lb = $('#launch button[value=launch] .bl'); if (lb) lb.textContent = 'Launch'; }
    yieldKey();
  }
  function retry(id: string): void {
    var u = unconfirmed[id]; if (!u || u.flying) return; u.flying = true;
    toast('Sending ' + u.what + (u.form.dataset.named ? ' for ' + u.form.dataset.named : '') + ' again…', [], 0);
    fly(u.body).then(function(r){ u!.flying = false; landed(u!.form, id, u!.body, u!.what, r[0], r[1]); }, function(){ u!.flying = false; landed(u!.form, id, u!.body, u!.what, 0, 'Not confirmed: no answer from the Pass. Safe to repeat.'); });
  }
  function decorate(id: string): void {
    var p = plateNode(id), u = unconfirmed[id]; if (!p || !u) return;
    // New thread has its own button for it: Launch again, with ⌘↵, in the dialog (hill climb 2 r9, Opus and Fable).
    // Cancel stays live beside it, so the dialog closes by click as well as Esc (hill climb 2 r10, Opus and Fable).
    if (id === 'launch') { var lb = $<HTMLButtonElement>('button[value=launch]', p), cb = $<HTMLButtonElement>('[data-launch-cancel]', p); if (lb) { lb.disabled = false; lb.dataset.was = ''; $('.bl', lb)!.textContent = 'Launch again'; } if (cb) { cb.disabled = false; cb.dataset.was = ''; } return; }
    // The held form's own buttons cannot send while the box can, so they step aside: one blue action (hill climb 2 r10).
    if (u.form && u.form !== p) u.form.classList.add('held');
    var d = $('.dock', p) || p, box = $('.retry', p);
    if (!box) { box = document.createElement('div'); box.className = 'retry'; d.insertBefore(box, d.firstChild); }
    // The box takes the place of the buttons of the form it sends again, under that form's question or note, so you read
    // what it sends first, and it never sits by another form (hill climb 2 r11, Opus and Sol).
    var at = u.form && u.form !== p && p.contains(u.form) ? u.form : null;
    if (at && at.nextSibling !== box) at.parentNode!.insertBefore(box, at.nextSibling);
    box.textContent = '';
    var msg = document.createElement('p'); msg.className = 'result bad'; msg.textContent = u.refused ? u.refused + ' The first send is still not confirmed: send the same again, or check the thread in T3.' : u.text + ' Check the thread in T3, or send the same again.';
    var b = document.createElement('button'); b.type = 'button'; b.className = 'btn fill'; b.setAttribute('data-retry', ''); b.textContent = 'Send ' + u.what + ' again';
    var kb = document.createElement('kbd'); kb.dataset.cmd = 'ticket.suggested'; kb.textContent = SK(); b.appendChild(kb);
    box.appendChild(msg); box.appendChild(b); yieldKey();
    // Its list card says so too: a red dot, words in the label colour (hill climb 2 r3, Opus).
    $$('.tile[data-plate="' + id + '"]').forEach(function(t){
      if ($('.nc', t)) return;
      // Its own line at the card's foot, so the top row keeps the project's name whole.
      var m = document.createElement('span'); m.className = 'th nc'; m.innerHTML = '<i></i>Not confirmed. Open it to retry.';
      t.appendChild(m);
    });
  }
  function wake(): Promise<void> { var q = location.search; return fetch('/app' + q, { cache: 'no-store' }).then(function(r){ return r.ok ? r.text() : null; }).then(function(h){ if (h && q === location.search) { sync(h); Object.keys(unconfirmed).forEach(decorate); markSent(); } }, function(){}); }
  // Reload and a project switch refresh the board in place (council 3): the page never unloads, so a send waiting
  // out its Undo keeps its four seconds and a half-written note stays.
  window.__ycSoftReload = function(){ wake(); };
  // ----- The projects the board shows (Dan, 2026-11-10, view menu mock a) -----
  // A tick flips at once and the menu stays open. The chip follows at once, and the board when the menu closes (sync
  // waits while a menu is open). All projects ticks every box. The last ticked box stays ticked and shakes: no project
  // at all is not a view. The address repeats p, ?p=A&p=B; no p is All projects.
  function pickProject(pk: HTMLElement): void {
    var nav = pk.closest<HTMLElement>('.pmenu-l')!, boxes = $$('.pk[data-p]', nav), all = $('.pk.all', nav), names: string[] | null = null;
    function on(b: Element): boolean { return b.getAttribute('aria-checked') === 'true'; }
    if (pk === all) { if (on(all)) return; }
    else {
      // The last ticked box stays ticked and shakes once; the class goes when the shake ends, so reopening the menu
      // does not shake it again.
      if (on(pk) && boxes.filter(on).length === 1) {
        pk.classList.remove('no'); void pk.offsetWidth; pk.classList.add('no');
        pk.addEventListener('animationend', function(){ pk.classList.remove('no'); }, { once: true });
        return;
      }
      var ticked = boxes.filter(function(b){ return b === pk ? !on(b) : on(b); });
      names = ticked.map(function(b){ return b.dataset.p!; });
      // Every project on the board, and no pick that has no ticket now (data-gone), is All projects, as the server
      // reads it; unless T3 did not answer: then the list is not the whole of it.
      var gone = function(b: Element): boolean { return b.hasAttribute('data-gone'); };
      if (!nav.hasAttribute('data-nc') && !ticked.some(gone) && ticked.length === boxes.filter(function(b){ return !gone(b); }).length) names = null;
    }
    drawPicked(names);
    var q = names ? '?' + names.map(function(n){ return 'p=' + encodeURIComponent(n); }).join('&') : '';
    if (q === location.search) return;
    history.pushState(null, '', location.pathname + q); state.sel = null; wake();
  }
  // A project clicked in You's chart: that project alone, as if picked in the menu.
  function pickOnly(name: string): void {
    if (!name) return;
    drawPicked([name]);
    var q = '?p=' + encodeURIComponent(name);
    if (q === location.search) return;
    history.pushState(null, '', location.pathname + q); state.sel = null; wake();
  }
  // Every copy of the menu (the rail's, and the expanded view's header) shows the same picks. names: null is All projects.
  function drawPicked(names: string[] | null): void {
    drawn = {};
    $$('details.vmenu').forEach(function(d){
      var boxes = $$('.pk[data-p]', d), all = $('.pk.all', d), sel: HTMLElement[] = [];
      // All projects is every project on the board: a pick with no ticket now (data-gone) is not one of them.
      boxes.forEach(function(b){ var y = names ? names.indexOf(b.dataset.p!) >= 0 : !b.hasAttribute('data-gone'); b.setAttribute('aria-checked', String(y)); if (y) sel.push(b); });
      if (all) all.setAttribute('aria-checked', names ? 'mixed' : 'true');
      var cur = $('summary .vp, summary .fan', d), nw = document.createElement('span');
      if (!names) { nw.className = 'vp'; nw.textContent = 'All projects'; }
      else {
        var list = sel.map(function(b){ return b.dataset.p; }).join(', '), vh = document.createElement('span');
        nw.className = 'fan'; nw.style.setProperty('--n', sel.length as unknown as string); nw.title = list;
        sel.forEach(function(b, i){
          var c = document.createElement('span'), m = $('.pm', b); c.className = 'card'; c.style.setProperty('--i', i as unknown as string);
          if (m) { m = m.cloneNode(true) as HTMLElement; m.removeAttribute('title'); c.appendChild(m); }
          nw.appendChild(c);
        });
        vh.className = 'vh'; vh.textContent = list; nw.appendChild(vh);
      }
      if (cur) cur.replaceWith(nw);
    });
  }
  // The picks in the address, as pickedFrom reads them (client/board.ts): repeats and empty names drop out; null is
  // All projects. An array, not an object: a project may be called "__proto__".
  function pickedNow(): string[] | null {
    var out: string[] = [];
    new URLSearchParams(location.search).getAll('p').forEach(function(n){ if (n && out.indexOf(n) < 0) out.push(n); });
    return out.length ? out : null;
  }
  // Picks that cover every project on the board are All projects: the address drops them, so a project that turns up
  // later shows too, and All projects stays a way out of a filter (PR-Agent r2 on #10).
  function normalizePicked(){
    var a = $('.vmenu .pk.all'); if (!a || a.getAttribute('aria-checked') !== 'true') return;
    var u = new URLSearchParams(location.search); if (!u.has('p')) return;
    u.delete('p'); var q = u.toString();
    history.replaceState(history.state, '', location.pathname + (q ? '?' + q : ''));
  }
  // Back and Forward: the boxes and the chip follow the address at once, even while the board waits for the menu to
  // close, so the next tick starts from the right picks (PR-Agent r2 on #10). A pick the menu has no box for closes
  // the menu instead, and the refresh draws it.
  window.addEventListener('popstate', function(){
    var names = pickedNow(), have = $$('.vmenu .pk[data-p]').map(function(b){ return b.dataset.p; });
    if (!names || names.every(function(n){ return have.indexOf(n) >= 0; })) drawPicked(names);
    else { var om = $<HTMLDetailsElement>('details.vmenu[open]'); if (om) om.open = false; }
    state.sel = null; wake();
  });
  document.addEventListener('submit', function(ev){
    var f = ev.target as PageForm; if (!f.matches || !f.matches('form.act')) return;
    ev.preventDefault();
    var b = ev.submitter && (ev.submitter as HTMLButtonElement).name === 'kind' ? ev.submitter as HTMLButtonElement : $<HTMLButtonElement>('button.primary', f);
    if (b) send(f, b);
  });
  // A half-written note or a pick is saved on this Mac per ticket, so a reload or a restart keeps it (council 3).
  // (No backslashes in this script: it sits in a template string.)
  var CUSTOM = '~custom~';
  // A draft is keyed by what its form answers: a T3 question form by its request, any other form by its place among
  // the forms that are not questions. So an answered question going away never moves another form's draft onto the
  // wrong form or loses it (hill climb 2 r10, Sol).
  function draftKey(f: PageForm): string | null {
    var p = f.dataset.plate && plateNode(f.dataset.plate); if (!p) return null;
    var rq = f.elements.request && f.elements.request.value;
    if (rq) return 'yc.draft.' + p.id + '.q.' + rq;
    return 'yc.draft.' + p.id + '.f.' + $$<PageForm>('form.act', p).filter(function(x){ return !(x.elements.request && x.elements.request.value); }).indexOf(f);
  }
  // A draft saved before by the form's place on the ticket.
  function oldDraftKey(f: PageForm): string | null { var p = f.dataset.plate && plateNode(f.dataset.plate); return p ? 'yc.draft.' + p.id + '.' + $$<PageForm>('form.act', p).indexOf(f) : null; }
  function forget(k: string): void { try { window.localStorage.removeItem(k); } catch (x) {} }
  // What the form holds now: the note and the picks.
  function snap(f: PageForm): Draft {
    var d: Draft = { note: '', picks: {}, custom: {}, intent: f.dataset.intent || '' };
    if (f.elements.note && f.elements.note.tagName === 'TEXTAREA') d.note = f.elements.note.value;
    $$<HTMLInputElement>('fieldset.q-set:not([disabled]) input[type=radio]:checked', f).forEach(function(r){
      var own = r.hasAttribute('data-custom'); d.picks[r.name] = own ? CUSTOM : r.value; if (own) d.custom[r.name] = $<HTMLInputElement>('.custom', r.parentNode)!.value;
    });
    return d;
  }
  // The signature is what the send carries. The armed Reply or Request changes is not in it: the kind is checked on its own
  // at send, so Esc and re-arming keep the send id (hill climb 2 r7, Astra).
  function sig(f: PageForm): string { if (f.classList.contains('launch')) return JSON.stringify(lsnap(f as LaunchForm)); var d = snap(f); delete d.intent; return JSON.stringify(d); }
  // A draft saved before that change carries a signature with the intent in it.
  function sameSig(f: PageForm, s: string | undefined, kind: string | undefined): boolean { return !!s && (s === sig(f) || s === JSON.stringify(snap(f)) || carried(sig(f), kind) === carried(s, kind)); }
  // What a send carries: an answer carries its picks and note, a launch its fields, and Reply, Request changes, Merge, Hold and
  // Settle only the note. So a pick made after a Reply, or one a refused answer made, keeps that Reply's one-time id
  // (hill climb 2 r9, Astra).
  var NOTE_ONLY = ['reply', 'refire', 'go', 'hold', 'settle'];
  function carried(s: string | undefined, kind: string | undefined): string | undefined { if (NOTE_ONLY.indexOf(String(kind || '').split(':')[0]!) < 0) return s; try { return JSON.stringify({ note: JSON.parse(s!).note || '' }); } catch (e) { return s; } }
  function sameSent(f: PageForm): boolean { return carried(sig(f), f.dataset.sentKind) === carried(f.dataset.sentSig, f.dataset.sentKind); }
  // Merge and Approve are one form value, "go", told apart by "pr" (open or none), and they are different sends. A
  // restored Approve pressed again once the button says Merge is a new send with a new id, as any change of kind is:
  // the same id could make T3 drop the Merge as a repeat (PR-Agent r2 on #69). A record from before says only "go"
  // and matches either, as it did.
  function sendKind(f: PageForm, kind: string): string { return kind === 'go' && f.elements.pr ? 'go:' + f.elements.pr.value : kind; }
  function kindOf(body: string): string { var p = new URLSearchParams(body), k = p.get('kind') || ''; return k === 'go' && p.get('pr') ? 'go:' + p.get('pr') : k; }
  function sameKind(a: string | undefined, b: string | undefined): boolean { a = String(a || ''); b = String(b || ''); return a === b || (a === 'go' && b.indexOf('go:') === 0) || (b === 'go' && a.indexOf('go:') === 0); }
  // A send that may have reached T3, known from its saved id, marks its list cards. A refresh redraws the lists, so
  // every refresh marks them again (hill climb 2 r9, Opus and Astra). One held in memory has its own mark.
  function markSent(only?: PageForm): void {
    (only ? [only] : $$<PageForm>('form.act')).forEach(function(f){
      var pid = f.dataset.plate; if (!f.dataset.sentSig || !pid || unconfirmed[pid]) return;
      $$('.tile[data-plate="' + pid + '"]').forEach(function(t){ if ($('.nc', t)) return; var m = document.createElement('span'); m.className = 'th nc'; m.innerHTML = '<i></i>Not confirmed. Open it to check.'; t.appendChild(m); });
    });
  }
  function freshNonce(f: PageForm): void {
    if (f.elements.nonce) f.elements.nonce.value = (window.crypto && crypto.randomUUID) ? crypto.randomUUID() : Date.now() + '-' + Math.random().toString(36).slice(2);
    delete f.dataset.sentSig; delete f.dataset.sentKind;
    // A changed restored send is a new one, so the card's restored mark goes (one in memory stays until it settles).
    var pid = f.dataset.plate; if (pid && !unconfirmed[pid]) $$('.tile[data-plate="' + pid + '"] .nc').forEach(function(m){ m.remove(); });
  }
  // A send fired as the page closed is saved with its one-time id and kind. Sent again unchanged from the restored
  // draft, it is the same send to the server and T3, never a second one (PR-Agent r1 on #38). Once its note, picks
  // or kind change, it is a new send with a new id (PR-Agent r2 on #38).
  // The new-thread form keeps its draft, and after a send its one-time id, across a reload (hill climb 2 r5, Sol).
  var LKEY = 'yc.launchDraft';
  // A draft keeps the project it was written for until you pick another, so a reload never fills in a different one.
  function lsnap(f: LaunchForm): LaunchSnap { var w = $<HTMLInputElement>('input[name=workspace]:checked', f); return { prompt: f.elements.prompt.value, title: f.elements.title.value, project: f.elements.project.value || f.dataset.lost || '', workspace: w ? w.value : '' }; }
  function saveLaunch(f: LaunchForm, leaving?: boolean): void {
    var q = leaving && f._sent, d: LaunchSnap = q ? JSON.parse(JSON.stringify(q)) : lsnap(f), s = q ? JSON.stringify(q) : sig(f);
    if (!leaving && f.dataset.sentSig && s !== f.dataset.sentSig) freshNonce(f);
    if (leaving) { d.nonce = f.elements.nonce.value; d.sig = s; f.dataset.sentSig = s; f.dataset.sentKind = 'launch'; }
    else if (f.dataset.sentSig) { d.nonce = f.elements.nonce.value; d.sig = f.dataset.sentSig; }
    d.at = Date.now();
    if (!d.prompt.trim() && !d.title.trim() && !d.nonce) { forget(LKEY); return; }
    store(LKEY, JSON.stringify(d));
  }
  function restoreLaunch(f: LaunchForm): void {
    if (f.elements.prompt.value || f.elements.title.value) return;
    var d: (LaunchSnap & { at: number }) | null = null; try { d = JSON.parse(store(LKEY) || 'null'); } catch (x) { d = null; }
    if (!d) return;
    if (Date.now() - d.at > 30 * 864e5) { forget(LKEY); return; }
    f.elements.prompt.value = d.prompt || ''; f.elements.title.value = d.title || '';
    if (d.project && $$<HTMLOptionElement>('option', f.elements.project).some(function(o){ return o.value === d!.project; })) { f.elements.project.value = d.project; delete f.dataset.lost; }
    else if (d.project) { f.elements.project.selectedIndex = -1; f.dataset.lost = d.project; }
    var w = d.workspace && $<HTMLInputElement>('input[name=workspace][value="' + d.workspace + '"]', f); if (w) w.checked = true;
    if (d.nonce && sig(f) === d.sig) { f.elements.nonce.value = d.nonce; f.dataset.sentSig = d.sig; f.dataset.sentKind = 'launch'; }
  }
  function saveDraft(f: PageForm, leaving?: boolean, kind?: string): void {
    if (f.classList.contains('launch')) { if (!f.dataset.busy || leaving) saveLaunch(f as LaunchForm, leaving); return; }
    var k = draftKey(f); if (!k || (f.dataset.busy && !leaving)) return;
    if (!leaving && f.dataset.sentSig && !sameSent(f)) freshNonce(f);
    var d = snap(f);
    d.latest = plateNode(f.dataset.plate)!.dataset.latest || ''; d.at = Date.now();
    if (leaving) { d.nonce = f.elements.nonce ? f.elements.nonce.value : ''; d.kind = kind ? sendKind(f, kind) : ''; d.sig = sig(f); }
    else if (f.dataset.sentSig) { d.nonce = f.elements.nonce!.value; d.kind = f.dataset.sentKind || ''; d.sig = f.dataset.sentSig; }
    // An unchanged note sent before the agent's latest message keeps saying so after another reload.
    if (stale(f)) d.sentBefore = true;
    // An unchanged note written before the agent's latest message keeps saying so after another reload (PR-Agent r4 on #38).
    else if (f.dataset.before !== undefined && f.dataset.before === d.note) d.wroteBefore = true;
    // A send with no note still keeps its record, so a resend after a reload is the same request (hill climb 2 r4, Astra).
    // An armed Reply or Request changes with no note yet stays armed after a reload (PR-Agent r3 on #38).
    if (!d.note.trim() && !Object.keys(d.picks).length && !d.intent && !(d.nonce && d.sig)) { forget(k); return; }
    store(k, JSON.stringify(d));
  }
  function clearDraft(f: PageForm): void { if (f.classList.contains('launch')) { forget(LKEY); return; } var k = draftKey(f); if (k) forget(k); }
  function restoreDrafts(scope: ParentNode | null): void {
    $$<PageForm>('form.act[data-plate]', scope).forEach(function(f){
      if (f.dataset.restored || f.dataset.busy) return; f.dataset.restored = '1';
      var k = draftKey(f), raw = k && store(k), d: SavedDraft | null = null;
      if (k && !raw) { var ok = oldDraftKey(f), old = ok && store(ok); if (old) { raw = old; store(k, old); forget(ok!); } }
      try { d = raw && JSON.parse(raw); } catch (x) { d = null; }
      if (!d) return;
      // A note survives a new message from the agent. Its picks, armed action and send id belonged to the earlier
      // message, so they go: an old id on a new send could make T3 drop it as a repeat, and an old pick could answer a
      // new question (hill climb 2 r7, Opus and Sol). If that note was already sent, the ticket says it may have
      // reached the agent (hill climb 2 r6, Opus). A draft untouched for 30 days is dropped.
      if (Date.now() - d.at > 30 * 864e5) { forget(k!); return; }
      var now = plateNode(f.dataset.plate)!.dataset.latest || '', earlier = now !== d.latest, went = !!(d.nonce && d.sig);
      if (earlier) {
        if (!d.note || !d.note.trim()) { forget(k!); return; }
        d = { note: d.note, picks: {}, custom: {}, intent: '', latest: now, at: d.at, sentBefore: went || !!d.sentBefore, wroteBefore: !(went || d.sentBefore) };
        store(k!, JSON.stringify(d));
      }
      if (d.note && f.elements.note && f.elements.note.tagName === 'TEXTAREA') { f.elements.note.value = d.note; f.classList.add('noting'); grow(f.elements.note); }
      Object.keys(d.picks || {}).forEach(function(name){
        var v = d!.picks[name], r = $$<HTMLInputElement>('fieldset.q-set:not([disabled]) input[type=radio]', f).filter(function(x){ return x.name === name && (v === CUSTOM ? x.hasAttribute('data-custom') : x.value === v); })[0];
        if (r) { r.checked = true; if (v === CUSTOM) $<HTMLInputElement>('.custom', r.parentNode)!.value = (d!.custom || {})[name] || ''; }
      });
      if (d.intent && $('button[value="' + d.intent + '"]', f)) { f._restoring = true; setIntent(f, d.intent); f._restoring = false; }
      if (d.nonce && f.elements.nonce && sameSig(f, d.sig, d.kind)) { f.elements.nonce.value = d.nonce; f.dataset.sentSig = sig(f); f.dataset.sentKind = d.kind || ''; }
      f.dataset.touched = '1'; primaryLabel(f); noteKey(f);
      if (qSets(f).length > 1) qShow(f, qAt(f));
      // The not-confirmed state is in memory only, so after a reload the draft says it (hill climb 2 r6, Fable).
      // One colour for "Not confirmed", in session and after a reload (hill climb 2 r7, Opus).
      // Its list card keeps the mark too, as it does before the reload (hill climb 2 r8, Opus).
      markSent(f);
      if (d.sentBefore && !f.dataset.sentSig) f.dataset.stale = d.note || ''; else delete f.dataset.stale;
      noteKey(f);
      if (f.dataset.sentSig) say(f, 'Not confirmed: this may already have reached the agent. Check the thread in T3; sending it unchanged is the same request.', 'bad');
      else if (d.sentBefore) say(f, 'You sent this note before the agent’s latest message, so it may have reached the agent. Check the thread in T3 before you send it again.', 'bad');
      else if (earlier || d.wroteBefore) say(f, 'You wrote this note before the agent’s latest message. Check it still fits.', '');
      if (!d.sentBefore && (earlier || d.wroteBefore)) f.dataset.before = d.note || ''; else delete f.dataset.before;
    });
  }
  // Notes grow with what you write instead of showing a resize grip (council 3).
  function grow(t: HTMLElement | null | undefined): void { if (!t || t.tagName !== 'TEXTAREA') return; t.style.height = 'auto'; t.style.height = Math.min(t.scrollHeight + 2, 260) + 'px'; }
  document.addEventListener('input', function(ev){ var f = (ev.target as HTMLInputElement).closest && (ev.target as HTMLInputElement).closest<PageForm>('form.act'); if ((ev.target as HTMLInputElement).tagName === 'TEXTAREA') grow((ev.target as HTMLInputElement)); if (f) { f.dataset.touched = '1'; if ((ev.target as HTMLInputElement).matches && (ev.target as HTMLInputElement).matches('.custom')) primaryLabel(f); saveDraft(f); if ((ev.target as HTMLInputElement).name === 'note') noteKey(f); } });
  document.addEventListener('change', function(ev){
    var f = (ev.target as HTMLInputElement).closest && (ev.target as HTMLInputElement).closest<PageForm>('form.act'); if (!f) return;
    if ((ev.target as HTMLInputElement).name === 'project') delete f.dataset.lost;
    f.dataset.touched = '1'; say(f, '', ''); saveDraft(f);
    var fs = (ev.target as HTMLInputElement).closest<HTMLFieldSetElement>('fieldset.q-set'), pl = f.closest<Plate>('.plate'); if (fs && pl) pl._lastSet = fs;
    // A pick on a card brings the next unanswered one forward, a beat later so you see your pick land.
    // Your own answer stays in front: you still have to write it (PR-Agent r1 on #50).
    if (fs && (ev.target as HTMLInputElement).type === 'radio' && qSets(f).length > 1) { qShow(f, qSets(f).indexOf(fs)); if (!(ev.target as HTMLInputElement).hasAttribute('data-custom')) setTimeout(function(){ if (fs!.classList.contains('q-on')) qNext(f!); }, 180); }
    // The blue button names the answer you picked, on an agent's call and on a T3 question alike (Astra).
    if ($('button.primary[value=call], button.primary[value=answer]', f)) primaryLabel(f);
    yieldKey();
  });

  // ----- Screenshots in the app's own viewer -----
  var shotsList: HTMLAnchorElement[] = [], shotAt = 0;
  function showShot(i: number): void {
    shotAt = (i + shotsList.length) % shotsList.length; var a = shotsList[shotAt]!;
    var img = $<HTMLImageElement>('img', viewer)!; img.src = a.getAttribute('href')!; img.alt = ($<HTMLImageElement>('img', a) || {} as Partial<HTMLImageElement>).alt || '';
    $('.v-cap', viewer)!.textContent = (($('.att-cap', a) || {} as Partial<HTMLElement>).textContent || '') +(shotsList.length > 1 ? '  ·  ' + (shotAt + 1) + ' of ' + shotsList.length : '');
    $$('[data-v=prev], [data-v=next], .v-arrows', viewer).forEach(function(b){ b.hidden = shotsList.length < 2; });
  }
  viewer.addEventListener('click', function(ev){
    var v = (ev.target as Element).closest<HTMLElement>('[data-v]');
    if (v) { if (v.dataset.v === 'close') viewer.close(); else showShot(shotAt + (v.dataset.v === 'next' ? 1 : -1)); return; }
    if (ev.target === viewer || (ev.target as Element).tagName === 'IMG') viewer.close();
  });

  // ----- Clicks and keys -----
  document.addEventListener('click', function(ev){
    var t = ev.target as Element;
    var m = $<HTMLDetailsElement>('details.pmenu[open]'); if (m && !m.contains(t)) m.open = false;
    if (t.closest('[data-view-toggle]')) { toggleView(); return; }
    // The view menu: a project's check box, All projects, and the You | Team toggle all keep the menu open.
    var pk = t.closest<HTMLElement>('.vmenu .pk');
    if (pk) { pickProject(pk); return; }
    var sc = t.closest<HTMLElement>('.vmenu .seg [data-scope]');
    if (sc) { setScope(sc.dataset.scope!); return; }
    // The chart: a project opens its threads, ‹ All projects goes back. A thread's band carries data-plate, so a click
    // on it opens the ticket below, as its card does.
    var dr = t.closest<Element>('.you [data-drill]');
    if (dr) { var tp = $('.you .fx-tip'); if (tp) tp.hidden = true; pickOnly(dr.getAttribute('data-drill') || ''); return; }
    var nf = t.closest<HTMLElement>('.nf[data-folder]');
    // In You, expanded, a stage row opens that stage's list in the pass view, with no ticket open.
    if (nf && !focusView()) { state.passFolder = nf.dataset.folder!; state.passSel = null; toggleView(); return; }
    if (nf) { setFolder(nf.dataset.folder!); if (focusView()) { state.sel = null; place(); } return; }
    var shot = t.closest<HTMLAnchorElement>('a[data-shot]');
    if (shot) { ev.preventDefault(); var box = shot.closest('.plate') || document; shotsList = $$<HTMLAnchorElement>('a[data-shot]', box); showShot(shotsList.indexOf(shot)); if (!viewer.open) viewer.showModal(); yieldKey(); return; }
    var to = t.closest<HTMLElement>('[data-team-open]');
    if (to) { var ta = t.closest<HTMLElement>('[data-team-act]'); openTeamCall(to.dataset.teamOpen, ta ? ta.dataset.teamAct : null); return; }
    var tl = t.closest<HTMLElement>('[data-plate]:not(form)');
    if (tl && !t.closest('.plate')) { state.listKey = listKeyOf(tl); select(tl.dataset.plate); return; }
    var rt = t.closest('[data-retry]'); if (rt) { var pl = rt.closest('.plate'); if (pl) retry(pl.id); return; }
    if (t.closest('[data-settings]')) { openSettings(); return; }
    var an = t.closest('[data-addnote]'); if (an) { shut(an); noting(an.closest<PageForm>('form.act'), true); return; }
    // More's rows: Open in T3 follows the ticket's link, as O does. In a narrow bar, Hold and Settle press the bar's own
    // buttons, so every check in send() still runs.
    var ot = t.closest('[data-open-t3]'); if (ot) { shut(ot); var op = ot.closest('.plate'), ol = op && $('.plate-bar a[href]', op); if (ol) ol.click(); return; }
    var pr = t.closest<HTMLElement>('[data-press]'); if (pr) { shut(pr); var pf = pr.closest<PageForm>('form.act'), pb = pf && $<HTMLButtonElement>('button[name=kind][value="' + pr.dataset.press + '"]', pf); if (pb && !pb.disabled) send(pf!, pb); return; }
    if (t.closest('[data-close]')) { sheet.close(); return; }
    if (t === sheet) sheet.close();
  });
  sheet.addEventListener('close', function(){ var id = state.sel; if (!focusView()) { unmount(); state.sel = null; mark(); } var back = id && $('[data-plate="' + id + '"]:not(form)'); if (back) back.focus({ preventScroll: true }); });
  // The page's keys, as each command's default key reads (client/keys.ts). The router below sends every key here.
  function onKey(ev: PageKey): void {
    // Esc closes the menu and puts focus back on its chip, so the keys go on from there.
    var m = $<HTMLDetailsElement>('details.pmenu[open]'); if (m && ev.key === 'Escape') { var back = m.contains(document.activeElement) && $('summary', m); m.open = false; if (back) back.focus(); return; }
    // More, while open: Esc or . closes it, the arrows move between its rows, and Enter or Space presses the row in
    // focus. Any other key closes it, then does what it always does (N adds a note, O opens T3, Cmd+Enter sends).
    var om = openMenu();
    if (om) {
      if (ev.key === 'Escape' || ev.key === '.') { ev.preventDefault(); shut(om); return; }
      if (ev.key === 'ArrowDown' || ev.key === 'ArrowUp') { ev.preventDefault(); menuStep(om, ev.key === 'ArrowDown' ? 1 : -1); return; }
      if (/^(Shift|Meta|Control|Alt|Tab)$/.test(ev.key) || ((ev.key === 'Enter' || ev.key === ' ') && om.contains(document.activeElement) && !(ev.metaKey || ev.ctrlKey))) return;
      shut(om);
    }
    if (viewer.open) { if (ev.key === 'ArrowRight') showShot(shotAt + 1); else if (ev.key === 'ArrowLeft') showShot(shotAt - 1); return; }
    // Dan, 2026-11-10: Cmd+K opens and closes the action bar; Cmd+T and Cmd+N open New thread; Cmd+, opens Settings.
    // Each closes whichever of the three is open first, so only one is ever up.
    var cmd = (ev.metaKey || ev.ctrlKey) && !ev.shiftKey && !ev.altKey, ck = ev.key.length === 1 ? ev.key.toLowerCase() : ev.key;
    if (cmd && ck === ',') { ev.preventDefault(); if (bar) bar.close(); if (launchDlg.open) launchDlg.close(); openSettings('layout'); return; }
    if (cmd && ck === 'k' && bar) { ev.preventDefault(); if (ev.repeat) return; if (setDlg.open) setDlg.close(); if (launchDlg.open) launchDlg.close(); bar.toggle(); return; }
    if (cmd && (ck === 't' || ck === 'n')) { ev.preventDefault(); if (bar) bar.close(); if (setDlg.open) setDlg.close(); openLaunch(); return; }
    // Option-Shift-Cmd-A: the next Appearance, as T3 Code's appearance.cycle. Option changes ev.key, so read the code.
    if ((ev.metaKey || ev.ctrlKey) && ev.altKey && ev.shiftKey && ev.code === 'KeyA') { ev.preventDefault(); if (!ev.repeat) cycleTheme(); return; }
    if (bar && bar.isOpen()) return;
    if (setDlg.open) return;
    // The launch dialog: Cmd+Enter launches; every other key is typing.
    if (launchDlg.open) {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && !ev.repeat) { ev.preventDefault(); var lf = $<LaunchForm>('form.launch', launchDlg)!; send(lf, $<HTMLButtonElement>('button.primary', lf)!); }
      return;
    }
    var typing = (ev.target as Element).closest && (ev.target as Element).closest<HTMLInputElement | HTMLTextAreaElement>('textarea, input[type=text]');
    // The form you are in, else the one you last picked in, else the open ticket's first free one (keyForm).
    var here = (ev.target as Element).closest && (ev.target as Element).closest<PageForm>('form.act');
    var form = keyForm(here);
    // Cmd+Enter: the armed action (Reply, Request changes), else the blue one (Merge, Approve, the recommended answer, or
    // Settle once merged), else, with a note written, Reply. Merge and Approve take it since the action bar (Dan,
    // 2026-11-10: the approved mock's tooltip reads "M or ⌘↵"), with Undo as for every send. This replaces council 1b.
    // A send that was not confirmed: Cmd+Enter repeats it, as its Retry button says (council 3). While the toast
    // offers Retry with ⌘↵, the key is the toast's, unless you are writing a note.
    var toastOpen = false; try { toastOpen = toastEl.matches(':popover-open'); } catch (x) {}
    // The open ticket's own Retry box owns the key over any toast, and the toast then shows no ⌘↵ (hill climb 2 r11, Opus).
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && ownRetry() && !(here && !here.dataset.busy)) { ev.preventDefault(); if (!ev.repeat) retry(mounted!.id); return; }
    // The toast never takes the key while the open ticket holds its own Retry, wherever focus is: its hint is hidden then (r12, Astra).
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && toastKey && toastOpen && !typing && !ownRetry()) { ev.preventDefault(); if (!ev.repeat) toastKey(); return; }
    // Cmd+R in a browser refreshes in place too (the desktop app's menu does the same).
    if ((ev.metaKey || ev.ctrlKey) && !ev.shiftKey && (ev.key === 'r' || ev.key === 'R')) { ev.preventDefault(); wake(); return; }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter' && form) {
      ev.preventDefault();
      if (ev.repeat) return;
      var want = form.dataset.intent, b = want ? $<HTMLButtonElement>('button[value="' + want + '"]', form) : $<HTMLButtonElement>('button.primary', form);
      if (!b && form.elements.note && form.elements.note.value && form.elements.note.value.trim() && !stale(form)) b = $<HTMLButtonElement>('button[value=reply]', form);
      if (!b && stale(form)) { say(form, 'You sent this note before the agent’s latest message, so it may have reached the agent. Send it again with Reply' + (keyLabel('ticket.reply') ? ' (' + keyLabel('ticket.reply') + ')' : '') + ', change it, or clear it.', 'bad'); return; }
      var gkb = $('button[value="go"] kbd', form);
      if (b && !b.disabled) send(form, b); else say(form, 'Nothing is recommended here. Pick an action: ' + [gkb && gkb.dataset.cmd === 'ticket.approve' ? ['ticket.approve', 'Approve'] : ['ticket.merge', 'Merge'], ['ticket.requestChanges', 'Request changes'], ['ticket.reply', 'Reply'], ['ticket.hold', 'Hold'], ['ticket.settle', 'Settle']].map(function(a){ var l = keyLabel(a[0]!); return l ? l + ' ' + a[1] : a[1]; }).join(', ') + '.', '');
      return;
    }
    if (typing) {
      // Esc leaves the note only; it must not also close the ticket's sheet (Sol).
      if (ev.key === 'Escape') { ev.preventDefault(); var tf = typing.form as PageForm | null; setIntent(tf, null); typing.blur(); if (tf && typing.tagName === 'TEXTAREA' && !typing.value.trim()) noting(tf, false); yieldKey(); }
      return;
    }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    // Arrow keys on a focused option, button or menu belong to that control.
    var control = (ev.target as Element).closest && (ev.target as Element).closest('input, select, button, summary, [contenteditable]');
    if ((ev.key === 'ArrowDown' || ev.key === 'ArrowUp') && control) return;
    // Gmail's keys where they exist: J/K move, Z undoes, ? lists every key; E is done (Settle), H holds, R replies.
    // Caps Lock does not matter; holding a key moves through the list but never repeats a send.
    var k = ev.key.length === 1 && !ev.shiftKey ? ev.key.toLowerCase() : ev.key;
    // Space and Shift+Space page through the open message, from the list or the message (hill climb 2 r2, Opus), and in the kitchen's sheet (r11, Sol).
    if (k === ' ' && mounted && (focusView() || sheet.open) && (!control || ((ev.target as Element).closest && (ev.target as Element).closest('[data-plate].tile')))) {
      var ps = $('.plate-scroll', mounted);
      if (ps) { ev.preventDefault(); ps.scrollBy({ top: (ev.shiftKey ? -1 : 1) * Math.max(40, ps.clientHeight - 60) }); return; }
    }
    if (k === 'ArrowDown' || k === 'j') { ev.preventDefault(); step(1); return; }
    if (k === 'ArrowUp' || k === 'k') { ev.preventDefault(); step(-1); return; }
    if (ev.repeat) return;
    if (k === '?') { ev.preventDefault(); openSettings('keys'); return; }
    if (k === 'z') { var last = pendingSends[pendingSends.length - 1]; if (last) last.undo(); return; }
    if (k === 'v') { toggleView(); return; }
    if (k === 'Escape') { if (sheet.open) sheet.close(); return; }
    if (k === 'o' && mounted) { var link = $('.plate-bar a[href]', mounted); if (link) link.click(); return; }
    if (!form) return;
    // . opens More, as in Gmail, with its first row in focus.
    if (k === '.') { var mn = $('.abar .menu', form), mb = $('.abar [data-more]', form); if (mn && mb && mb.getClientRects().length) { ev.preventDefault(); try { mn.showPopover(); } catch (x) {} menuStep(mn, 1); } return; }
    // Left and right move between question cards; on a focused option they stay the browser's.
    if ((k === 'ArrowLeft' || k === 'ArrowRight') && !control && qSets(form).length > 1) { ev.preventDefault(); qShow(form, qAt(form) + (k === 'ArrowRight' ? 1 : -1)); return; }
    // While a question waits, its option letters come first (an option "e" beats Settle).
    // A key that stands in for a changed one (ev.synthetic) is never an option's letter.
    if (/^[a-i]$/.test(k) && mounted && !ev.synthetic) {
      var ls = letterAt(ev.target as Element | null, k);
      if (ls && ls.held) { say(ls.held.closest('form.act'), 'This answer is waiting on its Retry, so a letter does not change it.', ''); return; }
      if (ls) { ls.radio!.checked = true; ls.radio!.dispatchEvent(new Event('change', { bubbles: true })); return; }
    }
    // A key with no button here says why instead of doing nothing (Opus).
    // A T3 question has no Reply: point to answering it, or opening it in T3 Code (Astra).
    var kR = keyLabel('ticket.reply'), kO = keyLabel('ticket.open'), toT3 = (kO ? kO + ' to open' : 'open') + ' it in T3 Code.';
    var orR = $('button[value=reply]', form) ? ', or ' + (kR ? kR + ' to reply.' : 'reply.') : ', or ' + toT3;
    var NO: Record<string, string> = { go: 'No Merge here: answer the question' + orR, approve: 'No Approve here: answer the question' + orR, refire: 'No Request changes on a question: pick an option' + orR, reply: 'No Reply here: answer the question, or ' + toT3, settle: 'Settle comes back once the question is answered.', hold: 'Hold comes back once the question is answered.' };
    var press = function(kind: string): void { var b = $<HTMLButtonElement>('button[value="' + kind + '"]', form); if (b && !b.disabled) send(form!, b); else if (NO[kind]) say(form, NO[kind]!, ''); };
    if (k === 'e') { press('settle'); return; }
    if (k === 'h') { press('hold'); return; }
    // M merges and A approves (Dan, 2026-11-10): one button, named by whether a pull request is open, and each key
    // presses it only under its own name. G, the old Go, still presses it, whichever it says (old habits).
    if (k === 'm' || k === 'a' || k === 'g') {
      // The button's key names its command (data-cmd), whatever key Settings → Shortcuts gave it.
      var gb = $('button[value="go"]', form), gk = gb && $('kbd', gb) ? ({ 'ticket.merge': 'M', 'ticket.approve': 'A' } as Record<string, string>)[$('kbd', gb)!.dataset.cmd!] || '' : '';
      if (k === 'g' || !gb || gk === k.toUpperCase()) { press(gb || k !== 'a' ? 'go' : 'approve'); return; }
      var kA = keyLabel('ticket.approve'), kM = keyLabel('ticket.merge');
      say(form, k === 'm' ? 'No Merge here: no pull request is open. ' + (kA ? kA + ' approves.' : 'Approve goes ahead.') : 'No Approve here: a pull request is open. ' + (kM ? kM + ' merges it.' : 'Merge merges it.'), '');
      return;
    }
    if (k === 'n') { if (form.elements.note) { ev.preventDefault(); noting(form, true); } return; }
    if (k === 'r' || k === 'f') {
      var kind = k === 'r' ? 'reply' : 'refire';
      if (!$('button[value="' + kind + '"]', form)) { if (NO[kind]) say(form, NO[kind]!, ''); return; }
      ev.preventDefault(); setIntent(form, kind);
      if (form.elements.note) form.elements.note.focus();
    }
  }
  // Every key goes through the shortcuts first (client/keys.ts). With none changed it is onKey, exactly as before.
  // A changed key reaches onKey as the key its command had by default; a command with no default key runs here; a
  // default key its command gave up does nothing where that command applies. A plain key keeps typing in a text field
  // and belongs to an open dialog, as ⌘↵ does there (it sends), and an option's letter comes first while a question waits.
  document.addEventListener('keydown', function(ev){
    if (kxRec) return;
    // A key an input method uses while it composes text (Japanese, Chinese) is the method's alone, as in the action bar:
    // Esc or ⌘↵ then never leaves, or sends half a word. Safari's last key of a composition reads as keyCode 229.
    if (ev.isComposing || ev.keyCode === 229) return;
    if (!KST.changed) { onKey(ev); return; }
    var c = K.comboOf(ev), t = ev.target as Element | null;
    var typing = !!(t && t.closest && t.closest('textarea, input[type=text], input[type=search], [contenteditable]'));
    var dialog = [barDlg, setDlg, launchDlg, viewer].some(function(d){ return d && d.open; });
    if (!c || (K.plain(c) && typing) || (dialog && K.dialogKey(c)) || (/^[a-i]$/.test(c) && letterAt(t, c))) { onKey(ev); return; }
    var r = K.route(KST, c, { ticket: !!mounted, dialog: dialog });
    if (!r) { onKey(ev); return; }
    // A changed key is the shortcut's alone, so the browser never also acts on it (Hold on ⌘F opens no Find).
    if (r.as) { ev.preventDefault(); onKey(K.synth(r.as, ev) as PageKey); return; }
    ev.preventDefault();
    if (r.run && !ev.repeat) RUN[r.run]!();
  });
  // The commands with no default key: the router runs them, in a dialog too. The two that open the bar close the other
  // dialogs first, as ⌘K does.
  function barAt(step: string): void { if (!bar) return; if (setDlg.open) setDlg.close(); if (launchDlg.open) launchDlg.close(); if (viewer.open) viewer.close(); bar.openAt(step); }
  var RUN: Record<string, () => void> = {
    'thread.note': function(){ barAt('note'); },
    'thread.goto': function(){ barAt('goto'); },
    'view.you': function(){ setScope('you'); },
    'view.team': function(){ if (teamNow()) setScope('team'); else toast('View: Team needs a team first.', null, 3000); }
  };
  // Every key label on the board names its command (data-cmd, client/board.ts) and shows that command's key now.
  // A button's first key shows the send key while it is armed (setIntent, noteKey): then only its own key changes.
  function relabel(scope: ParentNode | null): void {
    $$('kbd[data-cmd]', scope || document).forEach(function(kb){
      var g = keyLabel(kb.dataset.cmd!), b = kb.closest<HTMLElement>('button');
      if (b && b.dataset.key !== undefined && $('kbd', b) === kb) {
        var sending = kb.textContent !== b.dataset.key;
        b.dataset.key = g;
        if (sending) { kb.textContent = SK(); kb.classList.remove('nokey'); return; }
      }
      kb.textContent = g; kb.classList.toggle('nokey', !g);
    });
    // A tooltip that names its key in brackets ("Settings (⌘,)") names the key now, or none.
    $$('[data-tcmd]', scope || document).forEach(function(el){ var g = keyLabel(el.dataset.tcmd!); el.title = el.title.replace(/ \([^)]*\)$/, '') + (g ? ' (' + g + ')' : ''); });
  }

  // ----- Settings → Shortcuts (⌘K bar PR 4, the approved mock v3) -----
  // Each command's keys, with Change. Change records the next key pressed; Esc keeps the old one. A key another command
  // has asks first, in the row: Swap them, or Keep. Reset gives one command its default back; Reset all, every one.
  var kxRec: string | null = null, kxClash: KxClash | null = null, kxHint = '', kxMods = '', kxEscAt = 0;
  var kxList = $('#kx-list'), kxQ = $<HTMLInputElement>('#kx-q');
  function escH(s: unknown): string { return String(s == null ? '' : s).replace(/[&<>"]/g, function(c){ return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' } as Record<string, string>)[c]!; }); }
  function kxCaps(key: string): string { return '<span class="kx-k">' + K.glyphs(key).map(function(g){ return '<kbd>' + escH(g) + '</kbd>'; }).join('') + '</span>'; }
  function kxRow(c: Command): string {
    var keys = K.keysOf(KST, c.id), over = !K.isDefault(KST, c.id), rec = kxRec === c.id, cl = kxClash && kxClash.id === c.id ? kxClash : null;
    var line = rec ? (keys.length ? 'Recording. Press the keys, or esc to keep ' + keys.map(K.label).join(' or ') : 'Recording. Press the keys, or esc to leave it without one')
      : c.note && !over ? K.label(c.note) + ' is T3 Code’s own new-thread key' : (c.d || '');
    var right = rec ? '<span class="recbox" aria-hidden="true">' + escH(kxMods ? kxMods + ' …' : '…') + '</span>'
      : (cl ? kxCaps(cl.key) : keys.length ? keys.map(kxCaps).join('<span class="kx-or">or</span>') : '<span class="kx-no">No key</span>')
        + '<button type="button" class="kx-ed" data-kx-ed="' + c.id + '" aria-label="Change the key for ' + escH(c.t) + '">Change</button>';
    var more = '';
    if (cl) more = '<div class="kx-msg" role="alert"><b>Taken</b><span>' + escH(cl.text) + '</span>'
      + (cl.canTake ? '<button type="button" class="btn kx-b" data-kx-swap>' + (cl.gives && cl.gives.length ? 'Swap them' : 'Take it') + '</button>' : '')
      + '<button type="button" class="btn kx-b" data-kx-keep>' + (keys.length ? 'Keep ' + escH(keys.map(K.label).join(' or ')) : 'Cancel') + '</button></div>';
    else if (rec && kxHint) more = '<p class="kx-hint" role="alert">' + escH(kxHint) + '</p>';
    return '<div class="kr-row kx-row' + (over ? ' kr-over' : '') + (rec ? ' kx-rec' : '') + (cl ? ' kx-clash' : '') + '" data-kx="' + c.id + '"' + (rec ? ' tabindex="-1"' : '') + '>'
      + '<div class="kr-l"><div class="kr-h"><h4>' + escH(c.t) + '</h4><button type="button" class="kr-reset" data-kx-reset="' + c.id + '" title="Use the default key">Reset</button></div>'
      + (line ? '<p>' + escH(line) + '</p>' : '') + '</div><div class="kx-c">' + right + '</div>' + more + '</div>';
  }
  function kxFixed(f: FixedKey): string {
    return '<div class="kr-row kx-row kx-fix"><div class="kr-l"><div class="kr-h"><h4>' + escH(f.t) + '</h4></div>' + (f.d ? '<p>' + escH(f.d) + '</p>' : '') + '</div>'
      + '<div class="kx-c">' + f.keys.map(kxCaps).join('') + (f.more ? '<span class="kx-or">…</span>' : '') + '</div></div>';
  }
  function kxRender(){
    if (!kxList) return;
    var raw = kxQ ? kxQ.value.trim() : '', q = raw.toLowerCase(), groups: string[] = [], rows: Record<string, string[]> = {};
    var hit = function(words: string[]): boolean { return !q || words.join(' ').toLowerCase().indexOf(q) >= 0; };
    K.COMMANDS.forEach(function(c){
      if (!hit([c.g, c.t, c.d || ''].concat(K.keysOf(KST, c.id).map(K.label))) && kxRec !== c.id && !(kxClash && kxClash.id === c.id)) return;
      if (!rows[c.g]) { rows[c.g] = []; groups.push(c.g); }
      rows[c.g]!.push(kxRow(c));
    });
    var fixed = K.FIXED.filter(function(f){ return hit(['Fixed', f.t, f.d || ''].concat(f.keys.map(K.label))); });
    var html = groups.map(function(g){ return '<h3 class="kgroup">' + escH(g) + '</h3><div class="kr-group kx-group">' + rows[g]!.join('') + '</div>'; }).join('')
      + (fixed.length ? '<h3 class="kgroup">Fixed</h3><div class="kr-group kx-group">' + fixed.map(kxFixed).join('') + '</div>' : '');
    // A render keeps the focus where it was, on the same button in the same row: a save that ends later renders too.
    var fa = document.activeElement, frow = fa && kxList.contains(fa) && fa.closest('[data-kx]'), fsel: string | null = null;
    if (frow) fsel = '[data-kx="' + frow.getAttribute('data-kx') + '"]' + (['data-kx-ed', 'data-kx-reset', 'data-kx-swap', 'data-kx-keep'].filter(function(n){ return fa!.hasAttribute(n); }).map(function(n){ return ' [' + n + ']'; })[0] || '');
    kxList.innerHTML = html || '<p class="kx-none">No shortcut matches “' + escH(raw) + '”.</p>';
    var fback = fsel && kxList.querySelector<HTMLElement>(fsel); if (fback && fback !== document.activeElement) fback.focus();
    var ra = $<HTMLButtonElement>('[data-kx-resetall]'); if (ra) ra.disabled = !KST.changed;
    var fb = $('[data-kx-file]'); if (fb) fb.hidden = !KFILE;
    var nt = $('.kx-note'), notes = (kxFileNote ? [kxFileNote] : []).concat(KST.notes || []);
    if (nt) { nt.hidden = !notes.length; nt.textContent = notes.length ? (KFILE ? 'keybindings.json: ' : 'Saved shortcuts: ') + notes.slice(0, 3).join(' ') + (notes.length > 3 ? ' And ' + (notes.length - 3) + ' more.' : '') : ''; }
  }
  function kxSay(text: string): void { var l = $('.kx-live'); if (l) l.textContent = text || ''; }
  // What a change does to the other commands, in words, before it applies: " Hold until 8:00 tomorrow: H."
  function kxOthers(st: KeyState, id: string): string {
    return K.COMMANDS.filter(function(c){ return c.id !== id && K.keysOf(st, c.id).join(' ') !== K.keysOf(KST, c.id).join(' '); })
      .map(function(c){ var ks = K.keysOf(st, c.id); return ' ' + c.t + ': ' + (ks.length ? ks.map(K.label).join(' or ') : 'no key') + '.'; }).join('');
  }
  function kxFocus(id: string): void { var b = $('[data-kx-ed="' + id + '"]'); if (b) b.focus(); }
  function kxStart(id: string): void {
    kxRec = id; kxClash = null; kxHint = ''; kxMods = ''; kxRender();
    var r = $('.kx-row.kx-rec'); if (r) r.focus();
    var keys = K.keysOf(KST, id);
    kxSay('Recording a key for ' + K.CMD[id]!.t + '. Press the keys, or Escape to ' + (keys.length ? 'keep ' + K.label(keys[0]) : 'leave it without one') + '.');
  }
  function kxStop(back: boolean): void { var id = kxRec; kxRec = null; kxHint = ''; kxMods = ''; kxRender(); if (back && id) kxFocus(id); }
  // Save: the browser's copy, and on the Mac the file. Every key label on the board follows.
  function kxApply(st: KeyState, id: string | null, said: string): void {
    KST = st; kxClash = null;
    var list = K.toList(st), text = JSON.stringify(list);
    if (list.length) store('yc.keys', text); else forget('yc.keys');
    kxSeen = text;
    if (KFILE) KFILE.write(list).then(function(r){ kxFileNote = r && r.error ? 'Could not save the file: ' + r.error : ''; kxRender(); }, function(){ kxFileNote = 'Could not save the file.'; kxRender(); });
    relabel(document); kxRender();
    if (id) kxFocus(id);
    kxSay(said);
  }
  // Recording takes every key first, in the capture phase, so nothing else on the page acts on it. Tab still moves on.
  window.addEventListener('keydown', function(ev){
    if (!kxRec) return;
    if (!setDlg.open) { kxStop(false); return; }
    // Tab moves on from the row: its Change button has the focus first, so the browser moves on from there.
    if (ev.key === 'Tab') { kxStop(true); return; }
    ev.preventDefault(); ev.stopPropagation();
    if (ev.isComposing) return;
    if (ev.key === 'Escape') { kxEscAt = Date.now(); kxStop(true); kxSay('Kept as it was.'); return; }
    var id = kxRec, c = K.comboOf(ev);
    if (!c) {
      var g = K.glyphs((ev.metaKey || ev.ctrlKey ? 'mod+' : '') + (ev.altKey ? 'alt+' : '') + (ev.shiftKey ? 'shift+' : '') + 'x'); g.pop();
      kxMods = g.join(' '); var rb = $('.kx-row.kx-rec .recbox'); if (rb) rb.textContent = kxMods ? kxMods + ' …' : '…';
      return;
    }
    var cl = K.clash(KST, id, c);
    if (cl && (cl.reserved || cl.fixed)) { kxHint = cl.text; kxMods = ''; kxRender(); var r = $('.kx-row.kx-rec'); if (r) r.focus(); kxSay(cl.text); return; }
    kxRec = null; kxHint = ''; kxMods = '';
    if (cl) {
      kxClash = { id: id, key: c, other: cl.other!, text: cl.text, canTake: cl.canTake!, gives: cl.gives! }; kxRender();
      var sb = $('[data-kx-swap]') || $('[data-kx-keep]'); if (sb) sb.focus();
      return;
    }
    kxApply(K.set(KST, id, c), id, K.CMD[id]!.t + ': ' + K.label(c) + '.');
  }, true);
  window.addEventListener('keyup', function(ev){
    if (!kxRec) return;
    var g = K.glyphs((ev.metaKey || ev.ctrlKey ? 'mod+' : '') + (ev.altKey ? 'alt+' : '') + (ev.shiftKey ? 'shift+' : '') + 'x'); g.pop();
    kxMods = g.join(' '); var rb = $('.kx-row.kx-rec .recbox'); if (rb) rb.textContent = kxMods ? kxMods + ' …' : '…';
  }, true);
  // Esc that stopped a recording never also closes Settings.
  setDlg.addEventListener('cancel', function(ev){ if (kxRec || Date.now() - kxEscAt < 400) { ev.preventDefault(); if (kxRec) kxStop(true); } });
  setDlg.addEventListener('close', function(){ kxRec = null; kxClash = null; kxHint = ''; kxMods = ''; });
  setDlg.addEventListener('click', function(ev){
    var t = ev.target as Element | null; if (!t || !t.closest) return;
    if (kxRec && !t.closest('.kx-row.kx-rec')) kxStop(false);
    var ed = t.closest<HTMLElement>('[data-kx-ed]'); if (ed) { kxStart(ed.dataset.kxEd!); return; }
    var rs = t.closest<HTMLElement>('[data-kx-reset]');
    if (rs) { var rid = rs.dataset.kxReset!, dk = K.CMD[rid]!.keys, rst = K.reset(KST, rid); kxApply(rst, rid, K.CMD[rid]!.t + (dk.length ? ': ' + dk.map(K.label).join(' or ') + ' again.' : ' has no key again.') + kxOthers(rst, rid)); return; }
    if (t.closest('[data-kx-swap]') && kxClash) { var c = kxClash, sst = K.swap(KST, c.id, c.key); if (sst) kxApply(sst, c.id, K.CMD[c.id]!.t + ': ' + K.label(c.key) + '.' + kxOthers(sst, c.id)); return; }
    if (t.closest('[data-kx-keep]') && kxClash) { var kid = kxClash.id; kxClash = null; kxRender(); kxFocus(kid); kxSay('Kept as it was.'); return; }
    if (t.closest('[data-kx-resetall]')) { kxApply(K.build(K.defaultList()), null, 'Every shortcut has its default key again.'); var q = $('#kx-q'); if (q) q.focus(); return; }
    if (t.closest('[data-kx-file]') && KFILE) KFILE.open().then(function(r){ if (r && r.error) { kxFileNote = 'Could not open the file: ' + r.error; kxRender(); } }, function(){});
  });
  if (kxQ) kxQ.addEventListener('input', kxRender);
  // On the Mac the file is the list: read at start and whenever the window comes back, so an edit there applies.
  // With no file yet, the browser's list becomes it.
  function kxLoad(): void {
    if (!KFILE) return;
    KFILE.read().then(function(r){
      if (!r) return;
      if (r.error) { kxFileNote = r.error; kxRender(); return; }
      kxFileNote = '';
      if (r.list == null) { var mine = K.toList(KST); if (mine.length) KFILE!.write(mine); kxRender(); return; }
      var text = JSON.stringify(r.list);
      if (text === kxSeen) { kxRender(); return; }
      kxSeen = text; KST = K.build(r.list); kxClash = null;
      if (Array.isArray(r.list) && r.list.length) store('yc.keys', text); else forget('yc.keys');
      relabel(document); kxRender();
    }, function(){});
  }
  window.addEventListener('focus', kxLoad);
  kxLoad();
  // A screenshot that loads changes the message's height: fades and the reader's join follow (hill climb 2 r2, Fable).
  document.addEventListener('load', function(ev){ if (ev.target && (ev.target as Element).tagName === 'IMG') fades(); }, true);
  // A screenshot that cannot load becomes a plain line saying so, never a broken box (hill climb r5, Opus).
  document.addEventListener('error', function(ev){
    var img = ev.target as Element | null; if (!img || img.tagName !== 'IMG') return;
    var a = img.closest && img.closest('a.att'); if (!a) return;
    // An attachment keeps its box and its label, and says the file is gone (Dan, 2026-11-07).
    var p = document.createElement('span'); p.className = 'att missing'; p.setAttribute('role', 'listitem');
    var box = document.createElement('span'); box.className = 'att-img'; box.textContent = 'Not available';
    var cap = a.querySelector('.att-cap'); p.appendChild(box); if (cap) p.appendChild(cap);
    a.replaceWith(p);
  }, true);
  // Typing your own answer picks it: a field inside a label does not check the label's radio by itself.
  document.addEventListener('focusin', function(ev){ var t = ev.target as Element; if (t.matches && t.matches('label.opt .custom')) { var r = t.parentNode!.querySelector<HTMLInputElement>('input[data-custom]'); if (r) r.checked = true; } });

  applyPrefs(); applyScope(); normalizePicked(); applyFlow(true); if (KST.changed || !K.mac) relabel(document); restoreDrafts(document);
  setView(state.view); setFolder('pass');
  fades();
  // The Cmd+K action bar (client/bar.ts). View: You and View: Team read and set the same scope as the footer
  // chip's switch; with no reports (#yc-team absent) views() says so and their rows stay hidden (Dan, 2026-11-10).
  bar = installBar({
    $: $, $$: $$, store: store, forget: forget, state: state, prefs: prefs, reduce: reduce,
    mounted: function(){ return mounted; }, plateNode: plateNode, keyForm: keyForm, select: select, setFolder: setFolder, listKeyOf: listKeyOf,
    send: send, setIntent: setIntent, noting: noting, toggleView: toggleView, openLaunch: openLaunch, openSettings: openSettings, setDensity: setDensity, setTheme: setTheme, mini: function(k){ return MINI[k] || ''; },
    liftToast: liftToast, yieldKey: yieldKey, grow: grow, views: viewsNow, setScope: setScope,
    keyGlyphs: function(id){ return K.keysOf(KST, id).map(function(k){ return K.glyphs(k); }); }
  }, barCore());
}
