// French Brigade, the Your team view's Sankey (flow mock v3.3, locked 2026-11-11; Dan, 2026-11-12, "A": grouped by
// person until a tracker reader brings features). Each teammate below you is a group on the left; their threads run
// left to right through the stages: In progress, In review up the sign-off ladder, Ready to merge at the person who
// merges, then Merged. Staging and Release are "not checked": no reader brings them yet.
//
// The ladder (brief, "The sign-off ladder"): a PR is signed off by each lead above its author, and the lead directly under
// the top of the roster merges (the top itself, on a flat team). The tiers come from the roster's `under`, never from
// titles, so a flatter team draws fewer columns. You see the two tiers below you by name; deeper tiers fold into one
// node per person two levels down ("Priya's team"). Leads above you show outlined, with none of their other work.
// A thread in review passes a lead only when their approval is read (the PR's reviewers, client/reviewers.ts, matched
// to the lead by the GitHub login their Mac sends) and waits at the first lead whose approval is not. What is not read
// says "not checked" in the thread's tooltip.
//
// Drawn as client/flow.ts draws You's chart: our own layout, one SVG string. Width is threads. Gray is time since the
// last change. No red, orange or yellow fills; The Pass holds the calls, and hover links them both ways (data-k, data-f).
import { AGE_WORD, ageCls, ageOf, ago, clamp, e, f1, hov, plural, ribbon, strands, type Age, type Fit, type Pt } from './flow.ts';
import { loginOf } from './reviewers.ts';
import type { OpenKitchen, TeamPr, TeamView } from './open-kitchen.ts';

/** The stages French Brigade draws. Backlog and Planned have not started: they stay off the chart. */
export type FbStage = 'In progress' | 'In review' | 'Ready to merge' | 'Merged';
const STAGES: readonly FbStage[] = ['In progress', 'In review', 'Ready to merge', 'Merged'];
const RANK: Record<FbStage, number> = { Merged: 0, 'Ready to merge': 1, 'In review': 2, 'In progress': 3 };

type Raw = Record<string, unknown>;
/** The roster as a tree, from where the viewer stands. */
export interface Tree {
  me: string;
  name(id: string): string;
  /** Ancestors, nearest first. */
  up(id: string): string[];
  /** The GitHub login this person's Mac sends (team summaries `gh`), or null: not checked. */
  login(id: string): string | null;
}

/** The roster's reporting tree. With no `under` on anyone, a lead has everyone directly below them (client/open-kitchen.ts
 *  below, the rule 3b and step 4 agreed). A loop or an unknown lead ends the line there. */
export function treeOf(view: TeamView | null | undefined): Tree | null {
  const me = view?.me?.id;
  if (!me) return null;
  const people = (Array.isArray(view?.people) ? view.people : []).filter((p): p is Raw & { id: string } => !!p && typeof p === 'object' && typeof (p as Raw).id === 'string');
  const byId = new Map(people.map((p) => [p.id, p]));
  // Flat only when no one names a lead: an `under` naming someone not on the roster ends that line instead.
  const flat = !people.some((p) => p.under); // as client/open-kitchen.ts below()
  const parent = (id: string): string | null => {
    if (flat) return id !== me && view?.lead ? me : null;
    const u = byId.get(id)?.under;
    return typeof u === 'string' && u !== id && byId.has(u) ? u : null;
  };
  const ups = new Map<string, string[]>();
  const up = (id: string): string[] => {
    const had = ups.get(id);
    if (had) return had;
    const out: string[] = [], seen = new Set([id]);
    for (let p = parent(id); p !== null && !seen.has(p); p = parent(p)) { out.push(p); seen.add(p); }
    ups.set(id, out);
    return out;
  };
  const nameOf = (id: string): string => {
    const n = id === me ? view?.me?.name ?? byId.get(id)?.name : byId.get(id)?.name;
    return typeof n === 'string' && n.trim() ? n.trim() : 'Someone';
  };
  const login = (id: string): string | null => {
    const s = byId.get(id)?.summary;
    return s && typeof s === 'object' ? loginOf((s as Raw).gh) : null;
  };
  return { me, name: nameOf, up, login };
}

