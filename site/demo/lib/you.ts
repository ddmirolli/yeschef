// The numbers behind the You view (Dan, 2026-11-10, views mock v4): agent time today and the agents running line.
// Both come from T3 Code's run times. t3_thread_read with runLimit lists a thread's recent runs, each with
// startedAt and completedAt (read on 2026-11-10). Nothing here is guessed: without run times the view says
// "Not checked". T3 gives no merge times and no check results, so the view says "Not checked" for those too.

import type { ThreadRead, ThreadRow } from './contracts.ts';

/** One run in ms: closed, or running (end null), or open: it stopped with no known length, and may have run until `until`. */
export type Run = { start: number; end: number | null; open?: undefined; until?: undefined }
  | { start: number; end: number; open: true; until: number };
/** One thread's runs (readRuns): newest first, and whether T3 has older runs than it sent. */
export interface RunsEntry { runs: Run[]; more: boolean }
/** One wait on you: from the thread's last update when Yes Chef first saw it ask, seen at that poll, to the poll that
 *  saw no question. */
export interface Wait { from: number; seen: number }
export interface WaitEntry { wait: Wait | null; past: (Wait & { to: number })[] }
/** A ticket as agentTime and runningSeries read it (client/board.ts Ticket). */
export interface TimedTicket { place: string; project: string; runs?: RunsEntry[] | null | undefined }

/** Midnight where Yes Chef runs: "today" is this calendar day, as for Verified today (client/board.ts). */
export const dayStart = (now: number): number => new Date(now).setHours(0, 0, 0, 0);

export const RUNNING: ReadonlySet<string> = new Set(['preparing', 'queued', 'starting', 'running']);

/** Whether a thread's run times are worth reading: it has run, and it is running, was updated today, or T3 sent no
 *  update time, so only its runs can tell (PR-Agent r5 on #74). t0: midnight (dayStart). */
export const mayRunToday = (t: Pick<ThreadRow, 'latestRunId' | 'status' | 'updatedAt'>, t0: number): boolean => !!t.latestRunId && (RUNNING.has(t.status) || !(Date.parse(t.updatedAt) < t0));

/** One thread's runs from a t3_thread_read answer, newest first as T3 sends them: [{ start, end }] in ms, end null
 *  while it runs. A run that stopped without an end time (T3 sent completedAt even for interrupted runs on 2026-11-10)
 *  has no known length: it is open, counts no time, and makes what it touches a floor or "not checked" (PR-Agent on
 *  #74). So is a run with no start time (PR-Agent r4 on #74). until: the latest an open run can have run: its end, the
 *  next run's start (a thread runs one run at a time), or no limit. more: T3 has older runs than it sent. */
export function readRuns(read: (Pick<ThreadRead, 'recentRuns'> & { thread?: { runCount?: number | undefined } | undefined }) | null | undefined): RunsEntry {
  const runs: Run[] = [];
  let next = Infinity;  // the next newer run's start, or its end when T3 sent no start
  for (const r of read?.recentRuns || []) {
    const start = Date.parse(r.startedAt ?? ''), done = Date.parse(r.completedAt ?? ''), began = Number.isFinite(start);
    if (began && Number.isFinite(done)) runs.push({ start, end: done });
    else if (began && RUNNING.has(r.status ?? '')) runs.push({ start, end: null });
    else {
      const until = Number.isFinite(done) ? done : next;
      runs.push(began ? { start, end: start, open: true, until } : { start: until, end: until, open: true, until });
    }
    next = began ? start : Number.isFinite(done) ? done : next;
  }
  const total = Number(read?.thread?.runCount);
  return { runs, more: Number.isFinite(total) && total > runs.length };
}

/** Waits on you that T3's run times hold. T3 keeps a run going while its thread waits on a question, and after the
 *  answer the run may carry on, so its start and end hold the wait. Yes Chef sees each wait while it lasts and keeps
 *  it for the day, so agent time and the running line leave it out after the answer too (PR-Agent r3 on #74).
 *  log: thread id to { wait, past }, kept from poll to poll. wait: the wait going now, { from, seen }: from is the
 *  thread's last update when Yes Chef first saw it ask (NaN when T3 sent none), seen is that poll's time. past: today's
 *  waits that ended, each with to, the first poll that saw no question (a few seconds late, so agent time errs low).
 *  A wait that started and ended while Yes Chef was not running is not seen, and it counts as agent time. */
export function trackWaits(log: Map<string, WaitEntry>, threads: readonly Pick<ThreadRow, 'threadId' | 'status' | 'updatedAt'>[], questions: { has(id: string): boolean }, now: number): Map<string, WaitEntry> {
  const t0 = dayStart(now), ids = new Set<string>();
  for (const t of threads) {
    ids.add(t.threadId);
    const w: WaitEntry = log.get(t.threadId) || { wait: null, past: [] };
    const asking = t.status === 'waiting' || questions.has(t.threadId);
    if (asking && !w.wait) w.wait = { from: Math.min(Date.parse(t.updatedAt), now), seen: now };
    if (!asking && w.wait) { w.past.push({ ...w.wait, to: now }); w.wait = null; }
    w.past = w.past.filter((p) => p.to > t0);
    if (w.wait || w.past.length) log.set(t.threadId, w); else log.delete(t.threadId);
  }
  for (const id of [...log.keys()]) if (!ids.has(id)) log.delete(id);
  return log;
}

