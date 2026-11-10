// The ⌘K action bar (Dan, 2026-11-10: "Then yes, build"). Spec: docs/command-bar-v1_0.md. Approved mock:
// docs/mocks/command-bar-v3.html. ⌘K opens the bar empty at the window's centre, like Spotlight. The first character
// lifts it to the typing position and the list unfolds below. When the field is empty again it waits 250 ms, sinks
// back to the centre, and after 5 s empty rises with your last action and three suggestions. ↓ shows them at once
// (Dan, 1A). ↑ in the empty field brings back earlier actions, like a terminal. Esc clears first, then closes.
//
// Four parts. BAR_CSS and BAR_HTML go into the page (client/server.mjs). barCore() is pure and tested
// (client/bar.test.mjs). installBar() runs in the page. server.mjs inlines barCore and installBar by their source
// text, so neither may use anything outside itself: no imports, no names from this module. Both are ES5, like the
// page script.

// Motion: Apple's default spring, duration 0.5 s, bounce 0. In CSS that is 735 ms with this linear() curve: the
// critically damped spring drawn to 0.1% of the travel, as in the mock's spring5 rule (Dan, 2026-11-10).
export const SPRING = 'linear(0, 0.0575, 0.1803, 0.3208, 0.4551, 0.5729, 0.6711, 0.7501, 0.8122, 0.8601, 0.8966, 0.924, 0.9445, 0.9596, 0.9708, 0.9789, 0.9848, 0.9891, 0.9922, 0.9944, 0.996, 0.9972, 0.998, 0.9986, 1)';

export const BAR_CSS = `
/* The ⌘K action bar (client/bar.mjs). One transform and one grid row move it, so typing during the motion only
   retargets it: nothing waits for an animation. */
#bar{--cb-dur:735ms;--cb-ease:${SPRING};--cb-lead:150ms;--cb-stag:40ms;
  --cb-pop:#FFFFFF;--cb-foot:#F2F2F7;--cb-sel:rgba(0,113,227,.12);--cb-ph:#8E8E93;
  position:fixed;inset:0;width:100%;height:100%;max-width:none;max-height:none;margin:0;padding:0;border:0;background:transparent;color:var(--label);overflow:hidden}
#bar::backdrop{background:rgba(0,0,0,.30);animation:cb-fade .2s ease}
@media (prefers-color-scheme:dark){#bar{--cb-pop:#2C2C2E;--cb-foot:#2C2C2E;--cb-sel:rgba(10,132,255,.22);--cb-ph:#8E8E93}#bar::backdrop{background:rgba(0,0,0,.45)}}
#bar .cb{position:absolute;left:50%;top:var(--cb-top,112px);width:min(660px,calc(100vw - 32px));background:var(--cb-pop);border-radius:16px;
  box-shadow:0 0 0 .5px rgba(0,0,0,.10),0 24px 64px rgba(0,0,0,.22),0 4px 14px rgba(0,0,0,.10);overflow:hidden;
  transform:translate(-50%,var(--cb-y,0px));transition:transform var(--cb-dur) var(--cb-ease),opacity .1s ease}
@media (prefers-color-scheme:dark){#bar .cb{box-shadow:0 0 0 .5px rgba(255,255,255,.10),0 24px 64px rgba(0,0,0,.6),0 4px 14px rgba(0,0,0,.4)}}
#bar[open] .cb{animation:cb-fade .16s ease}
#bar .cb.center{--cb-y:var(--cb-cy,0px)}
#bar .cb.snap,#bar .cb.snap .cb-drop{transition:none}
#bar .cb.dip{opacity:0}
.cb-q{display:flex;align-items:center;gap:10px;padding:16px 18px}
.cb-q>svg{width:18px;height:18px;color:var(--label2);flex:none}
.cb-q input{flex:1;min-width:0;border:0;outline:0;background:none;padding:0;font:400 20px/1.3 var(--sans);color:var(--label)}
.cb-q input::placeholder{color:var(--cb-ph)}
.cb-crumb{flex:0 1 auto;min-width:0;display:inline-flex;align-items:center;gap:5px;height:26px;padding:0 9px;border-radius:6px;background:var(--pass-t);color:var(--pass);font-weight:600;font-size:12px;white-space:nowrap}
.cb-crumb svg{width:10px;height:10px;flex:none}
.cb-crumb .cb-ct{min-width:0;overflow:hidden;text-overflow:ellipsis}
.cb-q input:disabled{opacity:1}
.cb-hint{display:inline-flex;align-items:center;gap:6px;color:var(--label2);font-size:12px;white-space:nowrap;flex:none}
.cb-hint kbd+kbd,.cb-hint .cb-gap{margin-left:6px}
#bar kbd{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:6px;background:var(--fill);color:var(--label2);font:500 12px/1 var(--sans);letter-spacing:0}
#bar kbd+kbd{margin-left:3px}
.cb-drop{display:grid;grid-template-rows:1fr;opacity:1;transition:grid-template-rows var(--cb-dur) var(--cb-ease),opacity var(--cb-dur) ease}
.cb-drop>div{min-height:0;overflow:hidden;border-top:.5px solid var(--sep)}
#bar .cb.center .cb-drop{grid-template-rows:0fr;opacity:0}
.cb-res{max-height:min(520px,calc(100dvh - var(--cb-top,112px) - 150px));overflow:auto;overscroll-behavior:contain;padding:6px 8px 8px;scrollbar-width:thin}
.cb-gh{display:flex;gap:6px;min-width:0;padding:10px 10px 4px;font-size:12px;font-weight:600;color:var(--label2)}
.cb-gh span{font-weight:400;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-it{display:flex;align-items:center;gap:12px;min-height:40px;padding:8px 10px;border-radius:10px;cursor:default}
.cb-it.sel{background:var(--cb-sel)}
.cb-it.off{opacity:.65}
.cb-ic{flex:none;display:grid;place-items:center;width:26px;height:26px;border-radius:6px;background:var(--fill);color:var(--label2);font:700 12px/1 var(--sans)}
.cb-ic svg{width:15px;height:15px}
.cb-ic.blue{background:var(--pass);color:#fff}
.cb-ic.cb-pm{background:none}
.cb-ic.cb-pm .pm{width:26px;height:26px;border-radius:6px;font-size:12px}
.cb-t{display:flex;flex-direction:column;min-width:0}
.cb-t b{font-weight:500;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-t small{color:var(--label2);font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.cb-k{margin-left:auto;display:flex;align-items:center;gap:8px;flex:none}
.cb-tag{padding:2px 7px;border-radius:6px;background:var(--pass-t);color:var(--pass);font-size:12px;font-weight:600}
.cb-tag.now{background:var(--fill);color:var(--label2)}
.cb-st{display:inline-flex;align-items:center;gap:6px;color:var(--label2);font-size:12px;white-space:nowrap}
.cb-foot{display:flex;align-items:center;gap:16px;padding:10px 16px;border-top:.5px solid var(--sep);background:var(--cb-foot);color:var(--label2);font-size:12px}
.cb-foot span{display:inline-flex;align-items:center;gap:6px}
.cb-foot .r{margin-left:auto;flex:none}
.cb-foot button{height:26px;padding:0 10px;border:0;border-radius:6px;background:var(--fill);color:var(--label);font:500 12px/1 var(--sans);white-space:nowrap;cursor:pointer}
.cb-empty{padding:28px 20px;text-align:center;color:var(--label2);font-size:14px}
/* Send a note: the thread, the note, and Back and Send, inside the bar (mock v3's compose step). */
.cb-compose{display:flex;flex-direction:column;gap:12px;padding:14px 16px 16px}
.cb-compose[hidden]{display:none}
.cb-to{display:flex;align-items:center;gap:10px;min-width:0;padding:10px 12px;border-radius:10px;background:var(--fill)}
.cb-to .cb-t b{font-weight:600}
.cb-compose textarea{display:block;width:100%;min-height:96px;max-height:260px;box-sizing:border-box;border:0;outline:0;resize:none;overflow:auto;background:var(--fill);border-radius:10px;padding:12px 14px;font:400 15px/1.45 var(--sans);color:var(--label)}
.cb-compose textarea::placeholder{color:var(--cb-ph)}
.cb-say{margin:0;font-size:13px;color:var(--label)}
.cb-say:empty{display:none}
.cb-say.bad{color:var(--red)}
.cb-crow{display:flex;align-items:center;gap:10px}
.cb-crow .cb-why{color:var(--label2);font-size:12px;min-width:0}
.cb-crow .cb-sp{margin-left:auto}
.cb-compose button{flex:none;display:inline-flex;align-items:center;gap:6px;height:30px;padding:0 12px;border:0;border-radius:8px;background:var(--fill);color:var(--label);font:500 13px/1 var(--sans);white-space:nowrap;cursor:pointer}
.cb-compose button.fill{background:var(--accent);color:#fff}
#bar .cb-compose button.fill kbd{background:rgba(255,255,255,.22);color:#fff}
#bar button:focus-visible,.cb-compose textarea:focus-visible{outline:2px solid var(--pass);outline-offset:2px}
.cb-empty+.cb-gh{padding-top:0}
@keyframes cb-pop{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:none}}
@keyframes cb-fade{from{opacity:0}to{opacity:1}}
/* Clipped only while the rows pop in (core.popEnd), so a long list scrolls again after. */
.cb-res.popin{overflow:hidden}
.cb-res.popin .cb-it,.cb-res.popin .cb-gh{animation:cb-pop var(--cb-dur) var(--cb-ease) both;animation-delay:calc(var(--cb-lead) + var(--i,0) * var(--cb-stag))}
/* Reduce Motion: no slide. The bar fades out, moves, and fades back in. */
@media (prefers-reduced-motion:reduce){
  #bar .cb{transition:opacity .1s ease}
  .cb-drop{transition:opacity .1s ease}
  .cb-res.popin .cb-it,.cb-res.popin .cb-gh{animation:cb-fade .2s ease both;animation-delay:.1s}
}
/* A phone has no Esc or arrow keys to show, and less room for the field's words. */
@media (max-width:760px){.cb-hint,.cb-foot .cb-move,.cb-foot .cb-note,#bar .cb-q>kbd,#bar .cb-compose button kbd{display:none}.cb-q{padding:14px 14px}.cb-q input{font-size:16px}.cb-res{padding:4px 6px 6px}
  .cb-compose{padding:12px}.cb-compose textarea{font-size:16px}.cb-crow{flex-wrap:wrap}.cb-crow .cb-why{flex-basis:100%}}
`;

