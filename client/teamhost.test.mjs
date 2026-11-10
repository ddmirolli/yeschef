// node --test client/teamhost.test.mjs. The team page and its actions (step 3b, PR 3), on a fake relay.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fakeRelay, fakeNet } from '../relay/fake.mjs';
import { teamHost, relayUrl } from './teamhost.mjs';
import { teamPage, DEFAULT_RELAY } from './teamui.mjs';

const until = async (cond, what) => { for (let i = 0; i < 2000; i++) { if (await cond()) return; await new Promise((r) => setTimeout(r, 5)); } throw new Error('timed out: ' + what); };
const projects = [{ id: 'p-app', title: 'app' }, { id: 'p-site', title: 'site' }];

function host(relay, net, store = { saved: [], load: () => null, save(s) { this.saved.push(s && structuredClone(s)); } }) {
  const ran = [];
  const h = teamHost({ store, net, now: () => relay.now(), projectsOf: () => projects, t3Ok: () => true,
    boardOf: () => ({ board: { tickets: [] }, ok: true, at: relay.now() }), run: async (input) => { ran.push(input); return { status: 200, text: 'ok' }; } });
  return { h, store, ran, page: (path = '/team') => h.route(new URL(path, 'http://x')).body };
}
const body = (html) => html.split('<div id="yc-team">')[1].split('<dialog')[0];

async function pair() {
  const relay = fakeRelay();
  const net = fakeNet(relay);
  const lead = host(relay, net), dev = host(relay, net);
  await lead.h.start(); await dev.h.start();
  assert.equal((await lead.h.act({ op: 'create', teamName: 'Fernpay', name: 'Sam Lead', relay: 'https://relay.test' })).status, 200);
  await until(() => lead.h.view()?.link === 'online', 'the lead online');
  assert.equal((await lead.h.act({ op: 'invite' })).status, 200);
  const link = lead.page().match(/value="(https:\/\/yeschef\.codes\/join#[^"]+)"/)[1];
  return { relay, net, lead, dev, link };
}

test('only /team is the team\'s; any other path is left to the board', () => {
  const relay = fakeRelay();
  const { h } = host(relay, fakeNet(relay));
  assert.equal(h.route(new URL('http://x/')), null);
  assert.equal(h.route(new URL('http://x/teams')), null);
  assert.match(h.route(new URL('http://x/team')).body, /Make a team/);
});

test('a lead makes a team, opens a link, and the dev\'s ask shows on the chart with the dev\'s own code', async () => {
  const { lead, dev, link } = await pair();
  assert.match(body(lead.page()), /Invite your team/);
  assert.match(body(lead.page()), /No one is waiting/);
  // The dev opens the link: Join names the lead and the team, and no key is made yet.
  const frag = link.split('#')[1];
  const join = body(dev.page('/team?join=' + encodeURIComponent(frag)));
  assert.match(join, /Join Fernpay/);
  assert.match(join, /Sam Lead invited you/);
  assert.equal(dev.store.saved.length, 0);
  assert.equal((await dev.h.act({ op: 'join', link: frag, name: 'Ada Lovelace', shared: 'p-app' })).status, 200);
  const code = dev.h.view().code;
  assert.match(code, /^\d{3} \d{3}$/);
  assert.match(body(dev.page()), new RegExp(`<b>${code}</b>`));
  await until(() => lead.h.view()?.pending.length === 1, 'the ask at the lead');
  const chip = body(lead.page()).match(/data-ask="[^"]+"[\s\S]*?<span class="code"[^>]*>([^<]+)</);
  assert.equal(chip[1], code, 'the lead sees the same six digits beside the ask');
  assert.match(body(lead.page()), /Ada Lovelace/);
  assert.match(body(lead.page()), /app ·/, 'the project the dev named');
  lead.h.stop(); dev.h.stop();
});