/** One thread's runs with its waits (trackWaits) taken out: a run splits around each wait, newest part first, and a
 *  run inside a wait drops out. A wait with no start time leaves the run it was seen in with no known length: open,
 *  as in readRuns. */
export function withoutWaits<E extends RunsEntry>(entry: E | undefined, w: WaitEntry | undefined): E | undefined {
  const spans = w ? [...w.past, ...(w.wait ? [{ ...w.wait, to: Infinity }] : [])] : [];
  if (!entry || !spans.length) return entry;
  const runs = entry.runs.flatMap((r): Run[] => {
    if (r.open) return [r];
    if (spans.some((s) => !Number.isFinite(s.from) && s.seen >= r.start && s.seen <= (r.end ?? Infinity))) return [{ start: r.start, end: r.start, open: true, until: r.end ?? Infinity }];
    let parts: Run[] = [{ start: r.start, end: r.end }];
    for (const s of spans.filter((x) => Number.isFinite(x.from))) {
      parts = parts.flatMap((p): Run[] => {
        const e = p.end ?? Infinity;
        if (s.to <= p.start || s.from >= e) return [p];
        return [...(s.to < e ? [{ start: s.to, end: p.end }] : []), ...(s.from > p.start ? [{ start: p.start, end: s.from }] : [])];
      });
    }
    return parts;
  });
  return { ...entry, runs };
}

/** Whether an open run may have run today: it can have run until its until (readRuns). */
const openToday = (r: Run, t0: number): boolean => !!r.open && r.until > t0;

/** A thread's time today, in ms: each run's part since midnight, a running one up to now. cut: the time is a floor,
 *  because T3 sent only its newest runs and the oldest of them started today, or because a run today has no end time.
 *  open: a run today has no end time. */
export function timeToday(entry: RunsEntry, now: number): { ms: number; cut: boolean; open: boolean } {
  const t0 = dayStart(now);
  let ms = 0, oldest = Infinity, open = false;
  entry.runs.forEach((r) => {
    oldest = Math.min(oldest, r.start);
    if (openToday(r, t0)) open = true;
    const s = Math.max(r.start, t0), e = Math.min(r.end ?? now, now);
    if (e > s) ms += e - s;
  });
  return { ms, cut: (!!entry.more && oldest >= t0) || open, open };
}

/** Agent time today for the tickets shown, in ms, by project. Each thread (a ticket or one of its subagents) that ran
 *  today is one agent, however short its run. Coordinators stay out, as they stay out of the stages. Times add
 *  unrounded; only what is shown rounds (PR-Agent r2 on #74). */
export function agentTime(tickets: readonly TimedTicket[], now: number): { ms: number; agents: number; cut: boolean; byProject: Map<string, number> } {
  const byProject = new Map<string, number>();
  let ms = 0, agents = 0, cut = false;
  for (const k of tickets) {
    if (k.place === 'Coordinators') continue;
    for (const entry of k.runs || []) {
      const t = timeToday(entry, now);
      if (t.cut) cut = true;
      if (t.ms <= 0 && !t.open) continue;
      agents++; ms += t.ms;
      if (t.ms > 0) byProject.set(k.project, (byProject.get(k.project) || 0) + t.ms);
    }
  }
  return { ms, agents, cut, byProject };
}

/** How many agents ran at each point today: now, and every `step` ms before it back to the first run today, oldest
 *  first. Points count back from now, so they move with the clock, not with the hour. span: ms from first point to now.
 *  It never counts a run it was not sent (PR-Agent on #74): it starts no earlier than the oldest run T3 sent for a
 *  thread with more runs today, and a run today with no end time leaves the whole line unknown (no points). */
export function runningSeries(tickets: readonly Pick<TimedTicket, 'place' | 'runs'>[], now: number, step = 15 * 60000): { span: number; points: number[] } {
  const t0 = dayStart(now), runs: Run[] = [], none = { span: 0, points: [] };
  let floor = t0;
  for (const k of tickets) {
    if (k.place === 'Coordinators') continue;
    for (const entry of k.runs || []) {
      if (entry.runs.some((r) => openToday(r, t0))) return none;
      if (entry.more && entry.runs.length) floor = Math.max(floor, Math.min(...entry.runs.map((r) => r.start)));
      for (const r of entry.runs) if ((r.end ?? now) > t0 && r.start <= now) runs.push(r);
    }
  }
  if (!runs.length) return none;
  const first = Math.min(now, Math.max(floor, Math.min(...runs.map((r) => r.start))));
  const n = Math.floor((now - first) / step);
  const at = (t: number) => runs.filter((r) => r.start <= t && (r.end == null || r.end > t)).length;
  const points: number[] = [];
  for (let i = n; i >= 0; i--) points.push(at(now - i * step));
  return { span: n * step, points };
}

/** "under 1 min", "40 min", "4 h", "5.5 h". */
export function duration(ms: number): string {
  const min = Math.round(ms / 60000);
  if (ms > 0 && min < 1) return 'under 1 min';
  if (min < 60) return `${min} min`;
  const h = Math.round(ms / 360000) / 10;
  return `${Number.isInteger(h) ? h : h.toFixed(1)} h`;
}