// Icons: the mock's set, plus Request changes, Settle, Collapse and the two views.
const ICONS = {
  search: '<circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" stroke-width="1.6"/><path d="M10.4 10.4 14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  plus: '<path d="M8 3v10M3 8h10" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  note: '<path d="M3 3.5h10v7H7l-3 2.5v-2.5H3z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/>',
  jump: '<path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
  rows: '<path d="M3 4.5h10M3 8h10M3 11.5h10" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
  key: '<rect x="1.8" y="4" width="12.4" height="8" rx="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 6.7h.01M7 6.7h.01M9.5 6.7h.01M12 6.7h.01M5 9.4h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  gear: '<circle cx="8" cy="8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 1.8v2M8 12.2v2M1.8 8h2M12.2 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  rules: '<path d="M4 2.5h8v11H4z" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linejoin="round"/><path d="M6 5.5h4M6 8h4M6 10.5h2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  expand: '<path d="M9.5 2.5h4v4M6.5 13.5h-4v-4M13.5 2.5 9 7M2.5 13.5 7 9" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  collapse: '<path d="M13.5 6.5h-4v-4M2.5 9.5h4v4M9.5 6.5l4-4M6.5 9.5l-4 4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  hold: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 5v3.2l2 1.3" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  ext: '<path d="M9 3h4v4M13 3 7.5 8.5M11 9.5V13H3V5h3.5" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>',
  check: '<path d="m3.5 8.3 3 3 6-6.6" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
  merge: '<circle cx="4.5" cy="3.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4.5" cy="12.5" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.5" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 5.1v5.8M4.5 5.6c0 2 1.6 2.4 5.4 2.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
  refire: '<path d="M12.6 9.2A4.8 4.8 0 1 1 11.3 4.4" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/><path d="M12.2 2.2v3h-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  settle: '<circle cx="8" cy="8" r="5.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="m5.6 8.2 1.7 1.7 3.2-3.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
  cloche: '<path d="M2.8 11.6a5.2 5.2 0 0 1 10.4 0" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="8" cy="4.9" r="1.2" fill="currentColor"/><path d="M1.8 12.7h12.4l-1 1H2.8z" fill="currentColor"/>',
  you: '<circle cx="8" cy="5.5" r="2.6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3 13.5a5 5 0 0 1 10 0" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  team: '<circle cx="6" cy="5.8" r="2.2" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="11.2" cy="6.4" r="1.8" fill="none" stroke="currentColor" stroke-width="1.3"/><path d="M1.8 13.2a4.2 4.2 0 0 1 8.4 0M10.4 9.6a3.4 3.4 0 0 1 4 3.4" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>',
};

export const BAR_HTML = `<dialog id="bar" aria-label="Actions"><div class="cb center">
<div class="cb-q"><svg viewBox="0 0 16 16" aria-hidden="true"><use href="#cb-search"/></svg><span class="cb-crumb" hidden></span><input id="cb-q" type="text" role="combobox" aria-expanded="false" aria-controls="cb-res" aria-autocomplete="list" aria-label="Search actions, threads and settings" autocomplete="off" autocapitalize="off" spellcheck="false" placeholder="Search actions, threads and settings"><span class="cb-hint" hidden></span><kbd>esc</kbd></div>
<div class="cb-drop"><div><div class="cb-res" id="cb-res" role="listbox" aria-label="Actions" tabindex="-1"></div><div class="cb-compose" role="group" aria-label="Send a note" hidden><div class="cb-to"></div><textarea id="cb-msg" rows="4" aria-label="Your note" placeholder="What should the agent know?"></textarea><p class="cb-say" role="status"></p><div class="cb-crow"><span class="cb-why">Goes to the agent as your message, queued like T3 Code's own queue.</span><span class="cb-sp"></span><button type="button" data-cb-back>Back</button><button type="button" class="fill" data-cb-send>Send <kbd>⌘</kbd><kbd>↵</kbd></button></div></div><div class="cb-foot"></div></div></div>
</div><svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>${Object.entries(ICONS).map(([id, d]) => `<symbol id="cb-${id}" viewBox="0 0 16 16">${d}</symbol>`).join('')}</defs></svg></dialog>`;

