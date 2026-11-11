import type { DemoKitchen, DemoOptions, DemoPr, DemoThread, DemoItem, DemoQuestion, DemoRun, DemoToolArgs } from './types.ts';
// The made-up kitchen behind the site's hero demo (agents view). It plays T3 Code for the app's own modules
// (lib/board.mjs, lib/actions.mjs, copied unchanged from client/), so the demo is the real app UI.
// Three made-up products: Fernpay, Loopline, Quillo. Nothing here reaches T3 Code or any server.
// Nothing leaves the pass on its own: every ticket there waits for the visitor's call. The agents answer a
// call a few seconds later, the way a real agent would, and two tickets in progress finish while the visitor watches.
import { buildBoard, renderApp, pickedFrom } from '../../demo/lib/board.mjs';
import { parseCalls, callKey, imageId } from '../../demo/lib/calls.mjs';
import { act } from '../../demo/lib/actions.mjs';
import { normalize, change } from '../../demo/lib/kitchen.mjs';
import { readRuns, dayStart, trackWaits, mayRunToday } from '../../demo/lib/you.mjs';

function requiredThread(thread: DemoThread | undefined): DemoThread {
  if (!thread) throw new Error('The demo thread is missing.');
  return thread;
}

const PAY = 'fernpay/fernpay', LOOP = 'loopline/dispatch', QUILL = 'quillo/quillo';
const pr = (repository: string, number: number, state: string) => ({ repository, number, state, url: `https://github.com/${repository}/pull/${number}` });
const decision = (title: string) => `**Decision for you**\n1. ${title}: merge it or request changes?\n   - a. Merge (recommended)\n   - b. Request changes`;

// The demo kitchen's rules: CodeRabbit reviews and agents test in Browserbase, as the site's Kitchen rules section
// shows (marketing words; the app calls them Rules). site/scripts/generate-demo.ts gives the server the same file, so the page
// it saves starts with them too.
export const DEMO_RULES = { all: { reviewer: 'coderabbit', browser: 'browserbase' } };

