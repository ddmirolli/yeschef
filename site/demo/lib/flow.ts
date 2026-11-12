// The expanded views' flow charts, drawn as SVG strings the way client/board.ts draws (Dan, 2026-11-11, stack A: our
// own layout in strict TypeScript, no chart library). This file is You's Sankey (flow mock v3.3, locked 2026-11-11):
// your threads run left to right from their project, through checks and review, to you, then to the branch they merged
// into. Width is threads. Gray is how long since a thread last changed, in three labelled steps (dark mode inverts it, so
// old is bright). No red, orange or yellow fills: an alarm is words plus an icon. A thread that waits on you keeps its
// gray and carries The Pass's cloche at its end, as its card does. Hover lights one thing in one colour, and a band
// and its Pass card light each other (the page script reads data-k, data-f and data-tip). Click a project to open its threads, one band each, with a hairline per subagent at the left.
// The release trains (Nightly, Stable) are "not checked": Yes Chef does not read a project's releases.

/** The stages a thread on the line can be in (client/board.ts STAGES). */
export type FlowStage = 'Backlog' | 'Planned' | 'In progress' | 'In review' | 'Ready to merge' | 'Merged';
/** One thread on the line, as the chart reads it. id: the ticket's plate id, which its Pass card carries too.
 *  since: when the thread last changed, in ms (NaN when T3 sent no time: "not checked"). subs: its subagent threads.
 *  waits: it waits on you (it is at The Pass). base: the branch a merged pull request went into, when T3 sent it. */
export interface FlowItem {
  id: string; title: string; project: string; stage: FlowStage; since: number; subs: number; waits: boolean;
  pr: number | null; base?: string | null | undefined;
}
/** How long since the thread last changed: under 1 day, 1 to 3 days, over 3 days, or not checked. */
export type Age = 0 | 1 | 2 | null;
type Stop = 'review' | 'you' | 'main';
interface Slot { y: number; h: number }
/** A band: threads of one project that take the same path and share an age (one thread each when opened, or when it
 *  waits on you). y0: where it leaves its project's node. lane: drilled in, where its own lane starts at the left.
 *  yIn and yOut: where it enters and leaves each node on its path. */
export interface Band {
  id: string; group: string; stage: FlowStage; age: Age; waits: boolean; items: FlowItem[]; h: number; y0: number;
  lane: number | null; path: Stop[]; yIn: Partial<Record<Stop, number>>; yOut: Partial<Record<Stop, number>>;
}
export interface Layout {
  H: number; span: number; drill: string | null; groups: (Slot & { name: string })[];
  nodes: Partial<Record<Stop, Slot>>; bands: Band[];
}

