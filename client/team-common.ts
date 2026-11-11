// What the team client's modules share: the times they agree on and one text cleaner.
import { AUTH_SKEW_MS } from './seal.ts';

/** How long a request over the socket waits for the relay's answer. */
export const ASK_MS = 15000;
/** A teammate's action older than this is not run. It is also how long the relay holds it. */
export const ACT_TTL = 15 * 60000;
/** A seen action id is kept past the last moment its action could still be taken: its age limit plus the skew allowed. */
export const SEEN_KEEP_MS = ACT_TTL + AUTH_SKEW_MS + 60000;
/** A welcome, and a member's ask for one, waits this long on the relay. */
export const WELCOME_TTL = 7 * 86400000;

/** Text on one line, trimmed, at most n characters. Anything else becomes text first; null and undefined become ''. */
export const clean = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