test('approve into an area: the dev\'s page says the role and the area, and the chart puts them there', async () => {
  const { lead, dev, link } = await pair();
  await dev.h.act({ op: 'join', link: link.split('#')[1], name: 'Ada Lovelace', shared: 'p-app' });
  await until(() => lead.h.view()?.pending.length === 1, 'the ask');
  assert.equal((await lead.h.act({ op: 'addArea', name: 'Site' })).status, 200);
  const area = lead.h.view().areas[0];
  const m = lead.h.view().pending[0].m;
  const r = await lead.h.act({ op: 'approve', m, role: 'owner', perms: 'see,reply,merge', area: area.id });
  assert.equal(r.status, 200, r.text);
  await until(() => dev.h.view()?.status === 'member' && dev.h.view()?.me.role === 'owner', 'the dev in');
  const mine = body(dev.page());
  assert.match(mine, /You're on Fernpay/);
  assert.match(mine, /Area owner<\/span> in Site/);
  assert.match(mine, /Merge, Request changes or Hold/);
  const chart = body(lead.page());
  assert.match(chart.split('data-area-id')[1], /Ada Lovelace/, 'in the Site card');
  // The dev's switches save at once and stop sharing empties the list.
  assert.equal((await dev.h.act({ op: 'share', shared: '' })).status, 200);
  assert.deepEqual(dev.h.view() && dev.store.saved.at(-1).shared, []);
  lead.h.stop(); dev.h.stop();
});

test('decline, then the dev\'s page says so and OK forgets the team on this Mac', async () => {
  const { lead, dev, link } = await pair();
  await dev.h.act({ op: 'join', link: link.split('#')[1], name: 'Ada', shared: '' });
  await until(() => lead.h.view()?.pending.length === 1, 'the ask');
  await lead.h.act({ op: 'decline', m: lead.h.view().pending[0].m });
  await until(() => dev.h.view()?.status === 'declined', 'declined');
  assert.match(body(dev.page()), /The lead did not add you/);
  assert.equal((await dev.h.act({ op: 'leave' })).status, 200);
  assert.equal(dev.store.saved.at(-1), null, 'the saved team is deleted');
  assert.match(body(dev.page()), /Make a team/);
  lead.h.stop();
});

test('a saved team that did not load is never written over by a new team or a join', async () => {
  const relay = fakeRelay();
  const store = { saved: [], load: () => { throw new Error('no Keychain'); }, save(s) { this.saved.push(s); } };
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
  const view = { status: 'member', link: 'online', teamName: evil, lead: true, leadName: evil, code: null, asked: [],
    me: { id: 'L', name: evil, role: 'lead', perms: ['see', 'invite'], area: null },
    areas: [{ id: 'A', name: evil }],
    people: [{ id: 'L', name: evil, role: 'lead', perms: ['see', 'invite'] }, { id: 'B', name: evil, role: 'owner', perms: ['see'], area: 'A' }],
    pending: [{ m: 'C', at: 0, code: '123 456', name: evil, projects: [evil] }], invites: [] };
  const html = teamPage({ view, links: [{ id: 'i', until: 0, link: 'https://yeschef.codes/join#x"><b>' }], now: 1 });
  assert.doesNotMatch(html, /<img src=x/);
  assert.doesNotMatch(html, /#x"><b>/);
  for (const m of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) assert.doesNotThrow(() => new vm.Script(m[1]));
  const data = html.match(/<script type="application\/json" id="yc-team-data">([\s\S]*?)<\/script>/)[1];
  assert.doesNotMatch(data, /</);
  assert.equal(JSON.parse(data).pending[0].name, evil);
});

test('each state has its screen', () => {
  const base = { link: 'online', teamName: 'Fernpay', leadName: 'Sam Lead', me: { id: 'D', name: 'Ada', role: null, perms: [] }, areas: [], people: [], pending: [], invites: [], asked: ['app'] };
  assert.match(teamPage({ view: { ...base, status: 'pending', code: '427 190' } }), /Asked to join Fernpay[\s\S]*427 190[\s\S]*app is shared once you're in/);
  assert.match(teamPage({ view: { ...base, status: 'pending', code: '427 190', link: 'waiting' } }), /Not checked: Yes Chef is not connected/);
  assert.match(teamPage({ view: { ...base, status: 'removed' } }), /You are off the team/);
  assert.match(teamPage({ view: { ...base, status: 'ended' } }), /The team was deleted/);
  assert.match(teamPage({}), /Relay<input[^>]+value="https:\/\/relay\.yeschef\.codes"/);
  assert.match(teamPage({ join: { leadName: 'Sam', teamName: 'F', until: Date.UTC(2026, 10, 17), leadSignPub: 'k', raw: 'abc' }, t3: { ok: false } }), /Not checked[\s\S]*Ask to join<\/button>/);
  assert.match(teamPage({ join: { leadName: 'Sam', teamName: 'F', until: 0, leadSignPub: 'k', raw: 'abc' }, t3: { ok: false } }), /btn primary" disabled>Ask to join/);
});

test('a save the store refused reaches the team client, so an action that needs its id saved does not run', async () => {
  const { lead } = await pair();
  const t = lead.h._team();
  assert.equal(await t.saveNow(), true);
  lead.store.save = () => Promise.reject(new Error('the Keychain said no'));
  assert.equal(await t.saveNow(), false);
  lead.store.save = () => { throw new Error('disk full'); };
  assert.equal(await t.saveNow(), false);
  lead.h.stop();
});