export const DAY = 86_400_000;
export const W = 860;
const TOP = 58, NW = 5, X0 = 10, XFAN = 70, XB = 118, XG = 150;
/** Where a band that has not reached review ends, by stage: further along the line is further right. */
const STUB: Partial<Record<FlowStage, number>> = { Backlog: 188, Planned: 216, 'In progress': 244 };
/** x of each node, and the stage zones behind them. */
const NODE_X: Record<Stop, number> = { review: 520, you: 640, main: 740 };
const ZONE_X = [0, 262, 560, 680, 780, W] as const;
const PATH: Record<FlowStage, Stop[]> = {
  Backlog: [], Planned: [], 'In progress': [], 'In review': ['review'], 'Ready to merge': ['review', 'you'], Merged: ['review', 'you', 'main'],
};
// Out of a project's node, work that went furthest sits on top.
const RANK: Record<FlowStage, number> = { Merged: 0, 'Ready to merge': 1, 'In review': 2, 'In progress': 3, Planned: 4, Backlog: 5 };
const AGE_WORD = ['under 1 day', '1 to 3 days', 'over 3 days'] as const;
/** The Pass's cloche, the at-the-pass mark on a thread's card (client/board.ts ICON.cloche: the same paths). */
export const CLOCHE = '<path d="M4.25 17.4a7.75 7.75 0 0 1 15.5 0" stroke-width="1.5" stroke-linecap="butt"/><circle cx="12" cy="7.4" r="1.75" fill="currentColor" stroke="none"/><path d="M2.75 19h18.5l-1.5 1.5H4.25z" fill="currentColor" stroke="none"/>';
const clocheIc = (cls: string): string => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${CLOCHE}</svg>`;

export const ageOf = (since: number, now: number): Age => {
  if (!Number.isFinite(since)) return null;
  const d = now - since;
  return d < DAY ? 0 : d < 3 * DAY ? 1 : 2;
};
const e = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
const f1 = (n: number): string => (Math.round(n * 10) / 10).toString();
const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
const cut = (s: string, n: number): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const ago = (since: number, now: number): string => {
  if (!Number.isFinite(since)) return 'not checked';
  const m = Math.max(0, Math.round((now - since) / 60000));
  return m < 1 ? 'under 1 min' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
};
/** A project's hover key: its name with no spaces, so the page can split keys on spaces. */
const gk = (name: string): string => `g:${encodeURIComponent(name)}`;

/** Where every band and node sits. drill: a project's name to open its threads, one band each; null for every project. */
export function layout(items: readonly FlowItem[], now: number, drill: string | null = null): Layout {
  const pick = drill === null ? items : items.filter((t) => t.project === drill);
  const map = new Map<string, Band>();
  for (const t of pick) {
    const age = ageOf(t.since, now);
    // A thread that waits on you is its own band, so its Pass card lights it alone.
    const key = drill !== null || t.waits ? `t|${t.id}` : `${t.project}|${t.stage}|${age}`;
    let b = map.get(key);
    if (!b) {
      b = { id: '', group: t.project, stage: t.stage, age, waits: t.waits, items: [], h: 0, y0: 0, lane: null, path: PATH[t.stage], yIn: {}, yOut: {} };
      map.set(key, b);
    }
    b.items.push(t);
  }
  const bands = [...map.values()];
  bands.forEach((b, i) => { b.id = String(i); });
  const names = [...new Set(bands.map((b) => b.group))].sort((a, b) => a.localeCompare(b));
  const total = pick.length, gap = drill === null ? 6 : 0, gaps = gap * Math.max(0, names.length - 1), laneGap = 5;
  const u = drill !== null ? 11 : Math.min(12, (440 - gaps) / Math.max(1, total));
  for (const b of bands) b.h = b.items.length * u;
  const leftH = drill !== null ? total * u + Math.max(0, total - 1) * laneGap : 0;
  const span = Math.max(200, drill !== null ? leftH : total * u + gaps);
  const H = TOP + span + 18;

  // The projects' nodes, centred.
  const groups: Layout['groups'] = [];
  let y = TOP + (span - (total * u + gaps)) / 2;
  for (const name of names) {
    const h = bands.filter((b) => b.group === name).reduce((s, b) => s + b.h, 0);
    groups.push({ name, y, h });
    y += h + gap;
  }
  // One node per stop, centred in its column: it holds every band that reaches it.
  const nodes: Layout['nodes'] = {};
  for (const s of ['review', 'you', 'main'] as const) {
    const h = bands.filter((b) => b.path.includes(s)).reduce((a, b) => a + b.h, 0);
    if (h) nodes[s] = { y: TOP + (span - h) / 2, h };
  }
  // Out of each project's node, top to bottom: furthest along first, then oldest, a band that waits on you last.
  for (const g of groups) {
    let acc = g.y;
    const mine = bands.filter((b) => b.group === g.name)
      .sort((a, b) => RANK[a.stage] - RANK[b.stage] || (b.age ?? -1) - (a.age ?? -1) || Number(a.waits) - Number(b.waits) || a.id.localeCompare(b.id));
    for (const b of mine) { b.y0 = acc; acc += b.h; }
  }
  // Into each node: work passing through on top, work waiting there below, each in the order it arrives, so the pile at
  // a node is its queue. Out of it, in the order it came in.
  const before = (b: Band, s: Stop): number => { const i = b.path.indexOf(s); const p = b.path[i - 1]; return p ? (b.yOut[p] ?? 0) : b.y0; };
  for (const s of ['review', 'you', 'main'] as const) {
    const node = nodes[s];
    if (!node) continue;
    const here = bands.filter((b) => b.path.includes(s));
    const last = (b: Band) => b.path[b.path.length - 1] === s;
    const order = [...here.filter((b) => !last(b)), ...here.filter(last)];
    order.sort((a, b) => Number(last(a)) - Number(last(b)) || before(a, s) - before(b, s));
    let acc = node.y;
    for (const b of order) { b.yIn[s] = acc; b.yOut[s] = acc; acc += b.h; }
  }
  // Drilled in, each thread starts in its own lane at the left.
  if (drill !== null) {
    let acc = TOP + (span - leftH) / 2;
    for (const b of [...bands].sort((a, b) => a.y0 - b.y0)) { b.lane = acc; acc += b.h + laneGap; }
  }
  return { H, span, drill, groups, nodes, bands };
}

/** A ribbon h high from (x0, y0) to (x1, y1), curved like a Sankey link. */
const link = (x0: number, y0: number, x1: number, y1: number, h: number): string => {
  const m = (x0 + x1) / 2;
  return `M${f1(x0)},${f1(y0)}C${f1(m)},${f1(y0)} ${f1(m)},${f1(y1)} ${f1(x1)},${f1(y1)}L${f1(x1)},${f1(y1 + h)}C${f1(m)},${f1(y1 + h)} ${f1(m)},${f1(y0 + h)} ${f1(x0)},${f1(y0 + h)}Z`;
};
/** A straight ribbon that ends in a round cap: a thread that stopped short of review. */
const stub = (x0: number, x1: number, y: number, h: number): string =>
  `M${f1(x0)},${f1(y)}L${f1(x1)},${f1(y)}A${f1(Math.min(5, h / 2))},${f1(h / 2)} 0 0 1 ${f1(x1)},${f1(y + h)}L${f1(x0)},${f1(y + h)}Z`;
const rect = (x0: number, x1: number, y: number, h: number): string => `M${f1(x0)},${f1(y)}L${f1(x1)},${f1(y)}L${f1(x1)},${f1(y + h)}L${f1(x0)},${f1(y + h)}Z`;
/** What a hover element belongs to (k), what it lights (f), and its tooltip. */
const hov = (k: readonly string[], f: readonly string[], tip: string): string => ` data-k="${e(k.join(' '))}" data-f="${e(f.join(' '))}" data-tip="${e(tip)}"`;
const ageCls = (a: Age): string => (a === null ? 'anc' : `a${a}`);
const WHERE: Partial<Record<FlowStage, string>> = { 'In review': ' · waiting on checks and review', 'Ready to merge': ' · waiting on you to merge', Merged: ' · merged' };

function threadTip(t: FlowItem, now: number): string {
  return `<b>${e(t.title)}</b><div>${t.stage}${t.pr !== null ? ` · PR #${t.pr}` : ''}</div>`
    + `<div class="m">Last change ${ago(t.since, now)} ago${t.subs ? ` · ${plural(t.subs, 'subagent')}` : ''}</div><div class="m">${e(t.project)}</div>`
    + (t.waits ? `<div class="alarm">${clocheIc('ic')}Waiting on you</div>` : '');
}
function bandTip(b: Band, now: number): string {
  const [t0] = b.items;
  if (b.items.length === 1 && t0) return threadTip(t0, now);
  const subs = b.items.reduce((s, t) => s + t.subs, 0);
  return `<b>${e(b.group)}</b><div>${plural(b.items.length, 'thread')} · ${b.stage}${WHERE[b.stage] ?? ''}</div>`
    + `<div class="m">Last change ${b.age === null ? 'not checked' : AGE_WORD[b.age]}${subs ? ` · ${plural(subs, 'subagent')}` : ''}</div>`;
}

/** The chart for one layout: the stage zones, the bands, the nodes and their names. */
export function drawFlow(L: Layout, now: number): string {
  const all = L.bands.flatMap((b) => b.items);
  const count = (...s: FlowStage[]) => all.filter((t) => s.includes(t.stage)).length;
  const zones: [string, string][] = [
    ['Before review', String(count('Backlog', 'Planned', 'In progress'))], ['In review', String(count('In review'))],
    ['Ready to merge', String(count('Ready to merge'))], ['Merged', String(count('Merged'))], ['Release', 'not checked'],
  ];
  let out = `<svg class="fx" viewBox="0 0 ${W} ${f1(L.H)}" role="img" aria-label="${e(L.drill === null ? 'Your threads by project, left to right from start to merge' : `${L.drill}: its threads, left to right from start to merge`)}">`;
  out += `<defs><pattern id="fx-dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="1" class="dot"/></pattern></defs><rect width="${W}" height="${f1(L.H)}" fill="url(#fx-dots)"/>`;
  zones.forEach(([name, n], i) => {
    const x0 = ZONE_X[i] ?? 0, x1 = ZONE_X[i + 1] ?? W;
    out += `<rect class="zone z${i % 2}" x="${x0}" y="0" width="${x1 - x0}" height="${f1(L.H)}"/>`;
    if (i) out += `<line class="zline" x1="${x0}" x2="${x0}" y1="0" y2="${f1(L.H)}"/>`;
    out += i === 4 ? `<text class="zlbl" x="${x0 + 10}" y="19">${name}</text><text class="zcount" x="${x0 + 10}" y="34">${n}</text>`
      : `<text class="zlbl" x="${x0 + 10}" y="19">${name}<tspan class="zcount" dx="6">${n}</tspan></text>`;
  });
  // Over the nodes: who each one is.
  out += `<text class="tierh" x="${NODE_X.review + NW / 2}" y="${TOP - 22}" text-anchor="middle">Checks and review</text>`;
  out += `<text class="tierh" x="${NODE_X.you + NW / 2}" y="${TOP - 22}" text-anchor="middle">You merge</text>`;

  let bands = '', fans = '', marks = '';
  for (const b of L.bands) {
    const ts = b.items.map((t) => `t:${t.id}`);
    const k = [`fl:${b.id}`, gk(b.group), ...ts, ...b.path.map((s) => `n:${s}`)], f = [`fl:${b.id}`, ...ts];
    const attrs = hov(k, f, bandTip(b, now));
    const cls = `band ${ageCls(b.age)}${b.waits ? ' wait' : ''}`;
    const segs: string[] = [];
    const [t0] = b.items;
    if (L.drill !== null && b.lane !== null) {
      segs.push(link(XFAN, b.lane, XG, b.y0, b.h));
      if (!t0 || !t0.subs) segs.push(rect(X0 + 30, XFAN + 1, b.lane, b.h));
      else {
        // One hairline per subagent (up to 8), fanning into the thread's lane.
        const m = Math.min(8, t0.subs), cy = b.lane + b.h / 2;
        fans += `<rect class="fanhit"${attrs} x="${X0}" y="${f1(b.lane - 2)}" width="${XFAN - X0}" height="${f1(b.h + 4)}"/>`;
        for (let j = 0; j < m; j++) {
          const yy = cy + (j - (m - 1) / 2) * 3.2;
          fans += `<path class="fanl ${ageCls(b.age)}" data-k="${e(k.join(' '))}" d="M${X0},${f1(yy)}C${X0 + 34},${f1(yy)} ${XFAN - 22},${f1(cy)} ${XFAN},${f1(cy)}"/>`;
        }
      }
    } else segs.push(rect(XB, XG, b.y0, b.h));
    const end = STUB[b.stage];
    if (end !== undefined) segs.push(stub(XG + NW, end, b.y0, b.h));
    let px = XG + NW, py = b.y0;
    for (const s of b.path) {
      segs.push(link(px, py, NODE_X[s], b.yIn[s] ?? 0, b.h));
      px = NODE_X[s] + NW; py = b.yOut[s] ?? 0;
    }
    // Every project open: a click opens the project. One project open: a click opens the thread, as its card does.
    const act = L.drill === null ? ` data-drill="${e(b.group)}"` : t0 ? ` data-plate="${e(t0.id)}"` : '';
    bands += `<path class="${cls}"${attrs}${act} d="${segs.join('')}"/>`;
    // Waiting on you: the cloche just inside the band's end, where the thread stopped.
    if (b.waits) {
      const last = b.path[b.path.length - 1];
      const x = last ? NODE_X[last] : (end ?? XG + NW), y = (last ? (b.yIn[last] ?? 0) : b.y0) + b.h / 2;
      marks += `<g class="atp" transform="translate(${f1(x - 15)},${f1(y - 6)})"><circle cx="6" cy="6" r="6.5"/><svg class="ic" x="0" y="0" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8">${CLOCHE}</svg></g>`;
    }
  }
  out += `<g class="bands">${bands}</g><g class="fans">${fans}</g><g class="marks">${marks}</g>`;

  // The projects' nodes and, with every project open, their names.
  for (const g of L.groups) {
    const mine = all.filter((t) => t.project === g.name);
    const subs = mine.reduce((s, t) => s + t.subs, 0);
    const tip = `<b>${e(g.name)}</b><div>${plural(mine.length, 'thread')}${subs ? ` · ${plural(subs, 'subagent')}` : ''}</div>`
      + `<div class="m">${mine.filter((t) => t.stage === 'Merged').length} merged · ${mine.filter((t) => t.stage === 'In review').length} in review</div>`
      + (L.drill === null ? '<div class="m">Click to open its threads</div>' : '');
    const dr = L.drill === null ? ` data-drill="${e(g.name)}"` : '';
    out += `<rect class="node"${hov([gk(g.name)], [gk(g.name)], tip)}${dr} x="${XG}" y="${f1(g.y)}" width="${NW}" height="${f1(Math.max(1, g.h))}" rx="1.5"/>`;
    if (L.drill === null) out += `<text class="gname"${hov([gk(g.name)], [gk(g.name)], tip)}${dr} x="${XB - 8}" y="${f1(g.y + g.h / 2)}" text-anchor="end" dominant-baseline="central">${e(cut(g.name, 16))}</text>`;
  }
  // The stops. A node's queue is the threads that end there.
  const ends = (s: Stop) => L.bands.filter((b) => b.path[b.path.length - 1] === s).flatMap((b) => b.items);
  const on = (s: Stop) => L.bands.filter((b) => b.path.includes(s) && b.path[b.path.length - 1] !== s).reduce((n, b) => n + b.items.length, 0);
  const old = (ts: FlowItem[]) => { const n = ts.filter((t) => ageOf(t.since, now) === 2).length; return n ? ` · ${n} over 3 days` : ''; };
  const merged = ends('main');
  const bases = new Set(merged.map((t) => t.base || ''));
  const base = bases.size === 1 ? [...bases][0] || null : null;
  const stops: [Stop, string, string][] = [
    ['review', 'Review', `<b>Checks and review</b><div>${ends('review').length} waiting${old(ends('review'))}</div><div class="m">${on('review')} moved on</div>`],
    ['you', 'You', `<b>You</b><div>${ends('you').length} ready to merge${old(ends('you'))}</div><div class="m">${on('you')} merged</div>`],
    ['main', base ?? '', `<b>${e(base ?? 'Merged')}</b><div>${plural(merged.length, 'thread')} merged${base ? ` into ${e(base)}` : ''}</div><div class="m">Releases not checked</div>`],
  ];
  for (const [s, word, tip] of stops) {
    const n = L.nodes[s];
    if (!n) continue;
    out += `<rect class="node${s === 'you' ? ' you' : ''}"${hov([`n:${s}`], [`n:${s}`], tip)} x="${NODE_X[s]}" y="${f1(n.y)}" width="${NW}" height="${f1(n.h)}" rx="1.5"/>`;
    if (word) out += `<text class="gname${s === 'you' ? ' strong' : ''}"${hov([`n:${s}`], [`n:${s}`], tip)} x="${NODE_X[s] + NW / 2}" y="${f1(n.y - 7)}" text-anchor="middle">${e(cut(word, 14))}</text>`;
  }
  return `${out}</svg>`;
}

/** You's chart, every project and each one opened, for the page to switch between without a round trip. The page
 *  shows the one data-view names ("" for every project). */
export function youFlow(items: readonly FlowItem[], now: number): string {
  const projects = [...new Set(items.map((t) => t.project))].sort((a, b) => a.localeCompare(b));
  return `<div class="fx-view" data-view="">${drawFlow(layout(items, now), now)}</div>`
    + projects.map((p) => `<div class="fx-view" data-view="${e(p)}" hidden>${drawFlow(layout(items, now, p), now)}</div>`).join('');
}

/** Under the chart: what gray means, and how to read it. */
export const FLOW_KEY = '<div class="fx-key"><span class="m">Gray is time since the last change:</span>'
  + AGE_WORD.map((w, i) => `<span class="fx-chip"><i class="sw a${i}"></i>${w}</span>`).join('')
  + `<span class="fx-chip">${clocheIc('ic atp-k')}Waiting on you</span>`
  + '<span class="m fx-how">Width = threads. Checks and review, then you merge. <span class="fx-top">Click a project to open its threads.</span><span class="fx-in">Click a thread to open it. Hairlines at the left are subagents.</span></span></div>';
