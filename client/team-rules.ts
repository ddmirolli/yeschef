// The team's Rules (Dan, 2026-11-13, 2A on the mock): escalation, the call thresholds, the model checks, and each area's
// projects, mode and failed-change budget. The lead sets them in Settings -> Rules. They travel sealed in the roster
// the lead signs, as the areas and roles do, so every Mac on the team raises the same calls at the same times. The
// relay never sees them.
//
// The defaults are the brief's proposed ones (docs/team-brigade-brief-v0_1.md, Thresholds), not rulings. The model
// checks and the budget are kept here before anything reads them: Duplicate and Diverging (step 4 of the order) and
// Over budget (French Brigade) read them when they are built.

import { RULES as CALL_RULES, type Rules as CallRules } from './open-kitchen.ts';

/** The team-wide rules. Every value is one of its choices. */
export interface TeamRules {
  /** A call nobody marks Seen reaches the lead after this many minutes. */
  escalateMin: number;
  stuckMin: number;
  waitMin: number;
  failRuns: number;
  /** Too big: over this many changed lines or files, lockfiles and generated files left out. */
  bigLines: number;
  bigFiles: number;
  /** Duplicate and Diverging: a model on the lead's quota compares plans. Off until the lead turns it on. */
  checks: boolean;
  /** Compares a day before Yes Chef stops until tomorrow; 0: no limit. */
  comparesDay: number;
  /** How alike two plans are, in percent, before the call says Duplicate, not Diverging. */
  dupAt: number;
}
export type Mode = 'open' | 'brigade';
/** An area as the roster carries it: its name, then what Rules gives it. `projects` are project names, as summaries
 *  name them (team-summaries.ts), since each Mac has its own T3 project ids. */
export interface AreaRules { id: string; name: string; projects: string[]; mode: Mode; budget: number }

/** Each rule's choices. The menus show these and a change must be one of them. */
export const CHOICES = {
  escalateMin: [5, 10, 15, 30, 60],
  stuckMin: [10, 20, 30, 60],
  waitMin: [5, 15, 30, 60],
  failRuns: [2, 3, 5],
  big: [[400, 15], [800, 30], [1500, 60]] as [number, number][],
  comparesDay: [20, 50, 100, 0],
  dupAt: [80, 90, 95],
  budget: [5, 10, 20],
} as const;

export const TEAM_DEFAULTS: Readonly<TeamRules> = Object.freeze({
  escalateMin: CALL_RULES.escalateMin, stuckMin: CALL_RULES.stuckMin, waitMin: CALL_RULES.waitMin, failRuns: CALL_RULES.failRuns,
  bigLines: CALL_RULES.bigLines, bigFiles: CALL_RULES.bigFiles, checks: false, comparesDay: 50, dupAt: 90,
});
export const BUDGET_DEFAULT = 10;
const AREA_PROJECTS = 50, PROJECT_NAME = 80;

// Text on one line, trimmed, at most n characters (as team-common.ts clean, which would bring the relay's crypto into
// the site's demo).
const clean = (s: unknown, n: number): string => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
const pick = (v: unknown, list: readonly number[], d: number): number => (typeof v === 'number' && list.includes(v) ? v : d);

/** The team rules from a roster, cleaned: an unknown or odd value is the default. */
export function cleanTeamRules(raw: unknown): TeamRules {
  const r = (raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}) as Record<string, unknown>;
  const big = CHOICES.big.find(([l, f]) => l === r.bigLines && f === r.bigFiles) || [TEAM_DEFAULTS.bigLines, TEAM_DEFAULTS.bigFiles];
  return {
    escalateMin: pick(r.escalateMin, CHOICES.escalateMin, TEAM_DEFAULTS.escalateMin),
    stuckMin: pick(r.stuckMin, CHOICES.stuckMin, TEAM_DEFAULTS.stuckMin),
    waitMin: pick(r.waitMin, CHOICES.waitMin, TEAM_DEFAULTS.waitMin),
    failRuns: pick(r.failRuns, CHOICES.failRuns, TEAM_DEFAULTS.failRuns),
    bigLines: big[0], bigFiles: big[1],
    checks: r.checks === true,
    comparesDay: pick(r.comparesDay, CHOICES.comparesDay, TEAM_DEFAULTS.comparesDay),
    dupAt: pick(r.dupAt, CHOICES.dupAt, TEAM_DEFAULTS.dupAt),
  };
}

