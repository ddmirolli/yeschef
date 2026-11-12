// T3 threads as a brigade board. Dan, 2026-11-06: a ticket is a top-level T3 thread; its subagent
// threads are its stations; Ready to merge and Verified live in T3 too. Stages follow docs/pass-definitions-v1_0.md.
import { createHash, randomUUID } from 'node:crypto';
import { imagesIn, imageUrl, withoutImages, recommendLines } from './calls.ts';
import { missingShots, ASK_SHOTS } from './kitchen.ts';
import { trackWaits, withoutWaits } from './you.ts';
import { youFlow } from './flow.ts';
import type { Fit } from './flow.ts';
import type { FlowItem, FlowStage } from './flow.ts';
import { openKitchen, kitchenBoard, KINDS, may, areaOf } from './open-kitchen.ts';
import type { Call, Shot } from './calls.ts';
import type { RunsEntry, WaitEntry } from './you.ts';
import type { Me, OpenKitchen, Person, PersonState, Side, TeamAsk, TeamCall, TeamPr, TeamView } from './open-kitchen.ts';
import type { Answered } from './actions.ts';
import type { Project, PullRequestLink, QuestionItem, ThreadRow } from './contracts.ts';

/** Where a ticket sits: a stage on the line, Verified, a held place, or Coordinators. */
export type Place = 'Backlog' | 'Planned' | 'In progress' | 'In review' | 'Ready to merge' | 'Merged' | 'Verified' | 'Stopped' | 'Failed'
  | 'Snoozed' | 'Coordinators';
/** A decision the agent asked in its own message (client/calls.ts): the message, its item and the decisions in it. */
export interface CallMessage { key: string; itemId: string; text: string; calls: Call[] }
/** What the server read of a thread's last messages (server.ts handback). */
export interface Handback { latest: { itemId?: string | undefined; text: string } | null; call: CallMessage | null; cut?: boolean | undefined }
/** A T3 question the ticket or one of its stations waits on. */
export interface Ask { thread: ThreadRow; items: QuestionItem[] }
/** One ticket: a top-level T3 thread with its stations, pull requests, stage and what waits on Dan. */
export interface Ticket {
  thread: ThreadRow; crew: ThreadRow[]; project: string; icon: string | null; place: Place;
  prs: PullRequestLink[]; open: PullRequestLink[]; merged: PullRequestLink[]; working: number; stations: number; asks: Ask[];
  yourTurn: boolean; lastWords: string | null; latestId: string | null; call: CallMessage | null; cut: boolean; atPass: boolean;
  updatedAt: string; runs: RunsEntry[] | null;
}
/** The board: every ticket, how many were verified today, and whether run times were read. */
export interface Board { tickets: Ticket[]; verifiedToday?: number; runsChecked: boolean }
/** The poll's result: good with its time, or not and why. */
export type Status = { ok: true; at: number; ms: number; error?: undefined } | { ok: false; at: number; ms: number; error: string };
/** The user's team, for the view switch (client/team.ts). view: Team.view(), when the team connection gives one. */
export interface TeamInput { view?: TeamView | null | undefined; now?: number | undefined; name?: string | null | undefined; below?: unknown; mode?: unknown }
/** A pull request as a card shows it: one label for the same number in repositories of the same name. */
export type ShownPr = PullRequestLink & { repositories: string[] };

// Developer words (Dan, 2026-11-10). A stage is never stored: T3 state decides it on every poll, so no old data names one.
export const STAGES: readonly Place[] = ['Backlog', 'Planned', 'In progress', 'In review', 'Ready to merge', 'Merged'];
export const HELD: readonly Place[] = ['Stopped', 'Failed', 'Snoozed'];
// Threads that run the kitchen rather than cook a dish (the ATC, an expo). Shown apart, never hidden.
export const COORDINATOR = /^(ATC|expo)\b/i;
const HINT: Record<string, string> = { Backlog: 'Not started', Planned: 'No PR yet', 'In progress': 'Agents building', 'In review': 'PR open', 'Ready to merge': 'Your look', Merged: 'Not verified yet' };
// PR stages wear GitHub's colors: In review open (green), Merged merged (purple). Blue stays the pass. The stages
// before a PR step up a gray ramp, darkest at In progress: orange said something was wrong (Dan, 2026-11-10).
const DOT: Record<string, string> = { Backlog: 'backlog', Planned: 'planned', 'In progress': 'prog', 'In review': 'open', 'Ready to merge': 'blue', Merged: 'merged' };
const RUNNING = new Set(['preparing', 'queued', 'starting', 'running']);
// A top-level thread whose run ended, and that you have not settled, has handed the turn back to you.
const HANDED_BACK = new Set(['completed', 'interrupted', 'idle']);

/** One entry per pull request: the same host, repository (case ignored) and number. When links disagree on its state,
 *  merged wins, since a merge is final; otherwise the last link wins, as before. */
export function uniquePrs<P extends Pick<PullRequestLink, 'host' | 'repository' | 'number' | 'state'>>(list: readonly P[]): P[] {
  const seen = new Map<string, P>();
  for (const p of list) {
    const key = `${String(p.host || 'github.com').toLowerCase()}|${String(p.repository).toLowerCase()}#${p.number}`;
    const had = seen.get(key);
    if (!had || had.state !== 'merged' || p.state === 'merged') seen.set(key, p);
  }
  return [...seen.values()];
}

/** What a card shows. T3 can link one PR under two owners after a repository moves: reviewwheel/reviewwheel#2371
 *  and ddmirolli/reviewwheel#2371 (seen 2026-11-08). The links carry no branch, so the Pass cannot prove they are one
 *  PR and keeps both in the data. A card shows one label for a number shared by repositories of the same name in the
 *  same state, and its tooltip names every repository. The plate lists every link. */
export function shownPrs(prs: readonly PullRequestLink[]): ShownPr[] {
  const groups = new Map<string, ShownPr>();
  for (const p of prs) {
    const key = `${String(p.repository).split('/').pop()!.toLowerCase()}#${p.number}#${p.state}`;
    const g = groups.get(key);
    if (g) g.repositories.push(p.repository); else groups.set(key, { ...p, repositories: [p.repository] });
  }
  return [...groups.values()];
}
const prTitle = (p: ShownPr): string => `${p.repositories.map((r) => `${r}#${p.number}`).join(', ')} ${p.state}`;
const morePrs = (n: number): string => `+${n} ${n === 1 ? 'PR' : 'PRs'}`;

/** Turn T3's projects, threads, waiting questions, and last messages into tickets with stages.
 *  lastWords: thread id to the agent's hand-back, { latest: { itemId, text }, call: { key, itemId, text, calls } | null },
 *  or to plain text. A call is a decision the agent asked in its own message (client/calls.ts). */
export function buildBoard({ projects, threads, questions, lastWords = new Map(), today = new Date(), runs = null, waits = null }: {
  projects: readonly Pick<Project, 'id' | 'title' | 'icon'>[]; threads: readonly ThreadRow[]; questions: ReadonlyMap<string, QuestionItem[]>;
  lastWords?: ReadonlyMap<string, Handback | string>; today?: Date; runs?: ReadonlyMap<string, RunsEntry> | null; waits?: Map<string, WaitEntry> | null;
}): Board {
  // T3 keeps a run "running" while its thread waits on a question (see asks below). The agent stopped when it asked,
  // the thread's last update, so its run stops there until the answer, and agent time and the running line agree
  // with "working" (PR-Agent r2 and r3 on #74). waits: client/you.ts trackWaits, kept from poll to poll by the
  // server, so a wait stays out after the answer. Without it, only the waits going now come out.
  const waitLog = runs ? (waits || trackWaits(new Map(), threads, questions, today.getTime())) : null;
  const byParent = new Map<string, ThreadRow[]>();
  for (const t of threads) if (t.parentThreadId) (byParent.get(t.parentThreadId) || byParent.set(t.parentThreadId, []).get(t.parentThreadId)!).push(t);
  const descendants = (t: ThreadRow): ThreadRow[] => (byParent.get(t.threadId) || []).flatMap((c) => [c, ...descendants(c)]);
  const project = new Map(projects.map((p) => [p.id, p]));
  const local = (d: Date) => d.toLocaleDateString('en-CA');  // the calendar day where the Pass runs
  const tickets = threads.filter((t) => !t.parentThreadId).map((t): Ticket | null => {
    const crew = [t, ...descendants(t)];
    const prs = uniquePrs(crew.flatMap((c) => c.pullRequests || []));
    const open = prs.filter((p) => p.state === 'open'), merged = prs.filter((p) => p.state === 'merged');
    // T3 shows a thread that waits on a question as "running": the pending question decides, not the status.
    const asks = crew.filter((c) => c.status === 'waiting' || questions.has(c.threadId));
    const words = lastWords.get(t.threadId);
    const handback: Handback = typeof words === 'string' ? { latest: { text: words }, call: null } : (words || { latest: null, call: null });
    const working = crew.filter((c) => RUNNING.has(c.status) && !questions.has(c.threadId)).length;
    const coordinator = COORDINATOR.test(t.title || '');
    // A call counts only when the turn is really Dan's: the stage and the actions use the same rule (PR-Agent r1 on #17).
    const yourTurn = !coordinator && !t.settled && !t.snoozed && !working && !!t.latestRunId && HANDED_BACK.has(t.status);
    const call = yourTurn && handback.call?.calls?.length ? handback.call : null;
    let place: Place;
    // Settled in T3 with nothing left open is Verified, shown on the day it settled. Older ones leave the board.
    // A settled thread with an open PR, or with work still running under it, keeps its stage.
    const verified = t.settled && !open.length && !working && !asks.length;
    if (verified && !(t.settledAt && local(new Date(t.settledAt)) === local(today))) return null;
    if (verified) place = 'Verified';
    else if (coordinator) place = 'Coordinators';
    else if (t.snoozed) place = 'Snoozed';
    else if (crew.some((c) => c.status === 'failed')) place = 'Failed';
    else if (['interrupted', 'cancelled', 'rolled_back'].includes(t.status)) place = 'Stopped';
    else if ((asks.length || call) && open.length) place = 'Ready to merge';
    else if (working) place = 'In progress';
    else if (open.length) place = 'In review';
    else if (merged.length) place = 'Merged';
    else if (t.status === 'idle' && !t.latestRunId) place = 'Backlog';
    else place = 'Planned';
    const p = project.get(t.projectId ?? '');
    return { thread: t, crew, project: p?.title || 'No project', icon: p?.icon || null, place, prs, open, merged, working,
      stations: crew.length - 1, asks: asks.map((c) => ({ thread: c, items: questions.get(c.threadId) || [] })),
      // cut: T3 cut the newest message off, so whether it asks a decision is not checked (PR-Agent r5 on #17).
      yourTurn, lastWords: handback.latest?.text || null, latestId: handback.latest?.itemId || null, call, cut: yourTurn && !!handback.cut,
      atPass: asks.length > 0 || place === 'Ready to merge' || yourTurn, updatedAt: t.updatedAt,
      // T3's run times for the ticket and its stations (client/you.ts readRuns), or null when they were not read.
      runs: runs ? crew.map((c) => withoutWaits(runs.get(c.threadId), waitLog?.get(c.threadId))).filter((r): r is RunsEntry => !!r) : null };
  }).filter((k): k is Ticket => k !== null);
  return { tickets, verifiedToday: tickets.filter((k) => k.place === 'Verified').length, runsChecked: !!runs };
}

const e = (s: unknown): string => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c]!);
const hue = (name: string): number => parseInt(createHash('sha1').update(name).digest('hex').slice(0, 8), 16) % 360;
// The project's own icon when the Pass can read it from T3's machine, else a lettered mark.
const mark = (name: string, icon: string | null | undefined): string => (icon ? `<img class="pm pimg" src="${e(icon)}" alt="" title="${e(name)}" aria-hidden="true">`
  : `<i class="pm" style="--h:${hue(name)}" title="${e(name)}" aria-hidden="true">${e(name.slice(0, 1).toUpperCase())}</i>`);
