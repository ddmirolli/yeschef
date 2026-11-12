// The expanded views' flow charts, drawn as SVG strings the way client/board.ts draws (Dan, 2026-11-11, stack A: our
// own layout in strict TypeScript, no chart library). This file is You's Sankey (flow mock v3.3, locked 2026-11-11):
// your threads run left to right from their project, through checks and review, to you, then to the branch they merged
// into. The columns are the stages: a thread's band stops dead, flat, inside the column of the stage it is in, and
// crosses a column's dashed edge only when it took that step. Nothing else draws a line (Dan, 2026-11-12: no node bars,
// which sat inside a column and read as a step that was not there). Width is threads. Gray is how long since a thread last changed, in three labelled steps (dark mode inverts it, so
// old is bright). No red, orange or yellow fills. What waits on you is The Pass's job (Dan, 2026-11-12): its threads
// keep their gray here, with no mark at rest, and hover links each one to its card both ways, in one colour (the page
// script reads data-k, data-f and data-tip). Their tooltip says "Waiting on you". Each project is its logo, gray until
// its work lights. Click one to open its threads, one band each, with a hairline per subagent at the left.
// The release trains (Nightly, Stable) are "not checked": Yes Chef does not read a project's releases.

/** The stages a thread on the line can be in (client/board.ts STAGES). */
export type FlowStage = 'Backlog' | 'Planned' | 'In progress' | 'In review' | 'Ready to merge' | 'Merged';
/** One thread on the line, as the chart reads it. id: the ticket's plate id, which its Pass card carries too.
 *  since: when the thread last changed, in ms (NaN when T3 sent no time: "not checked"). subs: its subagent threads.
 *  waits: it waits on you (it is at The Pass). base: the branch a merged pull request went into, when T3 sent it. */
