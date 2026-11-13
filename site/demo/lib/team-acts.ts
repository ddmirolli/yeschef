// A lead's call on a teammate's ticket, both ways (Dan, 2026-11-13, "A": wire Reply, Request changes, Rebase, Roll back,
// the answer and Hold to the relay). The relay path itself is team-inbox.ts act(): sealed, signed, checked by role on the
// dev's Mac and run once through the dev's own T3 sign-in.
//
// outgoing(): the lead's form (board.ts teamDock) -> who it goes to and the action the relay carries. Rebase and Roll
//   back are not actions of their own on the dev's Mac: they go as a Reply and a Request changes, with the words the
//   reader shows, so the role check is the one roles.ts already has (Rebase needs Reply, Roll back needs Merge).
// The dev's side, incoming(), is in team-inbox.ts beside the receive gate. This file imports nothing else from the
// team client, so the site demo (site/scripts/generate-demo.ts) can copy it.
import type { ActInput, ActResult } from './actions.ts';

/** An action as the relay carries it (team-inbox.ts Action). */
type Action = { kind: string; [field: string]: unknown };

/** The buttons a team call can carry (board.ts callWords acts, plus Hold). */
export const TEAM_ACTS = ['reply', 'refire', 'rebase', 'rollback', 'answer', 'hold'] as const;
export type TeamAct = (typeof TEAM_ACTS)[number];

const MAX_NOTE = 4000;
/** "Request changes. " goes before a Request changes on the dev's Mac (team-inbox.ts incoming), inside the same limit. */
const ROOM = MAX_NOTE - 'Request changes. '.length;
const text = (v: unknown, n: number): string => String(v ?? '').trim().slice(0, n);
const bad = (status: number, words: string): ActResult => ({ status, text: words });

/** The lead's form -> { to, action }, or a refusal the page shows. input: the posted fields (act, to, thread, note,
 *  say, q, c:0). */
export function outgoing(input: ActInput): { to: string; action: Action } | ActResult {
  const act = String(input.act || '') as TeamAct;
  if (!TEAM_ACTS.includes(act)) return bad(400, 'Unknown team action.');
  const to = text(input.to, 64), thread = text(input.thread, 200), note = text(input.note, MAX_NOTE + 1);
  if (!to || !thread) return bad(409, 'Not checked: this call names no thread to act on.');
  const say = text(input.say, 600);
  // The message as the dev's agent gets it, whole: a note that would be cut is refused here, never shortened later.
  const words = (act === 'rebase' || act === 'rollback') && say ? (note ? `${say}\n\n${note}` : say) : note;
  if (words.length > ((act === 'refire' || act === 'rollback') ? ROOM : MAX_NOTE)) return bad(400, 'That note is too long. Shorten it and send again.');
  switch (act) {
    case 'reply': case 'refire':
      if (!note) return bad(400, act === 'refire' ? 'Request changes needs a note: what should the agent fix?' : 'Write the reply first.');
      return { to, action: { kind: act, thread, note } };
    case 'rebase': case 'rollback':
      if (!say) return bad(409, 'Not checked: this call has no words to send.');
      return { to, action: { kind: act === 'rebase' ? 'reply' : 'refire', thread, note: note ? `${say}\n\n${note}` : say } };
    case 'answer': {
      // The question and every option the lead read: the dev's Mac answers only that same question.
      const pick = text(input['c:0'], 40), q = text(input.q, 200), opts = String(input.opts || '').slice(0, 2000);
      if (!pick) return bad(400, 'Pick an answer first.');
      if (!opts) return bad(409, 'Not checked: this question has no options to answer.');
      return { to, action: { kind: 'answer', thread, pick, q, opts, ...(note ? { note } : {}) } };
    }
    case 'hold':
      if (note) return bad(400, 'Hold sends the agent nothing, so your note would be lost. Send it with Reply first, or clear it.');
      return { to, action: { kind: 'hold', thread } };
  }
}