/** One teammate's thread on the chart. calls: the hover keys of the calls on it in your Pass (p:<plate>). */
export interface FbItem {
  id: string; title: string; project: string | null; stage: FbStage; since: number; author: string; prs: TeamPr[]; calls: string[];
}
/** The threads the chart draws: the picked projects' threads below you, in the four stages. */
export function brigadeItems(ok: OpenKitchen, tree: Tree, { want = null, plateOf }: { want?: ReadonlySet<string> | null; plateOf: (callId: string) => string | null }): FbItem[] {
  if (ok.status !== 'live') return [];
  const keys = new Map<string, string[]>();
  for (const c of ok.pass) {
    const plate = plateOf(c.id);
    if (!plate) continue;
    const threads = c.kind === 'overlap' ? c.facts.sides.map((s) => s.ticket.thread) : [c.thread];
    for (const t of threads) if (t) keys.set(t, [...(keys.get(t) ?? []), `p:${plate}`]);
  }
  return ok.tickets.flatMap(({ k, person }) => {
    const stage = STAGES.find((s) => s === k.place);
    if (!stage || !tree.up(person).includes(tree.me)) return [];
    if (want && (k.project === null || !want.has(k.project))) return [];
    return [{ id: k.thread, title: k.title || 'Untitled thread', project: k.project, stage, since: k.updatedAt ?? NaN, author: person, prs: k.prs, calls: keys.get(k.thread) ?? [] }];
  });
}

/** A sign-off node: a person (or a folded team) on the ladder. */
interface Node { key: string; label: string; role: 'you' | 'above' | 'below'; merge: boolean; level: number }
/** A band: threads of one group that take the same path, share a stage and an age (one thread each when opened, or
 *  when a call is on it). */
export interface FbBand {
  id: string; group: string; stage: FbStage; age: Age; items: FbItem[]; stops: string[]; h: number; y0: number; y: Record<string, number>;
  /** In review and past every lead's read approval: it waits on checks or other reviewers, not on a lead. */
  signed: boolean;
}
export interface FbLayout {
  H: number; W: number; drill: string | null; nodes: (Node & { x: number; y: number; h: number })[];
  groups: { key: string; label: string; y: number; h: number }[]; bands: FbBand[]; cols: number[];
}

export const W = 860;
const TOP = 58, FOOT = 18, NG = 20, XN = 96, XB = 104, XG = 136;
/** The stage zones: In progress, In review (the ladder), Ready to merge (who merges), Merged, Staging, Release. */
const ZONE_X = [0, 236, 546, 640, 716, 788, W] as const;
const X_MERGE = 593, END_PROG = 214, END_REVIEW = 276, END_MERGED = 690;

/** Who signs a thread off, nearest first, and who merges it, from its author's line. */
function ladder(tree: Tree, author: string): { signers: string[]; merger: string | null } {
  const u = tree.up(author);
  return u.length >= 2 ? { signers: u.slice(0, u.length - 2), merger: u[u.length - 2]! } : { signers: [], merger: u[0] ?? null };
}
/** Whether this lead's approval of the thread's open PR is read. */
function approved(tree: Tree, lead: string, t: FbItem): boolean {
  // Every open PR on the thread needs it: one approved PR beside an unread or unapproved one has not passed the lead.
  const login = tree.login(lead)?.toLowerCase(), open = t.prs.filter((p) => p.state === 'open');
  return !!login && open.length > 0 && open.every((p) => !!p.reviewers?.some((r) => !r.team && r.state === 'approved' && r.who.toLowerCase() === login));
}

// You see the two tiers below you by name; deeper tiers fold into the person two levels down.
const foldOf = (tree: Tree, id: string): string | null => {
  const u = tree.up(id), d = u.indexOf(tree.me) + 1;
  return d > 2 ? u[d - 3] ?? null : null;
};
/** The group a teammate's threads sit in on the left: themselves (p:<id>) or, three tiers down and deeper, the folded
 *  team of the person two levels below you (f:<id>). ?who=<key> opens one. */