export interface FlowItem {
  id: string; title: string; project: string; stage: FlowStage; since: number; subs: number; waits: boolean;
  pr: number | null; base?: string | null | undefined;
  /** The project's logo (client/board.ts mark): its icon's URL when T3's machine has one, else a lettered tile in hue. */
  icon?: string | null | undefined; hue?: number | undefined;
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
const TOP = 58, FOOT = 18, X0 = 10, XFAN = 70, XB = 118, XG = 150;
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
export const AGE_WORD = ['under 1 day', '1 to 3 days', 'over 3 days'] as const;
/** The Pass's cloche, the at-the-pass mark on a thread's card (client/board.ts ICON.cloche: the same paths). */
export const CLOCHE = '<path d="M4.25 17.4a7.75 7.75 0 0 1 15.5 0" stroke-width="1.5" stroke-linecap="butt"/><circle cx="12" cy="7.4" r="1.75" fill="currentColor" stroke="none"/><path d="M2.75 19h18.5l-1.5 1.5H4.25z" fill="currentColor" stroke="none"/>';
const clocheIc = (cls: string): string => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true">${CLOCHE}</svg>`;

export const ageOf = (since: number, now: number): Age => {
  if (!Number.isFinite(since)) return null;
  const d = now - since;
  return d < DAY ? 0 : d < 3 * DAY ? 1 : 2;
};
export const e = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
export const f1 = (n: number): string => (Math.round(n * 10) / 10).toString();
export const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;
export const ago = (since: number, now: number): string => {
  if (!Number.isFinite(since)) return 'not checked';
  const m = Math.max(0, Math.round((now - since) / 60000));
  return m < 1 ? 'under 1 min' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`;
};
/** A project's hover key: its name with no spaces, so the page can split keys on spaces. */
const gk = (name: string): string => `g:${encodeURIComponent(name)}`;

/** A project's logo in the chart, as its mark on a card (client/board.ts mark): the icon, else its initial on its hue. */
const LOGO = 22;
const logo = (name: string, t: FlowItem | undefined): string => (t?.icon
  ? `<image href="${e(t.icon)}" width="${LOGO}" height="${LOGO}" preserveAspectRatio="xMidYMid meet"/>`
  : `<rect width="${LOGO}" height="${LOGO}" rx="6" fill="hsl(${t?.hue ?? 0} 48% 42%)"/><text class="pml" x="${LOGO / 2}" y="${LOGO / 2}" text-anchor="middle" dominant-baseline="central">${e(name.slice(0, 1).toUpperCase())}</text>`);

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));
/** Where every band and node sits. drill: a project's name to open its threads, one band each; null for every project.
 *  fitH: the height (in viewBox units) the page has free for the chart. With it the river spreads to fill that height
 *  with a margin above and below (Dan, 2026-11-12): threads grow to a cap, and the rest goes between projects (or, opened,
 *  between threads), so the left branches out and the stops stay packed. Without it, the chart keeps its own size. */
export function layout(items: readonly FlowItem[], now: number, drill: string | null = null, fitH?: number): Layout {
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
  const total = pick.length, n = names.length;
  let gap = drill === null ? 6 : 0, laneGap = 5;
  // Every thread keeps at least 3 px (PR-Agent r1 on #49: 75 projects' gaps alone passed 440 px); past that the chart
  // grows and scrolls inside the view.
  let u = drill !== null ? 11 : Math.max(3, Math.min(12, (440 - gap * Math.max(0, n - 1)) / Math.max(1, total)));
  let room = 200;
  if (fitH !== undefined && Number.isFinite(fitH)) {
    room = Math.max(200, fitH - TOP - FOOT);
    // A margin that grows with the room, so the river never runs edge to edge.
    const avail = room - 2 * clamp(room * 0.07, 20, 52);
    if (drill === null) {
      u = clamp((avail - 6 * Math.max(0, n - 1)) / Math.max(1, total), 3, 30);
      if (n > 1) gap = Math.max(6, (avail - total * u) / (n - 1));
    } else {
      u = clamp((avail - 5 * Math.max(0, total - 1)) / Math.max(1, total), 11, 24);
      if (total > 1) laneGap = clamp((avail - total * u) / (total - 1), 5, 60);
    }
  }
  const gaps = gap * Math.max(0, n - 1);
  for (const b of bands) b.h = b.items.length * u;
  const leftH = drill !== null ? total * u + Math.max(0, total - 1) * laneGap : 0;
  const span = Math.max(room, drill !== null ? leftH : total * u + gaps);
  const H = TOP + span + FOOT;
  // Centred in the whole chart, not under the stage names, so the margins above and below match; never over the names.
  const mid = (h: number): number => Math.max(TOP, (H - h) / 2);

  // Separation tightens left to right (Dan, 2026-11-12): the space between projects (opened: between threads) at the
  // left shrinks at each stop in step with how far right it is, until the branch they merged into holds them touching.
  // In every project view, a project's own bands touch from its node on; opened, each thread is its own.
  const x0 = XG, x1 = NODE_X.main;
  const sepAt = (x: number): number => (drill !== null ? laneGap : gap) * clamp((x1 - x) / (x1 - x0), 0, 1);
  const sep = (a: Band, b: Band, x: number): number => (drill !== null || a.group !== b.group ? sepAt(x) : 0);
  /** Bands stacked at x: their heights and the space between neighbours. */
  const stack = (list: readonly Band[], x: number): number =>
    list.reduce((h, b, k) => h + b.h + (k ? sep(list[k - 1]!, b, x) : 0), 0);

  // Out of each project's node, top to bottom: furthest along first, then oldest, a band that waits on you last.
  const mine = (name: string): Band[] => bands.filter((b) => b.group === name)
    .sort((a, b) => RANK[a.stage] - RANK[b.stage] || (b.age ?? -1) - (a.age ?? -1) || Number(a.waits) - Number(b.waits) || a.id.localeCompare(b.id));
  // The projects' nodes, centred.
  const groups: Layout['groups'] = [];
  const heights = names.map((name) => stack(mine(name), XG));
  let y = mid(heights.reduce((a, h) => a + h, 0) + gaps);
  names.forEach((name, k) => {
    const h = heights[k]!, list = mine(name);
    groups.push({ name, y, h });
    let acc = y;
    list.forEach((b, i) => { if (i) acc += sep(list[i - 1]!, b, XG); b.y0 = acc; acc += b.h; });
    y += h + gap;
  });
  // Into each node: work passing through on top, work waiting there below, each in the order it arrives, so the pile at
  // a node is its queue. Out of it, in the order it came in. One node per stop, centred in its column.
  const nodes: Layout['nodes'] = {};
  const before = (b: Band, s: Stop): number => { const i = b.path.indexOf(s); const p = b.path[i - 1]; return p ? (b.yOut[p] ?? 0) : b.y0; };
  for (const s of ['review', 'you', 'main'] as const) {
    const here = bands.filter((b) => b.path.includes(s));
    if (!here.length) continue;
    const last = (b: Band) => b.path[b.path.length - 1] === s;
    const order = [...here.filter((b) => !last(b)), ...here.filter(last)];
    order.sort((a, b) => Number(last(a)) - Number(last(b)) || before(a, s) - before(b, s));
    const h = stack(order, NODE_X[s]);
    const node = { y: mid(h), h };
    nodes[s] = node;
    let acc = node.y;
    order.forEach((b, i) => { if (i) acc += sep(order[i - 1]!, b, NODE_X[s]); b.yIn[s] = acc; b.yOut[s] = acc; acc += b.h; });
  }
  // Drilled in, each thread starts in its own lane at the left and runs straight to XG: one project has no node to gather
  // at (Dan, 2026-11-12: the header names it), so its lane is where it leaves.
  if (drill !== null) {
    let acc = mid(leftH);
    for (const b of [...bands].sort((a, b) => a.y0 - b.y0)) { b.lane = acc; acc += b.h + laneGap; }
  }
  return { H, span, drill, groups, nodes, bands };
}

/** A point on a band's top edge: straight to it, or curved like a Sankey link (c). */
export interface Pt { x: number; y: number; c: boolean }
/** A band as one ribbon h high through its points, ending flat at the stage it is in (Dan, 2026-11-12: a round cap
 *  read as the band looping back on itself): one outline, so no seam shows where its straight and curved parts meet. */
const go = (a: Pt, b: Pt, dy: number): string => {
  if (!b.c) return `L${f1(b.x)},${f1(b.y + dy)}`;
  const m = (a.x + b.x) / 2;
  return `C${f1(m)},${f1(a.y + dy)} ${f1(m)},${f1(b.y + dy)} ${f1(b.x)},${f1(b.y + dy)}`;
};
export const ribbon = (p: readonly Pt[], h: number): string => {
  const [first] = p, last = p[p.length - 1]!;
  let d = `M${f1(first!.x)},${f1(first!.y)}`;
  for (let i = 1; i < p.length; i++) d += go(p[i - 1]!, p[i]!, 0);
  d += `L${f1(last.x)},${f1(last.y + h)}`;
  for (let i = p.length - 1; i > 0; i--) d += go(p[i]!, { ...p[i - 1]!, c: p[i]!.c }, h);
  return `${d}Z`;
};
/** A band that carries n threads shows each one (Dan, 2026-11-12: threads and strings, not linguini): n - 1 hairlines
 *  along the ribbon, splitting it into equal strands. Every Sankey draws them after its bands. */
export const strands = (p: readonly Pt[], h: number, n: number): string => {
  if (n < 2 || p.length < 2) return '';
  let out = '';
  for (let k = 1; k < n; k++) {
    const dy = (h * k) / n;
    let d = `M${f1(p[0]!.x)},${f1(p[0]!.y + dy)}`;
    for (let i = 1; i < p.length; i++) d += go(p[i - 1]!, p[i]!, dy);
    out += `<path class="strand" d="${d}"/>`;
  }
  return out;
};
/** What a hover element belongs to (k), what it lights (f), and its tooltip. */
export const hov = (k: readonly string[], f: readonly string[], tip: string): string => ` data-k="${e(k.join(' '))}" data-f="${e(f.join(' '))}" data-tip="${e(tip)}"`;
export const ageCls = (a: Age): string => (a === null ? 'anc' : `a${a}`);
const WHERE: Partial<Record<FlowStage, string>> = { 'In review': ' · waiting on checks and review', 'Ready to merge': ' · waiting on you to merge', Merged: ' · merged' };

function threadTip(t: FlowItem, now: number): string {
  return `<b>${e(t.title)}</b><div>${t.stage}${t.stage === 'Merged' && t.base ? ` into ${e(t.base)}` : ''}${t.pr !== null ? ` · PR #${t.pr}` : ''}</div>`
    + `<div class="m">Last change ${ago(t.since, now)} ago${t.subs ? ` · ${plural(t.subs, 'subagent')}` : ''}</div><div class="m">${e(t.project)}</div>`
    + (t.waits ? `<div class="alarm">${clocheIc('ic')}Waiting on you</div>` : '');
}
function bandTip(b: Band, now: number): string {
  const [t0] = b.items;
  if (b.items.length === 1 && t0) return threadTip(t0, now);
  const subs = b.items.reduce((s, t) => s + t.subs, 0);
  // The branch a merged band went into, when every thread in it went into the same known one.
  const base = b.stage === 'Merged' && b.items.every((t) => t.base && t.base === t0?.base) ? t0?.base : null;
  return `<b>${e(b.group)}</b><div>${plural(b.items.length, 'thread')} · ${b.stage}${base ? ` · merged into ${e(base)}` : WHERE[b.stage] ?? ''}</div>`
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
  out += `<defs><pattern id="fx-dots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="1" class="dot"/></pattern></defs><rect width="${W}" height="100%" fill="url(#fx-dots)"/>`;
  zones.forEach(([name, n], i) => {
    const x0 = ZONE_X[i] ?? 0, x1 = ZONE_X[i + 1] ?? W;
    out += `<rect class="zone z${i % 2}" x="${x0}" y="0" width="${x1 - x0}" height="100%"/>`;
    if (i) out += `<line class="zline" x1="${x0}" x2="${x0}" y1="0" y2="100%"/>`;
    out += i === 4 ? `<text class="zlbl" x="${x0 + 10}" y="19">${name}</text><text class="zcount" x="${x0 + 10}" y="34">${n}</text>`
      : `<text class="zlbl" x="${x0 + 10}" y="19">${name}<tspan class="zcount" dx="6">${n}</tspan></text>`;
  });

  let bands = '', fans = '';
  for (const b of L.bands) {
    const ts = b.items.map((t) => `t:${t.id}`);
    const k = [`fl:${b.id}`, gk(b.group), ...ts], f = [`fl:${b.id}`, ...ts];
    const attrs = hov(k, f, bandTip(b, now));
    const cls = `band ${ageCls(b.age)}${b.waits ? ' wait' : ''}`;
    const [t0] = b.items;
    if (L.drill !== null && b.lane !== null && t0 && t0.subs) {
      // One hairline per subagent (up to 8), fanning into the thread's lane.
      const m = Math.min(8, t0.subs), cy = b.lane + b.h / 2;
      fans += `<rect class="fanhit"${attrs} x="${X0}" y="${f1(b.lane - 2)}" width="${XFAN - X0}" height="${f1(b.h + 4)}"/>`;
      for (let j = 0; j < m; j++) {
        const yy = cy + (j - (m - 1) / 2) * 3.2;
        fans += `<path class="fanl ${ageCls(b.age)}" data-k="${e(k.join(' '))}" d="M${X0},${f1(yy)}C${X0 + 34},${f1(yy)} ${XFAN - 22},${f1(cy)} ${XFAN},${f1(cy)}"/>`;
      }
    }
    // From its project's logo (opened: its own lane at the left), straight, then on to where it is now.
    const xs = L.drill !== null && b.lane !== null ? (t0 && t0.subs ? XFAN : X0 + 30) : XB;
    const pts: Pt[] = [{ x: xs, y: b.y0, c: false }, { x: XG, y: b.y0, c: false }];
    const end = STUB[b.stage];
    if (end !== undefined) pts.push({ x: end, y: b.y0, c: false });
    for (const st of b.path) pts.push({ x: NODE_X[st], y: b.yIn[st] ?? 0, c: true });
    // Every project open: a click opens the project. One project open: a click opens the thread, as its card does.
    // Opened, each thread's band is a button a keyboard reaches too (PR-Agent r1 on #49); every project is reached by its name.
    const act = L.drill === null ? ` data-drill="${e(b.group)}"`
      : t0 ? ` data-plate="${e(t0.id)}" tabindex="0" role="button" aria-label="${e(`${t0.title}, ${t0.stage}${t0.waits ? ', waiting on you' : ''}`)}"` : '';
    bands += `<path class="${cls}"${attrs}${act} d="${ribbon(pts, b.h)}"/>${strands(pts, b.h, b.items.length)}`;
  }
  // The river fills the column down to The Pass's foot (Dan, 2026-11-12): the page stretches .fx-body to the height that
  // is free (data-span is its natural height under data-top), and moves each name to its node's new place (data-y) at its own size.
  let names = '';
  out += `<g class="fx-body" data-top="${TOP}" data-span="${f1(L.span)}"><g class="bands">${bands}</g><g class="fans">${fans}</g>`;

  // Every project open: each project's logo where its name was, its threads starting at it (Dan, 2026-11-12, 1B: no bar
  // beside it). The logo is gray at rest and takes its colour when anything of its project lights: its own threads'
  // keys are on it. One project open has no logo: the header names it, and its threads run straight in from the left.
  if (L.drill === null) for (const g of L.groups) {
    const mine = all.filter((t) => t.project === g.name);
    const subs = mine.reduce((s, t) => s + t.subs, 0);
    const tip = `<b>${e(g.name)}</b><div>${plural(mine.length, 'thread')}${subs ? ` · ${plural(subs, 'subagent')}` : ''}</div>`
      + `<div class="m">${mine.filter((t) => t.stage === 'Merged').length} merged · ${mine.filter((t) => t.stage === 'In review').length} in review</div>`
      + '<div class="m">Click to open its threads</div>';
    const dr = ` data-drill="${e(g.name)}"`;
    const lk = [gk(g.name), ...mine.map((t) => `t:${t.id}`)];
    names += `<g class="glogo"${hov(lk, [gk(g.name)], tip)}${dr} tabindex="0" role="button" aria-label="${e(`Open ${g.name}: ${plural(mine.length, 'thread')}`)}">`
      + `<svg x="${XB - 8 - LOGO}" y="${f1(g.y + g.h / 2 - LOGO / 2)}" data-y="${f1(g.y + g.h / 2)}" data-dy="${-LOGO / 2}" width="${LOGO}" height="${LOGO}" viewBox="0 0 ${LOGO} ${LOGO}" overflow="visible">${logo(g.name, mine[0])}</svg></g>`;
  }
  return `${out}</g><g class="fx-names">${names}</g></svg>`;
}

/** You's chart. One project picked (the header picker, or a click on a project here) shows its threads, one band
 *  each; more shows every project. */
export function youFlow(items: readonly FlowItem[], now: number, fit: Fit | null = null): string {
  const projects = [...new Set(items.map((t) => t.project))];
  const svg = drawFlow(layout(items, now, projects.length === 1 ? projects[0]! : null, fit ? (fit.h * W) / fit.w : undefined), now);
  // data-fit: the size this chart was laid out for, so the page asks again only when its column's size changes.
  return `<div class="fx-view">${fit ? svg.replace('<svg class="fx"', `<svg class="fx" data-fit="${fit.w}x${fit.h}"`) : svg}</div>${FLOW_KEY}`;
}
/** The chart's size in CSS px, from the page's fx=WxH (client/page.ts fitFlow); null when absent or out of range. */
export interface Fit { w: number; h: number }
export function fitFrom(params: URLSearchParams): Fit | null {
  const m = /^(\d{3,4})x(\d{3,4})$/.exec(params.get('fx') || '');
  if (!m) return null;
  const w = Number(m[1]), h = Number(m[2]);
  return w >= 300 && w <= 4000 && h >= 150 && h <= 3000 ? { w, h } : null;
}

/** The three grays, in the chart's bottom-right corner, where a Sankey leaves room (Dan, 2026-11-12). */
export const FLOW_KEY = '<div class="fx-key" title="Time since the last change"><span class="vh">Time since the last change:</span>'
  + AGE_WORD.map((w, i) => `<span class="fx-chip"><i class="sw a${i}"></i>${w}</span>`).join('') + '</div>';