/** The bar's pure parts: matching, history and the view rows. Tested in client/bar.test.mjs. */
export function barCore() {
  var MAX = 5;
  function norm(s) { return String(s == null ? '' : s).toLowerCase().replace(/\s+/g, ' ').trim(); }
  function words(q) { return norm(q).split(' ').filter(Boolean); }
  function atStart(h, w) { var i = h.indexOf(w); while (i >= 0) { if (i === 0 || !/[a-z0-9]/.test(h.charAt(i - 1))) return true; i = h.indexOf(w, i + 1); } return false; }
  // Every word you type must appear in the row: its title, its line, its group or its keywords.
  function match(q, hay) { var h = norm(hay); return words(q).every(function (w) { return h.indexOf(w) >= 0; }); }
  // How well a row's title answers the words: a title that starts with them first, then words that start the title's
  // words, then words inside it. "pick b" puts "Pick b: …" above "Pick a: … by the agent".
  function score(q, title) {
    var t = norm(title), ws = words(q), n = 0;
    ws.forEach(function (w) { n += atStart(t, w) ? 3 : t.indexOf(w) >= 0 ? 1 : 0; });
    return n + (ws.length && t.indexOf(ws.join(' ')) === 0 ? 4 : 0);
  }
  // The rows that match, best first inside each group. A group whose best row answers the words better comes first
  // ("send a note" finds Send a note to a thread… before the open ticket's Note); on a tie the groups keep their order,
  // so the open ticket's actions lead. keep: the groups never move (a step's list, where their order means something).
  function filter(rows, q, keep) {
    var hit = rows.filter(function (r) { return match(q, r.hay != null ? r.hay : [r.t, r.d, r.g, r.kw].join(' ')); });
    var order = {}, best = {}, gi = 0;
    var xs = hit.map(function (r, i) {
      var s = score(q, r.t), g = String(r.g);
      if (!(g in order)) { order[g] = gi++; best[g] = s; } else if (s > best[g]) best[g] = s;
      return { r: r, i: i, g: g, s: s };
    });
    return xs.sort(function (a, b) { return (keep ? 0 : best[b.g] - best[a.g]) || order[a.g] - order[b.g] || b.s - a.s || a.i - b.i; })
      .map(function (x) { return x.r; });
  }
  // A short fingerprint of a whole label (FNV-1a), so a saved label cut to 200 characters still compares in full.
  function fp(s) { s = String(s); var h = 0x811c9dc5; for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return h.toString(16); }
  // Your recent actions, newest first, at most five. Saved on this Mac only; anything malformed is dropped.
  function readRecent(raw) {
    var a; try { a = JSON.parse(raw || '[]'); } catch (x) { return []; }
    if (!Array.isArray(a)) return [];
    return a.filter(function (r) { return !!r && typeof r.id === 'string' && !!r.id && typeof r.t === 'string' && !!r.t && typeof r.at === 'number' && isFinite(r.at); })
      .slice(0, MAX).map(function (r) { var o = { id: r.id, t: r.t.slice(0, 200), at: r.at }; if (typeof r.f === 'string' && r.f) o.f = r.f; return o; });
  }
  // Whatever you run becomes the last action; running it again moves it to the top instead of adding a copy. f is the
  // whole label's fingerprint.
  function pushRecent(list, id, t, at) {
    return [{ id: id, t: String(t).slice(0, 200), at: at, f: fp(t) }].concat((list || []).filter(function (r) { return r.id !== id; })).slice(0, MAX);
  }
  // The thread your last note went to: { id, at }, else null.
  function readNoted(raw) {
    var n; try { n = JSON.parse(raw || 'null'); } catch (x) { return null; }
    return n && typeof n.id === 'string' && !!n.id && typeof n.at === 'number' && isFinite(n.at) ? { id: n.id, at: n.at } : null;
  }
  function ago(at, now) {
    var s = Math.max(0, Math.floor((now - at) / 1000));
    if (s < 60) return 'Just now';
    var m = Math.floor(s / 60); if (m < 60) return m + ' min ago';
    var h = Math.floor(m / 60); if (h < 24) return h + ' h ago';
    var d = Math.floor(h / 24); return d === 1 ? 'Yesterday' : d + ' days ago';
  }
  // The item after `cur` in a list of ids, else the first one that is not `cur`. Null when there is none.
  function after(ids, cur) {
    var i = ids.indexOf(cur), rest = ids.filter(function (x) { return x !== cur; });
    var next = i < 0 ? rest[0] : ids.slice(i + 1)[0] || rest[0];
    return next === undefined ? null : next;
  }
  // View: You and View: Your team (Dan, 2026-11-10, views mock v4). Only a user with reports gets them, and only once
  // the app can switch views. views: { hasReports, current: 'you' | 'team', team: { name, below } }. Nothing is guessed:
  // a missing team name or count reads "not checked".
  var VIEW_KW = 'switch team me mine solo lead reports scope';
  function viewRows(views, canSwitch) {
    if (!views || views.hasReports !== true || !canSwitch) return [];
    var team = views.team || {}, below = typeof team.below === 'number' && isFinite(team.below) ? team.below : null;
    var name = typeof team.name === 'string' && team.name ? team.name : 'Team name not checked';
    var count = below === null ? 'people below you not checked' : below + (below === 1 ? ' person' : ' people') + ' below you';
    return [
      { id: 'view:you', scope: 'you', g: 'View', t: 'View: You', d: 'Your own agents, and only their calls in The Pass', kw: VIEW_KW, icon: 'you', now: views.current === 'you' },
      { id: 'view:team', scope: 'team', g: 'View', t: 'View: Your team', d: name + ', ' + count, kw: VIEW_KW, icon: 'team', now: views.current === 'team' },
    ];
  }
  // Send a note: every thread, the ones that take a note first. why(id) says why one takes none now, else ''.
  function notePick(all, why) {
    var rows = all.map(function (k) { return { k: k, why: why(k.id) || '' }; });
    return rows.filter(function (r) { return !r.why; }).concat(rows.filter(function (r) { return !!r.why; }));
  }
  // A ticket action's id names the hand-back it answers (sig: the call's key, the question's request, else the
  // thread's latest message), so a saved action never runs on a newer hand-back from the same thread.
  function tkId(pid, sig, fi, kind) { return 'tk:' + pid + ':' + encodeURIComponent(sig || '-') + ':' + fi + ':' + kind; }
  // When the last of n popping rows has landed: the lead, the stagger and one spring (BAR_CSS).
  function popEnd(n) { return 150 + Math.max(0, n - 1) * 40 + 735; }
  return { MAX: MAX, SINK_MS: 250, COUNT_MS: 5000, match: match, score: score, filter: filter, fp: fp, readRecent: readRecent, pushRecent: pushRecent, readNoted: readNoted, ago: ago, after: after, viewRows: viewRows, tkId: tkId, popEnd: popEnd, notePick: notePick };
}