export function groupOfIn(tree: Tree, id: string): { key: string; label: string } {
  const f = foldOf(tree, id);
  return f ? { key: `f:${f}`, label: `${tree.name(f)}'s team` } : { key: `p:${id}`, label: tree.name(id) };
}

/** Where every band and node sits. drill: a group's key to open its threads, one band each. fitH: the height (in
 *  viewBox units) the page has free, as client/flow.ts layout reads it. */
export function brigadeLayout(items: readonly FbItem[], tree: Tree, now: number, drill: string | null = null, fitH?: number): FbLayout {
  const fold = (id: string) => foldOf(tree, id), groupOf = (id: string) => groupOfIn(tree, id);
  const nodes = new Map<string, Node>();
  const nodeOf = (id: string, merge: boolean): string => {
    const level = tree.up(id).length, f = fold(id);
    const n: Node = id === tree.me ? { key: `n:${id}`, label: 'You', role: 'you', merge, level }
      : tree.up(tree.me).includes(id) ? { key: `n:${id}`, label: tree.name(id), role: 'above', merge, level }
      : f ? { key: `f:${f}`, label: `${tree.name(f)}'s team`, role: 'below', merge, level: tree.up(tree.me).length + 3 }
      : { key: `n:${id}`, label: tree.name(id), role: 'below', merge, level };
    if (!nodes.has(n.key)) nodes.set(n.key, n);
    return n.key;
  };
  // Opened: a person's threads one band each (p:<id>), or a folded team as its people, bundled as the full chart is
  // (f:<id>), so a team of any size reads the same way one level down (Dan's scale check, 2026-11-12).
  const one = !!drill?.startsWith('p:');
  const pick = drill === null ? items : items.filter((t) => (one ? t.author === drill.slice(2) : groupOf(t.author).key === drill));
  const rowOf = (id: string) => (drill?.startsWith('f:') ? { key: `p:${id}`, label: tree.name(id) } : groupOf(id));
  const map = new Map<string, FbBand>();
  for (const t of pick) {
    const { signers, merger } = ladder(tree, t.author);
    const stops: string[] = [];
    const add = (k: string) => { if (stops[stops.length - 1] !== k) stops.push(k); };
    let signed = false;
    if (t.stage === 'In review') {
      signed = signers.length > 0;
      for (const s of signers) { add(nodeOf(s, false)); if (!approved(tree, s, t)) { signed = false; break; } }
    } else if (t.stage !== 'In progress') {
      for (const s of signers) add(nodeOf(s, false));
      if (merger) add(nodeOf(merger, true));
    }
    const age = ageOf(t.since, now), g = rowOf(t.author);
    const key = one || t.calls.length ? `t|${t.id}` : `${g.key}|${t.stage}|${age}|${stops.join('>')}|${signed}`;
    let b = map.get(key);
    if (!b) map.set(key, b = { id: '', group: one ? `t:${t.id}` : g.key, stage: t.stage, age, items: [], stops, h: 0, y0: 0, y: {}, signed });
    b.items.push(t);
  }
  const bands = [...map.values()];
  bands.forEach((b, i) => { b.id = String(i); });
  const labels = new Map(pick.map((t) => [rowOf(t.author).key, rowOf(t.author).label]));
  // People in name order; opened, threads by stage, furthest first.
  const stageOf = (g: string) => RANK[bands.find((b) => b.group === g)!.stage];
  const names = [...new Set(bands.map((b) => b.group))].sort((a, z) => (!one ? (labels.get(a) ?? a).localeCompare(labels.get(z) ?? z) : stageOf(a) - stageOf(z)) || a.localeCompare(z));
  const total = pick.length, n = names.length;

  // Columns: review levels deepest first (left), then who merges.
  const used = [...nodes.values()].filter((d) => bands.some((b) => b.stops.includes(d.key)));
  const levels = [...new Set(used.filter((d) => !d.merge).map((d) => d.level))].sort((a, z) => z - a);
  const REV0 = ZONE_X[1] + 16, REV1 = ZONE_X[2] - 16;
  const cols = levels.map((_, i) => REV0 + ((REV1 - REV0) * (i + 0.5)) / levels.length);
  const xOf = (d: Node): number => (d.merge ? X_MERGE : cols[levels.indexOf(d.level)] ?? X_MERGE);

  let gap = 6, laneGap = 5;
  let u = one ? 11 : Math.max(3, Math.min(12, (440 - gap * Math.max(0, n - 1)) / Math.max(1, total)));
  let room = 200;
  if (fitH !== undefined && Number.isFinite(fitH)) {
    room = Math.max(200, fitH - TOP - FOOT);
    const avail = room - 2 * clamp(room * 0.07, 20, 52);
    // Thinner bands, never a chart past its panel: a thread may be a single unit high when the team is large.
    if (!one) {
      u = clamp((avail - 14 * Math.max(0, n - 1)) / Math.max(1, total), 1, 30);
      if (n > 1) gap = Math.max(6, (avail - total * u) / (n - 1));
    } else {
      u = clamp((avail - 5 * Math.max(0, total - 1)) / Math.max(1, total), 2, 24);
      if (total > 1) laneGap = clamp((avail - total * u) / (total - 1), 1, 60);
    }
  }
  for (const b of bands) b.h = b.items.length * u;
  // A name needs about 14 px: a person with one thin band keeps that much room.
  const gh = (g: string) => bands.filter((b) => b.group === g).reduce((h, b) => h + b.h, 0);
  if (!one && n > 1) gap = Math.max(gap, 14 - Math.min(...names.map(gh)));
  const sepG = one ? laneGap : gap;
  // Separation tightens left to right (Dan, 2026-11-12), down to touching at the merge.
  const sepAt = (x: number): number => sepG * clamp((X_MERGE - x) / (X_MERGE - XG), 0, 1);
  const sep = (a: FbBand, b: FbBand, x: number): number => (a.group !== b.group ? sepAt(x) : 0);
  const stack = (list: readonly FbBand[], x: number): number => list.reduce((h, b, k) => h + b.h + (k ? sep(list[k - 1]!, b, x) : 0), 0);
  const mine = (g: string) => bands.filter((b) => b.group === g)
    .sort((a, z) => RANK[a.stage] - RANK[z.stage] || (z.age ?? -1) - (a.age ?? -1) || a.id.localeCompare(z.id));
  const heights = names.map((g) => stack(mine(g), XG));
  const leftH = heights.reduce((a, h) => a + h, 0) + sepG * Math.max(0, n - 1);
  const placed = used.map((d) => ({ ...d, x: xOf(d), y: 0, h: 0 }));
  const xs = [...new Set(placed.map((d) => d.x))].sort((a, z) => a - z);
  const groups: FbLayout['groups'] = [];
  // Every band and node for a chart H high; returns the height the columns took. A node's bands are ordered as they
  // arrive, so a column's height is known only once it is placed (PR-Agent r2 and r3 on #56).
  const prior = (b: FbBand, key: string): number => { const i = b.stops.indexOf(key); const p = b.stops[i - 1]; return p ? b.y[p] ?? b.y0 : b.y0; };
  const place = (H: number): number => {
    const mid = (h: number, lift = 0): number => Math.max(TOP + lift, (H - h) / 2);
    groups.length = 0;
    let y = mid(leftH);
    names.forEach((g, k) => {
      const list = mine(g);
      groups.push({ key: g, label: labels.get(g) ?? '', y, h: heights[k]! });
      let acc = y;
      list.forEach((b, i) => { if (i) acc += sep(list[i - 1]!, b, XG); b.y0 = acc; acc += b.h; });
      y += heights[k]! + sepG;
    });
    // Column by column, left to right. Into each node: work passing through on top, work waiting there below, each in
    // the order it arrives, so the pile at a node is its queue. Nodes in a column sit in the order their work arrives.
    let need = 0;
    for (const x of xs) {
      const here = placed.filter((d) => d.x === x).map((d) => {
        const list = bands.filter((b) => b.stops.includes(d.key));
        const last = (b: FbBand) => b.stops[b.stops.length - 1] === d.key;
        list.sort((a, z) => Number(last(a)) - Number(last(z)) || prior(a, d.key) - prior(z, d.key));
        return { d, list, at: list.reduce((s, b) => s + prior(b, d.key), 0) / Math.max(1, list.length) };
      }).sort((a, z) => a.at - z.at || a.d.key.localeCompare(z.d.key));
      const colH = here.reduce((h, { list }) => h + stack(list, x), 0) + NG * Math.max(0, here.length - 1);
      need = Math.max(need, colH + 14);
      let acc = mid(colH, 14);
      for (const { d, list } of here) {
        d.y = acc; d.h = stack(list, x);
        let yy = acc;
        list.forEach((b, i) => { if (i) yy += sep(list[i - 1]!, b, x); b.y[d.key] = yy; yy += b.h; });
        acc += d.h + NG;
      }
    }
    return need;
  };
  // As tall as the left side or the tallest column, whichever needs more: place, and again while a column needs more.
  let H = TOP + Math.max(room, leftH) + FOOT;
  for (let pass = 0; pass < 4; pass++) {
    const want = TOP + Math.max(room, leftH, place(H)) + FOOT;
    if (want <= H + 1e-6) break;
    H = want;
  }
  // Never below the foot, however the passes ended.
  H = Math.max(H, ...placed.map((d) => d.y + d.h + FOOT));
  return { H, W, drill, nodes: placed, groups, bands, cols: xs };
}