// "just now" or "12 min ago", for sentences; ago() stays the short form for cards.
const since = (iso: string): string => (ago(iso) === 'now' ? 'just now' : `${ago(iso)} ago`);
// claude-opus-5-5 -> Opus 5.5, gpt-6.1-sol -> GPT-6.1 Sol: the names Dan uses.
const model = (m: string | null | undefined): string => {
  if (!m) return '';
  const c = /^claude-([a-z]+)-(\d+)-(\d+)/.exec(m);
  if (c) { const [, n = '', a, b] = c; return `${n.charAt(0).toUpperCase()}${n.slice(1)} ${a}.${b}`; }
  const g = /^gpt-([\d.]+)-([a-z]+)/.exec(m);
  if (!g) return m;
  const [, v, n = ''] = g;
  return `GPT-${v} ${n.charAt(0).toUpperCase()}${n.slice(1)}`;
};
// An option's text: escaped, with a GitHub pull request address shown as "PR #32".
// The link keeps the whole URL (a comment anchor, /files); only its label shortens to "PR #n" (PR-Agent r5 on #27).
const optText = (t: unknown): string => e(t).replace(/https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)[^\s<"]*/g, (all: string, n: string) => {
  const url = all.replace(/[.,;:!?)]+$/, '');
  return `<a href="${url}" target="_blank" rel="noopener">PR #${n}</a>${all.slice(url.length)}`;
});
const ago = (iso: string): string => { const m = Math.round((Date.now() - Date.parse(iso)) / 60000); return m < 1 ? 'now' : m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`; };
export const ICON = {
  cloche: '<path d="M4.25 17.4a7.75 7.75 0 0 1 15.5 0" stroke-width="1.5" stroke-linecap="butt"/><circle cx="12" cy="7.4" r="1.75" fill="currentColor" stroke="none"/><path d="M2.75 19h18.5l-1.5 1.5H4.25z" fill="currentColor" stroke="none"/>',
  chev: '<path d="m6 9 6 6 6-6"/>', done: '<circle cx="12" cy="12" r="9"/><path d="m8 12.4 2.7 2.7L16.2 9.4"/>',
  out: '<path d="M8.5 15.5 16 8"/><path d="M9.5 8H16v6.5"/>', x: '<path d="M7 7l10 10M17 7 7 17"/>',
  sliders: '<path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/>',
  // The action bar's icons (mock v1, Dan, 2026-11-10).
  merge: '<circle cx="6.5" cy="5.5" r="2.2"/><circle cx="6.5" cy="18.5" r="2.2"/><circle cx="17.5" cy="12" r="2.2"/><path d="M6.5 7.7v8.6"/><path d="M6.5 7.7c0 2.8 2.3 4.3 5 4.3h3.8"/>',
  approve: '<path d="m5 12.5 4.5 4.5L19 7.5"/>',
  changes: '<path d="M12 4.5v8M8 8.5h8M8 18.5h8"/>',
  reply: '<path d="M10 7 5 12l5 5"/><path d="M5 12h9a5 5 0 0 1 5 5v1.5"/>',
  hold: '<circle cx="12" cy="13" r="7.5"/><path d="M12 9.5V13l2.5 1.8"/><path d="M5 4.5 3 6.5M19 4.5l2 2"/>',
  settle: '<rect x="3.5" y="4.5" width="17" height="4" rx="1"/><path d="M5 8.5v9a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-9"/><path d="M12 11.5v5M9.8 14.5l2.2 2.2 2.2-2.2"/>',
  more: '<circle cx="5.5" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none"/><circle cx="18.5" cy="12" r="1.4" fill="currentColor" stroke="none"/>',
  note: '<path d="M4.5 19.5h4l10-10-4-4-10 10z"/><path d="m13 7 4 4"/>',
  send: '<path d="M4.5 11.5 19.5 4.5l-5 15-3-6.2z"/><path d="m11.5 13.3 3.5-3.6"/>',
  // You: one person, in the cloche's line (docs/icons/person.svg).
  person: '<circle cx="12" cy="8.25" r="3.25" stroke-width="1.5"/><path d="M5.75 19.5a6.25 6.25 0 0 1 12.5 0" stroke-width="1.5" stroke-linecap="butt"/>',
  // The modes (docs/icons/skillet.svg, toque.svg): Open kitchen and French Brigade. Filled parts take no stroke here,
  // because svg() strokes everything at 1.8.
  skillet: '<g transform="translate(8.98 10.62)"><circle r="3.50" fill="currentColor" fill-opacity=".28" stroke="none"/><circle r="5.1" stroke-width="1.0"/><g transform="rotate(30)"><path d="M-4.26 -2.8 L-6.98 -1.76 L-7.40 -1.15 L-7.40 1.15 L-6.98 1.76 L-4.26 2.8" stroke-width="0.75" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M4.80 -0.8 L14.85 -1.1 L15.30 -0.65 L15.30 0.65 L14.85 1.1 L4.80 0.8 Z M13.25 0 a.5 .5 0 1 0 1 0 a.5 .5 0 1 0 -1 0 Z" fill="currentColor" fill-rule="evenodd" stroke="none"/></g></g>',
  toque: '<path d="M7.6 16.1V12.55A3.3 3.3 0 0 1 9.35 6.35A3.05 3.05 0 0 1 14.65 6.35A3.3 3.3 0 0 1 16.4 12.55V16.1" stroke-width="1.25" stroke-linecap="butt"/><path d="M10.55 12.1V15.3" stroke-width="0.75"/><path d="M13.45 12.1V15.3" stroke-width="0.75"/><path d="M6.9 17.75H17.1L16.10 19.15H7.90Z" fill="currentColor" stroke="none"/>',
};
type IconName = keyof typeof ICON;
const svg = (n: IconName, cls = 'ic'): string => `<svg class="${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICON[n]}</svg>`;
const chip = (text: unknown, tone: string): string => `<span class="chip c-${tone}">${e(text)}</span>`;
const STATUS_TONE: Record<string, string> = { running: 'green', starting: 'green', queued: 'gray', preparing: 'gray', waiting: 'amber', completed: 'gray', idle: 'gray', interrupted: 'amber', failed: 'red', cancelled: 'gray' };
const PR_TONE: Record<string, string> = { open: 'open', merged: 'merged', closed: 'closed' };
// Agents write light Markdown and T3 thread links. Cards show plain words; links become "a T3 thread".
const plain = (text: unknown): string => withoutImages(text).replace(/<t3-thread:\/\/[^>\s]+>/g, 'a T3 thread').replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
/** The first paragraph of an agent's last message, as plain words cut to a card's length. */
const gist = (text: unknown, max = 240): string => { const p = plain(text).trim().split(/\n\s*\n/)[0]!.replace(/[*`]/g, '').replace(/\s+/g, ' '); return p.length > max ? p.slice(0, max - 1) + '…' : p; };
/** A T3 thread link (t3-thread://v2/<environment>/<thread>) as an address on the T3 web app, or null. */
const t3Web = (url: string, origin: string | null | undefined): string | null => { const m = /^t3-thread:\/\/v2\/([^/>\s]+)\/([^>\s]+)$/.exec(url); return m && origin ? `${origin}/${m[1]}/${m[2]}` : null; };
/** An agent's message for the open ticket: escaped first, then links, bold, code, and "- " lines as a list
 *  (list items joined with no newline, because the message keeps its line breaks). Images show as screenshots. */
const rich = (text: unknown, origin: string): string => {
  const out: string[] = [], list: string[] = [], keep: string[] = [];
  // Links first, as placeholders, so escaping never breaks their addresses. Only https and T3 thread links open.
  const held = (html: string) => `\u0000${keep.push(html) - 1}\u0000`;
  const anchor = (label: string, href: string) => `<a href="${e(href)}" target="_blank" rel="noopener">${e(label)}${svg('out')}</a>`;
  // Screenshots are attachments pinned at the top of the ticket (Dan, 2026-11-07), so the message drops its images.
  // A line that is only a screenshot's path is that attachment again, so it goes too; a path inside a sentence stays.
  const shown = new Set(imagesIn(text).map((im) => im.src));
  let src = String(text || '').replace(MD_IMG, '').replace(/^[ \t]*`((?:\/|~\/)[^`\s]+)`[ \t]*$/gm, (all: string, p: string) => (shown.has(p) ? '' : all)).replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    .replace(/\[([^\]\n]+)\]\(\s*<?([^)\s>]+)>?\s*\)/g, (all: string, label: string, url: string) => {
      const href = /^https?:\/\//i.test(url) ? url : t3Web(url, origin);
      return href ? held(anchor(label, href)) : label;
    })
    .replace(/<(t3-thread:\/\/[^>\s]+)>/g, (all: string, url: string) => { const href = t3Web(url, origin); return href ? held(anchor('a T3 thread', href)) : 'a T3 thread'; })
    .replace(/(^|[\s(])(https:\/\/[^\s)<>`]+[^\s)<>`.,;:!?'"])/g, (all: string, pre: string, url: string) => pre + held(anchor(url.replace(/^https:\/\//, ''), url)));
  const lines = e(src).replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>').replace(/`([^`\n]+)`/g, '<code>$1</code>').split('\n');
  // A Markdown table ("| a | b |" then "|---|---|") renders as a table: agents report queues and checks this way.
  const row = (l: string) => /^\s*\|.*\|\s*$/.test(l);
  const cells = (l: string) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (row(line) && /^\s*\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?\s*$/.test(lines[i + 1] || '')) {
      flush();
      const head = cells(line), body: string[][] = [];
      for (i += 2; i < lines.length && row(lines[i]!); i++) body.push(cells(lines[i]!));
      i--;
      out.push(`<table class="md"><thead><tr>${head.map((c) => `<th>${c}</th>`).join('')}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table>`);
      continue;
    }
    const m = /^\s*[-*] (.*)$/.exec(line);
    if (m) list.push(m[1]!); else { flush(); out.push(line); }
  }
  function flush() { if (list.length) { out.push(`<ul>${list.map((x) => `<li>${x}</li>`).join('')}</ul>`); list.length = 0; } }
  flush();
  return out.join('\n').replace(/\n?(<ul>|<table class="md">)/g, '$1').replace(/(<\/ul>|<\/table>)\n?/g, '$1').replace(/\u0000(\d+)\u0000/g, (all: string, i: string) => keep[Number(i)]!);
};
// The same pattern as calls.ts MD_IMAGE: a Markdown image, ![alt](src).
const MD_IMG = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** Every screenshot the ticket's messages show, as attachments pinned under the title at one size, like an email's
 *  (Dan, 2026-11-07). Before and after stay side by side in the agent's order; each is labelled; one that cannot
 *  load keeps its box and says so (the page script marks it). */
const attachments = (...texts: unknown[]): string => {
  const seen = new Set<string>(), list: Shot[] = [];
  for (const t of texts) for (const im of imagesIn(t)) if (!seen.has(im.src)) { seen.add(im.src); list.push(im); }
  if (!list.length) return '';
  const label = (im: Shot) => im.alt || im.src.split('/').pop();
  return `<div class="atts" role="list" aria-label="Screenshots">${list.map((im) => { const u = imageUrl(im.src);
    return `<a class="att" role="listitem" href="${e(u)}" data-shot target="_blank" rel="noopener"><span class="att-img"><img src="${e(u)}" alt="${e(label(im))}" loading="lazy"></span><span class="att-cap">${e(label(im))}</span></a>`; }).join('')}</div>`;
};

function tile(k: Ticket, quiet = false): string {
  const bits: string[] = [];
  if (k.stations) bits.push(`${k.stations} station${k.stations > 1 ? 's' : ''}`);
  if (k.working) bits.push(`<span class="th k-green"><i></i>${k.working} working</span>`);
  // PR state is a dot, as in the ticket's PR chip; the words stay in the text colour (hill climb 2 r2, Opus).
  // Each pull request by its number, as a mail label (Dan, 2026-11-08); two shown, the rest counted.
  const prs = shownPrs(k.prs).sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1));
  for (const p of prs.slice(0, 2)) bits.push(`<span class="th pr-${prDot(p)}" title="${e(prTitle(p))}"><i></i>#${p.number}</span>`);
  if (prs.length > 2) bits.push(morePrs(prs.length - 2));
  const who = model(k.thread.model);
  // One span per fact and no literal dots, so a wrap never leaves a dot hanging (hill climb r1, Opus).
  return `<button type="button" class="tile${quiet ? ' quiet' : ''}${k.atPass ? ' at' : ''}" data-plate="${e(plateId(k))}" data-thread="${e(k.thread.threadId)}">`
    + `<span class="tile-top"><span class="proj">${mark(k.project, k.icon)}<span class="pn">${e(k.project)}</span></span>${who ? `<span class="mdl">${e(who)}</span>` : ''}<span class="age">${ago(k.updatedAt)}</span>${k.atPass ? svg('cloche', 'ic at-ic') + '<span class="vh">At the pass.</span>' : ''}</span>`
    + `<span class="t">${e(k.thread.title)}</span><span class="meta">${bits.map((b) => `<span class="mb">${b}</span>`).join('')}</span></button>`;
}

const oldestAsk = (k: Ticket): Ask | undefined => [...k.asks].sort((a, b) => (a.thread.updatedAt < b.thread.updatedAt ? -1 : 1))[0];
const plateId = (k: Pick<Ticket, 'thread'>): string => 'p-' + createHash('sha1').update(k.thread.threadId).digest('hex').slice(0, 12);

/** The blue pill names how many questions wait. Everything at the pass waits on you, so "Asks you" said nothing a
 *  card did not; the count says how much (Dan, 2026-11-08). A hand-back has no pill: its stage says what it wants. */
const qWord = (n: number): string => (n === 1 ? '1 question' : n > 1 ? `${n} questions` : 'A question');
/** How many questions wait on you in this ticket: a T3 question's items, or an agent call's decisions. */
// Every T3 question the dock shows counts, the ticket's and its stations' (PR-Agent r6 on #50).
const questionCount = (k: Ticket): number => (k.asks.length ? k.asks.reduce((n, a) => n + (a.items?.length || 0), 0) : k.call && !k.cut ? k.call.calls.length : 0);
// A pull request's dot: open, merged, or closed without merging (PR-Agent r6 on #50).
const prDot = (p: Pick<PullRequestLink, 'state'>): string => (p.state === 'open' ? 'open' : p.state === 'closed' ? 'closed' : 'merged');
/** A ticket's labels, like a mail client's: the ask and its count, the stage, and its pull requests by number. */
function labels(k: Ticket): string {
  const n = questionCount(k), asks = !!(oldestAsk(k) || (k.call && !k.cut));
  const out: string[] = [];
  if (asks) out.push(`<span class="chip c-blue">${qWord(n)}</span>`);
  out.push(`<span class="lb"><i class="gd c-${DOT[k.place] || 'gray'}"></i>${e(k.place)}</span>`);
  const prs = shownPrs(k.prs).sort((a, b) => (a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1));
  for (const p of prs.slice(0, 2)) out.push(`<span class="lb th pr-${prDot(p)}" title="${e(prTitle(p))}"><i></i>#${p.number}</span>`);
  if (prs.length > 2) out.push(`<span class="lb">${morePrs(prs.length - 2)}</span>`);
  return out.filter(Boolean).join('');
}

/** A ticket at the pass, read like an email (Dan, 2026-11-08): who (project and model), the subject (the T3 thread's
 *  title), one line of preview (the first question, or the hand-back's gist), and labels. Nothing else. */
function passTile(k: Ticket): string {
  const ask = oldestAsk(k), q = ask?.items?.[0];
  const preview = ask ? (q?.question || 'An agent asks you something') + (ask.thread.threadId !== k.thread.threadId ? ` (${ask.thread.title || 'a station'})` : '')
    : k.call && !k.cut ? k.call.calls[0]!.question
    : k.lastWords ? gist(k.lastWords, 160) : 'The agent finished its turn.';
  const who = model(k.thread.model);
  return `<button type="button" class="tile call-tile mail" data-plate="${e(plateId(k))}" data-thread="${e((ask?.thread || k.thread).threadId)}">`
    + `<span class="ct-top"><span class="proj">${mark(k.project, k.icon)}<span class="pn">${e(k.project)}</span></span>${who ? `<span class="mdl">${e(who)}</span>` : ''}<span class="age">${ago(ask?.thread?.updatedAt || k.updatedAt)}</span></span>`
    + `<span class="q">${e(k.thread.title || 'Untitled thread')}</span><span class="ct-pv">${e(preview)}</span><span class="lbs">${labels(k)}</span></button>`;
}

// The ticket's one place to act (Dan, 2026-11-07): the decision, one note, and the action bar. No confirm step: the
// page holds each send a few seconds with Undo, then sends it.
// Every form names its ticket and carries a one-time id; the server checks everything again (client/actions.ts).
const hidden = (name: string, value: unknown): string => `<input type="hidden" name="${name}" value="${e(value)}">`;
// The form values stay "go" and "refire" (identifiers; saved drafts carry them). Only the words and keys changed
// (Dan, 2026-11-10): Merge is M, Request changes is F ("say what to fix").
// What the Undo toast says while the send waits (hill climb r2, Fable).
const VERB: Record<string, string> = { go: 'Merging {t}', refire: 'Requesting changes on {t}', reply: 'Replying to {t}', hold: 'Holding {t} until 8:00 tomorrow', settle: 'Settling {t}', call: 'Sending your answer{p} for {t}', answer: 'Sending your answer{p} for {t}' };
// The action bar (Dan, 2026-11-10; mock v1, calls 1a, 2a and 3a), like Gmail's: one row, bottom-left and pinned to the
// ticket's foot in every view, the same at any width. The recommended action is blue; then Changes and Reply, an icon
// and one word each; then Hold and Settle as icons after a thin divider; then More (⋯, key "."), a floating card with
// the rest. New actions go in More, not the row. Keys show only in a tooltip, on hover or keyboard focus.
// The blue button is what Cmd+Enter sends: Merge, Approve, Send, or Settle once merged. Dan's tooltip for Merge reads
// "M or ⌘↵", so it replaces council 1b's "Merge never takes Cmd+Enter"; the Undo still holds every send four seconds.
// Each button keeps its form value, so the keys and sends find it. Its first key names its command (data-cmd, from
// client/keys.ts), which the page script reads to tell Merge from Approve and relabels when the key is changed in
// Settings → Shortcuts; Cmd+Enter comes second.
/** One action: its icon, its word (none for an icon button), its full name, its key and command, and its toast. */
interface ActEntry { ic: IconName; word?: string; name: string; key: string; cmd?: string; toast?: string }
type ActKind = 'go' | 'approve' | 'refire' | 'reply' | 'hold' | 'settle' | 'shipped' | 'send' | 'again';
const ACT: Record<ActKind, ActEntry> = {
  go: { ic: 'merge', word: 'Merge', name: 'Merge: the agent merges it', key: 'M', cmd: 'ticket.merge' },
  // A ticket with no open pull request has nothing to merge: there the same button is Approve, with A, and the agent
  // goes ahead with what it handed back, a plan or a finding (Pass call 1a, Dan, 2026-11-10). A question's option
  // letters never meet it: a ticket with a question shows no Approve.
  approve: { ic: 'approve', word: 'Approve', name: 'Approve: the agent goes ahead', key: 'A', cmd: 'ticket.approve', toast: 'Approving {t}' },
  // Call 1a (Dan, 2026-11-10): the button says Changes; its tooltip, the keys sheet and the toasts keep the full name.
  refire: { ic: 'changes', word: 'Changes', name: 'Request changes: say what to fix', key: 'F', cmd: 'ticket.requestChanges' },
  reply: { ic: 'reply', word: 'Reply', name: 'Reply to the agent', key: 'R', cmd: 'ticket.reply' },
  hold: { ic: 'hold', name: 'Hold until 8:00 tomorrow', key: 'H', cmd: 'ticket.hold' },
  settle: { ic: 'settle', name: 'Settle: it leaves the pass', key: 'E', cmd: 'ticket.settle' },
  shipped: { ic: 'settle', word: 'Settle', name: 'Settle: it moves to Verified', key: 'E', cmd: 'ticket.settle' },
  send: { ic: 'send', word: 'Send answer', name: 'Send your answer', key: '' },
  again: { ic: 'send', word: 'Send again', name: 'Send the same answer again', key: '' },
};
// Each key is [label, command] (or a label alone, for a key no one can change).
const kbd = (label: string, cmd?: string): string => `<kbd${cmd ? ` data-cmd="${cmd}"` : ''}>${label}</kbd>`;
type KeySpec = string | readonly [string, (string | undefined)?];
const keys = (list: readonly KeySpec[]): string => list.map((k): [string, string | undefined] => (typeof k === 'string' ? [k, undefined] : [k[0], k[1]])).filter((k) => k[0]).map((k, i) => `${i ? '<span class="or">or</span>' : ''}${kbd(k[0], k[1])}`).join('');
// The tooltip: the full name, then the keys. Screen readers get the button's own name; the keys are for the eye.
const tip = (name: string, list: readonly KeySpec[]): string => `<span class="tip" aria-hidden="true"><span class="tn">${name}</span>${keys(list)}</span>`;
/** One action. a: an ACT entry, labelled when it has a word, else an icon; lead: the blue recommended action. */
const btn = (kind: string, a: ActEntry, lead = false, extra = ''): string => `<button type="submit" name="kind" value="${kind}" class="${a.word ? 'ab' : 'ib'}${lead ? ' fill primary' : ''}"`
  + ` data-toast="${a.toast || VERB[kind] || 'Sending {t}'}"${a.word ? '' : ` aria-label="${a.name}"`}${extra}>${svg(a.ic)}${a.word ? `<span class="bl">${a.word}</span>` : ''}${tip(a.name, [[a.key, a.cmd], lead ? ['⌘↵', 'ticket.suggested'] : ''])}</button>`;
const noteField = (need: string, value = ''): string => `<label class="note"><span>Note to the agent <span class="muted">${need}</span></span><textarea name="note" rows="2" maxlength="4000" placeholder="What should the agent know?">${e(value)}</textarea></label>`;
// More's rows: an icon, a word and its key. The note stays folded away until R, F, N or Add a note asks for it (council 1b).
const MORE_NOTE = `<button type="button" class="mi" role="menuitem" data-addnote>${svg('note')}<span>Add a note</span>${kbd('N', 'ticket.addNote')}</button>`;
const MORE_T3 = `<button type="button" class="mi" role="menuitem" data-open-t3>${svg('out')}<span>Open in T3</span>${kbd('O', 'ticket.open')}</button>`;
// A narrow ticket's row has four slots, so Hold and Settle move into More (call 2a), and the card shows their keys. These rows press the row's own button,
// which keeps the form value.
const phoneRow = (kind: ActKind, word: string): string => `<button type="button" class="mi ph" role="menuitem" data-press="${kind}">${svg(ACT[kind].ic)}<span>${word}</span>${kbd(ACT[kind].key, ACT[kind].cmd)}</button>`;
/** The bar: the labelled buttons, a divider and the icon buttons, then More and its card. The hint line sits above the
 *  row, so a hint never moves the buttons. More is a popover: the card floats above the ticket, never cut off by it. */
function bar(labelled: readonly string[], icons: readonly string[], rows: readonly string[]): string {
  const id = `m-${randomUUID()}`, ic = icons.filter(Boolean);
  return `<div class="act-foot"><p class="result" role="status"></p><div class="abar">${labelled.filter(Boolean).join('')}`
    + (ic.length ? `<span class="vr" aria-hidden="true"></span>${ic.join('')}` : '')
    + `<button type="button" class="ib more-b" data-more popovertarget="${id}" aria-label="More" aria-haspopup="menu">${svg('more')}<span class="mw">More</span>${tip('More', [['.', 'ticket.more']])}</button>`
    + `<div class="menu" id="${id}" popover role="menu" aria-label="More actions">${rows.filter(Boolean).join('')}`
    + `<button type="button" class="mi-x" popovertarget="${id}" popovertargetaction="hide">Cancel</button></div></div></div>`;
}
const formOpen = (k: Ticket, extra = '', nonce: string = randomUUID()): string => `<form class="act" method="post" action="/act" data-plate="${e(plateId(k))}">${hidden('nonce', nonce)}${hidden('thread', k.thread.threadId)}${extra}`;

const plainLine = (l: string): string => l.replace(/\*\*/g, '').replace(/^\s*(?:[-*]\s+)?(?:\d+[.)]\s+)?/, '').trim().replace(/[:.]$/, '');
// "Recommendation: a now. Offer b to the team next week.": the words after the label, when they start with an option letter.
const REC_LABEL = /^\s*(?:[-*]\s+)?\**recommend(?:ation|ed|s)?\**\s*:\**\s*/i;
const recRest = (line: string): string | null => { if (!REC_LABEL.test(line)) return null; const r = line.replace(REC_LABEL, '').replace(/\*\*/g, '').trim(); return /^\(?[a-i]\b(?![a-z'])/i.test(r) ? r : null; };
/** Each decision's recommendation, when it says more than its letter. The message drops the line, so its question's
 *  card shows it under the options (Dan, 2026-11-08: "Recommendation: a. T3 Code uses it" lost its reason). */
function recNotes(call: CallMessage): { notes: string[]; used: Set<number> } {
  // Only the line the parser read each decision's recommendation from moves: never advice from another part of the
  // message (PR-Agent r1, r4, r5, r7 on #50).
  const notes: string[] = [], used = new Set<number>(), lines = call.text.split('\n'), at = recommendLines(call.text);
  if (at.length !== call.calls.length) return { notes, used };
  at.forEach((n, i) => {
    const r = n >= 0 ? recRest(lines[n] ?? '') : null;
    if (r == null || /^\(?[a-i]\)?\.?$/i.test(r)) return;
    notes[i] = r; used.add(n);
  });
  return { notes, used };
}

/** Several questions in one answer show one at a time, as cards (Dan, 2026-11-08): "1 of 3", back and next, and a dot
 *  each that fills once answered. The buttons stay pinned below. The page script moves between them. */
const qNav = (n: number): string => n < 2 ? '' : `<div class="q-nav" role="group" aria-label="Questions"><span class="q-pos" aria-live="polite">1 of ${n}</span>`
  + `<button type="button" class="q-go" data-qgo="-1" aria-label="Previous question" disabled>${svg('chev')}</button><button type="button" class="q-go" data-qgo="1" aria-label="Next question">${svg('chev')}</button>`
  + `<span class="q-dots">${Array.from({ length: n }, (_, i) => `<button type="button" class="q-dot${i ? '' : ' on'}" data-qto="${i}" aria-label="Question ${i + 1}"></button>`).join('')}</span></div>`;
const qOn = (n: number, i: number): string => (n > 1 && i === 0 ? ' q-on' : '');

/** A T3 question a station (or the ticket) is waiting on: its options, then Send. Hold and Settle wait for the answer. */
const ASK_LATER = '<p class="mi-n" role="none">Hold and Settle come back once the question is answered.</p>';
function askDock(k: Ticket, a: Ask): string {
  const byRequest = new Map<string, QuestionItem[]>();
  for (const q of a.items) (byRequest.get(q.requestId) || byRequest.set(q.requestId, []).get(q.requestId)!).push(q);
  const self = a.thread.threadId === k.thread.threadId;
  const who = self ? '' : `<p class="dock-who">${e(a.thread.title || 'A station')} asks</p>`;
  return [...byRequest.entries()].map(([request, qs]) => `<form class="act${qs.length > 1 ? ' q-car' : ''}" method="post" action="/act" data-plate="${e(plateId(k))}">${hidden('nonce', randomUUID())}${hidden('thread', a.thread.threadId)}${hidden('request', request)}${who}`
    + qNav(qs.length) + qs.map((q, qi) => `<fieldset class="q-set${qOn(qs.length, qi)}"><legend>${e(q.question)}</legend>`
      + (q.options || []).map((o, n) => { const rec = /\s*\(recommended\)\s*$/i.test(o.label); const shown = o.label.replace(/\s*\(recommended\)\s*$/i, '');
        return `<label class="opt"><input type="radio" name="q:${e(q.id)}" value="${e(o.label)}" data-key="${'abcdefghi'[n] || ''}"${rec ? ' data-rec' : ''}${q.required === false ? '' : ' data-need'}><span class="opt-t"><b><span class="okey">${'abcdefghi'[n] || ''}.</span> ${optText(shown)}</b>${rec ? ' <span class="rec">Recommended</span>' : ''}${o.description ? `<span class="muted"> ${e(o.description)}</span>` : ''}</span></label>`; }).join('')
      + (q.allowCustomAnswer ? `<label class="opt"><input type="radio" name="q:${e(q.id)}" value="" data-custom><input type="text" class="custom" placeholder="Your own answer" maxlength="2000"></label>` : '')
      + `</fieldset>`).join('')
    // A T3 question has no Reply, and Hold and Settle wait for its answer: More says so.
    + bar([btn('answer', ACT.send, true, ' data-what="your answer"')], [], [MORE_T3, ASK_LATER]) + '</form>').join('');
}

/** What the agent asked in its own message: one choice per decision, the recommended one marked. */
function callDock(k: Ticket, call: CallMessage, done: Answered | undefined): string {
  const reply = btn('reply', ACT.reply, false, ' data-what="your reply" data-note');
  const icons = [btn('hold', ACT.hold, false, ' data-what="Hold until 8:00 tomorrow"'), btn('settle', ACT.settle, false, ' data-what="Settle"')];
  const rows = [phoneRow('hold', ACT.hold.name), phoneRow('settle', 'Settle'), MORE_NOTE, MORE_T3];
  if (done?.confirmed) {
    return formOpen(k) + `<p class="dock-done">You answered ${e(done.picks)} at ${e(done.at)}. The agent gets it when its turn ends.</p>`
      + noteField('needed for Reply') + bar([reply], icons, rows) + '</form>';
  }
  // An unconfirmed send comes back filled in, under its first id, so a retry repeats those exact bytes and T3 keeps one.
  const retry = !!done && !done.confirmed;
  const n = call.calls.length, why = recNotes(call).notes;
  return formOpen(k, hidden('call', call.key), done && retry ? done.nonce : randomUUID()).replace('class="act"', `class="act${n > 1 ? ' q-car' : ''}"`)
    + (retry ? `<p class="result bad">Not confirmed: your ${e(done.picks)} at ${e(done.at)} may not have reached T3. Check the thread in T3, or send the same answer again.</p>` : '')
    + qNav(n) + call.calls.map((c, i) => `<fieldset class="q-set${qOn(n, i)}"${retry ? ' disabled' : ''}><legend>${e(c.question)}</legend>`
      + c.options.map((o) => `<label class="opt"><input type="radio" name="c:${i}" value="${o.letter}" data-key="${o.letter}" data-need${o.letter === c.recommend ? ' data-rec' : ''}${retry && done?.letters?.[i] === o.letter ? ' checked' : ''}><span class="opt-t"><b>${o.letter}.</b> ${optText(o.text)}${o.letter === c.recommend ? ' <span class="rec">Recommended</span>' : ''}</span></label>`).join('')
      + (why[i] ? `<p class="q-why"><b>Recommendation:</b> ${e(why[i])}</p>` : '') + `</fieldset>`).join('')
    + (done && retry ? call.calls.map((c, i) => hidden(`c:${i}`, done.letters?.[i] || '')).join('') + hidden('note', done.note || '')
      : noteField('optional with your answer, needed for Reply'))
    // A retry sends the same answer again and nothing else, so its row has only that.
    + (retry ? bar([btn('call', ACT.again, true, ' data-what="the same answer again"')], [], [MORE_T3])
      : bar([btn('call', ACT.send, true, ' data-what="your answer"'), reply], icons, rows)) + '</form>';
}

/** A ticket handed back with no decision asked: Merge or Approve (or Settle once merged) in blue, Changes with a note,
 *  Reply, then Hold and Settle. */
function turnDock(k: Ticket): string {
  const sent = k.place === 'Merged', canGo = k.atPass && !sent && !k.cut;
  const go = k.open.length ? btn('go', ACT.go, true, ' data-what="Merge: the agent merges it"')
    : btn('go', ACT.approve, true, ` data-what="${ACT.approve.name}"`);
  const labelled = [
    sent ? btn('settle', ACT.shipped, true, ' data-what="Settle: it moves to Verified"') : canGo ? go : '',
    k.atPass && !k.cut ? btn('refire', ACT.refire, false, ' data-what="Request changes with your note" data-note') : '',
    btn('reply', ACT.reply, false, ' data-what="your reply" data-note'),
  ];
  const icons = [btn('hold', ACT.hold, false, ' data-what="Hold until 8:00 tomorrow"'), sent ? '' : btn('settle', ACT.settle, false, ' data-what="Settle: it leaves the pass"')];
  const rows = [phoneRow('hold', ACT.hold.name), sent ? '' : phoneRow('settle', 'Settle'), MORE_NOTE, MORE_T3];
  // "pr" says which button the lead saw, Merge or Approve, so the server never sends the other one (client/actions.ts).
  return formOpen(k, hidden('pr', k.open.length ? 'open' : 'none')) + noteField(k.atPass && !k.cut ? 'needed for Request changes and Reply' : 'needed for Reply') + bar(labelled, icons, rows) + '</form>';
}

function dock(k: Ticket, answered: ReadonlyMap<string, Answered>): string {
  if (k.place === 'Coordinators') return '';
  if (k.asks.length) {
    return `<aside class="dock" aria-label="Your answer"><p class="dock-k">${chip(qWord(questionCount(k)), 'blue')}</p>${k.asks.map((a) => a.items.length ? askDock(k, a) : `<p class="row-l">${e(a.thread.title || 'A station')} asks a question that did not load. Answer it in T3.</p>`).join('')}</aside>`;
  }
  if (k.yourTurn && k.call && !k.cut) {
    const done = answered.get(k.call.key);
    return `<aside class="dock${done?.confirmed ? ' dock-plain' : ''}" aria-label="Your call"><p class="dock-k">${chip(qWord(questionCount(k)), 'blue')}</p>${callDock(k, k.call, done)}</aside>`;
  }
  return `<aside class="dock dock-plain" aria-label="Your move">${k.atPass ? `<p class="dock-k">${chip(k.place === 'Ready to merge' ? 'Your look' : k.place === 'Merged' ? 'Check it' : 'Your turn', 'blue')}</p>` : ''}${turnDock(k)}</aside>`;
}

/** One ticket in full. The message and its screenshots read on the left (or above); the dock acts. */
function plate(k: Ticket, link: (t: ThreadRow) => string, origin: string, answered: ReadonlyMap<string, Answered>, rules: unknown): string {
  const parts: string[] = []; let handBack = '';
  if (k.asks.length && !k.yourTurn && k.lastWords) parts.push(`<div class="prose last full">${rich(k.lastWords, origin)}</div>`);
  for (const a of k.asks) {
    if (a.thread.threadId !== k.thread.threadId) parts.push(`<p class="msg-h"><b>${e(a.thread.title || 'A station')}</b> is waiting on your answer. <a href="${e(link(a.thread))}" target="_blank" rel="noopener">Open in T3${svg('out')}</a></p>`);
  }
  if (k.yourTurn && !k.asks.length && k.call) {
    // The dock holds the options, so the message drops its lettered option lines and keeps the rest (Fable).
    const opts = k.call.calls.flatMap((c) => c.options.map((o): [string, string] => [o.letter, String(o.text).slice(0, 24)]));
    const OPTLINE = /^\s*(?:[-*]\s+)?(?:\*\*)?\(?([a-zA-Z])[.)](?:\*\*)?\s+(\S.*?)\s*$/;
    // The dock also shows each question and the recommendation, so their scaffolding lines go too (hill climb r4,
    // Sol): "Decision for you", "1. Ship #2151?", "Recommendation: a.". Supporting prose stays.
    const qs = k.call.calls.map((c) => plainLine(c.question).toLowerCase());
    const moved = recNotes(k.call).used;
    const scaffold = (line: string, n: number) => {
      const p = plainLine(line).toLowerCase();
      // A recommendation line goes too, with its reasons: the question's card shows them (Dan, 2026-11-08).
      return /^(decisions?|your call)( for (you|dan))?$/.test(p) || qs.includes(p) || /^recommend(ation|ed|s)?:?\s*\(?[a-i]\)?\.?$/.test(p) || moved.has(n);
    };
    // A line with a screenshot or a link stays, so neither is lost (PR-Agent r2 to r6 on #27). The dock links only an
    // option's GitHub PR URLs, so only an option line may drop for those; a question or recommendation line keeps them.
    const NONPR = /https?:\/\/(?!github\.com\/[^\s/]+\/[^\s/]+\/pull\/[0-9]+)/;
    const isOpt = (line: string) => { const m = OPTLINE.exec(line); return !!(m && opts.some(([l, t]) => l === m[1]!.toLowerCase() && m[2]!.replace(/\*\*/g, '').startsWith(t.replace(/\*\*/g, '').slice(0, 12)))); };
    const keep = (line: string) => line.includes('](') || (isOpt(line) ? NONPR.test(line) : /https?:\/\//.test(line));
    // Once the answer is confirmed the dock no longer shows the choices, so the message keeps them all (PR-Agent r6).
    const done = answered && answered.get(k.call.key);
    const body = done?.confirmed ? k.call.text.trim()
      : k.call.text.split('\n').filter((line, n) => keep(line) || !(scaffold(line, n) || isOpt(line))).join('\n').replace(/\n{3,}/g, '\n\n').trim();
    parts.push(`<div class="prose last full">${rich(body, origin)}</div>`);
    if (k.latestId && k.latestId !== k.call.itemId && k.lastWords) parts.push(`<p class="msg-h"><b>Since then</b></p><div class="prose last full">${rich(k.lastWords, origin)}</div>`);
  } else if (k.yourTurn) {
    // Every hand-back says first what it asks of you (hill climb 2 r1, Opus), under the title like a question, before
    // the pull requests and screenshots (r2, Astra).
    handBack = k.place === 'Merged' ? 'Try it where it shipped. If it works, settle it.' : k.cut ? 'The agent handed it back. Not checked: the Pass could not read all of its recent messages. Read them in T3 before you act.'
      : k.place === 'In review' ? 'Review the pull request, then merge or request changes.' : k.place === 'Ready to merge' ? 'Ready for your look. Check it, then merge or request changes.' : '';
    parts.push(k.lastWords ? `<div class="prose last full">${rich(k.lastWords, origin)}</div>` : '');
  }
  const prUrl = (p: PullRequestLink) => p.url || `https://github.com/${p.repository}/pull/${p.number}`;
  // The pull request is what Dan acts on: up to three as chips under the title, the rest in a fold (hill climb r1).
  // Open pull requests first: they are the current work (hill climb r2, Astra).
  // The pull request the message names comes first, so the chip beside the question is the one it is about
  // (hill climb 2, r1); then open ones.
  const said = [k.call?.text, k.lastWords].filter(Boolean).join('\n');
  // A whole URL or number only: /pull/21 is not named by /pull/2151 (PR-Agent r1 on #38).
  const named = (p: PullRequestLink) => (said.split(prUrl(p)).slice(1).some((rest) => !/^[0-9]/.test(rest)) || new RegExp(`#${p.number}(?![0-9])`).test(said) ? 0 : 1);
  // The plate lists every link. Two that would read alike (one PR linked under its old and new owner) show the owner.
  const base = (p: PullRequestLink) => `${p.repository.split('/').pop()!.toLowerCase()}#${p.number}`;
  const twin = (p: PullRequestLink) => k.prs.some((o) => o !== p && base(o) === base(p));
  const prsSorted = [...k.prs].sort((a, b) => (named(a) - named(b)) || ((a.state === 'open' ? 0 : 1) - (b.state === 'open' ? 0 : 1)));
  const prChips = prsSorted.slice(0, 3).map((p) => `<a class="prc t-${PR_TONE[p.state ?? ''] || 'gray'}" href="${e(prUrl(p))}" target="_blank" rel="noopener"><i></i>${e(twin(p) ? p.repository : p.repository.split('/').pop())}#${p.number}<span>${e(p.state)}</span>${svg('out')}</a>`).join('');
  const prs = prsSorted.slice(3).map((p) => `<li>${chip(p.state, PR_TONE[p.state ?? ''] || 'gray')}<a href="${e(prUrl(p))}" target="_blank" rel="noopener">${e(p.repository)}#${p.number}${svg('out')}</a></li>`).join('');
  // A ticket still cooking has no hand-back to read: say where it stands instead of an empty sheet.
  const facts = [HINT[k.place] || k.place, k.working ? `${k.working} working` : '', k.open.length ? `${k.open.length} PR${k.open.length === 1 ? '' : 's'} open` : k.merged.length ? `${k.merged.length} merged` : '', `updated ${since(k.updatedAt)}`].filter(Boolean);
  const why = k.working ? 'The agents are still working. Their hand-back shows here when they finish.' : '';
  const status = !k.yourTurn && !k.asks.length ? `<p class="status-line">${facts.map((f) => `<span>${e(f)}</span>`).join('')}</p>${why ? `<p class="status-why">${why}</p>` : ''}` : '';
  // Stations (hill climb r2): live and stuck ones first, a chip only when not completed, eight shown, the rest folded.
  const RANK: Record<string, number> = { running: 0, starting: 0, queued: 0, preparing: 0, waiting: 1, failed: 2, interrupted: 2 };
  const crew = k.crew.slice(1).sort((a, b) => ((RANK[a.status] ?? 3) - (RANK[b.status] ?? 3)) || (a.updatedAt < b.updatedAt ? 1 : -1));
  const row = (c: ThreadRow) => `<li>${c.status !== 'completed' ? chip(c.status, STATUS_TONE[c.status] || 'gray') : ''}<a href="${e(link(c))}" target="_blank" rel="noopener">${e(c.title || 'Station')}${svg('out')}</a><span class="muted">${e([model(c.model), since(c.updatedAt)].filter(Boolean).join(' · '))}</span></li>`;
  const stations = crew.slice(0, 8).map(row).join('');
  const more = crew.length > 8 ? `<details class="more-st"><summary>Show all ${crew.length}</summary><ul class="links">${crew.slice(8, 60).map(row).join('')}</ul>${crew.length > 60 ? `<p class="muted">${crew.length - 60} more in T3.</p>` : ''}</details>` : '';
  const live = crew.some((c) => (RANK[c.status] ?? 3) < 2);
  const id = plateId(k);
  // The title is the T3 thread's; the questions live in the dock, one card each (Dan, 2026-11-08). Under the title, only
  // the blue pill with how many wait on you.
  const nQ = questionCount(k);
  const lead = nQ ? `<p class="lead lead-n"><span class="chip c-blue lead-k">${qWord(nQ)}</span></p>`
    : handBack ? `<p class="lead"><span class="lead-q">${handBack}</span></p>` : '';
  // Screenshots from every message the reader shows, pinned under the title (Dan, 2026-11-07).
  const atts = !parts.length ? '' : attachments(...(k.yourTurn && !k.asks.length && k.call ? [k.call.text, k.latestId && k.latestId !== k.call.itemId ? k.lastWords : ''] : [k.lastWords]));
  // Rules (Dan, 2026-11-08): a call about something you can see, with no screenshots, says so. The button
  // fills Reply with the ask; you send it with Cmd+Enter, and can change it first.
  const shotsMissing = k.yourTurn && !k.asks.length && k.call && !k.cut && !answered.get(k.call.key)?.confirmed
    && missingShots(rules, k.thread.projectId, k.call, imagesIn(k.call.text).length
      // Shots sent in a later message count too: the same messages the attachments row reads (PR-Agent r4 on #49).
      + (k.latestId && k.latestId !== k.call.itemId ? imagesIn(k.lastWords || '').length : 0));
  const flag = shotsMissing ? `<p class="kr-flag"><span class="kr-k">No screenshots</span><span class="kr-t">This call asks about something you can see.</span>`
    + `<button type="button" class="btn quiet kr-ask" data-ask-shots="${e(ASK_SHOTS)}"><span class="bl">Ask for them</span></button></p>` : '';
  return `<article class="plate" id="${e(id)}" data-thread="${e(k.thread.threadId)}" data-latest="${e(k.latestId || '')}"${k.atPass ? ' data-at' : ''} aria-labelledby="${e(id)}-t">`
    + `<div class="plate-bar"><span class="proj" data-project="${e(k.project)}">${mark(k.project, k.icon)}${e(k.project)}</span><span class="stg"><i class="gd c-${DOT[k.place] || 'gray'}"></i>${e(k.place)}</span>${model(k.thread.model) ? `<span class="mdl">${e(model(k.thread.model))}</span>` : ''}<a class="open-t3" href="${e(link(k.thread))}" target="_blank" rel="noopener">Open in T3${svg('out')}${kbd('O', 'ticket.open')}</a>`
    + `<button type="button" class="close" data-close aria-label="Close"><kbd>esc</kbd>${svg('x')}</button></div>`
    // The title, the ask, the pull requests and the screenshots stay pinned while the message scrolls (Dan, 2026-11-08).
    + `<div class="plate-main"><div class="plate-scroll" tabindex="-1"><header class="plate-head"><h2 class="plate-t" id="${e(id)}-t">${e(k.thread.title)}</h2>`
    + lead + flag + (prChips ? `<div class="pr-row">${prChips}</div>` : '') + atts + status + '</header>'
    + (parts.length ? `<section class="msg">${parts.join('')}</section>` : '')
    + (prs ? `<details class="more"><summary>More pull requests <span class="muted">${k.prs.length - 3}</span></summary><ul class="links">${prs}</ul></details>` : '')
    + (stations ? `<details class="more"${live ? ' open' : ''}><summary>Stations <span class="muted">${crew.length}</span></summary><ul class="links">${stations}</ul>${more}</details>` : '')
    + `</div>${dock(k, answered)}</div></article>`;
}

const plural = (n: number | null, one: string, many = one + 's'): string => `${n} ${n === 1 ? one : many}`;
// Minutes as a card says them: "52 min", "3 h", "2 d".
const span = (m: number): string => (m < 60 ? `${m} min` : m < 1440 ? `${Math.floor(m / 60)} h` : `${Math.floor(m / 1440)} d`);
const NOT = (why: string): string => `<b class="nc">Not checked</b><span>${why}</span>`;
/** Bars of whole numbers, one each, tallest the highest. */
function bars(vals: readonly number[], label: string): string {
  const w = 200, h = 30, m = Math.max(1, ...vals), bw = w / vals.length;
  return `<svg class="vbars" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" role="img" aria-label="${e(label)}">${vals.map((v, i) => { const bh = Math.max(2, (v / m) * (h - 2));
    return `<rect x="${(i * bw + 1.5).toFixed(1)}" y="${(h - bh).toFixed(1)}" width="${Math.max(1, bw - 3).toFixed(1)}" height="${bh.toFixed(1)}" rx="1.5"/>`; }).join('')}</svg>`;
}
/** You, expanded: the solo Sankey (Dan, 2026-11-11, flow mock v3.3; client/flow.ts) under the header picker. It took the
 *  place of the six stage columns: your threads run left to right from their project, through checks and review, to you
 *  and the branch they merged into, and a band that waits on you lights its card in The Pass beside it. Without a good
 *  poll it says "Not checked"; with nothing on the line it says so. Verified and on hold stay in the stage list. */
function youView({ chart, head, back }: { chart: string; head: string; back: boolean }): string {
  // Back: one project open (a click on it in the chart, or a pick), so the way to every project sits beside the picker.
  const btn = back ? `<button type="button" class="fx-back" data-unpick aria-label="Back to all projects" title="Back to all projects">${svg('chev')}</button>` : '';
  return `<section class="you" aria-label="Your threads by stage"><header class="you-h">${head}${btn}</header>`
    + `<div class="you-b"><div class="fx-wrap">${chart}<div class="fx-tip" role="tooltip" hidden></div></div></div></section>`;
}

// ---------- Your team, Open kitchen (step 4) ----------
// client/open-kitchen.ts derives the calls; this draws them in the approved parts (mock v2, round 2, 2026-11-10): the
// call tile in The Pass, the rail card, the quiet line under the tiles, and a reader per call. Times are the team
// reading's `now`, never the page clock. Until the team connection lands no page has a team view, so none of this
// shows; the tests and screenshots feed it a made-up team.
const initials = (name: unknown): string => String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w.charAt(0).toUpperCase()).join('') || '?';
const face = (p: Person | null | undefined, cls = ''): string => `<span class="av${cls ? ` ${cls}` : ''}" style="--h:${hue(String(p?.name || p?.id || '?'))}" title="${e(p?.name || 'Someone')}" aria-hidden="true">${e(initials(p?.name))}</span>`;
// Number() keeps what new Date() made of a missing time before the port: null is 0, undefined is not a date.
const hm = (t: number | null | undefined): string => new Date(Number(t)).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
const nf = (n: unknown): string => Number(n).toLocaleString('en-US');
const and = (xs: readonly string[]): string => (xs.length < 2 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);
const pos = (s: string | null): string => `${s}’s`;
const teamPlateId = (c: { id: string }): string => 'p-' + createHash('sha1').update(`team:${c.id}`).digest('hex').slice(0, 12);
// A teammate's PR link comes from their summary: only a GitHub pull request address opens.
const prHref = (pr: TeamPr) => (/^https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/[0-9]+$/.test(pr?.url || '') ? pr.url : `https://github.com/${String(pr?.repo || '').split('/').map(encodeURIComponent).join('/')}/pull/${Number(pr?.n) || 0}`);
const teamPrChip = (pr: TeamPr): string => `<a class="prc t-${PR_TONE[pr.state ?? ''] || 'gray'}" href="${e(prHref(pr))}" target="_blank" rel="noopener"><i></i>${e(String(pr.repo).split('/').pop())}#${Number(pr.n)}<span>${e(pr.state)}</span>${svg('out')}</a>`;
const kvs = (pairs: readonly (readonly [string, string, string?])[]): string => `<div class="tvis"><div class="kvs">${pairs.map(([k, v, cls]) => `<div class="kv"><span>${e(k)}</span><b${cls ? ` class="${cls}"` : ''}>${e(v)}</b></div>`).join('')}</div></div>`;
const vlab = (left: string, right = '', tone = ''): string => `<div class="vl"><span>${left}</span>${right ? `<b${tone ? ` class="${tone}"` : ''}>${e(right)}</b>` : ''}</div>`;
const NC_V = 'Not checked';

/** Who has seen the call, and why it reached you. Seen comes from each dev's own Yes Chef, in their summary. */
type Namer = (id: string) => string;
function seenLine(c: TeamCall, name: Namer): string {
  const seen = c.who.filter((id) => c.seen[id] != null), not = c.who.filter((id) => c.seen[id] == null);
  const s = seen.map((id) => `${name(id)} at ${hm(c.seen[id])}`);
  const r = c.reach;
  const why = r.why === 'red' ? 'Red calls reach you at once.'
    : r.why === 'quiet' ? `${and(c.quiet.map((q) => name(q.person)))} ${c.quiet.length > 1 ? 'are' : 'is'} not reporting, so it reached you at once.`
    : r.why === 'runs' ? `It reached you at the ${r.runs}th failed run.`
    : r.why === 'time' ? `It reached you after ${r.min} min.`
    : r.why === 'unseen' ? `It reached you after ${r.min} min unseen.` : '';
  const head = seen.length ? `<b class="ok">Seen</b> by ${e(and(s))}.${not.length ? ` ${e(and(not.map(name)))} ${not.length > 1 ? 'have' : 'has'} not seen it.` : ''}`
    : `<b class="no">Not seen</b> by ${e(and(not.map(name)))}.`;
  return `<p class="tseen">${head} ${e(why)}</p>`;
}

/** A dev who is not reporting: their data stops at their last report, and the reader says so before anything else. */
const quietBox = (c: TeamCall, name: Namer, now: number): string => c.quiet.map((q) => `<div class="tquiet"><span class="hz" aria-hidden="true"></span><span><b>Not reporting${q.since != null ? ` since ${hm(q.since)}` : ''}.</b> `
  + `${e(pos(name(q.person)))} Mac has sent nothing${q.since != null ? ` for ${span(Math.max(0, Math.round((now - q.since) / 60000)))}` : ''}, so what it sent last is all Yes Chef knows.</span></div>`).join('');

/** The words and parts of each call: tile title and preview, the reader's lead, Suggested, its body and its actions.
 *  acts: [kind, word, tooltip], the first one blue. */
/** A call's words and parts. acts: [kind, word, tooltip]; ask and rec only for a question. */
interface Words { title: string; preview: string; lead: string; suggest: string; why: string; body: string;
  acts: [string, string, string][]; reply: string | null; ask?: TeamAsk; rec?: string | null }
function callWords(c: TeamCall, { name, now, people }: { name: Namer; now: number; people: ReadonlyMap<string, Person> }): Words {
  const { kind, facts: f } = c, who = name(c.who[0] ?? '');
  const pr = c.prs[0];
  switch (kind) {
    case 'main': {
      const n = f.cause?.pr.n, by = f.cause ? name(f.cause.person) : null, br = f.branch;
      const checks = f.failing.length ? and(f.failing) : 'A required check';
      const day = new Date(now); day.setHours(0, 0, 0, 0);
      const merges = f.mergedToday.filter((m) => m.at >= day.getTime() && m.at <= now);
      const cut = f.cause ? f.cause.pr.mergedAt : null;
      const ribbon = merges.length ? `<div class="tvis">${vlab(`Your team’s merges to ${e(br)} today`, c.since != null ? `Red since ${hm(c.since)}` : 'Red', 'red')}`
        + `<div class="ribbon">${merges.map((m) => `<i${m.n === n ? ' class="r"' : cut != null && m.at > cut ? ' class="a"' : ''} title="#${m.n}, ${e(name(m.person))}, ${hm(m.at)}"></i>`).join('')}</div>`
        + `<div class="raxis"><span>${hm(merges[0]!.at)}</span>${f.cause ? `<span>#${n} at ${hm(cut)}</span>` : ''}<span>now</span></div>`
        + `<div class="wlg">${merges.some((m) => m.n !== n && (cut == null || m.at <= cut)) ? '<span><i class="g"></i>merged</span>' : ''}${f.cause ? `<span><i class="r"></i>#${n}, then red</span>` : ''}`
        + `${merges.some((m) => cut != null && m.at > cut) ? '<span><i class="a"></i>merged after it</span>' : ''}</div></div>` : '';
      const waits = f.waiting.length ? `<div class="tvis">${vlab(`Waiting on ${e(br)}`, `${plural(f.waiting.length, 'PR')} can’t merge`)}<div class="tprs">${f.waiting.map((w) => `<span class="tpr">${face(people.get(w.person), 'sm')}#${w.n}</span>`).join('')}</div></div>` : '';
      const size = f.cause?.pr.size;
      const facts = kvs([
        f.cause ? ['PR', `#${n} ${f.cause.ticket.title || ''}`.trim()] : ['Repo', f.repo],
        ['By', f.cause ? `${pos(by)} agent, merged ${hm(cut)}` : NC_V],
        ['Size', size && [size.files, size.added, size.removed].every(Number.isFinite) ? `${plural(size.files, 'file')}, +${nf(size.added)} −${nf(size.removed)}` : NC_V],
        [f.failing.length > 1 ? 'Failing checks' : 'Failing check', f.failing.length ? f.failing.join(', ') : NC_V, 'mono'],
      ]);
      return {
        title: f.cause ? `${br} is red after #${n} merged` : `${br} is red in ${f.repo}`,
        preview: f.waiting.length ? `${plural(f.waiting.length, 'PR')} can’t merge until ${br} is green.` : `${br} has been red${c.since != null ? ` since ${hm(c.since)}` : ''}.`,
        lead: `${checks} ${f.failing.length > 1 ? 'have' : 'has'} failed on ${br}${c.since != null ? ` since ${hm(c.since)}` : ''}. `
          + (f.clean ? `#${n} is the first red commit, and nothing came after it.` : f.cause ? `#${n} is the first red commit. More came after it, so a roll back is not clean.` : 'No PR from your team is the first red commit.'),
        suggest: f.clean ? `Roll back #${n}` : f.cause ? `Ask ${by} to fix ${br}` : `Find what broke ${br}`,
        why: f.clean ? `Roll back #${n}. Nothing came after it, so the revert is clean. ${pos(by)} thread keeps the work.`
          : f.cause ? `Ask ${pos(by)} agent to fix ${br}. More came after #${n}, so a revert would not be clean.` : `Open ${pos(br)} failing check in ${f.repo} on GitHub. No PR from your team is the first red commit.`,
        body: ribbon + waits + facts,
        acts: f.clean ? [['rollback', 'Roll back', `Roll back: ${pos(by)} agent reverts #${n}`], ['reply', 'Reply', `Reply to ${pos(by)} agent`]]
          : f.cause ? [['reply', 'Reply', `Reply to ${pos(by)} agent`]] : [],
        reply: f.cause ? by : null,
      };
    }
    case 'overlap': {
      // An Overlap always has a file with shared lines and two sides (open-kitchen.ts).
      const top = f.files[0]!, A = f.sides[0]!, B = f.sides[1]!, R = name(f.rebaser.person), K = name(f.keeper.person);
      const kpr = f.keeper.pr, rpr = f.rebaser.pr;
      const same = A.person === B.person;
      const names = same ? `${pos(name(A.person))} two threads` : `${name(A.person)} and ${name(B.person)}`;
      const both = kpr && rpr;
      const card = (s: Side) => { const p = s.pr;
        return `<div class="tcard"><div class="h">${face(people.get(s.person))}${e(name(s.person))}<span class="lb"><i class="gd c-${DOT[s.ticket.place ?? ''] || 'gray'}"></i>${e(s.ticket.place || NC_V)}</span></div>`
          + `<div class="t">${e(s.ticket.title || 'Untitled thread')}</div><div class="m">${e([p ? `PR #${p.n}` : 'No PR yet', s.ticket.working ? plural(s.ticket.working, 'agent') : '', s.ticket.startedAt != null ? `started ${hm(s.ticket.startedAt)}` : ''].filter(Boolean).join(', '))}</div></div>`; };
      // The file's line map: each side's changed ranges, the shared lines boxed in red.
      const ends = [...top.a, ...top.b].map((r) => Math.max(r[0], r[1]));
      const L = Math.max(10, Math.ceil(Math.max(...ends) / 10) * 10);
      const at = (a: number, b: number) => `left:${((a - 1) / L * 100).toFixed(2)}%;width:${(Math.max(1, b - a + 1) / L * 100).toFixed(2)}%`;
      const lane = (s: Side, rs: readonly (readonly [number, number, ...unknown[]])[]) => `<div class="tr"><span>${e(name(s.person))}</span><div class="lane">${rs.map((r) => `<i style="${at(r[0], Math.max(r[0], r[1]))}"></i>`).join('')}</div></div>`;
      const bands = top.shared.map((r) => `<div class="band" style="left:calc(62px + (100% - 62px) * ${((r[0] - 1) / L).toFixed(4)});width:calc((100% - 62px) * ${((r[1] - r[0] + 1) / L).toFixed(4)})"></div>`).join('');
      const ticks = [1, Math.round(L / 4), Math.round(L / 2), Math.round((3 * L) / 4), L];
      const s0 = top.shared[0]!;
      // From two merge bases the line numbers are near, not exact: "About".
      const lines = (f.near ? 'About l' : 'L') + (s0[0] === s0[1] ? `ine ${s0[0]}` : `ines ${s0[0]} to ${s0[1]}`);
      const map = `<div class="tvis">${vlab(`<span class="mono">${e(top.path)}</span>`, `${lines}, both${top.shared.length > 1 ? `, and ${top.shared.length - 1} more` : ''}`, 'red')}<div class="fmap">`
        + lane(A, top.a) + lane(B, top.b) + bands + `<div class="ticks"><span></span><div>${ticks.map((t) => `<span>${t}</span>`).join('')}</div></div></div>`
        + (f.files.length > 1 ? `<p class="tmore">Also the same lines of ${plural(f.files.length - 1, 'more file')}: ${e(f.files.slice(1, 4).map((x) => x.path.split('/').pop()).join(', '))}${f.files.length > 4 ? ', …' : ''}</p>` : '') + '</div>';
      return {
        title: `${names} both change ${top.path.split('/').pop()}`,
        preview: both ? 'Both PRs are open. Whoever merges second redoes the work.' : 'Whoever merges second redoes the work.',
        lead: `Both change ${lines.toLowerCase()} of ${top.path}. Whoever merges second redoes part of the work.`
          + (f.near ? ' They started from different points on the base, so the line numbers are near, not exact.' : ''),
        suggest: `Ask ${R} to rebase`,
        why: `Ask ${R} to rebase${kpr ? ` on #${kpr.n}` : ''}. ${pos(K)} thread is ${String(f.keeper.ticket.place || 'further along').toLowerCase()} and further along.`,
        body: `<div class="duo">${card(A)}${card(B)}</div>` + map,
        acts: [['rebase', 'Rebase', `Rebase: ${pos(R)} agent rebases${kpr ? ` on #${kpr.n}` : ''}`], ['reply', 'Reply', `Reply to ${pos(R)} agent`]],
        reply: R,
      };
    }
    case 'failing':
      return {
        title: `#${f.pr.n} checks failed ${f.redRuns} runs in a row`,
        preview: c.since != null ? `${pos(who)} PR has been red since ${hm(c.since)}.` : `${pos(who)} PR keeps failing its checks.`,
        lead: `${f.ticket.title || 'The thread'}: ${f.redRuns} red runs in a row${c.since != null ? `, the first at ${hm(c.since)}` : ''}.`,
        suggest: 'Ask for a new approach',
        why: `Request changes: ask ${pos(who)} agent for a new approach. ${f.redRuns} runs failed in a row.`,
        body: kvs([['PR', `#${f.pr.n} ${f.ticket.title || ''}`.trim()], ['By', `${pos(who)} agent${f.ticket.working ? `, ${plural(f.ticket.working, 'agent')}` : ''}`], ['Red runs in a row', String(f.redRuns)], ['Red for', c.since != null ? span(Math.round((now - c.since) / 60000)) : NC_V]]),
        acts: [['refire', 'Changes', `Request changes: ${pos(who)} agent gets your note`], ['reply', 'Reply', `Reply to ${pos(who)} agent`]],
        reply: who,
      };
    case 'stuck':
      return {
        title: `${pos(who)} agent is quiet${pr ? ` on #${pr.n}` : ''}`,
        preview: `The thread runs, with nothing new since ${hm(c.since)}.`,
        lead: `${f.ticket.title || 'The thread'}. It is running, but it has sent no message, commit or check since ${hm(c.since)}.`,
        suggest: 'Ask for status',
        why: `Reply: ask ${pos(who)} agent where it stands.`,
        body: kvs([['Agents', f.ticket.working ? `${f.ticket.working}, running` : NC_V], ['Quiet for', span(Math.round((now - Number(c.since)) / 60000))], ['PR', pr ? `#${pr.n}, ${pr.state}` : 'None yet'], ['Thread', f.ticket.place || NC_V]]),
        acts: [['reply', 'Reply', `Reply to ${pos(who)} agent`], ['refire', 'Changes', `Request changes: ${pos(who)} agent gets your note`]],
        reply: who,
      };
    case 'waiting': {
      const a = f.ask, rec = /^[a-i]$/.test(a.rec || '') ? a.rec : null;
      return {
        title: `${pos(who)} agent waits on an answer`,
        preview: String(a.q || 'An agent asks a question.'),
        lead: `${f.ticket.title || 'The thread'} has waited on this since ${hm(c.since)}. It does nothing until someone answers.`,
        suggest: rec ? `Answer ${rec}` : 'Answer it',
        why: rec ? `Answer ${rec}, the agent’s pick.` : 'Answer it, or reply with what the agent needs.',
        body: kvs([['Thread', f.ticket.title || NC_V], ['Waiting for', span(Math.round((now - Number(c.since)) / 60000))], ['PR', pr ? `#${pr.n}, ${pr.state}` : 'None yet'], [`${who}, last seen`, c.quiet[0]?.since != null ? hm(c.quiet[0].since) : 'Reporting']]),
        ask: a, rec,
        acts: [['answer', 'Send answer', `Send your answer to ${pos(who)} agent`], ['reply', 'Reply', `Reply to ${pos(who)} agent`]],
        reply: who,
      };
    }
    case 'big':
    default:
      return {
        title: `#${f.pr.n} changes ${nf(f.lines)} lines in ${plural(f.size.files, 'file')}`,
        preview: 'The limit is 800 lines or 30 files.',
        lead: 'The limit is 800 lines or 30 files, with lockfiles left out.',
        suggest: 'Split it',
        why: `Request changes: ask ${pos(who)} agent to split #${f.pr.n} into smaller PRs.`,
        body: kvs([['PR', `#${f.pr.n} ${f.ticket.title || ''}`.trim()], ['Changed lines', `+${nf(f.size.added)} −${nf(f.size.removed)}`], ['Files', String(f.size.files)], ['By', `${pos(who)} agent`]]),
        acts: [['refire', 'Changes', `Request changes: ${pos(who)} agent gets your note`], ['reply', 'Reply', `Reply to ${pos(who)} agent`]],
        reply: who,
      };
  }
}

/** The call's dock. Each action shows only for a role whose boxes allow it (open-kitchen.ts may); the blue one only
 *  when it is the suggested action. Nothing here sends yet: the page refuses a team form until the team connection
 *  lands, and the server has no route for one. */
function teamDock(c: TeamCall, w: Words, me: Me | null | undefined, id: string): string {
  const allowed = w.acts.filter(([kind]) => may(me, kind));
  const blue = allowed.length && allowed[0] === w.acts[0] ? allowed[0]![0] : null;
  // Names come from teammates' summaries, so the tooltip's name is escaped here (btn writes it as markup).
  const labelled = allowed.map(([kind, word, name]) => btn(kind, { ic: kind === 'reply' ? 'reply' : kind === 'refire' ? 'changes' : 'send', word, name: e(name), key: '' }, kind === blue, ` data-what="${e(name)}"${kind === 'reply' || kind === 'refire' ? ' data-note' : ''}`));
  const hold = may(me, 'hold') ? btn('hold', ACT.hold, false, ' data-what="Hold until 8:00 tomorrow"') : '';
  const settle = btn('settle', { ...ACT.settle, name: 'Settle: it leaves your Pass' }, false, ' data-what="Settle"');
  const rows = [hold ? phoneRow('hold', ACT.hold.name) : '', phoneRow('settle', 'Settle'), allowed.length ? MORE_NOTE : ''];
  const ask = w.ask && may(me, 'answer') ? `<fieldset class="q-set"><legend>${e(w.ask.q || 'The agent asks')}</legend>`
    + (Array.isArray(w.ask.options) ? w.ask.options : []).filter((o) => /^[a-i]$/.test(o?.k || '')).map((o) => `<label class="opt"><input type="radio" name="c:0" value="${o.k}" data-key="${o.k}" data-need${o.k === w.rec ? ' data-rec' : ''}><span class="opt-t"><b>${o.k}.</b> ${e(o.t)}${o.k === w.rec ? ' <span class="rec">Recommended</span>' : ''}</span></label>`).join('')
    + '</fieldset>' : '';
  const kinds = allowed.map(([kind]) => kind);
  const note = !allowed.length ? '' : noteField(kinds.includes('refire') ? 'needed for Changes and Reply' : kinds.includes('reply') ? `optional with ${kinds[0] === 'reply' ? 'Hold' : allowed[0]![1]}, needed for Reply` : 'optional');
  const only = allowed.length ? '' : `<p class="dock-who">Your role can see this call. Acting on it needs more from your lead.</p>`;
  return `<aside class="dock dock-plain" aria-label="Your move"><form class="act team-act" method="post" action="/act" data-plate="${e(id)}">${only}${ask}${note}${bar(labelled, [hold, settle], rows)}</form></aside>`;
}

/** Your team, expanded (mock v2, approved 2026-11-10): a header, four instruments, the rows (flow mock round 3.3, locked
 *  2026-11-11: they replace Who's on what) and the files two live threads change. Its numbers come from client/open-kitchen.ts kitchenBoard; what no summary says reads "Not checked". */
function boardOf({ ok, now, want, fold, name, people, plateOf, menu }: { ok: OpenKitchen; now: number; want: ReadonlySet<string> | null; fold: ReadonlySet<string>; name: Namer;
  people: ReadonlyMap<string, Person>; plateOf: (id: string) => string | null; menu: string }): string {
  const title = want ? [...want].sort((a, b) => a.localeCompare(b)).join(', ') : 'All projects';
  // The header is the project picker, with no count line under it (Dan, 2026-11-11): people want what is slow, stuck
  // and worth their focus, which the board below shows. The heading stays for a screen reader.
  const top = `<header class="you-h"><h2 id="tb-t" class="vh">Open kitchen, ${e(title)}</h2>${menu}</header>`;
  const B = kitchenBoard(ok, { now, want });
  if (!B) {
    const why = ok.why === 'offline' ? 'Yes Chef’s team connection is down.' : 'No one on your team has reported yet.';
    return `<section class="tboard" aria-labelledby="tb-t">${top}<div class="you-b"><p class="nc-l"><b>Not checked</b> ${e(why)}</p></div></section>`;
  }
  const ins = (label: string, v: string, extra = '') => `<div class="ins" role="listitem"><p class="l">${e(label)}</p><p class="v">${v}</p>${extra}</div>`;
  const ago = (t: number) => span(Math.max(0, Math.round((now - t) / 60000)));
  const short = (repo: unknown) => String(repo).split('/').pop()!;
  // 1. The base: red since the first red commit, or green; one mark per merge today, so it agrees with Merged today.
  const b = B.base;
  const label1 = b.branches.length === 1 ? b.branches[0]! : 'Base branches';
  // Bases are one per repo and branch: name the branch only when there is more than one, and count repos apart.
  const baseName = (r: { repo: unknown; branch: unknown }) => (b.branches.length > 1 ? `${short(r.repo)} ${r.branch}` : short(r.repo));
  const nRepos = new Set(b.repos.map((r) => r.toLowerCase())).size;
  const v1 = b.state === 'red' ? `<b class="red">Red</b><span>${b.since !== null ? `since ${hm(b.since)}` : 'since not checked'}${b.count > 1 ? `, ${e(and([...new Set(b.red.map(baseName))]))}` : ''}</span>`
    : b.state === 'green' ? `<b class="green">Green</b><span>${e(nRepos > 1 ? `${nRepos} repos` : b.count > 1 ? `${short(b.repos[0])}, ${plural(b.count, 'branch', 'branches')}` : short(b.repos[0]))}</span>`
    : NOT(b.count ? 'a required check has no result yet' : 'no Mac online has read it');
  const rib = b.merges.length ? `<div class="kribbon" role="img" aria-label="${e(`${plural(b.merges.length, 'merge')} today`)}">${b.merges.map((m) => `<i${m.tone === 'red' ? ' class="r"' : ''} title="${e(`#${m.n}, ${name(m.person)}, ${hm(m.at)}${m.tone === 'red' ? `, while ${label1} is red` : ''}`)}"></i>`).join('')}</div>`
    + `<span class="cap"><span>${plural(b.merges.length, 'merge')}</span>${b.merges.some((m) => m.tone === 'red') ? `<span class="red">red: since ${b.since !== null ? hm(b.since) : 'the break'}</span>` : ''}</span>` : '';
  // 2. Merged today: the count and bars by hour. "Usual by now" needs weeks of merge times, which no summary sends.
  const m = B.merged;
  // Merges with no time may be today's: the count is then a floor, and says so.
  // What a count cannot see goes in a caption under it ("Not counted: …"); a count that may be low says "at least".
  const gapWords = (g: { away?: number; capped?: number }, untimed = 0) => [untimed ? `${plural(untimed, 'merge')} with no time` : '', g.away ? `${plural(g.away, 'Mac')} not reporting` : '',
    g.capped ? `${plural(g.capped, 'Mac')} that sent part of ${g.capped === 1 ? 'its' : 'their'} threads` : ''].filter(Boolean).join(', ');
  const gapCap = (words: string) => words ? `<span class="cap"><span>Not counted: ${e(words)}</span></span>` : '';
  const mGap = gapWords(m.gap, m.untimed);
  const v2 = `<b>${m.count}</b><span>${mGap ? 'at least' : 'usual by now: not checked'}</span>`;
  const hh = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const mbars = bars(m.byHour, `Merges by hour from ${hh(m.from)}: ${m.byHour.join(', ')}`).replace('class="vbars"', 'class="vbars mg"')
    + `<span class="cap"><span>${hh(m.from)}</span><span>now</span></span>` + gapCap(mGap);
  // 3. Waiting for review: PRs ready for review and how long each has waited, oldest first.
  const r = B.review;
  // A Mac that is not reporting may hold more, so a caption says so; with none counted the count is not checked, never 0.
  const rGap = gapWords(r.gap);
  const v3 = r.count ? `<b>${r.count}</b><span>${r.count === 1 ? 'PR' : 'PRs'}, oldest ${r.ages ? span(Math.round(r.ages[0]! / 60000)) : 'not checked'}</span>`
    : rGap ? NOT(e(rGap)) : '<b>0</b><span>no PR waits</span>';
  const rbars = (r.ages ? bars(r.ages.slice(0, 12).map((a) => Math.round(a / 60000)), `How long each waits: ${r.ages.slice(0, 12).map((a) => span(Math.round(a / 60000))).join(', ')}`) : '') + (r.count ? gapCap(rGap) : '');
  // 4. Agents running now. The day's line needs readings over the day, which no summary sends.
  const v4 = `<b>${B.agents.count}</b><span>on ${plural(B.agents.threads, 'thread')}</span>`;
  const inst = `<div class="inst" role="list">${ins(label1, v1, rib)}${ins('Merged today', v2, mbars)}${ins('Waiting for review', v3, rbars)}${ins('Agents running', v4, gapCap(gapWords(B.agents.gap)))}</div>`;

  const who = okRows({ R: B.rows, now, want, fold, name, people, plateOf });
  // Files two live threads change.
  const F = B.files;
  const FS: Record<'same' | 'different' | 'nc' | 'gen', [string, string]> = { same: ['Same lines. In The Pass', 'red'], different: ['Different lines. Fine', ''], nc: ['Lines not checked', 'gray'], gen: ['Lockfile or generated. Not compared', 'gray'] };
  const frow = (f: (typeof F.rows)[number]) => {
    const [word, tone] = f.state === 'same' && !(f.call && f.call.mine) ? ['Same lines', 'red'] : f.state === 'nc' && f.near ? ['Lines not checked: two merge bases', 'gray'] : FS[f.state];
    const open = f.call && f.call.mine ? plateOf(f.call.id) : null;
    const inner = `<span class="f" title="${e(`${f.repo}: ${f.path}`)}">${e(f.path)}</span><span class="fc">${f.people.map((id) => face(people.get(id), 'sm')).join('')}</span><span class="s${tone ? ` ${tone}` : ''}">${e(word)}</span>`;
    return open ? `<button type="button" class="sf" role="listitem" data-team-open="${e(open)}">${inner}</button>` : `<div class="sf" role="listitem">${inner}</div>`;
  };
  // Threads whose changes were not read could share any file, so the list never reads as all clear while some are out.
  const out = [F.unread ? `${plural(F.unread, 'live thread')} not checked: ${F.unread === 1 ? 'its' : 'their'} changed files were not sent.` : '',
    F.partial ? `${plural(F.partial, 'thread')} sent only part of ${F.partial === 1 ? 'its' : 'their'} files.` : '',
    F.capped ? `${plural(F.capped, 'Mac')} sent only part of ${F.capped === 1 ? 'its' : 'their'} threads.` : ''].filter(Boolean).join(' ');
  const fbody = !F.compared ? `<p class="nc-l"><b>Not checked</b> No live thread has sent its changed files.</p>`
    : F.rows.length ? `<div class="sfl" role="list">${F.rows.slice(0, 8).map(frow).join('')}</div>${F.rows.length > 8 ? `<p class="tmore">And ${plural(F.rows.length - 8, 'more file')}.</p>` : ''}${out ? `<p class="tmore">${e(out)}</p>` : ''}`
    : out ? `<p class="nc-l">No file is changed by two of the ${plural(F.compared, 'thread')} read. ${e(out)}</p>` : `<p class="nc-l">No file is changed by two live threads.</p>`;
  const files = `<section class="pnl" aria-labelledby="tb-f"><header class="ph"><h3 id="tb-f">Files two live threads change</h3><span>${F.at !== null ? `checked ${hm(F.at)}` : 'check time not checked'}</span></header>${fbody}</section>`;
  return `<section class="tboard" aria-labelledby="tb-t">${top}<div class="you-b">${inst}${who}${files}</div></section>`;
}

type Rows = NonNullable<ReturnType<typeof kitchenBoard>>['rows'];
/** Open kitchen's rows (Dan, 2A on the flow mock, locked 2026-11-11): one fixed row per person with their agents as
 *  squares, the code areas those agents touch as cells that darken with more agents, and merged today. Two people in
 *  the same file draw a link between their cells, in that file's column: the one line on the chart, and it marks that
 *  event where it happens. Sub-leads group their people; a click on the group folds it (?fold=<id>). Hover links the
 *  chart and The Pass both ways (data-k, data-f, as client/flow.ts). Red and amber are calls and nothing else. */
function okRows({ R, now, want, fold, name, people, plateOf }: { R: Rows; now: number; want: ReadonlySet<string> | null; fold: ReadonlySet<string>; name: Namer;
  people: ReadonlyMap<string, Person>; plateOf: (id: string) => string | null }): string {
  const W = 860, ROW = 48, TOPK = 62, XA = 112, SQ = 16, GAP = 4, SLOTS = 8, XM = XA + SLOTS * (SQ + GAP) + 14, MW = 112;
  // Columns: as many as fit at 24 px; past that the least busy fold into one "Other areas" column at the end.
  const busy = (c: { project: string; area: string }) => R.people.reduce((n, r) => n + r.agents.filter((a) => !a.out && a.working && a.project === c.project && a.areas?.includes(c.area)).length, 0);
  const room = W - XM - MW - 10, MAXC = Math.max(1, Math.floor(room / 24));
  let cols: { project: string | null; area: string; of: { project: string; area: string }[] }[] = R.columns.map((c) => ({ ...c, of: [c] }));
  if (cols.length > MAXC) {
    const keep = new Set([...R.columns].sort((a, z) => busy(z) - busy(a)).slice(0, MAXC - 1));
    cols = [...R.columns.filter((c) => keep.has(c)).map((c) => ({ ...c, of: [c] })), { project: null, area: 'Other areas', of: R.columns.filter((c) => !keep.has(c)) }];
  }
  const CW = cols.length ? Math.min(88, Math.floor(room / cols.length)) : 0;
  const XT = XM + cols.length * CW + (cols.length ? 12 : 0);
  const colOf = (project: string | null, area: string) => cols.findIndex((c) => c.of.some((o) => o.project === project && o.area === area));
  const inCol = (a: Rows['people'][number]['agents'][number], c: number) => !a.out && !!a.areas && cols[c]!.of.some((o) => o.project === a.project && a.areas!.includes(o.area));
  // Red only in the column of the file an Overlap shares, never in the other areas of the same agents.
  const shared = (ids: readonly string[], c: number) => R.links.some((l) => (ids.includes(l.a) || ids.includes(l.b)) && colOf(l.project, l.area) === c);
  // A cell lights for an Overlap's call only in that Overlap's column.
  const linkKeys = (ids: readonly string[], c: number) => R.links.filter((l) => (ids.includes(l.a) || ids.includes(l.b)) && colOf(l.project, l.area) === c).flatMap(callKey);
  const tone = (a: Rows['people'][number]['agents'][number]) => (a.call ? KINDS[a.call.kind].tone : a.working ? 'working' : 'idle');
  const callKey = (c: { id: string; mine: boolean } | null) => { const id = c && c.mine ? plateOf(c.id) : null; return id ? [`p:${id}`] : []; };
  const att = (k: string[], f: string, tip: string) => ` data-k="${e(k.join(' '))}" data-f="${e(f)}" data-tip="${e(tip)}"`;
  const podOf = new Map(R.pods.flatMap((p) => p.members.map((m) => [m, p.lead] as const)));
  type Line = { kind: 'pod'; lead: string; members: string[]; folded: boolean } | { kind: 'dev'; r: Rows['people'][number]; pod: string | null };
  const lines: Line[] = [];
  for (const r of R.people) {
    const pod = podOf.get(r.person) ?? null;
    if (pod && !lines.some((l) => l.kind === 'pod' && l.lead === pod)) lines.push({ kind: 'pod', lead: pod, members: R.pods.find((p) => p.lead === pod)!.members, folded: fold.has(pod) });
    if (!pod || !fold.has(pod)) lines.push({ kind: 'dev', r, pod });
  }
  const H = TOPK + lines.length * ROW + 6;
  const maxM = Math.max(1, ...R.people.map((r) => r.merged));
  // A Mac quiet since an earlier day says the day, never an hour that reads as today's.
  const when = (t: number) => (new Date(t).toDateString() === new Date(now).toDateString() ? hm(t) : new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }));
  const nA = (a: Rows['people'][number]['agents'][number]) => `${a.title || 'Untitled thread'}`;
  let head = '', rows = '', links = '';
  // The names over the columns: each project once, over its areas, then each area.
  for (const pj of [...new Set(cols.map((c) => c.project))]) {
    const cs = cols.flatMap((c, i) => (c.project === pj ? [i] : []));
    const x0 = XM + cs[0]! * CW, x1 = XM + (cs[cs.length - 1]! + 1) * CW - 6;
    if (pj) head += `<text class="pjname" x="${x0}" y="${TOPK - 40}">${e(pj)}</text><line class="pjrule" x1="${x0}" x2="${x1}" y1="${TOPK - 33}" y2="${TOPK - 33}"/>`;
  }
  cols.forEach((c, i) => {
    const n = R.people.reduce((s, r) => s + r.agents.filter((a) => inCol(a, i)).length, 0);
    const label = c.area.length * 6.2 > CW - 8 ? `${c.area.slice(0, Math.max(1, Math.floor((CW - 8) / 6.2) - 1))}…` : c.area;
    head += `<text class="zlbl col" tabindex="0"${att([`ar:${i}`], `ar:${i}`, `<b>${e(c.project ? `${c.project}: ${c.area}` : c.area)}</b><div>${plural(n, 'agent')}</div>${c.project ? '' : `<div class="m">${e(c.of.map((o) => `${o.project}: ${o.area}`).join(', '))}</div>`}`)} x="${XM + i * CW + (CW - 6) / 2}" y="${TOPK - 14}" text-anchor="middle">${e(label)}</text>`;
  });
  head += `<text class="zlbl" x="${XA}" y="${TOPK - 14}">Agents</text><text class="zlbl" x="${XT}" y="${TOPK - 14}">Merged today</text>`;
  const rowAt = new Map<string, number>();
  lines.forEach((l, i) => {
    const y = TOPK + i * ROW;
    if (l.kind === 'pod') {
      for (const m of l.members) if (l.folded) rowAt.set(m, i);
      const rs = R.people.filter((r) => l.members.includes(r.person)), ag = rs.flatMap((r) => r.agents);
      // One Overlap is one call, though two of the team's agents are in it.
      const calls = new Set(ag.flatMap((a) => (a.call && !a.out ? [a.call.id] : []))).size, m = rs.reduce((s, r) => s + r.merged, 0);
      const k = [`pod:${l.lead}`];
      rows += `<rect class="podband" x="0" y="${y - 4}" width="${W}" height="${ROW}"/>`;
      rows += `<text class="rowname strong" role="button" tabindex="0" data-fold="${e(l.lead)}" aria-expanded="${!l.folded}"${att(k, k[0]!, `<b>${e(name(l.lead))}’s team</b><div>${e(l.members.map(name).join(', '))}</div><div class="m">${ag.filter((a) => a.working).length} of ${plural(ag.length, 'agent')} working · ${m} merged today</div>`)} x="0" y="${y + 16}" dominant-baseline="central">${l.folded ? '▸' : '▾'} ${e(name(l.lead))}’s team</text>`;
      rows += `<text class="mnum" x="${XA}" y="${y + 16}" dominant-baseline="central">${plural(ag.length, 'agent')}${calls ? ` · ${plural(calls, 'call')}` : ''}</text>`;
      cols.forEach((_, c) => {
        const here = ag.filter((a) => a.working && inCol(a, c));
        if (!here.length) return;
        const hot = shared(l.members, c);
        const lvl = hot ? 'red' : here.length >= 5 ? 'n3' : here.length >= 3 ? 'n2' : 'n1';
        const ks = [`pc:${l.lead}:${c}`, ...k, `ar:${c}`, ...here.map((a) => `a:${a.thread}`), ...linkKeys(l.members, c)];
        rows += `<rect class="cell ${lvl}"${att(ks, `pc:${l.lead}:${c}`, `<b>${e(name(l.lead))}’s team · ${e(cols[c]!.area)}</b><div>${plural(here.length, 'agent')}</div>${hot ? '<div class="m red">Overlap</div>' : ''}`)} x="${XM + c * CW}" y="${y + 4}" width="${CW - 6}" height="${ROW - 24}" rx="4"/>`;
      });
      rows += `<text class="mnum strong" x="${XT}" y="${y + 16}" dominant-baseline="central">${m}</text>`;
      return;
    }
    const r = l.r, p = people.get(r.person), d = [`d:${r.person}`, ...(l.pod ? [`pod:${l.pod}`] : [])];
    rowAt.set(r.person, i);
    const ix = l.pod ? 14 : 0;
    const lead = l.pod === r.person ? ' · leads this team' : l.pod ? ` · reports to ${name(l.pod)}` : '';
    const dt = `<b>${e(name(r.person))}</b><div>${r.agents.filter((a) => a.working).length} of ${plural(r.agents.length, 'agent')} working</div><div class="m">${r.merged} merged today${e(lead)}</div>`;
    rows += `<text class="rowname${p ? '' : ' muted'}" tabindex="0"${att(d, d[0]!, dt)} x="${ix}" y="${y + 16}" dominant-baseline="central">${e(name(r.person))}</text>`;
    if (r.quiet) {
      // A Mac that is not reporting: its agents are not known now, so none are drawn.
      rows += `<text class="mnum" x="${XA}" y="${y + 16}" dominant-baseline="central">Not reporting${r.quiet.since !== null ? ` since ${when(r.quiet.since)}` : ''}</text>`;
    } else {
      const shown = r.agents.length > SLOTS ? r.agents.slice(0, SLOTS - 1) : r.agents;
      shown.forEach((a, j) => {
        const x = XA + j * (SQ + GAP);
        const ks = [`a:${a.thread}`, ...d, ...(a.areas ?? []).map((ar) => colOf(a.project, ar)).filter((c) => c >= 0).flatMap((c) => [`ar:${c}`, `c:${r.person}:${c}`]), ...callKey(a.call)];
        const call = a.call ? `<div class="m ${KINDS[a.call.kind].tone}">${e(KINDS[a.call.kind].word)}${a.call.mine ? ', in The Pass' : `, ${e(name(r.person))} holds it`}</div>` : '';
        const tip = `<b>${e(nA(a))}</b><div>${e(a.project || 'Project not checked')} · ${e(a.place || '')}</div><div class="m">${a.working ? 'Working' : 'Idle'}${a.areas ? '' : ' · changed files not checked'}</div>${a.out ? '<div class="m">Outside the picked projects</div>' : ''}${call}`;
        const open = a.call && a.call.mine && !a.out ? plateOf(a.call.id) : null;
        rows += `<rect class="ag ${a.out ? 'out' : tone(a)}"${open ? ` data-team-open="${e(open)}"` : ''}${att(ks, `a:${a.thread}`, tip)} x="${x}" y="${y + 8}" width="${SQ}" height="${SQ}" rx="3.5"/>`;
      });
      if (r.agents.length > SLOTS) rows += `<text class="mnum" x="${XA + (SLOTS - 1) * (SQ + GAP) + SQ / 2}" y="${y + 16}" text-anchor="middle" dominant-baseline="central">+${r.agents.length - SLOTS + 1}</text>`;
      if (!r.agents.length) rows += `<text class="mnum" x="${XA}" y="${y + 16}" dominant-baseline="central">No agents</text>`;
    }
    cols.forEach((_, c) => {
      const here = r.agents.filter((a) => a.working && inCol(a, c));
      if (!here.length) return;
      const hot = shared([r.person], c);
      const ks = [`c:${r.person}:${c}`, ...d, `ar:${c}`, ...here.map((a) => `a:${a.thread}`), ...(l.pod ? [`pc:${l.pod}:${c}`] : []), ...linkKeys([r.person], c)];
      const files = here.flatMap((a) => (a.files ?? []).filter((f) => cols[c]!.of.some((o) => o.project === a.project && areaOf(f) === o.area)).slice(0, 3).map((f) => `<div class="m mono">${e(f)}</div>`));
      rows += `<rect class="cell ${hot ? 'red' : `n${Math.min(3, here.length)}`}"${att(ks, `c:${r.person}:${c}`, `<b>${e(name(r.person))} · ${e(cols[c]!.area)}</b><div>${plural(here.length, 'agent')}</div>${files.join('')}${hot ? '<div class="m red">Overlap</div>' : ''}`)} x="${XM + c * CW}" y="${y}" width="${CW - 6}" height="${ROW - 16}" rx="4"/>`;
    });
    const bw = (r.merged / maxM) * (W - XT - 30);
    if (r.merged) rows += `<rect class="mbar"${att(d, d[0]!, dt)} x="${XT}" y="${y + 10}" width="${bw.toFixed(1)}" height="12" rx="3"/>`;
    rows += `<text class="mnum" x="${(XT + bw + (r.merged ? 6 : 0)).toFixed(1)}" y="${y + 16}" dominant-baseline="central">${r.merged}</text>`;
  });
  // Overlap: the one line on the chart. It joins the two people's cells in the column of the file both change.
  for (const l of R.links) {
    const c = colOf(l.project, l.area), ra = rowAt.get(l.a), rb = rowAt.get(l.b);
    if (c < 0 || ra === undefined || rb === undefined || ra === rb) continue;
    const [i, j] = [ra, rb].sort((x, z) => x - z) as [number, number];
    const bot = (r: number) => TOPK + r * ROW + (lines[r]!.kind === 'pod' ? ROW - 20 : ROW - 16);
    const x = XM + c * CW + (CW - 6) / 2, y1 = bot(i), y2 = TOPK + j * ROW + (lines[j]!.kind === 'pod' ? 4 : 0);
    const ks = [...l.threads.map((t) => `a:${t}`), ...callKey(l)];
    const tip = `<b class="red">Overlap</b><div class="mono">${e(l.path)}</div><div>${e(name(l.a))} and ${e(name(l.b))} both change it</div>`;
    links += `<line class="olink halo" x1="${x}" x2="${x}" y1="${y1}" y2="${y2}"/><line class="olink"${att(ks, ks.join(' '), tip)} x1="${x}" x2="${x}" y1="${y1}" y2="${y2}"/>`;
  }
  const all = R.people.flatMap((r) => (r.quiet ? [] : r.agents)), on = all.filter((a) => !a.out);
  const n = (f: (a: (typeof all)[number]) => boolean) => on.filter(f).length;
  const chip = (cls: string, word: string, count: number | null) => `<span><i class="sq ${cls}"></i>${word}${count === null ? '' : ` ${count}`}</span>`;
  const key = `<span class="lg okk">${chip('working', 'Working', n((a) => !a.call && a.working))}${chip('idle', 'Idle', n((a) => !a.call && !a.working))}`
    + `${chip('red', 'Act now', n((a) => a.call !== null && KINDS[a.call.kind].tone === 'red'))}${chip('amber', 'Decide soon', n((a) => a.call !== null && KINDS[a.call.kind].tone === 'amber'))}`
    + `${want ? chip('out', 'Other projects', all.length - on.length) : ''}<span><i class="sq n1"></i><i class="sq n2"></i><i class="sq n3"></i>1, 2, 3+ agents</span>`
    + `<span>Agents by lab: not checked</span></span>`;
  const svg = `<svg class="fx okr" viewBox="0 0 ${W} ${H}" role="img" aria-label="${e(`One row per person: ${R.people.length} people`)}"><defs><pattern id="okdots" width="14" height="14" patternUnits="userSpaceOnUse"><circle cx="7" cy="7" r="1" class="dot"/></pattern></defs>`
    + (cols.length ? `<rect x="${XM - 6}" y="${TOPK - 6}" width="${cols.length * CW + 6}" height="${lines.length * ROW}" fill="url(#okdots)"/>` : '')
    + `${head}${rows}${links}</svg>`;
  return `<section class="pnl ok-p" aria-labelledby="tb-who"><header class="ph"><h3 id="tb-who">Who’s on what</h3>${key}</header>`
    + `<div class="fx-wrap ok-wrap"><div class="fx-view">${svg}</div><div class="fx-tip" hidden></div></div></section>`;
}

/** Everything Your team draws when the page has a team reading. ctx: { icons } from the board, for project marks. */
function teamParts(team: TeamInput, view: TeamView, icons: ReadonlyMap<string, string | null>, want: ReadonlySet<string> | null = null, menu = '', fold: ReadonlySet<string> = new Set()) {
  const now = typeof team.now === 'number' && Number.isFinite(team.now) ? team.now : Date.now();
  const ok = openKitchen(view, { now });
  const me = view.me;
  const people = new Map<string, Person>(ok.people.map((p) => [p.id, p]));
  const name = (id: string) => people.get(id)?.name || 'Someone';
  const pm = (p: string | null) => mark(p || 'Project', (p && icons.get(p)) || null);
  // A picked project narrows the team's calls too; a call with no known project shows under All projects only.
  const calls = ok.pass.filter((c) => !want || (c.project !== null && want.has(c.project))).map((c) => ({ c, id: teamPlateId(c), w: callWords(c, { name, now, people }) }));
  // A red base with no named cause has nobody to name: the tile names its repo instead.
  type Item = { c: TeamCall; id: string; w: Words };
  const who = (c: TeamCall) => (!c.who.length ? ((c.kind === 'main' && c.facts.repo) || 'Not checked') : c.kind === 'overlap' && c.who.length > 1 ? and(c.who.map(name)) : name(c.who[0]!));
  const age = (c: TeamCall) => (c.since != null ? span(Math.max(0, Math.round((now - c.since) / 60000))) : '');
  const tile = ({ c, id, w }: Item) => `<button type="button" class="tile call-tile mail team-tile" data-plate="${e(id)}" data-thread="${e(id)}">`
    + `<span class="ct-top"><span class="proj">${pm(c.project)}<span class="pn">${e(c.project || 'Project')}</span></span><span class="mdl">${e(who(c))}</span>${age(c) ? `<span class="age">${age(c)}</span>` : ''}</span>`
    + `<span class="q">${e(w.title)}</span><span class="ct-pv">${e(w.preview)}</span>`
    + `<span class="lbs">${chip(KINDS[c.kind].word, KINDS[c.kind].tone)}<span class="lb tsg">Suggested: <b>${e(w.suggest)}</b></span></span></button>`;
  const plateOf = ({ c, id, w }: Item) => `<article class="plate team-plate" id="${e(id)}" data-thread="${e(id)}" data-at aria-labelledby="${e(id)}-t">`
    + `<div class="plate-bar"><span class="proj">${pm(c.project)}${e(c.project || 'Project')}</span><span class="stg"><i class="gd c-${KINDS[c.kind].tone}"></i>${e(KINDS[c.kind].word)}</span><span class="mdl">${e(who(c))}</span>`
    + `<button type="button" class="close" data-close aria-label="Close"><kbd>esc</kbd>${svg('x')}</button></div>`
    + `<div class="plate-main"><div class="plate-scroll" tabindex="-1"><header class="plate-head"><h2 class="plate-t" id="${e(id)}-t">${e(w.title)}</h2>`
    + `<p class="lead"><span class="lead-q">${e(w.lead)}</span></p>${c.prs.length ? `<div class="pr-row">${c.prs.map(teamPrChip).join('')}</div>` : ''}</header>`
    + `<section class="msg tv">${quietBox(c, name, now)}${seenLine(c, name)}${w.body}<div class="tsug"><b>Suggested</b><span>${e(w.why)}</span></div></section></div>`
    + teamDock(c, w, me, id) + '</div></article>';

  // The groups, each dev once (open-kitchen.ts sets the order of precedence): Not reporting, In The Pass, Fixing an
  // alarm, On track; and Not checked for a dev whose Mac has not reported at all.
  const GROUPS: [PersonState, string, string][] = [['pass', 'In The Pass', 'blue'], ['alarm', 'Fixing an alarm', 'amber'], ['quiet', 'Not reporting', 'gray'], ['track', 'On track', 'green'], ['unknown', NC_V, 'nc']];
  const by = Object.fromEntries(GROUPS.map(([k]) => [k, ok.people.filter((p) => p.state === k)])) as Record<PersonState, Person[]>;
  const live = ok.status === 'live';
  const why = ok.why === 'offline' ? `Yes Chef’s team connection is down${ok.linkAt ? ` since ${hm(ok.linkAt)}` : ''}.` : 'No one on your team has reported yet.';
  const segs = live ? GROUPS.flatMap(([k, , tone]) => by[k].map(() => `<i class="c-${tone}"></i>`)).join('') : '';
  const rows = live ? GROUPS.filter(([k]) => k !== 'unknown' || by[k].length).map(([k, word, tone]) => `<p class="nf tst"><i class="gd c-${tone}"></i><span>${word}</span><span class="n">${by[k].length}</span></p>`).join('')
    : `<p class="nf tst"><i class="gd c-nc"></i><span>${NC_V}</span><span class="n">–</span></p>`;
  const card = `<div class="nav-card team-card" role="group" aria-label="Your team"><div class="idrow">${svg('skillet', 'ic who')}<span class="vh">Open kitchen</span><span class="segbar" aria-hidden="true">${segs}</span></div>${rows}</div>`;

  // The quiet line: who else there is, so an empty Pass never reads as "nobody is working".
  const held = new Map<string, TeamCall>(); for (const c of ok.held) for (const id of c.who) if (!held.has(id)) held.set(id, c);
  const bits: string[] = [];
  const q = by.quiet;
  if (q.length === 1) { const p = q[0]!, t = p.lastSeen ?? p.at; bits.push(`${name(p.id)} is not reporting${typeof t === 'number' && Number.isFinite(t) ? ` since ${hm(t)}` : ''}.`); }
  else if (q.length) bits.push(`${and(q.map((p) => name(p.id)))} are not reporting.`);
  const al = by.alarm;
  if (al.length === 1) { const a = al[0]!, c = held.get(a.id), pr0 = c?.prs[0]; bits.push(`${name(a.id)} is fixing an alarm${pr0 ? ` on #${pr0.n}` : ''}.`); }
  else if (al.length) bits.push(`${and(al.map((p) => name(p.id)))} are fixing alarms.`);
  if (by.track.length) bits.push(`${plural(by.track.length, 'person', 'people')} ${by.track.length === 1 ? 'is' : 'are'} on track.`);
  if (by.unknown.length) bits.push(`${plural(by.unknown.length, 'person', 'people')} not checked.`);
  const calm = `<p class="tcalm">${svg('done')}<span>${calls.length ? 'Nothing else needs you.' : 'Nothing from your team needs you.'}${bits.length ? ` ${e(bits.join(' '))}` : ''}</span></p>`;
  // The Pass as a column beside the board (expanded): each call with its suggestion and Open, one click each. A click
  // goes back to The Pass with the call open; the suggestion also puts focus on its action there, since nothing sends
  // from Your team until the team connection lands.
  const xcard = ({ c, id, w }: Item) => {
    const [kind] = w.acts[0] || [];
    const sug = kind && may(me, kind) ? `<button type="button" class="xb fill" data-team-open="${e(id)}" data-team-act="${e(kind)}">${e(w.suggest)}</button>` : '';
    return `<div class="xc" role="listitem" data-team-open="${e(id)}"><p class="xk"><span class="w t-${KINDS[c.kind].tone}">${e(KINDS[c.kind].word)}</span>${age(c) ? `<span class="age">${age(c)}</span>` : ''}</p>`
      + `<p class="xt">${e(w.title)}</p><p class="xw">${e(who(c))}</p><div class="xa">${sug}<button type="button" class="xb" data-team-open="${e(id)}">Open</button></div></div>`;
  };
  const col = calls.length ? `<div class="tcol" role="list" aria-label="Your team’s calls">${calls.map(xcard).join('')}</div>` : '';
  const pass = !live ? `<div class="clear team-pass">${svg('cloche')}<p><b>${NC_V}</b></p><p class="muted">${e(why)} Your team’s calls show once it is back.</p></div>`
    : `<div class="team-pass tp-live"><div class="folder" data-folder="team">${calls.map(tile).join('')}</div>${col}${calm}</div>`;
  const board = boardOf({ ok, now, want, fold, name, people, menu, plateOf: (id) => (calls.some((x) => x.c.id === id) ? teamPlateId({ id }) : null) });
  return {
    ok, card, pass, board, count: live ? calls.length : '–',
    plates: calls.map(plateOf).join(''),
    meta: { name: [view.teamName, team.name].find((x) => typeof x === 'string' && x) || null, below: ok.people.length, mode: 'open' },
  };
}

/** The projects a page shows, from its address: ?p=A&p=B picks A and B; no p is All projects (Dan, 2026-11-10).
 *  Empty and repeated names drop out. Null means All projects. */
export function pickedFrom(params: URLSearchParams): string[] | null {
  const names = [...new Set(params.getAll('p').filter((p) => p !== ''))];
  return names.length ? names : null;
}

// A check box (view menu mock a, Dan, 2026-11-10): a drawn tick when picked, a dash when some are (All projects only).
const CB = '<span class="cb" aria-hidden="true"><svg viewBox="0 0 18 18"><path class="tick" d="M4.75 9.4l2.85 2.85 5.65-6.5"/><path class="dash" d="M5.25 9h7.5"/></svg></span>';
// A mark in the chip's fan has no tooltip of its own: the fan's tooltip names every picked project.
const fanMark = (name: string, icon: string | null | undefined): string => mark(name, icon).replace(/ title="[^"]*"/, '');

/** The rail's footer chip and the menu it opens (Dan, 2026-11-10, view menu mock a). The chip: the person, or the
 *  toque for Team, then "All projects" or the picked projects' icons fanned like a hand of cards. Since 2026-11-11 (Dan)
 *  neither the chip nor the toggle says "You" or "Team": the icon does, and the word rides on its tooltip and, for a
 *  screen reader, a hidden label. It never names the team or its mode. head: the expanded view's copy, which is that
 *  view's header (Dan, 2026-11-11): the view's own icon (the person in You, the skillet in Open kitchen, the toque in
 *  French Brigade), then All projects or the fan, a size up. The menu, top to bottom: All projects as a tri-state check box, one check box per
 *  project, and, only for a user with reports, a sliding You | Team toggle on one line. The toque means Team in both
 *  modes. projs: [name, mark html, on the board] in menu order; picked: the names picked, or null for All projects.
 *  ok: the board was read, so the project list is current; without it the list says "not checked". */
/** A project in the menu: its name, its mark and whether it has a ticket on the board now. */
type MenuProject = [name: string, mark: string, here: boolean];
/** The icon an expanded view's header starts with, and what it says. */
type HeadIcon = 'person' | 'skillet' | 'toque';
const HEAD_WORD: Record<HeadIcon, string> = { person: 'You', skillet: 'Team, Open kitchen', toque: 'Team, French Brigade' };
function viewMenu({ team, projs, picked, icons, ok, head = null }: { team: TeamInput | null; projs: readonly MenuProject[]; picked: readonly string[] | null;
  icons: ReadonlyMap<string, string | null>; ok: boolean; head?: HeadIcon | null }): string {
  const sel = new Set(picked || projs.map(([nm]) => nm));
  // Picking exactly the board's projects is All projects. A pick with no ticket now stays a pick, and so does any pick
  // without a board: then the list is unknown.
  const every = !picked || (ok && projs.every(([nm, , here]) => (here ? sel.has(nm) : !sel.has(nm))));
  const on = projs.filter(([nm]) => sel.has(nm)).map(([nm]) => nm);
  const names = e(on.join(', '));
  const which = every ? '<span class="vp">All projects</span>'
    : `<span class="fan" style="--n:${on.length}" title="${names}">${on.map((nm, i) => `<span class="card" style="--i:${i}">${fanMark(nm, icons.get(nm))}</span>`).join('')}<span class="vh">${names}</span></span>`;
  const icon = (n: IconName, word: string, cls = '') => `<span class="vi${cls}" title="${e(word)}">${svg(n, 'ic who')}<span class="vh">${e(word)}</span></span>`;
  const who = head ? icon(head, HEAD_WORD[head]) : team ? icon('person', 'You', ' vi-you') + icon('toque', 'Team', ' vi-team') : icon('person', 'You');
  // data-gone: a pick with no ticket now. The page script counts All projects as every box but these.
  const box = ([nm, m, here]: MenuProject) => `<button type="button" class="pk" role="checkbox" data-p="${e(nm)}"${here ? '' : ' data-gone'} aria-checked="${sel.has(nm)}">${CB}${m}<span class="vn">${e(nm)}</span></button>`;
  const seg = team ? `<hr><div class="seg" role="radiogroup" aria-label="View">`
    + `<button type="button" role="radio" aria-checked="false" data-scope="you" aria-label="You" title="You">${svg('person')}</button>`
    + `<button type="button" role="radio" aria-checked="false" data-scope="team" aria-label="Team" title="Team">${svg('toque')}</button></div>` : '';
  return `<details class="pmenu vmenu${head ? ' vhead' : ''}"><summary>${who}${which}${svg('chev')}</summary>`
    + `<nav class="pmenu-l" aria-label="${team ? 'Projects and view' : 'Projects'}"${ok ? '' : ' data-nc'}>`
    + `<button type="button" class="pk all" role="checkbox" aria-checked="${every ? 'true' : 'mixed'}">${CB}<span class="vn">All projects</span></button><hr>`
    + projs.map(box).join('')
    + (ok ? '' : '<p class="pk-nc"><b>Projects not checked.</b> T3 did not answer.</p>')
    + `${seg}</nav></details>`;
}

/** The page body (#app). picked: the projects' titles to show (pickedFrom), or null for All projects.
 *  Two views (Dan, 2026-11-07), switched by the logo: the pass, focused (stages as a list on the left, the tickets
 *  that wait on you, the open ticket beside them, like a mail client) and You, expanded (instruments over every
 *  stage as a column, 2026-11-10). The page script picks the view; the markup carries both.
 *  team: the user's team when they have reports (see viewMenu), else null. With team.view (client/team.ts Team.view())
 *  and team.now, Your team draws its calls (Open kitchen); without a view it says "Not checked". */
export interface RenderInput {
  board: Board; picked?: readonly string[] | null; link: (t: ThreadRow) => string; status: Status; origin: string;
  answered?: ReadonlyMap<string, Answered>; projects?: readonly Pick<Project, 'id' | 'title'>[]; rules?: unknown; team?: TeamInput | null;
  /** The size the page has for You's chart (client/flow.ts fitFrom), or null to draw it at its own size. */
  fit?: Fit | null;
  /** The sub-leads whose groups Open kitchen's rows draw folded (?fold=<id>). */
  fold?: readonly string[] | null;
}
export function renderApp({ board, picked = null, link, status, origin, answered = new Map(), projects = [], rules = null, team = null, fit = null, fold = null }: RenderInput): string {
  const want = picked && picked.length ? new Set(picked) : null;
  // Missing data renders "not checked": without a good poll, show no tickets at all, never an older board.
  const shown = status.ok ? board.tickets.filter((k) => !want || want.has(k.project)) : [];
  const spots: Record<string, Ticket[]> = {};
  for (const k of shown) (spots[k.place] ||= []).push(k);
  // A stable order in every column: newest ticket first by when it was opened, not by its last update (Opus).
  for (const list of Object.values(spots)) list.sort((a, b) => String(b.thread.createdAt || b.updatedAt).localeCompare(String(a.thread.createdAt || a.updatedAt)));
  // Questions first, then hand-backs; each oldest first, by the oldest waiting question, else the ticket.
  const since = (k: Ticket) => k.asks.map((a) => a.thread.updatedAt).sort()[0] || k.updatedAt;
  const asking = (k: Ticket) => Number(!!(k.asks.length || k.call));
  const waiting = shown.filter((k) => k.atPass).sort((a, b) => (asking(b) - asking(a)) || (since(a) < since(b) ? -1 : 1));
  // The menu lists every project with a ticket on the board, and any picked one that has none now, so it can still be
  // unticked. A Map: project titles come from T3 and may be any string, including "__proto__".
  const icons = new Map<string, string | null>();
  const onBoard = (status.ok ? board.tickets : []).filter((k) => k.place !== 'Coordinators');
  for (const k of onBoard) if (!icons.has(k.project) || k.icon) icons.set(k.project, k.icon || null);
  const here = new Set(icons.keys());
  for (const nm of want || []) if (!icons.has(nm)) icons.set(nm, null);
  const projs = [...icons.keys()].sort((a, b) => a.localeCompare(b)).map((nm): MenuProject => [nm, mark(nm, icons.get(nm)), here.has(nm)]);
  // The rail's footer chip and its menu. The toggle needs reports.
  const footMenu = viewMenu({ team, projs, picked: want ? [...want] : null, icons, ok: status.ok });
  // Your team, from a team reading (team.view, client/team.ts's shape). Without one it says "Not checked".
  // Expanded Team's header picker, on the board and on the waiting panel alike, since the rail's chip hides there.
  const teamHead = team ? viewMenu({ team, projs, picked: want ? [...want] : null, icons, ok: status.ok, head: 'skillet' }) : '';
  const T = team?.view ? teamParts(team, team.view, icons, want, teamHead, new Set(fold ?? [])) : null;
  const active = STAGES.reduce((x, s) => x + (spots[s] || []).length, 0), held = HELD.reduce((x, s) => x + (spots[s] || []).length, 0);
  // Unknown is not zero: without a good poll the counts read "not checked".
  const n = (v: number | string) => (status.ok ? v : 'not checked');
  const stats = ([['Active', active], ['Verified today', (spots.Verified || []).length], ['On hold', held]] as const).map(([k, v]) => `<li class="stat">${k} <b>${n(v)}</b></li>`).join('');
  const verified = spots.Verified || [];
  // You, expanded: the line's threads as a Sankey (client/flow.ts), keyed by the plate id their Pass card carries.
  const onLine = STAGES.flatMap((s) => spots[s] || []);
  const chart = !status.ok ? `<div class="fx-empty"><p><b>Not checked</b></p><p class="muted">T3 did not answer, so the chart cannot say where your threads are.</p></div>`
    : !onLine.length ? `<div class="fx-empty"><p><b>Nothing on the line</b></p><p class="muted">Threads show here from Backlog to Merged.</p></div>`
    : youFlow(onLine.map((k): FlowItem => ({ id: plateId(k), title: k.thread.title || 'Untitled thread', project: k.project, stage: k.place as FlowStage,
      since: Date.parse(k.updatedAt), subs: k.stations, waits: k.atPass, icon: k.icon, hue: hue(k.project), pr: (k.open[0] || k.merged[0])?.number ?? null,
      base: k.merged.length && !k.open.length ? (k.merged.every((p) => p.base && p.base === k.merged[0]!.base) ? k.merged[0]!.base : null) : null })), status.at, fit);
  const back = !!want && status.ok && new Set(onLine.map((k) => k.project)).size === 1;
  // The focused view's left list: the pass first, then each stage, then Verified and On hold.
  // Dan, 2026-11-07: Merged sits nearest the pass, then back down the line to Backlog, in one card; what is off the
  // line in its own card below.
  type Folder = [key: string, label: string, count: number];
  const line = [...STAGES].reverse().map((s): Folder => [s, s, (spots[s] || []).length]);
  const heldAll = HELD.flatMap((h) => spots[h] || []);
  const off: Folder[] = [['Verified', 'Verified', verified.length], ['On hold', 'On hold', heldAll.length]];
  const folders: Folder[] = [['pass', 'The Pass', waiting.length], ...line, ...off];
  const nfBtn = ([key, label, c]: Folder) => `<button type="button" class="nf${status.ok && !c && key !== 'pass' ? ' zero' : ''}" data-folder="${e(key)}">${key === 'pass' ? '' : DOT[key] ? `<i class="gd c-${DOT[key]}"></i>` : key === 'Verified' ? svg('done', 'ic vd') : '<i class="gd c-gray"></i>'}<span>${e(label)}</span><span class="n">${status.ok ? c : '–'}</span></button>`;
  // You (Dan, 2026-11-10): the person, then a bar with one piece per thread in its stage's colour. The bar reads left to
  // right along the line, Backlog to Merged (Dan, 2026-11-10), though the rows below list Merged first.
  // A long line shows one piece per stage, sized by its count, so each stays wide enough to see.
  const lineTickets = STAGES.flatMap((s) => spots[s] || []);
  const segs = lineTickets.length <= 24 ? lineTickets.map((k) => `<i class="c-${DOT[k.place]}"></i>`).join('')
    : STAGES.filter((s) => spots[s]?.length).map((s) => `<i class="c-${DOT[s]}" style="flex-grow:${spots[s]!.length}"></i>`).join('');
  const idrow = `<div class="idrow">${svg('person', 'ic who')}<span class="vh">You</span><span class="segbar" aria-hidden="true">${segs}</span></div>`;
  // The Pass item has no cloche: the app icon beside it is the only one (Dan, 2026-11-08).
  // In Your team the Pass item counts the team's calls instead of yours.
  const passBtn = T ? nfBtn(folders[0]!).replace(/<\/button>$/, `<span class="n tpn">${T.count}</span></button>`) : nfBtn(folders[0]!);
  const nav = `<nav class="stagenav" aria-label="Stages">${passBtn}<div class="nav-scroll">${T ? T.card : ''}<div class="nav-card" role="group" aria-label="Your threads">${idrow}${line.map(nfBtn).join('')}</div>`
    + `<div class="nav-card" role="group" aria-label="Off the line">${off.map(nfBtn).join('')}</div>`;
  const clear = status.ok ? `<div class="clear">${svg('cloche')}<p><b>All clear</b></p><p class="muted">Nothing needs you.</p></div>`
    : `<div class="clear">${svg('cloche')}<p><b>Not checked</b></p><p class="muted">T3 did not answer, so the Pass cannot say what waits on you.</p></div>`;
  // The Pass follows the view: in Your team it would hold your team's calls, which Yes Chef cannot read yet.
  const teamPass = T ? T.pass : team ? `<div class="clear team-pass">${svg('cloche')}<p><b>Not checked</b></p><p class="muted">Your team's calls need the team connection, which Yes Chef does not have yet.</p></div>` : '';
  const lists = teamPass + `<div class="folder" data-folder="pass">${waiting.length ? waiting.map((k) => passTile(k)).join('') : clear}</div>`
    + folders.slice(1).map(([key]) => `<div class="folder" data-folder="${e(key)}" hidden>${(key === 'Verified' ? verified : key === 'On hold' ? heldAll : spots[key] || []).map((k) => tile(k, key === 'Verified' || key === 'On hold')).join('')}</div>`).join('');
  const pass = `<section class="head" aria-labelledby="head-t"><header class="head-h"><h2 id="head-t">${svg('cloche')}<span class="head-name">The Pass</span></h2>${waiting.length ? `<span class="badge">${waiting.length}</span>` : ''}`
    + `<p class="muted">${waiting.length ? 'Needs your focus.<span class="sub2"> Questions first, then oldest first.</span>' : 'Calls and plates for you land here.'}</p>`
    // Your team, expanded: the column says how many calls need you (mock v2).
    + `${T && T.ok.status === 'live' ? `<p class="muted tpm">${T.count ? `${T.count} need you, most urgent first.` : 'Nothing from your team needs you.'}</p>` : ''}</header><div class="head-b">${lists}</div>`
    + `</section>`;
  const you = youView({ chart, back, head: viewMenu({ team, projs, picked: want ? [...want] : null, icons, ok: status.ok, head: 'person' }) });
  // Your team is not built yet (Dan, 2026-11-10): with reports, its view says so instead of showing anything made up.
  const teamWait = team ? `<section class="team-wait" aria-label="Your team"><header class="you-h">${teamHead}</header><div class="tw-b"><p><b>${e(team.name || 'Your team')}</b></p><p class="muted">Not checked. Your team's view needs the team connection, which Yes Chef does not have yet.</p></div></section>` : '';
  const lamp = status.ok ? 'ok' : 'bad';
  const projectOptions = `<select id="yc-projects" hidden>${[...projects].sort((a, b) => String(a.title).localeCompare(String(b.title))).map((p) => `<option value="${e(p.id)}">${e(p.title || 'Untitled')}</option>`).join('')}</select>`;
  const detail = status.ok ? `T3 Code at ${new URL(origin).host}. Checked ${new Date(status.at).toLocaleTimeString()} (${status.ms} ms).` : '';
  // The project menu (or, with reports, the view switch), the connection and Settings sit at the foot of the stage
  // list (Dan, 2026-11-08), pinned to the bottom of the column with no rule above them: the space does the separating
  // (Dan, 2026-11-09). The Shortcuts button went: ? and Settings open them.
  const lamps = `<ul class="lamps" aria-label="Sources"><li class="${lamp}" title="${e(detail)}"><i></i>${status.ok ? 'Live' : 'Not checked'}</li></ul>`;
  const gear = `<button type="button" class="gear" data-settings data-tcmd="settings.open" aria-label="Settings" title="Settings (⌘,)">${svg('sliders')}</button>`;
  const navFoot = `<div class="nav-foot">${footMenu}<div class="nav-foot-row">${lamps}${gear}</div></div></div></nav>`;
  const strip = status.ok ? '' : `<div class="strip" role="status"><b>T3</b> not checked: ${e(status.error)}</div>`;
  // The logo is the view switch: white on blue for the focused pass, blue on white for You, expanded.
  const logo = `<button type="button" class="logo" data-view-toggle data-tcmd="view.toggle" aria-label="Show the full kitchen" title="Switch view (V)"><span class="flip"><span class="face f-pass">${svg('cloche')}</span><span class="face f-kitchen">${svg('cloche')}</span></span><span class="vh">Yes Chef</span></button>`;
  return `<header class="bar"><h1 class="brand">${logo}</h1><ul class="stats" aria-label="Counts">${stats}</ul></header>${strip}`
    + `<div class="board">${nav}${navFoot}${you}${T ? T.board : teamWait}${pass}`
    + `<section class="reader" aria-label="Open ticket"><div class="reader-empty">${svg('cloche')}<p class="muted">Pick a ticket to read it here.</p></div></section></div>${projectOptions}`
    + (team ? `<script type="application/json" id="yc-team">${JSON.stringify(T ? T.meta : { name: team.name || null, below: typeof team.below === 'number' ? team.below : null, mode: team.mode === 'open' || team.mode === 'brigade' ? team.mode : null }).replace(/</g, '\\u003c')}</script>` : '')
    // The saved rules ride each refresh, so a second window's Settings shows them (PR-Agent r3 on #49).
    + (rules ? `<script type="application/json" id="yc-rules-now">${JSON.stringify(rules).replace(/</g, '\\u003c')}</script>` : '')
    + `<div id="plates" hidden>${T ? T.plates : ''}${shown.filter((k) => k.place !== 'Coordinators').map((k) => plate(k, link, origin, answered, rules)).join('')}</div>`;
}

// Settings -> Rules (Dan, 2026-11-08; Kitchen rules until 2026-11-10), laid out like T3 Code's settings: groups of rows, each a title and a
// line on the left and its switch or menu on the right. "Applies to" picks All projects or one project; a project's
// own value shows Reset, as T3 Code's overrides do. The page script fills the values and saves each change.
type KrRow = [key: string, title: string, line: string, kind: 'switch' | [value: string, label: string][]];
const KR_GROUPS: [string, KrRow[]][] = [
  ['Calls', [
    ['screens', 'Screenshots in visual calls', 'A call about something you can see shows each option, mocked up if it is not built yet.', 'switch'],
    ['missing', 'Visual call without them', 'What the Pass does when one arrives with no screenshots.', [['flag', 'Flag it'], ['off', 'Nothing']]],
    ['form', 'Decision form', 'How agents ask you to decide.', [['numbered', 'Numbered and lettered'], ['any', 'Agent’s choice']]],
  ]],
  ['Review', [
    ['reviewer', 'Pull-request reviewer', 'The bot agents wait for, and answer, before they ask you to merge.', [['none', 'None'], ['coderabbit', 'CodeRabbit'], ['pr-agent', 'PR-Agent'], ['codex', 'Codex']]],
    ['council', 'Council and hill climb', 'When agents may bring in other models to review the work.', [['ask', 'Only when I ask'], ['agent', 'Agent decides'], ['never', 'Never']]],
  ]],
  ['Tools', [
    ['browser', 'Browser', 'Where agents test in a browser.', [['any', 'Agent’s choice'], ['browserbase', 'Browserbase'], ['local', 'Local browser']]],
    ['tracker', 'Issue tracker', 'Where pull requests and hand-backs name their issue.', [['none', 'None'], ['linear', 'Linear'], ['github', 'GitHub Issues']]],
  ]],
];

/** The Rules pane. rules: the saved rules (client/kitchen.ts normalize); projects: T3's list, for "Applies to". */
export function kitchenPane({ rules, projects = [], error = '' }: { rules: unknown; projects?: readonly Pick<Project, 'id' | 'title'>[]; error?: string }): string {
  const ctl = (key: string, kind: KrRow[3]) => kind === 'switch'
    ? `<label class="kr-sw"><input type="checkbox" role="switch" data-kr="${key}" aria-labelledby="kr-${key}"><i></i></label>`
    : `<select class="kr-sel" data-kr="${key}" aria-labelledby="kr-${key}">${kind.map(([v, l]) => `<option value="${e(v)}">${e(l)}</option>`).join('')}</select>`;
  const row = ([key, title, line, kind]: KrRow) => `<div class="kr-row" data-row="${key}"><div class="kr-l"><div class="kr-h"><h4 id="kr-${key}">${e(title)}</h4>`
    + `<button type="button" class="kr-reset" data-kr-reset="${key}" title="Use the All projects value">Reset</button></div><p>${e(line)}</p></div>`
    + `<div class="kr-c">${ctl(key, kind)}</div></div>`;
  const scope = `<label class="kr-scope"><span>Applies to</span><select id="kr-scope"><option value="">All projects</option>`
    + [...projects].sort((a, b) => String(a.title).localeCompare(String(b.title))).map((p) => `<option value="${e(p.id)}">${e(p.title || 'Untitled')}</option>`).join('') + '</select></label>';
  const json = JSON.stringify(rules).replace(/</g, '\\u003c');
  return `<section class="set-pane" data-pane="rules"${error ? ` data-kr-error="${e(error)}"` : ''} hidden><div class="kr-top"><p class="kr-intro">Every thread Yes Chef starts gets these in its brief. The Pass checks the calls that come back.</p>${scope}</div>`
    + KR_GROUPS.map(([g, rows]) => `<h3 class="kgroup">${g}</h3><div class="kr-group">${rows.map(row).join('')}</div>`).join('')
    + `<h3 class="kgroup">House notes</h3><div class="kr-group"><div class="kr-row kr-notes" data-row="notes"><div class="kr-l"><div class="kr-h"><h4 id="kr-notes">Added to every brief</h4>`
    + `<button type="button" class="kr-reset" data-kr-reset="notes" title="Use the All projects value">Reset</button></div><p>Skills, test commands, anything else your agents should know.</p></div>`
    + `<textarea data-kr="notes" rows="3" maxlength="4000" aria-labelledby="kr-notes" placeholder="For example: run the tests with npm test before you hand back."></textarea></div></div>`
    + `<script type="application/json" id="yc-rules">${json}</script></section>`;
}
