// The team inside the board server (step 3b, PR 3): the /team page and the kind=team actions. It keeps one Team
// (client/team.ts) alive, hands it each board the Pass reads, and saves its state through `store`. The desktop app's
// store seals the state with the Keychain-held key before it touches a disk (desktop/main.ts); the web prototype keeps
// it in memory only, so a prototype run never writes a private key to a file.
import { createTeam, joinTeam, Team, webNet } from './team.ts';
import type { OwnBoard, TeamNet, TeamRun, TeamState, TeamTimers, View } from './team.ts';
import type { Readers } from './team-summaries.ts';
import type { Board } from './board.ts';
import { b64u, readInvite, sha256 } from './seal.ts';
import { outgoing } from './team-acts.ts';
import { may } from './open-kitchen.ts';
import { teamPage, teamBody, DEFAULT_RELAY, SITE } from './teamui.ts';
import type { PageOptions } from './teamui.ts';

/** Where the team's state is kept: the desktop app seals it with the Keychain-held key; the prototype keeps it in memory. */
export interface TeamStore { load(): TeamState | null | Promise<TeamState | null>; save(state: TeamState | null): unknown }
/** A project as T3 Code names it. */
export interface HostProject { id: string; title: string }
export interface HostOptions {
  store: TeamStore; run: TeamRun | null; boardOf: () => OwnBoard | null | undefined; projectsOf?: () => readonly HostProject[] | null | undefined;
  t3Ok?: () => boolean; net?: TeamNet; now?: () => number; timers?: TeamTimers; site?: string;
  /** The team the screens draw changed: a teammate's summary, who is online, the roster, the relay link, or this Mac
   *  joined or left. The server reads the board again, so Your team shows it (PR D). */
  changed?: () => void;
}
/** A kind=team action's fields, as the page posts them. */
export type TeamInput = Readonly<Record<string, string | undefined>>;
/** What an action answers: an HTTP status and the words the page shows. */
export interface Said { status: number; text: string }
/** A page answer: status, headers and the HTML. */
export interface Routed { status: number; headers: Record<string, string>; body: string }

const ok = (text = 'Done.'): Said => ({ status: 200, text });
const no = (text: unknown, status = 400): Said => ({ status, text: String(text || 'Not done.').slice(0, 300) });
const list = (v: unknown): string[] => String(v || '').split(',').map((s) => s.trim()).filter(Boolean);
const said = (r: { t?: unknown; link?: unknown; text?: unknown; error?: unknown } | null | undefined, done = 'Done.'): Said => (r && (r.t === 'ok' || r.link) ? ok(done) : no(r?.text || r?.error));

/** A relay address a lead may type: https, or a local one for a test. */
export function relayUrl(text: unknown): string | null {
  try {
    const u = new URL(String(text || '').trim() || DEFAULT_RELAY);
    if (u.protocol !== 'https:' && !['127.0.0.1', 'localhost'].includes(u.hostname)) return null;
    if (u.username || u.password || u.search || u.hash || (u.pathname !== '/' && u.pathname !== '')) return null;
    return u.origin;
  } catch { return null; }
}

/** store: { load() -> state or null, save(state or null) }. run(input, prefix, extra): an action on this dev's board.
 *  boardOf(): { board, ok, at }. projectsOf(): T3 Code's projects. t3Ok(): whether the board reads T3 Code now. */
