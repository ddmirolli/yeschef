// Who reviews a PR, as GitHub names them: one shape and one cleaner for the reader (client/pr-runs.ts), the summary a
// dev's Mac sends (client/team-summaries.ts) and the copy the lead's Mac reads (client/open-kitchen.ts). No imports: the
// site's demo copies this file unchanged.

/** Where one reviewer stands on a PR: asked (requested), approved, asked for changes (changes), or reviewed with no
 *  verdict standing (commented: a comment alone, or a verdict dismissed). `who` is a GitHub login, or org/team for a
 *  team asked as a whole; `at` is when their latest review came, null while only asked. */
export type Reviewer = { who: string; team: boolean; state: ReviewState; at: number | null };
export type ReviewState = 'requested' | 'approved' | 'changes' | 'commented';
export const REVIEW_STATES: readonly ReviewState[] = ['requested', 'approved', 'changes', 'commented'];
/** At most this many reviewers per PR travel in a summary. */
export const REVIEWERS_MAX = 20;

// GitHub's own name rules: a login is up to 39 letters, digits and single hyphens (an app's ends in [bot]); a team's
// slug is lower case, under its org's login. Anything else is not GitHub's and is left out.
const LOGIN = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}(?:\[bot\])?$/;
const SLUG = /^[a-z0-9][a-z0-9._-]{0,99}$/;
/** A GitHub login, or null when the value is not one. */
export const loginOf = (v: unknown): string | null => (typeof v === 'string' && LOGIN.test(v) ? v : null);
/** org/slug for a team, or null when either part is not GitHub's. */
export const teamOf = (org: unknown, slug: unknown): string | null =>
  loginOf(org) && typeof slug === 'string' && SLUG.test(slug) ? `${org as string}/${slug}` : null;

/** Reviewers from outside data (a summary, a teammate's Mac): each entry with a GitHub name and a known state, the first
 *  REVIEWERS_MAX, one per name. Null when the list itself is not there (not checked), never an empty guess. */
export function cleanReviewers(v: unknown): Reviewer[] | null {
  if (!Array.isArray(v)) return null;
  const out: Reviewer[] = [], seen = new Set<string>();
  for (const x of v as unknown[]) {
    if (out.length >= REVIEWERS_MAX) break;
    if (!x || typeof x !== 'object') continue;
    const r = x as { who?: unknown; team?: unknown; state?: unknown; at?: unknown };
    const team = r.team === true;
    const who = team ? (typeof r.who === 'string' ? teamOf(r.who.split('/')[0], r.who.split('/').slice(1).join('/')) : null) : loginOf(r.who);
    const state = REVIEW_STATES.find((s) => s === r.state);
    if (!who || !state || seen.has(who.toLowerCase())) continue;
    seen.add(who.toLowerCase());
    out.push({ who, team, state, at: typeof r.at === 'number' && Number.isFinite(r.at) && r.at > 0 ? r.at : null });
  }
  return out;
}