export function createKitchen({ now = Date.now, where, shot, onChange = () => {}, later = setTimeout }: DemoOptions): DemoKitchen {
  const ago = (min: number) => new Date(now() - min * 60000).toISOString();
  const projects = [['p-pay', 'Fernpay', 'fernpay'], ['p-loop', 'Loopline', 'loopline'], ['p-quill', 'Quillo', 'quillo']]
    .map(([id, title, dir]) => ({ id, title, ...where(dir) }));
  let n = 0, pos = 0, nextPr = 215;
  const threads: DemoThread[] = [];
  const items = new Map<string, DemoItem[]>();
  const questions = new Map<string, DemoQuestion[]>();
  const T = (title: string, projectId: string, status: string, more: Partial<DemoThread> & { ran?: boolean; min?: number } = {}) => {
    const t: DemoThread & { ran?: boolean; min?: number } = { threadId: `demo-${++n}`, title, projectId, status, parentThreadId: null, pullRequests: [], settled: false, snoozed: false,
      latestRunId: status === 'idle' && !more.ran ? null : `run-${n}`, updatedAt: ago(more.min ?? 10), itemCount: 0, model: 'claude-opus-5-5', ...more };
    delete t.ran; delete t.min;
    threads.push(t); items.set(t.threadId, []);
    return t;
  };
  // Positions count per thread, as in T3 Code; item ids are unique across the kitchen.
  const say = (t: DemoThread, type: string, text: string) => { const list = items.get(t.threadId) ?? []; list.push({ type, position: list.length + 1, itemId: `${t.threadId}-${++pos}`, text }); t.itemCount = list.length; };
  // Each thread's runs, newest first, as t3_thread_read lists them (recentRuns): [from, to] in minutes ago, to null
  // while it runs. The You view's agent time and running line read these.
  const runLog = new Map<string, DemoRun[]>();
  const ran = (t: DemoThread, ...spans: [number, number | null][]) => runLog.set(t.threadId, spans.map(([from, to], i) => ({ runId: `${t.threadId}-r${spans.length - i}`,
    status: to == null ? 'running' : 'completed', startedAt: ago(from), completedAt: to == null ? null : ago(to) })));
  // The waits on questions the board has seen, as client/server.mjs keeps them (client/you.mjs trackWaits).
  const waitLog = new Map<string, unknown>();

  // Backlog: nothing started.
  T('Usage alerts', 'p-pay', 'idle', { min: 300 });
  T('Archive old projects', 'p-quill', 'idle', { min: 220 });
  // Planned: handed back with the plan.
  const prep = T('Keyboard shortcuts', 'p-quill', 'idle', { ran: true, min: 52 });
  // In progress: agents building, some with subagents.
  const hooks = T('Webhook retries', 'p-pay', 'running', { min: 2 });
  const hookCrew = [T('Backend: retry queue', 'p-pay', 'running', { parentThreadId: hooks.threadId, min: 1, model: 'gpt-6.1' }),
    T('Words: resend button', 'p-pay', 'running', { parentThreadId: hooks.threadId, min: 3 })];
  const pricing = T('Pricing page under 1 s', 'p-pay', 'running', { min: 4 });
  const sms = T('Two-stops-away texts', 'p-loop', 'running', { min: 6 });
  T('Backend: SMS on approach', 'p-loop', 'running', { parentThreadId: sms.threadId, min: 5 });
  // Ready to merge: a question from T3, and a decision in the agent's message.
  const cards = T('Driver cards on the dispatch map', 'p-loop', 'running', { min: 18, pullRequests: [pr(LOOP, 88, 'open')] });
  const payouts = T('Retry failed payouts', 'p-pay', 'completed', { min: 34, pullRequests: [pr(PAY, 212, 'open'), pr(PAY, 213, 'open')] });
  // In review: PRs open.
  T('Invoice PDFs', 'p-pay', 'completed', { min: 75, settled: true, pullRequests: [pr(PAY, 205, 'open')] });
  const avatars = T('Avatar uploads', 'p-quill', 'completed', { min: 41, pullRequests: [pr(QUILL, 141, 'open')] });
  // Merged: waiting for the lead to check it.
  const phone = T('Search by phone', 'p-pay', 'completed', { min: 95, pullRequests: [pr(PAY, 198, 'merged')] });
  // Verified today, and on hold.
  T('Audit log', 'p-pay', 'completed', { min: 130, settled: true, settledAt: ago(Math.min(40, Math.max(0, (now() - new Date(now()).setHours(0, 0, 0, 0)) / 60000 - 1))), pullRequests: [pr(PAY, 190, 'merged')] });
  const tokens = T('Dark mode tokens', 'p-quill', 'cancelled', { min: 400 });
  const digest = T('Weekly digest email', 'p-pay', 'completed', { min: 600, snoozed: true });
  const audit = requiredThread(threads.find((t) => t.title === 'Audit log'));
  const invoice = requiredThread(threads.find((t) => t.title === 'Invoice PDFs'));
  ran(prep, [70, 52]);
  ran(hooks, [38, null]); ran(hookCrew[0], [30, null]); ran(hookCrew[1], [25, null]);
  ran(pricing, [22, null]);
  ran(sms, [45, null]); ran(requiredThread(threads.find((c) => c.parentThreadId === sms.threadId)), [35, null]);
  ran(cards, [80, null]);
  ran(payouts, [70, 34], [140, 95]);
  ran(invoice, [160, 75]);
  ran(avatars, [110, 41]);
  ran(phone, [180, 95]);
  ran(audit, [240, 130]);
  ran(tokens, [460, 400]);
  ran(digest, [660, 600]);

  for (const [t, text] of [
    [prep, 'Plan is ready: ? lists the shortcuts, J and K move, E settles. One PR, behind a setting. Approve it and I start.'],
    [payouts, 'Failed payouts now retry three times with backoff, and each row shows its retry state. Checks green.\n\n![Before](/demo/payouts-before.png) ![After](/demo/payouts-after.png)\n\n' + decision('Retry failed payouts')],
    [avatars, 'Upload a photo, crop it, and it shows everywhere your name does. PR #141 is open and the checks passed. It needs a review.'],
    [phone, 'Merged to main. Search matches phone numbers in any format, digits only.'],
    [cards, 'Each driver now has a card on the dispatch map, with their next stop and how many stops are left. PR #88 is open. One question before I finish the card.'],
  ] as [DemoThread, string][]) { say(t, 'user_message', 'Go.'); say(t, 'assistant_message', text); }
  questions.set(cards.threadId, [{ id: 'q1', requestId: 'r1', question: 'Show drive time or the delivery window on each driver card?',
    options: [{ label: 'Delivery window', description: 'what the customer was promised' }, { label: 'Drive time', description: 'live, changes every minute' }, { label: 'Both, window first' }] }]);

  const byId = (id: string) => requiredThread(threads.find((t) => t.threadId === id));
  const crewOf = (t: DemoThread) => threads.filter((c) => c.parentThreadId === t.threadId);
  const touch = (t: DemoThread) => { t.updatedAt = new Date(now()).toISOString(); };
  // A thread runs one run at a time: a new run interrupts the one going, so no two runs overlap (PR-Agent r3 on #74).
  const start = (t: DemoThread) => {
    t.status = 'running'; t.latestRunId = `run-${++n}`; touch(t);
    const was = runLog.get(t.threadId) || [];
    if (was[0] && !was[0].completedAt) { was[0].status = 'interrupted'; was[0].completedAt = t.updatedAt; }
    runLog.set(t.threadId, [{ runId: t.latestRunId, status: 'running', startedAt: t.updatedAt, completedAt: null }, ...was]);
  };
  // The thread's run ends where it stands now.
  const stop = (t: DemoThread) => { const r = (runLog.get(t.threadId) || [])[0]; if (r && !r.completedAt) { r.status = 'completed'; r.completedAt = new Date(now()).toISOString(); } };
  // A reply or an answer from the visitor brings a settled or held ticket back, so the agent's answer lands on the
  // Pass where they sent it from, not in a column they are not looking at (PR-Agent r6 on #61).
  const wake = (t: DemoThread) => { t.settled = false; delete t.settledAt; t.snoozed = false; };
  // A run's answer lands only if no newer run has started on the thread since (PR-Agent on #61).
  const afterRun = (t: DemoThread, ms: number, fn: () => void) => { const run = t.latestRunId; later?.(() => { if (t.latestRunId === run) fn(); }, ms); };
  const finish = (t: DemoThread, text: string, prs?: DemoPr[]) => {
    for (const c of crewOf(t)) { c.status = 'completed'; touch(c); stop(c); }
    if (prs) t.pullRequests = prs;
    t.status = 'completed'; touch(t); stop(t); say(t, 'assistant_message', text); onChange();
  };
  const openPrs = (t: Pick<DemoThread, 'pullRequests'>) => t.pullRequests.filter((p) => p.state === 'open');
  const repo = (t: DemoThread) => ({ 'p-pay': PAY, 'p-loop': LOOP, 'p-quill': QUILL }[t.projectId] ?? PAY);
  const names = (prs: DemoPr[]) => prs.map((p) => `#${p.number}`).join(' and ');
  const isAre = (prs: DemoPr[]) => (prs.length > 1 ? 'are' : 'is');

  // The agent's answer to a message from the Pass, a few seconds later.
  function reply(t: DemoThread, message: string) {
    const body = message.replace(/^Dan, from the Pass: /, '');
    // The app's words since 2026-11-10 (Merge, Approve, Request changes), and the old ones (Go, Refire) a saved page may
    // still send. Approve has no pull request to merge: the agent builds.
    const ship = /^(Merge it|Go\. Send it out)\./.test(body) || /^my call\.\n1a\. (Merge|Send it out)/.test(body);
    const refire = /^(Request changes|Refire)\. /.test(body) || /^my call\.\n1b\. (Request changes|Refire)/.test(body);
    // The note is quoted inside a sentence that ends with its own period ("Done: add the totals row."), so its own goes.
    // Merge, Approve and Go lead with their own words; only a note after them is the lead's ask.
    const note = (refire ? body.replace(/^(Request changes|Refire)\. /, '').replace(/^my call\.\n1b\. (Request changes|Refire)[^\n]*\n*/, '')
      : body.replace(/^(Merge it|Approved\. Go ahead|Go\. Send it out)\.\s*/, '')).trim().replace(/[.!?\s]+$/, '');
    afterRun(t, refire ? 5000 : 3500, () => {
      const open = openPrs(t);
      if (ship && open.length) {
        for (const p of open) p.state = 'merged';
        return finish(t, `Merged ${names(open)} to main. It is live, and the checks on main are green.`);
      }
      const prs = open.length ? t.pullRequests : [...t.pullRequests, pr(repo(t), nextPr++, 'open')];
      const live = openPrs({ pullRequests: prs });
      const what = refire ? `Fixed: ${note || 'what you asked'}.` : note && !/^(go|merge it)\b/i.test(note) ? `Done: ${note}.` : 'Built it.';
      finish(t, `${what} ${names(live)} ${isAre(live)} up to date and the checks are green.\n\n${decision(t.title)}`, prs);
    });
  }

  // Two tickets in progress come to the pass while the visitor watches: new work arriving, never work leaving.
  if (later) {
    afterRun(pricing, 25000, () => finish(pricing, `The pricing page loads in 0.8 s on a cold cache, down from 2.4 s. PR #${nextPr} is open and the checks are green.\n\n${decision('Pricing page under 1 s')}`,
      [pr(PAY, nextPr++, 'open')]));
    afterRun(hooks, 60000, () => finish(hooks, `Webhooks retry with backoff for 24 hours, and the dashboard shows each attempt. PR #${nextPr} is open and the checks passed. It needs a review.`,
      [pr(PAY, nextPr++, 'open')]));
  }

  // T3 Code's tools, as the app calls them (client/server.mjs and client/actions.mjs).
  async function call(name: string, args: DemoToolArgs = {}): Promise<unknown> {
    const thread = () => byId(args.threadId ?? '');
    switch (name) {
      case 't3_environment_read': return { environmentId: 'demo' };
      case 't3_project_list': return { projects };
      case 't3_thread_list': return { threads: threads.filter((x) => !!x.settled === !!args.settled).map((x) => ({ ...x })), nextCursor: null };
      case 't3_thread_read': {
        const list = (items.get(args.threadId ?? '') || []).filter((x) => x.position > (args.afterPosition || 0));
        const runs = runLog.get(args.threadId ?? '') || [];
        return { thread: args.threadId && { ...thread(), runCount: runs.length }, items: list, hasMore: false,
          ...(args.runLimit ? { recentRuns: runs.slice(0, args.runLimit).map((r) => ({ ...r })) } : {}) };
      }
      case 't3_pending_request':
        if (args.action === 'list') return { requestIds: questions.has(args.threadId ?? '') ? ['r1'] : [] };
        if (args.action === 'read') return { questions: questions.get(args.threadId ?? '') || [] };
        if (args.action === 'respond') {
          const picked = Object.values(args.answers || {})[0] || '';
          const t = thread();
          questions.delete(t.threadId); say(t, 'user_message', `Answer: ${picked}`); wake(t); start(t);
          afterRun(t, 4000, () => finish(t, `Driver cards now show ${String(picked).toLowerCase()}. ${names(openPrs(t))} ${isAre(openPrs(t))} up to date and the checks are green.\n\n${decision(t.title)}`));
          return { ok: true };
        }
        break;
      case 't3_thread_send': { const t = thread(); const message = args.message ?? ''; say(t, 'user_message', message); wake(t); start(t); reply(t, message); return { ok: true }; }
      case 't3_thread_organize': {
        const t = thread();
        // A held ticket is On hold, even one that was Verified: the board reads settled before snoozed.
        if (args.action === 'snooze') { t.snoozed = true; t.settled = false; delete t.settledAt; touch(t); return { ok: true }; }
        if (args.action === 'settle') { t.settled = true; t.settledAt = new Date(now()).toISOString(); touch(t); return { ok: true }; }
        break;
      }
      case 't3_thread_launch': {
        const nt = T(args.title || 'New ticket', args.projectId ?? 'p-pay', 'running', { min: 0 });
        ran(nt, [0, null]);
        say(nt, 'user_message', args.message ?? '');
        afterRun(nt, 5000, () => finish(nt, `Plan is ready: one PR, small and behind a setting. Approve it and I start.`));
        return { threadId: nt.threadId };
      }
    }
    throw new Error(`demo: ${name} is not in the demo kitchen`);
  }

  // What client/server.mjs poll() builds from those reads: the pending questions and each hand-back.
  function snapshot() {
    const words = new Map();
    for (const t of threads.filter((x) => !x.parentThreadId && !x.settled && !x.snoozed && x.latestRunId
      && (['completed', 'interrupted', 'idle'].includes(x.status) || questions.has(x.threadId)))) {
      const list = items.get(t.threadId) || [];
      const lastUser = list.map((x) => x.type).lastIndexOf('user_message');
      const said = list.slice(lastUser + 1).filter((x) => x.type === 'assistant_message');
      const latest = said.length ? said[said.length - 1] : null;
      const calls = latest ? parseCalls(latest.text) : [];
      words.set(t.threadId, { latest: latest && { itemId: latest.itemId, text: latest.text },
        call: latest && calls.length ? { key: callKey(latest.itemId, calls), itemId: latest.itemId, text: latest.text, calls } : null, cut: false });
    }
    const qs = new Map([...questions].map(([id, list]) => [id, list.map((q) => ({ ...q }))]));
    // Newest move first: the order client/server.mjs reads them in from the live stream (client/shells.mjs boardThreads).
    const moved = (x: DemoThread) => Date.parse(x.updatedAt) || 0;
    const ordered = [...threads].sort((a, b) => moved(b) - moved(a) || String(b.threadId).localeCompare(String(a.threadId)));
    // Run times for the threads that ran today, as client/server.mjs runTimes() reads them.
    const t0 = dayStart(now()), runs = new Map<string, unknown>();
    for (const t of threads.filter((x) => mayRunToday(x, t0))) {
      const list = runLog.get(t.threadId) || [];
      runs.set(t.threadId, readRuns({ recentRuns: list.slice(0, 50), thread: { runCount: list.length } }));
    }
    return buildBoard({ projects, threads: ordered.map((x) => ({ ...x })), questions: qs, lastWords: words, runs,
      waits: trackWaits(waitLog, ordered, qs, now()) });
  }

  // The app shows a screenshot an agent names through its /img route; the demo has its own files for each theme.
  const SHOTS = new Map(['payouts-before', 'payouts-after'].map((name) => [imageId(`/demo/${name}.png`), name]));
  // The rules' revision only goes up, from the clock, as in client/server.mjs: the page keeps the newest copy it saw.
  let rules = normalize(DEMO_RULES), rev = now();
  const answered = new Map(), holds = new Map();
  let board = snapshot();
  return {
    t3: { call },
    /** The board as the app sees it now (for the generator's checks). */
    board: () => snapshot(),
    /** The app's /app page for a query string, as client/server.mjs route() renders it. */
    page(search = '') {
      board = snapshot();
      const picked = pickedFrom(new URLSearchParams(search));
      return renderApp({ board, picked, link: () => 'https://t3.codes/', status: { ok: true, at: now(), ms: 4 },
        origin: 'https://t3.codes', answered, projects, rules: { ...rules, rev } })
        .replace(/\/img\/([0-9a-f]{20})/g, (all, id) => (SHOTS.has(id) ? shot(SHOTS.get(id) ?? id) : all));
    },
    /** The app's /act, as client/server.mjs runAct() handles it, for the desktop hook window.yeschef.act. */
    async act(body: string): Promise<[number, string]> {
      const input = Object.fromEntries(new URLSearchParams(body));
      if (input.kind === 'rules') {
        const out = change(rules, { scope: String(input.scope || ''), key: String(input.key || ''), value: String(input.value ?? ''), reset: input.reset === '1' });
        if (!out.rules) return [400, out.error];
        rules = out.rules; rev = Math.max(rev + 1, now()); onChange();
        return [200, JSON.stringify({ ...rules, rev })];
      }
      board = snapshot();
      try {
        const out = await act({ board, t3: { call }, input, holds, answered, projects, rules });
        if (out.status === 200) onChange();
        return [out.status, out.text];
      } catch (ex) {
        return [502, 'Not confirmed: ' + String(ex instanceof Error ? ex.message : ex).slice(0, 120)];
      }
    },
  };
}
