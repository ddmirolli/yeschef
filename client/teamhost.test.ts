// vp test client/teamhost.test.ts. The team page and its actions (step 3b, PR 3), on a fake relay.
import { test } from 'vite-plus/test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { fakeRelay, fakeNet } from '../relay/fake.ts';
import { teamHost, relayUrl } from './teamhost.ts';
import { teamPage, DEFAULT_RELAY } from './teamui.ts';
import type { FakeNet, FakeRelay } from '../relay/fake.ts';
import type { TeamStore } from './teamhost.ts';
import type { TeamState, View } from './team.ts';
import type { ActInput } from './actions.ts';
import type { Board, Ticket } from './board.ts';
import { renderApp, teamInputOf } from './board.ts';
import type { LinkRow, PageOptions, ProjectRow } from './teamui.ts';
import { grab, nth } from './test/expect.ts';

/** A store the test reads back: every state it was asked to save, in order. */
type Store = TeamStore & { saved: (TeamState | null)[] };
/** A view with only the fields a screen test sets: the page reads the others as missing. */
const viewOf = (v: object): View => v as View;
/** The page script as Node serves it. Node strips the types and keeps the text as written; Vitest's transform
 *  reprints it, so a test that reads the script's words reads it from Node. */
let served: string | undefined;
const servedScript = (): string => (served ??= grab(execFileSync(process.execPath, ['--input-type=module', '-e',
  "const { teamPage } = await import('./teamui.ts'); process.stdout.write(teamPage({}));"],
{ cwd: fileURLToPath(new URL('.', import.meta.url)), encoding: 'utf8' }), /<script>\(([\s\S]*?)\)\(\);<\/script>/, 1));
/** An invite as the page reads it, with only the fields a test sets. */
const joinOf = (j: object): NonNullable<PageOptions['join']> => j as NonNullable<PageOptions['join']>;