const WHERE = (b: FbBand, L: FbLayout): string => {
  const at = L.nodes.find((d) => d.key === b.stops[b.stops.length - 1]);
  if (b.stage === 'Merged') return ' · merged';
  if (!at) return b.stage === 'In review' ? ' · waiting on review' : '';
  if (b.signed) return ' · signed off, waiting on checks or review';
  const who = at.role === 'you' ? 'you' : e(at.label);
  return b.stage === 'Ready to merge' ? ` · waiting on ${who} to merge` : ` · waiting on ${who}`;
};
/** The open PR's reviewers, named as the team knows them. */
function reviewWords(t: FbItem, names: ReadonlyMap<string, string>): string {
  const open = t.prs.filter((p) => p.state === 'open');
  if (!open.length || t.stage === 'Merged') return '';
  const rs = open.flatMap((p) => p.reviewers ?? []);
  if (open.every((p) => p.reviewers === null)) return '<div class="m">Reviews not checked</div>';
  const nm = (who: string) => names.get(who.toLowerCase()) ?? who;
  const by = (s: string) => [...new Set(rs.filter((r) => r.state === s).map((r) => nm(r.who)))];
  const parts = [['Approved', by('approved')], ['Changes asked', by('changes')], ['Asked', by('requested')]] as const;
  const line = parts.filter(([, w]) => w.length).map(([k, w]) => `${k}: ${e(w.join(', '))}`).join(' · ');
  // A PR whose reviews were not read says so, beside the ones that were.
  const unread = open.filter((p) => p.reviewers === null).map((p) => `#${p.n}`);
  return `<div class="m">${line || 'No reviews yet'}${unread.length ? ` · Reviews on ${unread.join(', ')} not checked` : ''}</div>`;
}