/** What Rules adds to an area, cleaned: its projects (names, no repeats), its mode, its budget. */
export function cleanAreaRules(a: { projects?: unknown; mode?: unknown; budget?: unknown } | null | undefined): Pick<AreaRules, 'projects' | 'mode' | 'budget'> {
  const projects: string[] = [];
  for (const p of Array.isArray(a?.projects) ? a.projects : []) {
    const n = clean(p, PROJECT_NAME);
    if (n && !projects.includes(n)) projects.push(n);
    if (projects.length >= AREA_PROJECTS) break;
  }
  return { projects, mode: a?.mode === 'brigade' ? 'brigade' : 'open', budget: pick(a?.budget, CHOICES.budget, BUDGET_DEFAULT) };
}

/** One change from Settings to the team rules: { key, value } as the page sends them. Returns the new rules or an error. */
export function changeTeamRule(rules: TeamRules, key: string, value: string): { rules: TeamRules; error?: undefined } | { error: string; rules?: undefined } {
  const n = Number(value);
  const bad = { error: 'That is not one of the choices.' };
  if (key === 'big') {
    const [l, f] = value.split(':').map(Number);
    const c = CHOICES.big.find(([cl, cf]) => cl === l && cf === f);
    return c ? { rules: { ...rules, bigLines: c[0], bigFiles: c[1] } } : bad;
  }
  if (key === 'checks') return value === 'on' || value === 'off' ? { rules: { ...rules, checks: value === 'on' } } : bad;
  if (key === 'escalateMin' || key === 'stuckMin' || key === 'waitMin' || key === 'failRuns' || key === 'comparesDay' || key === 'dupAt') {
    return (CHOICES[key] as readonly number[]).includes(n) && value.trim() !== '' ? { rules: { ...rules, [key]: n } } : bad;
  }
  return { error: 'There is no such rule.' };
}

/** One change from Settings to an area: its mode, its budget, or one project in or out. */
export function changeArea(area: AreaRules, field: string, value: string, on?: boolean): { area: AreaRules; error?: undefined } | { error: string; area?: undefined } {
  if (field === 'mode') return value === 'open' || value === 'brigade' ? { area: { ...area, mode: value } } : { error: 'That is not one of the modes.' };
  if (field === 'budget') { const n = Number(value); return (CHOICES.budget as readonly number[]).includes(n) ? { area: { ...area, budget: n } } : { error: 'That is not one of the choices.' }; }
  if (field === 'project') {
    const name = projectName(value);
    if (!name) return { error: 'That project has no name.' };
    const rest = area.projects.filter((p) => p !== name);
    if (on && rest.length >= AREA_PROJECTS) return { error: `An area holds up to ${AREA_PROJECTS} projects.` };
    return { area: { ...area, projects: on ? [...rest, name] : rest } };
  }
  return { error: 'There is no such area setting.' };
}

/** The thresholds the calls use (client/open-kitchen.ts). The lead's steps keep the proposed ratios: Failing reaches the
 *  lead at twice its runs, Waiting at twice its minutes. Too big's lead wait and Not reporting stay as they are. */
export function callRules(raw: unknown): CallRules {
  const t = cleanTeamRules(raw);
  return { ...CALL_RULES, escalateMin: t.escalateMin, stuckMin: t.stuckMin, waitMin: t.waitMin, waitLeadMin: t.waitMin * 2,
    failRuns: t.failRuns, failLeadRuns: t.failRuns * 2, bigLines: t.bigLines, bigFiles: t.bigFiles };
}

/** The team view's mode: French Brigade once any area is in French Brigade (brief, "Mode per area": proposed). */
export function teamMode(areas: readonly { mode?: unknown }[] | null | undefined): Mode {
  return (areas || []).some((a) => a?.mode === 'brigade') ? 'brigade' : 'open';
}

/** A project's name as an area keeps it: what a chip shows, what a save stores and what a launch looks up are one
 *  name, so a title with doubled spaces or past 80 characters still finds its areas (PR-Agent r1 on #69). */
export function projectName(name: unknown): string {
  return clean(name, PROJECT_NAME);
}

/** The "Applies to" scopes of a project: each area it is in, in the team's order, as kitchen rules keys ("area:<id>"). */
export function areaScopes(areas: readonly { id: string; projects?: readonly string[] }[] | null | undefined, title: string | null | undefined): string[] {
  const name = projectName(title);
  if (!name) return [];
  return (areas || []).filter((a) => a.projects?.includes(name)).map((a) => `area:${a.id}`);
}