/** The bar in the page. app: the page script's own functions and state (client/server.mjs); core: barCore(). */
export function installBar(app, core) {
  var $ = app.$, $$ = app.$$;
  var dlg = document.getElementById('bar'); if (!dlg) return null;
  var box = $('.cb', dlg), input = $('#cb-q', dlg), res = $('#cb-res', dlg), foot = $('.cb-foot', dlg), crumb = $('.cb-crumb', dlg), hint = $('.cb-hint', dlg);
  var compose = $('.cb-compose', dlg), note = $('#cb-msg', dlg), toCard = $('.cb-to', dlg), say = $('.cb-say', dlg);
  var S = { q: '', sel: 0, step: null, sug: false, hist: -1, pop: false, up: false, rows: [], msg: '', to: null };
  var countT = 0, sinkT = 0, dipT = 0, popT = 0;
  // Where focus was before the bar opened. The bar puts it back itself, and only when it closes without running a row:
  // a field that takes focus can change its form (focusing an answer's own text picks it), so a row runs on the form
  // as it showed it.
  var prev = null, ran = false;
  var RECENT = 'yc.bar.recent', NOTED = 'yc.bar.noted';
  var SUG = 'Suggested: from this screen, The Pass and your last note';
  // The line under each of a ticket's actions: the words of Settings → Shortcuts.
  var WHY = { refire: 'Say what to fix, then ⌘↵', reply: 'Write a note, then ⌘↵', hold: 'Until 8:00 tomorrow', note: 'Add a note to the next send' };
  var ICON = { refire: 'refire', reply: 'note', hold: 'hold', settle: 'settle', note: 'note', open: 'ext', primary: 'check', pick: 'check' };

  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
  function txt(el) { return el ? el.textContent.replace(/\s+/g, ' ').trim() : ''; }
  function ic(name, cls) { return '<span class="cb-ic' + (cls ? ' ' + cls : '') + '" aria-hidden="true"><svg viewBox="0 0 16 16"><use href="#cb-' + name + '"/></svg></span>'; }
  function keys(k) { return (k || []).map(function (x) { return '<kbd>' + esc(x) + '</kbd>'; }).join(''); }
  function recent() { return core.readRecent(app.store(RECENT)); }
  function noted() { return core.readNoted(app.store(NOTED)); }
  function sel(id) { return '[data-plate="' + (window.CSS && CSS.escape ? CSS.escape(id) : id) + '"]'; }
  // The board is live only while T3 answers; otherwise what waits on you is not checked.
  function boardOk() { return !!$('.lamps li.ok') && !$('.lamps li.bad'); }
  function blank() { return !S.q && !S.step && S.hist < 0; }

  // ----- What the bar can run, read from the page each time, so it is never older than the board -----
  // Every ticket on the board once: its title, project, stage and whether it waits at The Pass.
  function tickets() {
    var seen = {}, out = [];
    $$('.head-b .folder').forEach(function (fd) {
      var name = fd.dataset.folder;
      $$('[data-plate]', fd).forEach(function (t) {
        if (t.tagName === 'FORM' || t.classList.contains('gone')) return;
        var id = t.dataset.plate, k = seen[id], pm = $('.proj .pm', t);
        if (!k) { k = seen[id] = { id: id, t: txt($('.t, .q', t)) || 'Untitled thread', project: txt($('.pn', t)), mark: pm ? pm.outerHTML : '', pass: false, stage: '', pv: '' }; out.push(k); }
        if (name === 'pass') { k.pass = true; k.pv = txt($('.ct-pv', t)); } else if (!k.stage) k.stage = name;
      });
    });
    return out;
  }
  function stageOf(key) {
    var nf = $('.stagenav .nf[data-folder="' + key.replace(/"/g, '') + '"]');
    var dot = nf && $('.gd', nf);
    return { label: nf ? txt($('span', nf)) || key : key, dot: dot ? '<i class="' + esc(dot.className) + '" aria-hidden="true"></i>' : '' };
  }
  function ticketRow(k, g, t) {
    var st = k.stage ? stageOf(k.stage) : null;
    return {
      id: 'go:' + k.id, g: g, t: t || k.t, hist: 'Go to ' + k.t, d: [k.project, k.pass ? 'In The Pass' : ''].filter(Boolean).join(' · '),
      // Its title, project and stage. Not the preview: "view" would find every thread that mentions a review.
      hay: [k.t, k.project, st ? st.label : ''].join(' '),
      icon: k.mark ? '<span class="cb-ic cb-pm" aria-hidden="true">' + k.mark + '</span>' : ic('jump'),
      right: st ? '<span class="cb-st">' + st.dot + esc(st.label) + '</span>' : '',
      run: function () { goTo(k.id); },
    };
  }
  // An option's words, without its letter or its Recommended tag.
  function optText(r) {
    var o = r.parentNode && $('.opt-t', r.parentNode); if (!o) return r.value;
    var c = o.cloneNode(true); $$('.okey, .rec, .muted', c).forEach(function (x) { x.remove(); });
    return txt(c).replace(/^[a-z]\.\s*/i, '') || r.value;
  }
  // A button's own line after its name ("Settle: it leaves the pass" gives "It leaves the pass"), else nothing.
  function what(b) { var m = /:\s*(.+)$/.exec(b.dataset.what || ''); return m ? m[1].charAt(0).toUpperCase() + m[1].slice(1) : ''; }
  // What ⌘↵ sends on this form, in words: "Send a: Keychain", "Send 1a, 2b", "Settle".
  function primary(f, pb, sets) {
    if (pb.value !== 'call' && pb.value !== 'answer') return { t: txt($('.bl', pb)), d: what(pb) || 'The recommended action', ready: true };
    var plan = sets.map(function (fs) {
      var c = $('input[type=radio]:checked', fs), x = c || $('input[data-rec]', fs);
      return x ? { key: x.hasAttribute('data-custom') ? '' : (x.dataset.key || x.value), text: x.hasAttribute('data-custom') ? 'your own answer' : optText(x), rec: !c } : null;
    });
    if (!plan.length || !plan.every(Boolean)) return { t: 'Send answer', d: 'Pick an answer first', ready: false };
    var t = plan.length > 1 ? 'Send ' + plan.map(function (p, i) { return (i + 1) + p.key; }).join(', ') : plan[0].key ? 'Send ' + plan[0].key + ': ' + plan[0].text : 'Send your answer';
    return { t: t, d: plan.some(function (p) { return p.rec; }) ? 'Recommended by the agent' : 'Your pick', ready: true };
  }
  // Every action a ticket offers right now, as its buttons and keys offer them. Busy forms (a send waiting out its
  // Undo, or its answer) offer nothing. A key an option has taken is not shown on the button it would have pressed.
  function ticketActions(p) {
    var out = []; if (!p) return out;
    var pid = p.id, title = txt($('.plate-t', p)) || 'this ticket', on = ' · ' + title, g = 'This ticket: ' + title;
    $$('form.act', p).forEach(function (f, fi) {
      if (f.dataset.busy) return;
      var el = f.elements, sig = (el.call && el.call.value) || (el.request && el.request.value) || p.dataset.latest || '';
      var id = function (kind) { return core.tkId(pid, sig, fi, kind); };
      var sets = $$('fieldset.q-set', f).filter(function (fs) { return !fs.disabled; });
      var pb = $('button.primary', f);
      if (pb && !pb.disabled) {
        var pr = primary(f, pb, sets);
        out.push({ id: id('primary'), fi: fi, kind: 'primary', pid: pid, g: g, t: pr.t, hist: pr.t + on, d: pr.d, icon: ic(pb.value === 'settle' ? 'settle' : 'check', 'blue'), k: ['⌘', '↵'], tag: pr.ready ? 'Suggested' : '', ready: pr.ready, run: function () { app.send(f, pb); } });
      }
      sets.forEach(function (fs, qi) {
        var q = txt($('legend', fs));
        $$('input[type=radio][data-key]', fs).forEach(function (r) {
          if (r.disabled || r.hasAttribute('data-custom')) return;
          var l = r.dataset.key, o = optText(r);
          out.push({ id: id('pick:' + qi + ':' + l), pid: pid, g: g, t: 'Pick ' + l + ': ' + o, hist: 'Pick ' + l + ': ' + o + on,
            d: sets.length > 1 ? 'Question ' + (qi + 1) + ': ' + q : r.hasAttribute('data-rec') ? 'Recommended by the agent' : '', kw: q,
            icon: '<span class="cb-ic" aria-hidden="true">' + esc(l.toUpperCase()) + '</span>', k: [l.toUpperCase()],
            run: function () { r.checked = true; r.dispatchEvent(new Event('change', { bubbles: true })); } });
        });
      });
      $$('button[name=kind]', f).forEach(function (b) {
        if (b === pb || b.disabled || b.hidden) return;
        // The name comes from the button's tooltip, up to ": ": Hold and Settle are icons with no word, and the tooltip
        // keeps "Request changes" where the button says "Changes" (Dan, 2026-11-10, call 1a). "8:00" has no space, so
        // "Hold until 8:00 tomorrow" stays whole, and a line the name already says is dropped. The first key there is the
        // button's own; Cmd+Enter, when shown, comes second.
        var kind = b.value, label = (txt($('.tn', b)) || txt($('.bl', b))).split(': ')[0], kb = $('kbd', b), key = kb && !kb.classList.contains('taken') ? txt(kb) : '';
        var d = kind === 'go' ? (key === 'M' || /merge/i.test(label) ? 'The agent merges its pull request' : 'The agent goes ahead') : kind === 'settle' ? what(b) : WHY[kind] || '';
        if (d && label.toLowerCase().indexOf(d.toLowerCase()) >= 0) d = '';
        var arm = kind === 'reply' || kind === 'refire';
        out.push({ id: id(kind), pid: pid, g: g, t: label, hist: label + on, d: d, icon: ic(kind === 'go' ? (/merge/i.test(label) ? 'merge' : 'check') : ICON[kind] || 'check'), k: key ? [key] : [],
          run: arm ? function () { app.setIntent(f, kind); if (f.elements.note) f.elements.note.focus(); } : function () { app.send(f, b); } });
      });
      var nb = $('button[data-addnote]', f);
      if (nb && !nb.disabled && f.elements.note) out.push({ id: id('note'), pid: pid, g: g, t: 'Note', hist: 'Note' + on, d: WHY.note, icon: ic('note'), k: ['N'], run: function () { app.noting(f, true); } });
    });
    var link = $('.plate-bar a[href]', p);
    if (link) out.push({ id: 'tk:' + pid + ':open', pid: pid, g: g, t: 'Open in T3 Code', hist: 'Open in T3 Code' + on, d: '', icon: ic('ext'), k: ['O'], run: function () { link.click(); } });
    return out;
  }
  // Send a note to any thread (PR 2). It uses the ticket's own Reply: the same form, draft, Undo and T3 send, queued
  // like T3 Code's queue (client/actions.mjs). A thread whose ticket offers no note here says why and cannot be picked.
  function noteForm(pid) {
    var p = app.plateNode(pid); if (!p) return null;
    return $$('form.act', p).filter(function (f) { return !!$('button[name=kind][value=reply]', f) && !!f.elements.note && f.elements.note.tagName === 'TEXTAREA'; })[0] || null;
  }
  // A call waiting on you takes a note too, as the ticket's own Reply does (its note field says "needed for Reply", and
  // /act takes a reply while a question waits). The bar says so, so the note never answers a call by surprise.
  function callOpen(pid) { var f = noteForm(pid); return !!(f && $('input[name=call]', f)); }
  function noteBlock(pid) {
    var p = app.plateNode(pid), f = noteForm(pid);
    if (!p) return 'Not on the board now';
    if (!f) return $('form.act input[name=request]', p) ? 'A question waits on it. Answer it in the ticket first.' : 'Its ticket has no Reply now';
    if (f.dataset.busy) return 'A send to it is waiting out its Undo';
    var b = $('button[name=kind][value=reply]', f);
    return b.disabled || b.hidden ? 'Its ticket has no Reply now' : '';
  }
  function nextInPass(all) {
    var m = app.mounted(), pass = all.filter(function (k) { return k.pass; });
    var id = core.after(pass.map(function (k) { return k.id; }), m ? m.id : null);
    return pass.filter(function (k) { return k.id === id; })[0] || null;
  }
  var NOT_CHECKED = { id: 'pass:nc', t: 'Next in The Pass: not checked', d: 'T3 did not answer, so the Pass cannot say what waits on you.', icon: ic('cloche'), off: true };
  function commands(all) {
    var out = [], m = app.mounted();
    if (m) out = out.concat(ticketActions(m));
    if (!boardOk()) out.push(Object.assign({ g: 'The Pass' }, NOT_CHECKED));
    else { var nx = nextInPass(all); if (nx) { var r = ticketRow(nx, 'The Pass', 'Next: ' + nx.t); r.d = nx.pv || r.d; out.push(r); } }
    out.push({ id: 'new', g: 'Threads', t: 'New thread in T3 Code', d: 'Also ⌘N', kw: 'launch start create agent prompt worktree', icon: ic('plus'), k: ['⌘', 'T'], run: function () { app.openLaunch(); } });
    out.push({ id: 'note', g: 'Threads', t: 'Send a note to a thread…', d: 'Pick any thread, write, send', kw: 'message reply tell write agent queue', icon: ic('note'), step: 'note' });
    out.push({ id: 'goto', g: 'Threads', t: 'Go to a thread…', d: 'Any thread on the board, by name', kw: 'find open jump switch ticket search', icon: ic('jump'), step: 'goto' });
    var kitchen = app.state.view === 'kitchen';
    out.push({ id: 'view', g: 'View', t: kitchen ? 'Collapse the view' : 'Expand the view', d: kitchen ? 'Only The Pass and the open ticket' : 'Every stage as a column', kw: 'expand collapse board stages columns pass switch logo', icon: ic(kitchen ? 'collapse' : 'expand'), k: ['V'], run: function () { app.toggleView(); } });
    core.viewRows(app.views(), typeof app.setScope === 'function').forEach(function (v) {
      out.push({ id: v.id, g: v.g, t: v.t, d: v.d, kw: v.kw, icon: ic(v.icon), now: v.now, run: function () { app.setScope(v.scope); } });
    });
    [['default', 'Default', 'Title and the agent’s summary'], ['comfortable', 'Comfortable', 'Title and one summary line'], ['compact', 'Compact', 'Titles only, the most tickets on screen']].forEach(function (d) {
      out.push({ id: 'density:' + d[0], g: 'View', t: 'Density: ' + d[1], d: d[2], kw: 'list rows size dense spacing', icon: ic('rows'), now: app.prefs.density === d[0], run: function () { app.setDensity(d[0]); } });
    });
    out.push({ id: 'team', g: 'Settings', t: 'Invite your team', d: 'Make a team, send the link, add each dev to the chart', kw: 'team invite join link relay roles chart members deputy engineer area', icon: ic('team'), run: function () { location.href = '/team'; } });
    out.push({ id: 'rules', g: 'Settings', t: 'Rules', d: 'Sent with every thread Yes Chef starts', kw: 'brief reviewer browser tracker council screenshots house notes', icon: ic('rules'), run: function () { app.openSettings('rules'); } });
    out.push({ id: 'keys', g: 'Settings', t: 'Keyboard shortcuts', d: 'Every key in one list', kw: 'keys hotkeys keybindings', icon: ic('key'), k: ['?'], run: function () { app.openSettings('keys'); } });
    out.push({ id: 'settings', g: 'Settings', t: 'Settings', d: 'Layout, rules and shortcuts', kw: 'preferences options layout', icon: ic('gear'), k: ['⌘', ','], run: function () { app.openSettings('layout'); } });
    return out;
  }
  function iconFor(id) {
    var p = id.split(':');
    if (p[0] === 'tk') return ic(p[2] === 'open' ? 'ext' : ICON[p[4]] || 'check');
    if (p[0] === 'go') return ic('jump');
    if (p[0] === 'note') return ic('note');
    return ic({ 'new': 'plus', view: p[1] === 'you' || p[1] === 'team' ? p[1] : 'expand', density: 'rows', rules: 'rules', keys: 'key', settings: 'gear', team: 'team' }[p[0]] || 'check');
  }
  function histRow(r, i, n) {
    return { id: r.id, g: i === 0 ? 'Last action' : 'Earlier action: ' + (i + 1) + ' of ' + n, t: r.t, hist: r.t, f: r.f, d: core.ago(r.at, Date.now()), icon: iconFor(r.id), k: ['↵'] };
  }
  // Suggestions come from real data only: the ticket on screen's recommended action, the next ticket in The Pass, and
  // the thread your last note went to. Missing data says "not checked"; nothing is guessed.
  function suggestions(all) {
    var out = [], r = recent(), m = app.mounted(), seen = {};
    if (r.length) { var h = histRow(r[0], 0, r.length); h.k = ['↑']; out.push(h); }
    if (m) {
      var kf = app.keyForm(null), fi = kf ? $$('form.act', m).indexOf(kf) : -1;
      var pr = fi < 0 ? null : ticketActions(m).filter(function (x) { return x.kind === 'primary' && x.fi === fi && x.ready; })[0];
      if (pr) out.push(Object.assign({}, pr, { g: SUG, d: 'The ticket on screen. ' + pr.d + '.', tag: '' }));
      seen[m.id] = 1;
    }
    if (!boardOk()) out.push(Object.assign({ g: SUG }, NOT_CHECKED));
    else {
      var nx = nextInPass(all);
      if (nx && !seen[nx.id]) { var row = ticketRow(nx, SUG, 'Go to ' + nx.t); row.d = 'Next in The Pass.' + (nx.pv ? ' ' + nx.pv : ''); out.push(row); seen[nx.id] = 1; }
    }
    var n = noted(), k = n && !seen[n.id] ? all.filter(function (x) { return x.id === n.id; })[0] : null;
    if (k) { var row2 = ticketRow(k, SUG, 'Go to ' + k.t); row2.d = 'Your last note went here ' + core.ago(n.at, Date.now()).toLowerCase() + '.'; out.push(row2); }
    return out;
  }
  function items() {
    var all = tickets();
    if (S.step === 'goto') return core.filter(all.map(function (k) { return ticketRow(k, 'Go to a thread'); }), S.q);
    if (S.step === 'note') return core.filter(core.notePick(all, noteBlock).map(function (x) { return noteRow(x.k, x.why); }), S.q, true);
    if (S.hist >= 0) { var r = recent(); return r[S.hist] ? [histRow(r[S.hist], S.hist, r.length)] : []; }
    if (!S.q.trim()) return S.sug ? suggestions(all) : [];
    var out = core.filter(commands(all), S.q), ids = {};
    out.forEach(function (x) { ids[x.id] = 1; });
    // Threads match only once you type, after the actions.
    var th = core.filter(all.map(function (k) { return ticketRow(k, 'Threads: on the board'); }), S.q).filter(function (x) { return !ids[x.id]; });
    return out.concat(th.slice(0, 8));
  }
  function noteRow(k, why) {
    var r = ticketRow(k, why ? 'Takes no note now' : 'Pick a thread');
    r.id = 'note:' + k.id; r.hist = 'Send a note to ' + k.t; r.compose = k.id; r.run = null;
    if (why) { r.off = true; r.d = why; }
    else if (callOpen(k.id)) r.d = 'Its call waits on you' + (r.d ? ' · ' + r.d : '');
    return r;
  }
  // A row's action, found again from the page as it is now, so a refresh between showing and running never runs a
  // stale button. A ticket's action is found on that ticket even when another one is open.
  function resolve(id) {
    if (id.indexOf('tk:') === 0) return ticketActions(app.plateNode(id.split(':')[1])).filter(function (x) { return x.id === id; })[0] || null;
    var all = tickets();
    if (id.indexOf('go:') === 0) { var k = all.filter(function (x) { return 'go:' + x.id === id; })[0]; return k ? ticketRow(k, '') : null; }
    if (id.indexOf('note:') === 0) { var kn = all.filter(function (x) { return 'note:' + x.id === id; })[0]; return kn ? noteRow(kn, '') : null; }
    return commands(all).filter(function (x) { return x.id === id && !x.off && !x.step; })[0] || null;
  }
  // Open a ticket where the view shows it: in the list it is in (the open one if it is there, else The Pass, else its
  // stage), or in the full kitchen's sheet.
  function goTo(pid) {
    var st = app.state, s = sel(pid), t = null;
    var hit = $$('.head-b .folder ' + s).filter(function (x) { return x.tagName !== 'FORM' && !x.classList.contains('gone'); });
    var inF = function (name) { return hit.filter(function (x) { return x.closest('.folder').dataset.folder === name; })[0]; };
    if (st.view === 'pass') {
      t = inF(st.folder) || inF('pass') || hit[0] || null;
      if (t && t.closest('.folder').dataset.folder !== st.folder) app.setFolder(t.closest('.folder').dataset.folder);
    } else {
      t = $('.rail ' + s) || $('.spike-b ' + s) || $('.shelf ' + s);
      st.listKey = t ? app.listKeyOf(t) : null;
    }
    app.select(pid);
    if (t && t.scrollIntoView) t.scrollIntoView({ block: 'nearest' });
  }

  // ----- Drawing -----
  function render() {
    var r = recent(), waiting = blank() && !S.sug;
    var writing = S.step === 'compose';
    input.placeholder = writing ? '' : S.step ? 'Which thread? Type its name' : 'Search actions, threads and settings';
    input.disabled = writing;
    crumb.hidden = !S.step;
    crumb.innerHTML = S.step === 'goto' ? 'Go to a thread' : S.step === 'note' ? 'Send a note' : writing ? 'Send a note<svg viewBox="0 0 16 16" aria-hidden="true"><use href="#cb-jump"/></svg><span class="cb-ct">' + esc(toTitle()) + '</span>' : '';
    res.hidden = writing; compose.hidden = !writing;
    if (writing) {
      hint.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      foot.innerHTML = '<span>' + keys(['⌘', '↵']) + 'Send</span><span>' + keys(['esc']) + 'Back</span><span class="r cb-note">Your note stays on the ticket as a draft</span>';
      return;
    }
    hint.hidden = !waiting;
    hint.innerHTML = waiting ? (r.length ? keys(['↑']) + 'Last action<span class="cb-gap"></span>' : '') + keys(['↓']) + 'Suggestions' : '';
    input.setAttribute('aria-expanded', String(!waiting));
    // Empty and not suggesting: the list folds away with what it last held, so the fold has something to fold.
    if (waiting) { S.rows = []; input.removeAttribute('aria-activedescendant'); return; }
    var rows = S.rows = items();
    S.sel = Math.max(0, Math.min(S.sel, rows.length - 1));
    if (rows[S.sel] && rows[S.sel].off) S.sel = live(S.sel, 1);
    var html = '', g = null, n = 0;
    rows.forEach(function (x, i) {
      if (x.g !== g) { g = x.g; var parts = String(g).split(': '); html += '<div class="cb-gh" role="presentation" style="--i:' + (n++) + '">' + esc(parts[0]) + (parts.length > 1 ? '<span>' + esc(parts.slice(1).join(': ')) + '</span>' : '') + '</div>'; }
      html += '<div class="cb-it' + (i === S.sel ? ' sel' : '') + (x.off ? ' off' : '') + '" role="option" id="cb-o' + i + '" aria-selected="' + (i === S.sel) + '"' + (x.off ? ' aria-disabled="true"' : '') + ' data-i="' + i + '" style="--i:' + (n++) + '">'
        + x.icon + '<span class="cb-t"><b>' + esc(x.t) + '</b>' + (x.d ? '<small>' + esc(x.d) + '</small>' : '') + '</span>'
        + '<span class="cb-k">' + (x.tag ? '<span class="cb-tag">' + esc(x.tag) + '</span>' : '') + (x.now ? '<span class="cb-tag now">Now</span>' : '') + (x.right || '') + keys(x.k) + '</span></div>';
    });
    var empty = S.sug && !S.q ? 'Nothing to suggest yet. Type to search every action.'
      : S.step && !S.q.trim() ? 'No thread on the board yet.'
      : S.step ? 'No thread on the board matches “' + esc(S.q.trim()) + '”.'
      : 'Nothing matches “' + esc(S.q.trim()) + '”. Try a thread’s name, an action or a setting.';
    clearTimeout(popT); res.classList.toggle('popin', S.pop);
    if (S.pop) popT = setTimeout(function () { res.classList.remove('popin'); }, core.popEnd(n));
    S.pop = false;
    res.innerHTML = (S.msg ? '<div class="cb-empty" role="status">' + esc(S.msg) + '</div>' : '') + (html || (S.msg ? '' : '<div class="cb-empty">' + empty + '</div>'));
    // New rows start at the top, where the highlight is.
    res.scrollTop = 0;
    S.msg = '';
    var f;
    if (S.hist >= 0) f = '<span>' + keys(['↑']) + 'Earlier</span><span>' + keys(['↓']) + 'Later</span><span>' + keys(['↵']) + 'Run again</span><span class="r cb-note">Like ↑ in a terminal</span>';
    else if (S.sug && !S.q && !S.step) f = '<span class="cb-move">' + keys(['↑', '↓']) + 'Move</span><span>' + keys(['↵']) + 'Run</span>' + (r.length || noted() ? '<span class="r"><button type="button" data-cb-clear>Clear recent actions</button></span>' : '');
    else f = '<span class="cb-move">' + keys(['↑', '↓']) + 'Move</span><span>' + keys(['↵']) + 'Run</span>' + (S.step ? '<span>' + keys(['⌫']) + 'Back</span>' : '<span class="r cb-note">Each action shows its key on the right</span>');
    foot.innerHTML = f;
    mark(false);
  }
  // The next row from i in a direction that can run; a "not checked" row never takes the highlight.
  function live(i, dir) {
    var n = S.rows.length;
    for (var k = 0; k < n; k++) { var j = ((i + dir * k) % n + n) % n; if (!S.rows[j].off) return j; }
    return i;
  }
  // Moves the highlight without rebuilding the rows, so hovering never cuts the pop-in short.
  function mark(scroll) {
    var any = false;
    $$('.cb-it', res).forEach(function (el) {
      var on = +el.dataset.i === S.sel; el.classList.toggle('sel', on); el.setAttribute('aria-selected', String(on));
      if (on) { any = true; input.setAttribute('aria-activedescendant', el.id); if (scroll !== false) el.scrollIntoView({ block: 'nearest' }); }
    });
    if (!any) input.removeAttribute('aria-activedescendant');
  }

  // ----- Motion: up at the typing position, or down at the window's centre -----
  function measure() {
    var h = window.innerHeight, top = Math.max(12, Math.min(112, Math.round(h * 0.125)));
    var qh = $('.cb-q', box).offsetHeight || 60;
    box.style.setProperty('--cb-top', top + 'px');
    box.style.setProperty('--cb-cy', Math.max(0, Math.round(h / 2 - qh / 2 - top)) + 'px');
  }
  // Snap skips the motion, for opening. Reduce Motion fades out, moves, and fades in.
  // A dip under way is never cut short: when it ends, it lands wherever the bar should be by then.
  function undip() { clearTimeout(dipT); dipT = 0; box.classList.remove('dip'); }
  function place(up, snap) {
    if (snap) { undip(); box.classList.add('snap'); box.classList.toggle('center', !up); void box.offsetHeight; box.classList.remove('snap'); S.up = up; return; }
    if (S.up === up) return;
    S.up = up;
    if (!app.reduce.matches) { undip(); box.classList.toggle('center', !up); return; }
    if (dipT) return;
    box.classList.add('dip');
    dipT = setTimeout(function () { dipT = 0; box.classList.toggle('center', !S.up); box.classList.remove('dip'); }, 110);
  }
  // The five-second count: empty at the centre for 5 s, then up with the last action and the suggestions.
  function startCount() { clearTimeout(countT); countT = setTimeout(function () { if (dlg.open && blank() && !S.sug) showSug(); }, core.COUNT_MS); }
  function stopCount() { clearTimeout(countT); }
  function showSug() { clearTimeout(sinkT); stopCount(); S.sug = true; S.sel = 0; S.pop = true; render(); place(true); }
  // After the field changes. Text: up now. Empty: wait a beat so a quick retype does not bounce it, then down and count.
  function changed() {
    S.sel = 0; clearTimeout(sinkT);
    if (!blank()) { stopCount(); S.sug = false; render(); place(true); return; }
    S.sug = false; render();
    sinkT = setTimeout(function () { if (dlg.open && blank() && !S.sug) { place(false); startCount(); } }, core.SINK_MS);
  }
  function recall(i) { var r = recent(); if (!r[i]) return; clearTimeout(sinkT); stopCount(); S.sug = false; S.hist = i; S.q = r[i].t; input.value = S.q; S.sel = 0; render(); place(true); }

  // ----- Writing a note -----
  function toTitle() { var k = S.to && tickets().filter(function (x) { return x.id === S.to; })[0]; return k ? k.t : 'this thread'; }
  function writeTo(pid) {
    var f = noteForm(pid), k = tickets().filter(function (x) { return x.id === pid; })[0];
    clearTimeout(sinkT); stopCount();
    S.step = 'compose'; S.to = pid; S.q = ''; S.hist = -1; S.sug = false; input.value = '';
    var st = k && k.stage ? stageOf(k.stage) : null;
    toCard.innerHTML = (k && k.mark ? '<span class="cb-ic cb-pm" aria-hidden="true">' + k.mark + '</span>' : ic('note'))
      + '<span class="cb-t"><b>' + esc(k ? k.t : 'This thread') + '</b><small>' + esc([k && k.project, st && st.label, k && k.pass ? 'In The Pass' : ''].filter(Boolean).join(' · ')) + '</small></span>';
    // The ticket's own draft, if it has one, so a note started there or here carries on.
    $('.cb-why', compose).textContent = callOpen(pid) ? 'Goes to the agent as your Reply to its call, queued like T3 Code\'s own queue.'
      : 'Goes to the agent as your message, queued like T3 Code\'s own queue.';
    note.value = f ? f.elements.note.value : ''; say.textContent = ''; say.className = 'cb-say';
    render(); place(true); note.focus();
    if (app.grow) app.grow(note);
  }
  // Every keystroke goes into the ticket's own note, so the page saves it as that ticket's draft, as typing there does.
  // The ticket's own limit (4,000). The bar's field has no maxlength, so a long paste is never cut: past the limit it says
  // so, keeps the ticket's draft at its last fitting text, and sends nothing.
  function tooLong(f) {
    var max = f.elements.note.maxLength;
    return max > 0 && note.value.length > max ? 'The note is ' + note.value.length + ' characters. A note holds ' + max + '. Shorten it first.' : '';
  }
  note.addEventListener('input', function () {
    var f = S.to && noteForm(S.to); if (!f || f.dataset.busy) return;
    var long = tooLong(f);
    if (long) { say.textContent = long; say.className = 'cb-say bad'; return; }
    f.elements.note.value = note.value; f.elements.note.dispatchEvent(new Event('input', { bubbles: true }));
    if (say.textContent) { say.textContent = ''; say.className = 'cb-say'; }
  });
  function sendNote() {
    if (S.step !== 'compose') return;
    var why = noteBlock(S.to);
    if (why) { say.textContent = why + '.'; say.className = 'cb-say bad'; return; }
    if (!note.value.trim()) { say.textContent = 'Write the note first.'; say.className = 'cb-say bad'; note.focus(); return; }
    var f = noteForm(S.to), b = $('button[name=kind][value=reply]', f), long = tooLong(f);
    if (long) { say.textContent = long; say.className = 'cb-say bad'; note.focus(); return; }
    f.elements.note.value = note.value; f.elements.note.dispatchEvent(new Event('input', { bubbles: true }));
    ran = true; close();
    app.send(f, b);
  }
  function back() { S.step = 'note'; S.to = null; S.q = ''; S.hist = -1; input.value = ''; input.disabled = false; changed(); input.focus(); }
  compose.addEventListener('click', function (ev) {
    if (ev.target.closest('[data-cb-send]')) sendNote();
    else if (ev.target.closest('[data-cb-back]')) back();
  });

  // ----- Running -----
  function remember(id, t) { app.store(RECENT, JSON.stringify(core.pushRecent(recent(), id, t, Date.now()))); }
  function runRow(row) {
    if (!row || row.off) return;
    if (row.step) { S.step = row.step; S.q = ''; input.value = ''; S.hist = -1; changed(); return; }
    var live = resolve(row.id);
    if (!live) { S.msg = 'No longer available: ' + row.t + '. The board has changed since.'; render(); return; }
    // A row runs only what it says. If the same action now reads differently (another pick on the same call, or the
    // view's toggle turned the other way), it runs nothing and says what it would do now. A saved row compares by its
    // whole label's fingerprint, since its text is cut to 200 characters.
    var was = row.hist || row.t, now = live.hist || live.t;
    if (row.f ? core.fp(now) !== row.f : was !== now) { S.msg = 'Changed since: “' + was + '” would now be “' + now + '”. Nothing ran.'; render(); return; }
    if (live.compose) {
      var why = noteBlock(live.compose);
      if (why) { S.msg = live.t + ': ' + why + '.'; render(); return; }
      remember(live.id, now); writeTo(live.compose); return;
    }
    remember(live.id, now);
    ran = true; close();
    var m = app.mounted();
    if (live.pid && (!m || m.id !== live.pid)) goTo(live.pid);
    live.run();
  }
  function escape() {
    if (S.step === 'compose') { back(); return; }
    if (S.step || S.q || S.hist >= 0) { S.step = null; S.q = ''; S.hist = -1; input.value = ''; changed(); return; }
    close();
  }
  function open() {
    if (dlg.open) return;
    // Focus leaves the page before the dialog opens, so the browser has nothing to put it back on when it closes.
    prev = document.activeElement; ran = false;
    if (prev && prev !== document.body && prev.blur) prev.blur();
    S.q = ''; S.sel = 0; S.step = null; S.sug = false; S.hist = -1; S.pop = false; S.msg = ''; S.rows = []; S.to = null;
    input.value = ''; input.disabled = false; res.innerHTML = ''; foot.innerHTML = '';
    dlg.showModal(); measure(); place(false, true); render(); app.liftToast(); input.focus(); startCount();
  }
  function close() { stopCount(); clearTimeout(sinkT); clearTimeout(popT); undip(); if (dlg.open) dlg.close(); }

  input.addEventListener('input', function () { S.q = input.value; S.hist = -1; changed(); });
  dlg.addEventListener('keydown', function (ev) {
    if (ev.isComposing || ev.keyCode === 229) return;
    if (S.step === 'compose' && ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey) && !ev.altKey && !ev.shiftKey) { ev.preventDefault(); ev.stopPropagation(); if (!ev.repeat) sendNote(); return; }
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    var n = S.rows.length;
    if (ev.key === 'Escape') { ev.preventDefault(); ev.stopPropagation(); escape(); return; }
    // Everything else belongs to the field. Tab moves between the field and the footer's button, as anywhere else.
    if (ev.target !== input) return;
    if (ev.key === 'ArrowUp') {
      ev.preventDefault(); ev.stopPropagation();
      if (S.hist >= 0) { if (S.hist < recent().length - 1) recall(S.hist + 1); return; }
      if (blank() && recent().length && (!S.sug || S.sel === 0)) { recall(0); return; }
      if (blank() && !S.sug) return;
      if (n) { S.sel = live(S.sel - 1, -1); mark(); }
      return;
    }
    if (ev.key === 'ArrowDown') {
      ev.preventDefault(); ev.stopPropagation();
      if (S.hist >= 0) { if (S.hist > 0) recall(S.hist - 1); else { S.hist = -1; S.q = ''; input.value = ''; changed(); } return; }
      if (blank() && !S.sug) { showSug(); return; }
      if (n) { S.sel = live(S.sel + 1, 1); mark(); }
      return;
    }
    if (ev.key === 'Enter') { ev.preventDefault(); ev.stopPropagation(); if (!ev.repeat && (!blank() || S.sug)) runRow(S.rows[S.sel]); return; }
    if (ev.key === 'Backspace' && S.step && !input.value) { ev.preventDefault(); S.step = null; changed(); return; }
  });
  // Esc that reaches the dialog itself (focus off the field) clears and closes the same way.
  dlg.addEventListener('cancel', function (ev) { ev.preventDefault(); escape(); });
  dlg.addEventListener('close', function () {
    stopCount(); clearTimeout(sinkT); clearTimeout(popT); undip();
    var p = prev; prev = null;
    if (!ran && p && p !== document.body && p.isConnected && !p.disabled && p.focus) p.focus({ preventScroll: true });
    ran = false; app.liftToast(); app.yieldKey();
  });
  dlg.addEventListener('click', function (ev) { if (ev.target === dlg) close(); });
  // A click anywhere in the bar but the field keeps the typing in the field, as the keys above expect.
  box.addEventListener('mousedown', function (ev) { if (ev.target !== input) ev.preventDefault(); });
  res.addEventListener('click', function (ev) { var it = ev.target.closest('.cb-it'); if (it) runRow(S.rows[+it.dataset.i]); });
  res.addEventListener('mousemove', function (ev) { var it = ev.target.closest('.cb-it'); if (!it || it.classList.contains('off') || +it.dataset.i === S.sel) return; S.sel = +it.dataset.i; mark(false); });
  // Apple's HIG asks for a way to clear history: this clears the recent actions and the last note's thread.
  foot.addEventListener('click', function (ev) {
    if (!ev.target.closest('[data-cb-clear]')) return;
    app.forget(RECENT); app.forget(NOTED); S.sel = 0; S.msg = 'Recent actions cleared.'; render(); input.focus();
  });
  window.addEventListener('resize', function () { if (dlg.open) measure(); });

  return {
    open: open, close: close, toggle: function () { if (dlg.open) close(); else open(); },
    isOpen: function () { return dlg.open; },
    // A note reached a thread: it becomes the "your last note" suggestion.
    noted: function (pid) { if (pid) app.store(NOTED, JSON.stringify({ id: pid, at: Date.now() })); },
  };
}
