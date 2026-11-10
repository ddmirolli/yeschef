// Dan's actions at the Pass, each a T3 tool call (Dan, 2026-11-06: "A", make it act).
// Every action names a thread on the current board; anything else is refused. Sends queue and never interrupt.
import { brief } from './kitchen.mjs';
const PREFIX = 'Dan, from the Pass: ';
export const KINDS = ['answer', 'call', 'go', 'refire', 'reply', 'hold', 'settle', 'launch'];
const MAX_PROMPT = 60000, MAX_TITLE = 120;
const MAX_NOTE = 4000;

/** 8:00 tomorrow, local time: the end of a Hold. */
export function tomorrowMorning(now = new Date()) {
  const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 8, 0, 0);
  return d.toISOString();
}

/** Check one action against the board, then run it. Returns { status, text }. t3: { call(name, args) }. */
/** holds: optional Map of nonce to snooze time, so a retried Hold keeps its first time.
 *  answered: optional Map of call key to { picks, at, nonce }, so a call is answered once (a retry of the same send passes). */
/** projects: T3's project list ({ id, title }); only a launch uses it, and only into one of these projects.
 *  rules: the rules (client/kitchen.mjs); a launch carries the project's rules in its brief. */
export async function act({ board, t3, input, now = new Date(), holds, answered, projects = [], rules = null }) {
  const kind = String(input.kind || '');
  const thread = String(input.thread || '');
  const note = String(input.note || '').trim().slice(0, MAX_NOTE);
  const nonce = String(input.nonce || '').replace(/[^\w-]/g, '').slice(0, 64);
  if (!KINDS.includes(kind)) return { status: 400, text: 'Unknown action.' };
  if (!nonce) return { status: 400, text: 'Missing action id. Reload the Pass.' };

  // A new thread in T3 Code (Dan, 2026-11-07; since 2026-11-10 Cmd+T or Cmd+N, as Cmd+K is the action bar). Into a
  // project T3 lists, with Dan's prompt; in a new worktree unless he chose the project checkout. The model and modes are T3's defaults for this sign-in.
  if (kind === 'launch') {
    const project = projects.find((p) => p.id === String(input.project || ''));
    if (!project) return { status: 400, text: 'Pick a project T3 Code knows.' };
    const message = String(input.prompt || '').trim();
    if (!message) return { status: 400, text: 'Write what the agent should do.' };
    if (message.length > MAX_PROMPT) return { status: 400, text: 'That prompt is too long. Shorten it.' };
    const title = (String(input.title || '').trim() || message.split('\n')[0]).replace(/\s+/g, ' ').slice(0, MAX_TITLE);
    const workspaceStrategy = { type: input.workspace === 'root' ? 'root' : 'worktree' };
    // The project's rules go under the prompt (Dan, 2026-11-08), so the agent works the project's way.
    const out = await t3.call('t3_thread_launch', { projectId: project.id, title, message: message + brief(rules, project.id), workspaceStrategy, clientRequestId: `pass-${nonce}` });
    return { status: 200, text: `Launched “${title}” in ${project.title}${workspaceStrategy.type === 'worktree' ? ', in a new worktree' : ''}.`, thread: out?.threadId || null };
  }

  if (kind === 'answer') {
    const ask = board.tickets.flatMap((k) => k.asks).find((a) => a.thread.threadId === thread);
    const request = String(input.request || '');
    const questions = (ask?.items || []).filter((q) => q.requestId === request);
    if (!ask || !questions.length) return { status: 409, text: 'That question is no longer waiting. The board will refresh.' };
    const answers = {};
    for (const q of questions) {
      // An option matches on its exact label; only a custom answer is trimmed (PR-Agent r8 on #12).
      const raw = String(input[`q:${q.id}`] ?? '');
      const opt = (q.options || []).find((o) => o.label === raw);
      const picked = opt ? raw : raw.trim();
      if (!picked && q.required === false) continue;
      if (!picked) return { status: 400, text: `Pick an answer for: ${q.question}` };
      if (!opt && !q.allowCustomAnswer) return { status: 400, text: 'That option is not on this question.' };
      answers[q.id] = opt ? (opt.value ?? opt.label) : picked;
    }
    await t3.call('t3_pending_request', { action: 'respond', threadId: thread, requestId: request, answers });
    return { status: 200, text: 'Answered. The agent has your answer.' };
  }

  const ticket = board.tickets.find((k) => k.thread.threadId === thread);
  if (!ticket || ticket.place === 'Coordinators') return { status: 409, text: 'That ticket is no longer on the board. The board will refresh.' };
  if ((kind === 'go' || kind === 'refire') && !ticket.atPass) return { status: 409, text: 'That ticket is not waiting on you.' };
  // An open call carries its own choices: a stale Merge or Request changes form must not answer around it (PR-Agent r2 on #17).
  if ((kind === 'go' || kind === 'refire') && ticket.call) return { status: 409, text: 'The agent asked a decision. Answer it in the ticket.' };
  if ((kind === 'go' || kind === 'refire') && ticket.cut) return { status: 409, text: 'Not checked: the Pass could not read all of the agent\'s recent messages. Read them in T3 and answer there.' };

  if (kind === 'call') {
    // A pending T3 question comes first, as for every other action (PR-Agent r6 on #17).
    if (ticket.asks.length) return { status: 409, text: 'A question waits on this ticket. Answer it first.' };
    // The answer names the exact message it answers. A newer message from the agent means a new question.
    const call = ticket.call;
    if (!call || call.key !== String(input.call || '')) return { status: 409, text: 'That call changed or is no longer waiting. The board will refresh.' };
    const picks = [];
    for (const [i, c] of call.calls.entries()) {
      const raw = String(input[`c:${i}`] ?? '');
      if (!raw) continue;
      const o = c.options.find((x) => x.letter === raw);
      if (!o) return { status: 400, text: 'That option is not on this call.' };
      picks.push({ n: i + 1, c, o });
    }
    // Every decision in the message gets an answer: the call closes as one (PR-Agent r2 on #17).
    if (picks.length < call.calls.length) return { status: 400, text: call.calls.length > 1 ? 'Answer every decision first.' : 'Pick an answer first.' };
    // "1a. Yes, merge." with the question after it: the agent asked by number and letter, and gets both back.
    const lines = picks.map(({ n, c, o }) => `${n}${o.letter}. ${o.text}` + (c.question !== 'Your call' ? ` (${c.question})` : ''));
    const message = PREFIX + 'my call.\n' + lines.join('\n') + (note ? `\n\n${note}` : '');
    const summary = picks.map(({ n, o }) => `${n}${o.letter}`).join(', ');
    // One answer per call. The call is reserved before the send, so two tabs never both send (PR-Agent r1 on #17).
    // Only a retry of the same send, byte for byte, passes again; T3 drops its repeat by the request id.
    // A send that fails keeps the reservation: it may have reached T3, so a different answer must not follow it.
    const done = answered?.get(call.key);
    if (done && (done.nonce !== nonce || done.message !== message)) {
      return { status: 409, text: done.nonce === nonce ? 'That retry changed the answer. The first send stands: check the thread in T3.' : `Already answered: ${done.picks}. Check the thread in T3.` };
    }
    // The record stays "unconfirmed" until T3 takes the send, so the sheet offers the same retry, never a false success.
    const rec = done || { picks: summary, letters: picks.map(({ o }) => o.letter), note, at: now.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' }), nonce, message, confirmed: false };
    if (answered && !done) {
      answered.set(call.key, rec);
      if (answered.size > 500) answered.delete(answered.keys().next().value);
    }
    await t3.call('t3_thread_send', { threadId: thread, message, mode: 'queue', clientRequestId: `pass-${nonce}` });
    rec.confirmed = true;
    return { status: 200, text: `Sent your call (${summary}) to the agent.` };
  }
  if (kind === 'go' && ticket.place === 'Merged') return { status: 409, text: 'That ticket is already merged. Settle it once you have checked it.' };
  if (ticket.asks.length && kind !== 'reply') return { status: 409, text: 'A question waits on this ticket. Answer it first.' };
  if ((kind === 'refire' || kind === 'reply') && !note) return { status: 400, text: kind === 'refire' ? 'Request changes needs a note: what should the agent fix?' : 'Write the reply first.' };

  // Hold and Settle send the agent nothing, so a written note would be lost (council 3, Opus): refuse it.
  if ((kind === 'hold' || kind === 'settle') && note) return { status: 400, text: `${kind === 'hold' ? 'Hold' : 'Settle'} sends the agent nothing, so your note would be lost. Send it with Reply (R) first, or clear it.` };
  if (kind === 'hold') {
    const until = holds?.get(nonce) ?? tomorrowMorning(now);
    if (holds) { holds.set(nonce, until); if (holds.size > 500) holds.delete(holds.keys().next().value); }
    await t3.call('t3_thread_organize', { action: 'snooze', threadId: thread, snoozedUntil: until });
    return { status: 200, text: 'On hold until 8:00 tomorrow.' };
  }
  if (kind === 'settle') {
    await t3.call('t3_thread_organize', { action: 'settle', threadId: thread });
    return { status: 200, text: ticket.place === 'Merged' ? 'Settled. It moves to Verified.' : 'Settled. It leaves the pass.' };
  }
  // Developer words (Dan, 2026-11-10): "go" on a ticket with an open pull request is Merge. With none there is nothing to
  // merge, so it is Approve: the agent goes ahead (Pass call 1a).
  const merge = kind === 'go' && ticket.open.length > 0;
  // The form says which button the lead saw. A pull request that opened or closed since then makes it the other
  // action, which they did not choose, so it waits for a fresh look. A form from before "pr" goes by the board.
  if (kind === 'go' && input.pr && (input.pr === 'open') !== merge) {
    return { status: 409, text: merge ? 'A pull request opened since you looked. Review it, then merge.' : 'The pull request is no longer open. Look again before you act.' };
  }
  const message = PREFIX + (kind === 'go' ? (merge ? 'Merge it.' : 'Approved. Go ahead.') + (note ? `\n\n${note}` : '')
    : kind === 'refire' ? `Request changes. ${note}` : note);
  await t3.call('t3_thread_send', { threadId: thread, message, mode: 'queue', clientRequestId: `pass-${nonce}` });
  return { status: 200, text: kind === 'go' ? (merge ? 'Sent: Merge.' : 'Sent: Approve.') : kind === 'refire' ? 'Sent: Request changes, with your note.' : 'Reply sent.' };
}