/** The chart as one panel, the way Open kitchen's rows sit (client/board.ts okRows): the page sends the size it has
 *  (fx=WxH), so it fills the column down to the foot of The Pass. */
export function drawBrigade(items: readonly FbItem[], tree: Tree, now: number, { drill = null, fit = null }: { drill?: string | null; fit?: Fit | null } = {}): string {
  const L = brigadeLayout(items, tree, now, drill, fit ? (fit.h * W) / fit.w : undefined);
  const all = L.bands.flatMap((b) => b.items);
  const count = (s: FbStage) => String(all.filter((t) => t.stage === s).length);
  const zones: [string, string][] = [['In progress', count('In progress')], ['In review', count('In review')], ['Ready to merge', count('Ready to merge')],
    ['Merged', count('Merged')], ['Staging', 'not checked'], ['Release', 'not checked']];
  // GitHub login to the teammate's name, for the reviewers in a tooltip.
  const names = new Map<string, string>();
  for (const id of new Set([tree.me, ...all.flatMap((t) => [t.author, ...tree.up(t.author)])])) { const l = tree.login(id); if (l) names.set(l.toLowerCase(), id === tree.me ? 'You' : tree.name(id)); }
  let out = `<svg class="fx okr fbr"${fit ? ` data-fit="${fit.w}x${fit.h}"` : ''} viewBox="0 0 ${W} ${f1(L.H)}" role="img" aria-label="${e(`French Brigade: ${plural(all.length, 'thread')} from start to merge, by person`)}">`;
  out += `<defs><pattern id="fb-dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="1" class="dot"/></pattern></defs><rect width="${W}" height="100%" fill="url(#fb-dots)"/>`;
  zones.forEach(([name, n], i) => {
    const x0 = ZONE_X[i] ?? 0, x1 = ZONE_X[i + 1] ?? W;
    out += `<rect class="zone z${i % 2}" x="${x0}" y="0" width="${x1 - x0}" height="100%"/>`;
    if (i) out += `<line class="zline" x1="${x0}" x2="${x0}" y1="0" y2="100%"/>`;
    out += i >= 2 ? `<text class="zlbl" x="${x0 + 8}" y="19">${name}</text><text class="zcount" x="${x0 + 8}" y="34">${n}</text>`
      : `<text class="zlbl" x="${x0 + 10}" y="19">${name}<tspan class="zcount" dx="6">${n}</tspan></text>`;
  });
  let bands = '', labels = '';
  for (const b of L.bands) {
    const calls = [...new Set(b.items.flatMap((t) => t.calls))];
    const k = [`fb:${b.id}`, `g:${b.group}`, ...b.stops, ...calls], f = [`fb:${b.id}`, ...calls];
    const [t0] = b.items;
    const tip = b.items.length === 1 && t0
      ? `<b>${e(t0.title)}</b><div>${e(tree.name(t0.author))} · ${t0.stage}${WHERE(b, L)}${t0.prs[0] ? ` · PR #${t0.prs[0].n}` : ''}</div>`
        + `<div class="m">Last change ${ago(t0.since, now)} ago</div>${reviewWords(t0, names)}${t0.project ? `<div class="m">${e(t0.project)}</div>` : ''}`
      : `<b>${e(L.groups.find((g) => g.key === b.group)?.label ?? '')}</b><div>${plural(b.items.length, 'thread')} · ${b.stage}${WHERE(b, L)}</div>`
        + `<div class="m">Last change ${b.age === null ? 'not checked' : AGE_WORD[b.age]}</div>`;
    // A person opened: their threads run from the left edge. Else each group's name sits at the left.
    const one = !!L.drill?.startsWith('p:'), xs = one ? 10 : XB;
    const pts: Pt[] = [{ x: xs, y: b.y0, c: false }, { x: XG, y: b.y0, c: false }];
    if (b.stage === 'In progress') pts.push({ x: END_PROG, y: b.y0, c: false });
    else if (b.stage === 'In review' && !b.stops.length) pts.push({ x: END_REVIEW, y: b.y0, c: false });
    for (const s of b.stops) { const d = L.nodes.find((n) => n.key === s); if (d) pts.push({ x: d.x, y: b.y[s] ?? b.y0, c: true }); }
    if (b.stage === 'Merged') { const p = pts[pts.length - 1]!; pts.push({ x: END_MERGED, y: p.y, c: false }); }
    // Every person shown: a click opens their threads. Opened: a thread with a call opens it in The Pass.
    const plate = t0?.calls[0]?.slice(2);
    const act = !one ? ` data-who="${e(b.group)}"` : plate ? ` data-team-open="${e(plate)}" tabindex="0" role="button" aria-label="${e(t0!.title)}"` : '';
    bands += `<path class="band ${ageCls(b.age)}"${hov(k, f, tip)}${act} d="${ribbon(pts, b.h)}"/>${strands(pts, b.h, b.items.length)}`;
  }
  // The names: each person (or folded team) at the left, each sign-off node over its pile. Leads above you are outlined.
  if (!L.drill?.startsWith('p:')) for (const g of L.groups) {
    const mineB = L.bands.filter((b) => b.group === g.key), n = mineB.reduce((s, b) => s + b.items.length, 0);
    const tip = `<b>${e(g.label)}</b><div>${plural(n, 'thread')}</div>`
      + `<div class="m">${STAGES.map((s) => [s, mineB.filter((b) => b.stage === s).reduce((c, b) => c + b.items.length, 0)] as const).filter(([, c]) => c).map(([s, c]) => `${c} ${s.toLowerCase()}`).join(' · ')}</div><div class="m">Click to open their threads</div>`;
    labels += `<text class="rowname fbg" x="${XN}" y="${f1(g.y + g.h / 2)}" dominant-baseline="central" text-anchor="end"${hov([`g:${g.key}`, ...mineB.flatMap((b) => b.items.flatMap((t) => t.calls))], [`g:${g.key}`], tip)} data-who="${e(g.key)}" tabindex="0" role="button" aria-label="${e(`Open ${g.label}: ${plural(n, 'thread')}`)}">${e(g.label)}</text>`;
  }
  for (const d of L.nodes) {
    // Waiting here: its last stop, and not merged (a merged thread passed through). Past it: signed off, or merged.
    const here = L.bands.filter((b) => b.stops.includes(d.key)), n = (f: (b: FbBand) => boolean) => here.filter(f).reduce((s, b) => s + b.items.length, 0);
    const last = (b: FbBand) => b.stops[b.stops.length - 1] === d.key;
    const nw = n((b) => last(b) && b.stage !== 'Merged' && !b.signed), nm = n((b) => b.stage === 'Merged'), np = n((b) => b.stage !== 'Merged') - nw;
    const tip = `<b>${e(d.label)}</b>${d.role === 'above' ? ' <span class="m">· above you</span>' : ''}`
      + `<div>${[d.merge ? `${nw} ready to merge` : `${nw} waiting for review`, np ? `${np} signed off` : '', nm ? `${nm} merged` : ''].filter(Boolean).join(' · ')}</div>`
      + (d.role === 'above' ? '<div class="m">Only your team’s work shows here.</div>' : '');
    const ty = d.y - 6, w = Math.max(30, d.label.length * 6.6 + 12);
    labels += `<g class="fbn r-${d.role}"${hov([d.key, ...here.flatMap((b) => b.items.flatMap((t) => t.calls))], [d.key], tip)}>`
      + (d.role === 'above' ? `<rect x="${f1(d.x - w / 2)}" y="${f1(ty - 11)}" width="${f1(w)}" height="16" rx="5"/>` : '')
      + `<text x="${f1(d.x)}" y="${f1(ty)}" text-anchor="middle">${e(d.label)}</text></g>`;
  }
  out += `<g class="bands">${bands}</g><g class="fx-names">${labels}</g></svg>`;
  const above = L.nodes.some((d) => d.role === 'above');
  // The key in the chart's bottom-right corner, as You's (client/flow.ts FLOW_KEY), with leads above you when shown.
  const key = `<div class="fx-key" title="Time since the last change"><span class="vh">Time since the last change:</span>`
    + `${AGE_WORD.map((w, i) => `<span class="fx-chip"><i class="sw a${i}"></i>${w}</span>`).join('')}${above ? '<span class="fx-chip"><i class="sw up"></i>above you</span>' : ''}</div>`;
  // The same shell as You's chart (client/board.ts youView): the chart edge to edge, the key and the tooltip over it.
  return `<div class="fx-wrap"><div class="fx-view">${out}</div>${key}<div class="fx-tip" role="tooltip" hidden></div></div>`;
}
