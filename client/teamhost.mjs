// The team inside the board server (step 3b, PR 3): the /team page and the kind=team actions. It keeps one Team
// (client/team.mjs) alive, hands it each board the Pass reads, and saves its state through `store`. The desktop app's
// store seals the state with the Keychain-held key before it touches a disk (desktop/main.mjs); the web prototype keeps
// it in memory only, so a prototype run never writes a private key to a file.
import { createTeam, joinTeam, Team, webNet } from './team.mjs';
import { readInvite } from './seal.mjs';
import { teamPage, teamBody, DEFAULT_RELAY, SITE } from './teamui.mjs';

const ok = (text = 'Done.') => ({ status: 200, text });
const no = (text, status = 400) => ({ status, text: String(text || 'Not done.').slice(0, 300) });
const list = (v) => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const said = (r, done = 'Done.') => (r && (r.t === 'ok' || r.link) ? ok(done) : no(r?.text || r?.error));

/** A relay address a lead may type: https, or a local one for a test. */
export function relayUrl(text) {
  try {
    const u = new URL(String(text || '').trim() || DEFAULT_RELAY);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
    return u.origin;
  } catch { return null; }
}

/** store: { load() -> state or null, save(state or null) }. run(input, prefix, extra): an action on this dev's board.
 *  boardOf(): { board, ok, at }. projectsOf(): T3 Code's projects. t3Ok(): whether the board reads T3 Code now. */
export function teamHost({ store, run, boardOf, projectsOf = () => [], t3Ok = () => false, net = webNet, now = Date.now, timers = globalThis, site = SITE }) {
  let team = null, state = null, ready = null, busy = Promise.resolve(), lost = '';
  // The store's answer goes back to the team client: a save it awaits (an action's id) fails when the store did.
  const save = (s) => {
    state = s;
    const done = Promise.resolve().then(() => store.save(s));
    done.catch((ex) => console.error('The team did not save:', String(ex?.message || ex).slice(0, 120)));
    return done;
  };

  function live(s) {
    team?.stop();
    team = null; state = s;
    if (!s) return;
    team = new Team({ state: s, save, net, now, timers, run, board: boardOf });
    team.start();
  }

  /** Read the saved team, once, at start. A state that does not load is reported and left on disk untouched. */
  function start() {
    return ready ||= Promise.resolve().then(() => store.load()).then((s) => { if (s) live(s); }, (ex) => {
      // The saved team stays where it is: a new team or a join must not write over it.
      lost = String(ex?.message || ex).slice(0, 120);
      console.error('The saved team did not load:', lost);
    });
  }

  const projectRows = () => {
    const tickets = boardOf()?.board?.tickets || [];
    const count = (id) => tickets.filter((k) => k.thread?.projectId === id).length;
    const ok = !!boardOf()?.ok;
    return (projectsOf() || []).map((p) => ({ id: p.id, title: p.title, threads: ok ? count(p.id) : null }));
  };

  /** The page, or null for any other path. ?join=<the link's fragment> shows Join for that invite. */
  function route(url) {
    if (url.pathname !== '/team') return null;
    const v = team?.view() || null;
    const raw = url.searchParams.get('join');
    const inv = raw && !v ? readInvite(raw) : null;
    const opts = { lost, view: v, join: inv && { ...inv, raw }, links: team && v?.status === 'member' ? team.links({ site }) : [],
      projects: projectRows(), shared: state?.shared || [], t3: { ok: t3Ok() }, now: now(), name: state?.name || '' };
    const page = teamPage(opts);
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: page };
  }

  /** One kind=team action. One at a time: two clicks never race on the roster. */
  function act(input) {
    const next = busy.then(() => step(input), (ex) => no(`Not done: ${ex?.message || ex}`, 500));
    busy = next.catch(() => {});
    return next;
  }

  /** A new team or join is live at once and saved before it says done. A failed save keeps the keys in use, says so,
   *  and shows "Not saved" until a later save gets through (PR-Agent r1 on #8). */
  async function kept(s, done) {
    live(s);
    if (await team.saveNow()) return ok(done);
    return no('Not saved: Yes Chef could not save the team on this Mac. It is in use now; keep Yes Chef open, check the disk and the Keychain, then try any change again.', 503);
  }

  async function step(input) {
    const op = String(input.op || '');
    // The saved team loads first: a make or a join while the Keychain answers must not write over it (PR-Agent r1 on #8).
    await start();
    if (lost) return no(`Not checked: the saved team did not load (${lost}). Quit Yes Chef and start it again.`, 503);
    if (op === 'create') {
      if (team) return no('This Mac is already on a team. Leave it first.', 409);
      const relay = relayUrl(input.relay);
      if (!relay) return no('The relay must be an https address, like ' + DEFAULT_RELAY + '.');
      if (!String(input.teamName || '').trim() || !String(input.name || '').trim()) return no('Type a team name and your name.');
      const s = await createTeam({ relay, teamName: input.teamName, name: input.name, net, now });
      return kept(s, 'Team made.');
    }
    if (op === 'join') {
      if (team) return no('This Mac is already on a team. Leave it first.', 409);
      const ids = list(input.shared);
      const titles = (projectsOf() || []).filter((p) => ids.includes(p.id)).map((p) => p.title);
      const s = await joinTeam({ link: String(input.link || ''), name: input.name, projects: titles, shared: ids, net, now });
      return kept(s, 'Asked.');
    }
    if (op === 'forgetLink') return ok();
    if (!team) return no('This Mac is not on a team.', 409);
    if (op === 'leave') { team.stop(); live(null); save(null); return ok('Left.'); }
    if (op === 'share') {
      if (!(await team.share(list(input.shared)))) return no('Not saved: Yes Chef could not save the shared projects on this Mac. They are in use now; try again shortly.', 503);
      return ok('Saved.');
    }
    const m = String(input.m || '');
    const area = String(input.area || '') || null;
    switch (op) {
      case 'invite': return said(await team.invite({ site }), 'Link made.');
      case 'approve': return said(await team.approve(m, String(input.role || 'engineer'), list(input.perms), area), 'Added.');
      case 'decline': return said(await team.decline(m), 'Declined.');
      case 'setRole': return said(await team.setRole(m, String(input.role || ''), list(input.perms), area), 'Saved.');
      case 'remove': return said(await team.remove(m), 'Removed.');
      case 'addArea': return said(await team.addArea(input.name), 'Added.');
      case 'renameArea': return said(await team.renameArea(String(input.id || ''), input.name), 'Renamed.');
      case 'removeArea': return said(await team.removeArea(String(input.id || '')), 'Removed.');
      default: return no('Unknown team action.');
    }
  }

  return {
    start, route, act,
    /** The Pass read a board: the team's summary follows it. */
    board(b) { if (team && b) team.board(b); },
    /** A board read failed: teammates read this Mac as not checked since then. */
    health(ok) { team?.health(ok); },
    wake() { team?.wake(); },
    stop() { team?.stop(); },
    view: () => team?.view() || null,
    /** For tests: the live team client. */
    _team: () => team,
    body: (opts) => teamBody(opts),
  };
}