const until = async (cond: () => unknown, what: string): Promise<void> => { for (let i = 0; i < 2000; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out: ' + what); };
const projects = [{ id: 'p-app', title: 'app' }, { id: 'p-site', title: 'site' }];
/** The projects as the page lists them: no thread counts read. */
const rows = projects as ProjectRow[];

function host(relay: FakeRelay, net: FakeNet, store: Store = { saved: [], load: () => null, save(s) { this.saved.push(s && structuredClone(s)); } }) {
  const ran: ActInput[] = [];
  let changes = 0;
  const h = teamHost({ store, net, now: () => relay.now(), projectsOf: () => projects, t3Ok: () => true,
    boardOf: () => ({ board: { tickets: [] as Ticket[] } as Board, ok: true, at: relay.now() }), run: async (input) => { ran.push(input); return { status: 200, text: 'ok' }; },
    changed: () => { changes++; } });
  return { h, store, ran, changes: () => changes, page: (path = '/team') => h.route(new URL(path, 'http://x'))!.body };
}
const body = (html: string): string => nth(nth(html.split('<div id="yc-team">'), 1).split('<dialog'), 0);

async function pair() {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const lead = host(relay, net), dev = host(relay, net);
  await lead.h.start(); await dev.h.start();
  assert.equal((await lead.h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam Lead', relay: 'https://relay.test' })).status, 200);
  await until(() => lead.h.view()?.link === 'online', 'the lead online');
  assert.equal((await lead.h.act({ op: 'invite' })).status, 200);
  const link = grab(lead.page(), /value="(https:\/\/yeschef\.codes\/join#[^"]+)"/, 1);
  return { relay, net, lead, dev, link };
}

test('only /team is the team\'s; any other path is left to the board', () => {
  const relay = fakeRelay();
  const { h } = host(relay, fakeNet(relay));
  assert.equal(h.route(new URL('http://x/')), null);
  assert.equal(h.route(new URL('http://x/teams')), null);
  assert.match(h.route(new URL('http://x/team'))!.body, /Make a team/);
});

test('a lead makes a team, opens a link, and the dev\'s ask shows on the chart with the dev\'s own code', async () => {
  const { lead, dev, link } = await pair();
  assert.match(body(lead.page()), /Invite your team/);
  assert.match(body(lead.page()), /No one is waiting/);
  // The dev opens the link: Join names the lead and the team, and no key is made yet.
  const frag = nth(link.split('#'), 1);
  const join = body(dev.page('/team?join=' + encodeURIComponent(frag)));
  assert.match(join, /Join Fernpay/);
  assert.match(join, /Sam Lead invited you/);
  assert.equal(dev.store.saved.length, 0);
  assert.equal((await dev.h.act({ op: 'join', link: frag, name: 'Ada Lovelace', shared: 'p-app' })).status, 200);
  const code = dev.h.view()!.code!;
  assert.match(code, /^\d{3} \d{3}$/);
  assert.match(body(dev.page()), new RegExp(`<b>${code}</b>`));
  await until(() => lead.h.view()?.pending.length === 1, 'the ask at the lead');
  const chip = grab(body(lead.page()), /data-ask="[^"]+"[\s\S]*?<span class="code"[^>]*>([^<]+)</, 1);
  assert.equal(chip, code, 'the lead sees the same six digits beside the ask');
  assert.match(body(lead.page()), /Ada Lovelace/);
  assert.match(body(lead.page()), /app ·/, 'the project the dev named');
  lead.h.stop(); dev.h.stop();
});

test('approve into an area: the dev\'s page says the role and the area, and the chart puts them there', async () => {
  const { lead, dev, link } = await pair();
  await dev.h.act({ op: 'join', link: nth(link.split('#'), 1), name: 'Ada Lovelace', shared: 'p-app' });
  await until(() => lead.h.view()?.pending.length === 1, 'the ask');
  assert.equal((await lead.h.act({ op: 'addArea', name: 'Site' })).status, 200);
  const area = nth(lead.h.view()!.areas, 0);
  const m = nth(lead.h.view()!.pending, 0).m;
  const r = await lead.h.act({ op: 'approve', m, role: 'owner', perms: 'see,reply,merge', area: area.id });
  assert.equal(r.status, 200, r.text);
  await until(() => dev.h.view()?.status === 'member' && dev.h.view()?.me.role === 'owner', 'the dev in');
  const mine = body(dev.page());
  assert.match(mine, /You're on Fernpay/);
  assert.match(mine, /Area owner<\/span> in Site/);
  assert.match(mine, /Merge, Request changes or Hold/);
  const chart = body(lead.page());
  assert.match(nth(chart.split('data-area-id'), 1), /Ada Lovelace/, 'in the Site card');
  // The dev's switches save at once and stop sharing empties the list.
  assert.equal((await dev.h.act({ op: 'share', shared: '' })).status, 200);
  assert.deepEqual(dev.h.view() && dev.store.saved.at(-1)!.shared, []);
  lead.h.stop(); dev.h.stop();
});

test('the app draws Your team from the relay: the lead once someone is below them, never the dev (PR D)', async () => {
  const { lead, dev, link } = await pair();
  // As the server reads it (server.ts teamView, then teamInputOf).
  const asApp = (v: View | null) => teamInputOf(v && { ...v, me: { ...v.me, id: v.me.id ?? null } }, Date.now());
  // A lead alone, or with only an ask, has no one below: the app shows their own threads only.
  assert.equal(asApp(lead.h.view()), null);
  await dev.h.act({ op: 'join', link: nth(link.split('#'), 1), name: 'Ada Lovelace', shared: 'p-app' });
  await until(() => lead.h.view()?.pending.length === 1, 'the ask');
  assert.equal(asApp(lead.h.view()), null);
  const asked = lead.changes();
  const r = await lead.h.act({ op: 'approve', m: nth(lead.h.view()!.pending, 0).m, role: 'engineer', perms: 'see' });
  assert.equal(r.status, 200, r.text);
  await until(() => dev.h.view()?.status === 'member', 'the dev in');
  assert.ok(lead.changes() > asked, 'the roster change reached the server');
  const t = asApp(lead.h.view());
  assert.ok(t);
  assert.equal(t.mode, 'open', 'every area starts in Open kitchen (Dan, 3A)');
  assert.equal(t.name, 'Fernpay');
  assert.equal(asApp(dev.h.view()), null, 'the dev has no one below them');
  // The dev's board goes to the lead as a summary: the lead's server hears of it, and Your team draws Ada from it.
  const before = lead.changes();
  dev.h.board({ tickets: [] as Ticket[] } as Board);
  await until(() => lead.changes() > before && lead.h._team()?.summaries.size === 1, 'the summary at the lead');
  const html = renderApp({ board: { tickets: [], runsChecked: false }, link: () => 'x', status: { ok: true, at: Date.now(), ms: 1 },
    origin: 'https://t3.example', team: asApp(lead.h.view()) });
  assert.match(html, /<script type="application\/json" id="yc-team">\{"name":"Fernpay","below":1,"mode":"open"\}<\/script>/);
  assert.match(html, /Ada Lovelace/);
  // Leaving reaches the server too, and the dev's next page has no team.
  const left = dev.changes();
  assert.equal((await dev.h.act({ op: 'leave' })).status, 200);
  assert.ok(dev.changes() > left, 'leaving reached the server');
  assert.equal(dev.h.view(), null);
  lead.h.stop(); dev.h.stop();
});

test('decline, then the dev\'s page says so and OK forgets the team on this Mac', async () => {
  const { lead, dev, link } = await pair();
  await dev.h.act({ op: 'join', link: nth(link.split('#'), 1), name: 'Ada', shared: '' });
  await until(() => lead.h.view()?.pending.length === 1, 'the ask');
  await lead.h.act({ op: 'decline', m: nth(lead.h.view()!.pending, 0).m });
  await until(() => dev.h.view()?.status === 'declined', 'declined');
  assert.match(body(dev.page()), /The lead did not add you/);
  assert.equal((await dev.h.act({ op: 'leave' })).status, 200);
  assert.equal(dev.store.saved.at(-1), null, 'the saved team is deleted');
  assert.match(body(dev.page()), /Make a team/);
  lead.h.stop();
});

test('a saved team that did not load is never written over by a new team or a join', async () => {
  const relay = fakeRelay();
  const store: Store = { saved: [], load: () => { throw new Error('no Keychain'); }, save(s) { this.saved.push(s); } };
  const { h, page } = host(relay, fakeNet(relay), store);
  const err = console.error; console.error = () => {};
  await h.start();
  console.error = err;
  const r = await h.act({ op: 'create', teamName: 'x', name: 'y', relay: 'https://relay.test' });
  assert.equal(r.status, 503);
  assert.match(r.text, /did not load/);
  assert.equal(store.saved.length, 0);
  assert.match(body(page()), /not checked/);
});

test('one action at a time: two creates that cross make one team', async () => {
  const relay = fakeRelay();
  const { h, store } = host(relay, fakeNet(relay));
  const a = h.act({ op: 'create', teamName: 'A', name: 'Sam', relay: 'https://relay.test' });
  const b = h.act({ op: 'create', teamName: 'B', name: 'Sam', relay: 'https://relay.test' });
  const [ra, rb] = await Promise.all([a, b]);
  assert.equal(ra.status, 200);
  assert.equal(rb.status, 409);
  assert.equal(store.saved.length, 1);
  h.stop();
});

test('the relay setting takes https, or a local address for a test, and nothing else', () => {
  assert.equal(relayUrl(''), DEFAULT_RELAY);
  assert.equal(relayUrl('https://relay.example.com/'), 'https://relay.example.com');
  assert.equal(relayUrl('http://127.0.0.1:8790'), 'http://127.0.0.1:8790');
  for (const bad of ['http://relay.example.com', 'https://u:p@relay.example.com', 'https://relay.example.com/x', 'https://relay.example.com/?a=1', 'javascript:alert(1)', 'relay']) assert.equal(relayUrl(bad), null, bad);
});

test('names from teammates are text, never markup, and the page\'s scripts parse', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const view = viewOf({ status: 'member', link: 'online', teamName: evil, lead: true, leadName: evil, code: null, asked: [],
    me: { id: 'L', name: evil, role: 'lead', perms: ['see', 'invite'], area: null },
    areas: [{ id: 'A', name: evil }],
    people: [{ id: 'L', name: evil, role: 'lead', perms: ['see', 'invite'] }, { id: 'B', name: evil, role: 'owner', perms: ['see'], area: 'A' }],
    pending: [{ m: 'C', at: 0, code: '123 456', name: evil, projects: [evil] }], invites: [] });
  const html = teamPage({ view, links: [{ id: 'i', until: 0, link: 'https://yeschef.codes/join#x"><b>' }] as LinkRow[], now: 1 });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /#x"><b>/);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]!));
  const data = grab(html, /<script type="application\/json" id="yc-team-data">([\s\S]*?)<\/script>/, 1);
  assert.doesNotMatch(data, /</);
  assert.equal(JSON.parse(data).pending[0].name, evil);
});

test('each state has its screen', () => {
  const base = { link: 'online', teamName: 'Fernpay', leadName: 'Sam Lead', me: { id: 'D', name: 'Ada', role: null, perms: [] }, areas: [], people: [], pending: [], invites: [], asked: ['app'] };
  assert.match(teamPage({ view: viewOf({ ...base, status: 'pending', code: '427 190' }) }), /Asked to join Fernpay[\s\S]*427 190[\s\S]*app is shared once you're in/);
  assert.match(teamPage({ view: viewOf({ ...base, status: 'pending', code: '427 190', link: 'waiting' }) }), /Not checked: Yes Chef is not connected/);
  assert.match(teamPage({ view: viewOf({ ...base, status: 'removed' }) }), /You are off the team/);
  assert.match(teamPage({ view: viewOf({ ...base, status: 'ended' }) }), /The team was deleted/);
  assert.match(teamPage({}), /Relay<input[^>]+value="https:\/\/relay\.yeschef\.codes"/);
  assert.match(teamPage({ join: joinOf({ leadName: 'Sam', teamName: 'F', until: Date.UTC(2026, 10, 17), leadSignPub: 'k', raw: 'abc' }), t3: { ok: false } }), /Not checked[\s\S]*Ask to join<\/button>/);
  assert.match(teamPage({ join: joinOf({ leadName: 'Sam', teamName: 'F', until: 0, leadSignPub: 'k', raw: 'abc' }), t3: { ok: false } }), /btn primary" disabled>Ask to join/);
});

test('a save the store refused reaches the team client, so an action that needs its id saved does not run', async () => {
  const { lead } = await pair();
  const t = lead.h._team()!;
  assert.equal(await t.saveNow(), true);
  lead.store.save = () => Promise.reject(new Error('the Keychain said no'));
  assert.equal(await t.saveNow(), false);
  lead.store.save = () => { throw new Error('disk full'); };
  assert.equal(await t.saveNow(), false);
  lead.h.stop();
});

test('a team whose last change did not save says so above the page', () => {
  const view = viewOf({ status: 'member', lead: false, unsaved: true, link: 'online', me: { id: 'm1', name: 'Ada', role: 'engineer', perms: ['see'], area: null, under: null }, people: [], areas: [], pending: [], invites: [] });
  assert.match(teamPage({ view }), /role="alert">Not saved: Yes Chef could not save/);
  assert.doesNotMatch(teamPage({ view: { ...view, unsaved: false } }), /Not saved:/);
});

test('a make or a join waits for the saved team to load, so it never writes over it (PR-Agent r1 on #8)', async () => {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  // A lead's saved team, read slowly (the Keychain is asking).
  const a = host(relay, net);
  await a.h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam', relay: 'https://relay.test' });
  const kept = structuredClone(a.store.saved.at(-1));
  a.h.stop();
  let let_go!: () => void;
  const store: Store = { saved: [], load: () => new Promise<TeamState | null>((r) => { let_go = () => r(kept!); }), save(s) { this.saved.push(s); } };
  const b = host(relay, net, store);
  b.h.start();
  const made = b.h.act({ op: 'create', teamName: 'Other', name: 'Sam', relay: 'https://relay.test' });
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(store.saved.length, 0, 'nothing is written while the saved team loads');
  let_go();
  const r = await made;
  assert.equal(r.status, 409);
  assert.equal(b.h.view()!.teamName, 'Fernpay');
  assert.equal(store.saved.filter((s) => s && s.teamName === 'Other').length, 0);
  b.h.stop();
});

test('a new team that did not save says so, keeps its keys in use, and the page says Not saved (PR-Agent r1 on #8)', async () => {
  const relay = fakeRelay();
  const store: Store = { saved: [], load: () => null, save() { return Promise.reject(new Error('the Keychain said no')); } };
  const { h, page } = host(relay, fakeNet(relay), store);
  const err = console.error; console.error = () => {};
  const r = await h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam', relay: 'https://relay.test' });
  console.error = err;
  assert.equal(r.status, 503);
  assert.match(r.text, /^Not saved/);
  assert.equal(h.view()!.teamName, 'Fernpay', 'the team stays in use');
  assert.match(body(page()), /role="alert">Not saved/);
  h.stop();
});

test('a member who may invite still has their own sharing switches and Stop sharing (PR-Agent r1 on #8)', () => {
  const me = { id: 'D', name: 'Dee', role: 'deputy', perms: ['see', 'reply', 'projects', 'invite'], area: null, under: 'L' };
  const lead0 = { id: 'L', name: 'Sam', role: 'lead', perms: ['see', 'invite'] };
  const view = viewOf({ status: 'member', lead: false, link: 'online', teamName: 'Fernpay', me, areas: [], pending: [], invites: [],
    people: [lead0, me] });
  const html = body(teamPage({ view, projects: rows, shared: ['p-app'] }));
  assert.match(html, /Invite your team/);
  assert.match(html, /data-form="share"[\s\S]*value="p-app" checked[\s\S]*value="p-site"/);
  assert.match(html, /data-op="share">Stop sharing/);
  const lead = body(teamPage({ view: viewOf({ ...view, lead: true, me: lead0 }), projects: rows }));
  assert.doesNotMatch(lead, /data-form="share"/, 'the lead page is unchanged');
});

test('the page script escapes quotes for attributes, rebuilds the area options, and keeps a sharing change made mid-save (PR-Agent r1 on #8)', () => {
  const src = servedScript();
  assert.match(src, /replace\(\/"\/g, '&quot;'\)/);
  assert.match(src, /data\.areas\.forEach\(function \(a\) \{ sel\.appendChild\(new Option\(a\.name, a\.id\)\)/);
  assert.match(src, /if \(fields\.op === 'share'\) queued = fields/);
});

test('Not saved never says restart, and Save again saves (PR-Agent r2 on #8)', async () => {
  const relay = fakeRelay();
  let fail = true;
  const store: Store = { saved: [], load: () => null, save(s) { if (fail) return Promise.reject(new Error('no')); this.saved.push(s); } };
  const { h, page } = host(relay, fakeNet(relay), store);
  const err = console.error; console.error = () => {};
  assert.equal((await h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam', relay: 'https://relay.test' })).status, 503);
  const banner = grab(body(page()), /<p class="unsaved"[\s\S]*?<\/p>/);
  assert.doesNotMatch(banner, /restart/i);
  assert.match(banner, /Keep Yes Chef open[\s\S]*data-op="saveAgain">Save again/);
  assert.equal((await h.act({ op: 'saveAgain' })).status, 503);
  fail = false;
  assert.equal((await h.act({ op: 'saveAgain' })).status, 200);
  console.error = err;
  assert.equal(store.saved.at(-1)!.teamName, 'Fernpay');
  assert.doesNotMatch(body(page()), /class="unsaved"/);
  h.stop();
});

test('Forget this ask says done only once the saved team is gone from disk (PR-Agent r2 on #8)', async () => {
  const relay = fakeRelay();
  let fail = false;
  const store: Store = { saved: [], load: () => null, save(s) { if (fail && s === null) return Promise.reject(new Error('disk')); this.saved.push(s); } };
  const { h } = host(relay, fakeNet(relay), store);
  await h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam', relay: 'https://relay.test' });
  fail = true;
  const err = console.error; console.error = () => {};
  const r = await h.act({ op: 'leave' });
  console.error = err;
  assert.equal(r.status, 503);
  assert.equal(h.view()!.teamName, 'Fernpay', 'still on the team, so it can try again');
  fail = false;
  assert.equal((await h.act({ op: 'leave' })).status, 200);
  assert.equal(store.saved.at(-1), null);
  assert.equal(h.view(), null);
});

test('a focused read-only field does not stop the refresh (PR-Agent r2 on #8)', () => {
  const src = servedScript();
  assert.match(src, /\/INPUT\|SELECT\/\.test\(ed\.tagName\) && !ed\.readOnly/);
});

test('Forget this ask: a save the client queued never lands after the deletion (PR-Agent r3 on #8)', async () => {
  const relay = fakeRelay();
  const writes: (string | null)[] = [];
  let slow = null as Promise<unknown> | null;
  const store: Store = { saved: [], load: () => null, save(s) { writes.push(s && s.teamName); if (s && slow) return slow; } };
  const { h } = host(relay, fakeNet(relay), store);
  await h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam', relay: 'https://relay.test' });
  const t = h._team()!;
  let release!: (value?: unknown) => void;
  slow = new Promise((r) => { release = r; });
  t.write();                 // a save in flight
  const left = h.act({ op: 'leave' });
  await new Promise((r) => setTimeout(r, 10));
  t.write();                 // the old client tries once more
  release(); slow = null;
  assert.equal((await left).status, 200);
  await new Promise((r) => setTimeout(r, 10));
  assert.equal(writes.at(-1), null, 'the deletion is the last write');
  assert.equal(h.view(), null);
});

test('a join that did not save shows Not saved and Save again on the waiting screen (PR-Agent r3 on #8)', () => {
  const view = viewOf({ status: 'pending', unsaved: true, link: 'online', teamName: 'Fernpay', leadName: 'Sam', code: '123 456', asked: [], me: { id: 'D', name: 'Ada', role: null, perms: [] }, areas: [], people: [], pending: [], invites: [] });
  const html = body(teamPage({ view }));
  assert.match(html, /class="unsaved"[\s\S]*Save again[\s\S]*Asked to join Fernpay/);
});

test('the page drops a refresh that a newer one or an edit overtook (PR-Agent r3 on #8)', () => {
  const src = servedScript();
  assert.match(src, /if \(!h \|\| mine !== seq \|\| \(!force && editing\(\)\)\) return;/);
  assert.match(src, /busy = true; seq\+\+;/);
});