export function teamHost({ store, run, boardOf, projectsOf = () => [], t3Ok = () => false, net = webNet, now = Date.now, timers = globalThis, site = SITE, changed = () => {} }: HostOptions) {
  let team: Team | null = null, state: TeamState | null = null, ready: Promise<void> | null = null, busy: Promise<unknown> = Promise.resolve(), lost = '', gen = 0;
  // The store's answer goes back to the team client: a save it awaits (an action's id) fails when the store did.
  const save = (s: TeamState | null): Promise<unknown> => {
    state = s;
    const done = Promise.resolve().then(() => store.save(s));
    done.catch((ex: unknown) => console.error('The team did not save:', String((ex as Error)?.message || ex).slice(0, 120)));
    return done;
  };

  function live(s: TeamState | null): void {
    team?.stop();
    team = null; state = s;
    if (!s) { changed(); return; }
    // Each client saves only while it is the live one: a save queued by a team this Mac left never lands after the
    // deletion (PR-Agent r3 on #8).
    const mine = ++gen;
    const own = (x: TeamState): Promise<unknown> => (mine === gen ? save(x) : Promise.reject(new Error('This team was left on this Mac.')));
    team = new Team({ state: s, save: own, net, now, timers, run, board: boardOf });
    // Only what the screens draw: the roster, summaries and presence ('team'), the relay link, and this Mac's status.
    team.on((ev) => { if (mine === gen && (ev.type === 'team' || ev.type === 'link' || ev.type === 'status')) changed(); });
    team.start();
    changed();
  }

  /** Read the saved team, once, at start. A state that does not load is reported and left on disk untouched. */
  function start(): Promise<void> {
    return ready ||= Promise.resolve().then(() => store.load()).then((s) => { if (s) live(s); }, (ex: unknown) => {
      // The saved team stays where it is: a new team or a join must not write over it.
      lost = String((ex as Error)?.message || ex).slice(0, 120);
      console.error('The saved team did not load:', lost);
    });
  }

  const projectRows = () => {
    const tickets = boardOf()?.board?.tickets || [];
    const count = (id: string): number => tickets.filter((k) => k.thread?.projectId === id).length;
    const ok = !!boardOf()?.ok;
    return (projectsOf() || []).map((p) => ({ id: p.id, title: p.title, threads: ok ? count(p.id) : null }));
  };

  /** The page, or null for any other path. ?join=<the link's fragment> shows Join for that invite. */
  function route(url: URL): Routed | null {
    if (url.pathname !== '/team') return null;
    const v = team?.view() || null;
    const raw = url.searchParams.get('join');
    const inv = raw && !v ? readInvite(raw) : null;
    const opts: PageOptions = { lost, view: v, join: inv && { ...inv, raw }, links: team && v?.status === 'member' ? team.links({ site }) : [],
      projects: projectRows(), shared: state?.shared || [], t3: { ok: t3Ok() }, now: now(), name: state?.name || '' };
    const page = teamPage(opts);
    return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }, body: page };
  }

  /** One kind=team action. One at a time: two clicks never race on the roster. */
  function act(input: TeamInput): Promise<Said> {
    const next = busy.then(() => step(input), (ex: unknown) => no(`Not done: ${(ex as Error)?.message || ex}`, 500));
    busy = next.catch(() => {});
    return next;
  }

  /** A new team or join is live at once and saved before it says done. A failed save keeps the keys in use, says so,
   *  and shows "Not saved" until a later save gets through (PR-Agent r1 on #8). */
  async function kept(s: TeamState, done: string): Promise<Said> {
    live(s);
    if (await team!.saveNow()) return ok(done);
    return no('Not saved: Yes Chef could not save the team on this Mac. It is in use now; keep Yes Chef open, check the disk and the Keychain, then try any change again.', 503);
  }

  async function step(input: TeamInput): Promise<Said> {
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
    if (op === 'act') {
      // A call on a teammate's ticket (team-acts.ts). The page's one-time id becomes the relay's delivery id, so a
      // retry of the same send is the same action to the dev's Yes Chef.
      const out = outgoing(input);
      if (!('action' in out)) return no(out.text, out.status);
      const nonce = String(input.nonce || '');
      if (!nonce) return no('Missing action id. Reload the Pass.');
      const r = await team.act(out.to, out.action, b64u(await sha256(`team-act:${nonce}`)).slice(0, 22));
      const sent = r.status === 200 && ['reply', 'refire', 'rebase', 'rollback', 'ship'].includes(String(input.act));
      // Ship sent: its mark keeps the feature's call off every Pass (open-kitchen.ts finesOf, SHIP_MS).
      if (sent && input.act === 'ship' && team.markShip(String(input.call || ''))) changed();
      return { status: r.status, text: sent ? `Sent to ${team.people.get(out.to)?.name || 'the dev'}’s agent.` : String(r.text || 'No answer.').slice(0, 300) };
    }
    if (op === 'fine') {
      // It's fine (Dan, 2026-11-13, "A"): the call leaves every Pass that shows it, recorded with who and when in this
      // Mac's summary (team-summaries.ts markFine). It tells no agent anything, so a note would be lost: refused.
      const me = team.view().me;
      if (!may({ ...me, id: me.id ?? null }, 'fine')) return no('Not cleared: your role can see this call. Clearing it needs more from your lead.', 403);
      if (String(input.note ?? '').trim()) return no('It’s fine sends the agent nothing, so your note would be lost. Send it with Reply first, or clear it.');
      if (!team.markFine(String(input.call || ''))) return no('Not checked: this card names no call to clear.', 409);
      changed();
      return ok('Cleared for your team.');
    }
    if (op === 'leave') {
      // Forgotten only once the saved team is gone from disk: else a restart would bring the ask back (PR-Agent r2 on #8).
      // Stop the client and let its queued saves finish first, so the deletion is the last write (PR-Agent r3 on #8).
      const was = state, t: Team = team;
      t.stop(); gen++; team = null;
      await t.writes?.catch(() => {});
      try { await save(null); } catch { live(was); return no('Not done: Yes Chef could not forget the team on this Mac. It is still saved; try again.', 503); }
      state = null;
      changed();
      return ok('Left.');
    }
    if (op === 'saveAgain') {
      if (await team.saveNow()) return ok('Saved.');
      return no('Not saved: Yes Chef still could not save the team on this Mac. Keep Yes Chef open and try again.', 503);
    }
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
      // Settings -> Rules: the team's Rules and each area's projects, mode and budget, signed into the roster.
      case 'teamRule': return said(await team.setTeamRule(String(input.key || ''), String(input.value ?? '')), 'Saved. Your team has it.');
      case 'areaRule': return said(await team.setArea(String(input.id || ''), String(input.field || ''), String(input.value ?? ''), input.on === '1'), 'Saved. Your team has it.');
      default: return no('Unknown team action.');
    }
  }

  return {
    start, route, act,
    /** The Pass read a board: the team's summary follows it, with what the board server reads beside it (3b PR 4). */
    board(b: Board | null | undefined, readers?: Readers): void { if (team && b) team.board(b, readers); },
    /** A reader beside the board has news: the summary follows, only when it changed. */
    readersMoved(): void { team?.readersMoved(); },
    /** A board read failed: teammates read this Mac as not checked since then. */
    health(ok: boolean): void { team?.health(ok); },
    wake(): void { team?.wake(); },
    stop(): void { team?.stop(); },
    view: (): View | null => team?.view() || null,
    /** For tests: the live team client. */
    _team: (): Team | null => team,
    body: (opts: PageOptions): string => teamBody(opts),
  };
}
