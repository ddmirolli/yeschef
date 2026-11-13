// Rules (Dan, 2026-11-08; Kitchen rules until 2026-11-10): how your projects work, set in Settings -> Rules, like T3
// Code's settings. Yes Chef's stages and actions stay the same for everyone; these rules are each setup's own.
// The file keeps its name, kitchen-rules.json, so saved rules load as before. They reach agents
// two ways: the brief on every thread Yes Chef starts, and the checks the Pass runs on what comes back.
// Threads started elsewhere follow the agent's own instruction files (CLAUDE.md, AGENTS.md).

/** The rules a setup can set. */
export type RuleKey = 'screens' | 'missing' | 'form' | 'reviewer' | 'council' | 'browser' | 'tracker';
/** One rule: its choices (the first is the built-in default) and the line it adds to a brief, per choice. */
export interface Rule { choices: readonly string[]; brief: Readonly<Record<string, string>> }
/** Some rules and the notes: a project's overrides. */
export type RuleSet = Partial<Record<RuleKey, string>> & { notes?: string };
/** Every rule and the notes: "All projects", or one project's rules in full. */
export type FullRuleSet = Record<RuleKey, string> & { notes: string };
/** A whole rules file: every rule for All projects, and each project's overrides. */
export interface Rules { all: FullRuleSet; projects: Record<string, RuleSet> }
/** A call message the Pass checks for screenshots: its questions and their options. */
export interface CallLike { calls?: { question?: string; options?: { text?: string }[] }[] }

/** Each rule: its choices (the first is the built-in default) and the line it adds to a brief, per choice. */
export const RULES: Readonly<Record<RuleKey, Rule>> = {
  screens: {
    choices: ['on', 'off'],
    brief: { on: 'A decision about anything I can see (a screen, a layout, a pill, copy on a page) shows a screenshot of each option, labelled with its letter. Mock up an option that is not built yet.' },
  },
  missing: {
    choices: ['flag', 'off'],
    brief: {},
  },
  form: {
    choices: ['numbered', 'any'],
    brief: { numbered: 'Ask each decision in your final message: a numbered question, lettered options, and a "Recommendation: a." line.' },
  },
  reviewer: {
    choices: ['none', 'coderabbit', 'pr-agent', 'codex'],
    brief: {
      coderabbit: 'CodeRabbit is the pull-request reviewer. Wait for its review and resolve each finding before you ask me to merge. Request no other review bot.',
      'pr-agent': 'PR-Agent is the pull-request reviewer. Run it on each head and resolve each finding before you ask me to merge. Request no other review bot.',
      codex: 'Codex is the pull-request reviewer. Wait for its review and resolve each finding before you ask me to merge.',
    },
  },
  council: {
    choices: ['ask', 'agent', 'never'],
    brief: {
      ask: 'Run a council or a hill climb only when I ask for one, and confirm its members first.',
      never: 'Do not run a council or a hill climb.',
    },
  },
  browser: {
    choices: ['any', 'browserbase', 'local'],
    brief: {
      browserbase: 'Use Browserbase for all browser work. Local Chrome and computer use need my permission.',
      local: 'Use a local browser for browser work.',
    },
  },
  tracker: {
    choices: ['none', 'linear', 'github'],
    brief: {
      linear: 'Name the Linear issue in the pull request and in your hand-back.',
      github: 'Name the GitHub issue in the pull request and in your hand-back.',
    },
  },
};
export const MAX_NOTES = 4000;
const KEYS = Object.keys(RULES) as RuleKey[];
const isKey = (k: string): k is RuleKey => (KEYS as string[]).includes(k);

/** The built-in defaults: what a new setup starts with. */
export const DEFAULTS: Readonly<FullRuleSet> = Object.freeze({ ...Object.fromEntries(KEYS.map((k) => [k, RULES[k].choices[0]!])), notes: '' }) as FullRuleSet;

/** Keep only known rules with allowed values. `full` fills the gaps with the defaults (for "All projects"). */
function clean(set: unknown, full: true): FullRuleSet;
function clean(set: unknown, full: false): RuleSet;
function clean(set: unknown, full: boolean): RuleSet {
  const out: RuleSet = {};
  const src: Record<string, unknown> = set && typeof set === 'object' && !Array.isArray(set) ? set as Record<string, unknown> : {};
  for (const k of KEYS) {
    const v = src[k];
    if (typeof v === 'string' && RULES[k].choices.includes(v)) out[k] = v;
    else if (full) out[k] = DEFAULTS[k];
  }
  if (typeof src.notes === 'string') out.notes = src.notes.slice(0, MAX_NOTES);
  else if (full) out.notes = '';
  return out;
}

/** A whole rules file, checked: { all: every rule, projects: { id: only the rules that project overrides } }. */
export function normalize(raw: unknown): Rules {
  const r: { all?: unknown; projects?: unknown } = raw && typeof raw === 'object' ? raw : {};
  const projects: Record<string, RuleSet> = {};
  if (r.projects && typeof r.projects === 'object' && !Array.isArray(r.projects)) {
    for (const [id, set] of Object.entries(r.projects)) {
      if (!/^[\w:.-]{1,200}$/.test(id)) continue;
      const c = clean(set, false);
      if (Object.keys(c).length) projects[id] = c;
    }
  }
  return { all: clean(r.all, true), projects };
}

/** The rules for one project: its overrides on top of its areas' ("area:<id>", in the team's order, a later area over an
 *  earlier one), on top of "All projects". An area's overrides are kept under its key beside the projects'. */
export function forProject(rules: unknown, projectId?: string | null, areas: readonly string[] = []): FullRuleSet {
  const r = normalize(rules);
  return Object.assign({ ...r.all }, ...areas.map((a) => r.projects[a] || {}), projectId && r.projects[projectId] || {});
}

/** One change from Settings, applied to the current rules, so a stale page never puts back other rules
 *  (PR-Agent on #49). { scope: '' for All projects or a project id, key, value } or { scope, key, reset: true },
 *  which gives a project's rule back to All projects. Returns { rules } or { error }. */
export function change(rules: unknown, { scope = '', key, value, reset = false }: { scope?: string; key: string; value?: unknown; reset?: boolean }):
  { rules: Rules; error?: undefined } | { error: string; rules?: undefined } {
  const r = normalize(rules);
  if (scope && !/^[\w:.-]{1,200}$/.test(scope)) return { error: 'That project id is not valid.' };
  if (key !== 'notes' && !isKey(key)) return { error: 'There is no such rule.' };
  if (reset) {
    if (!scope) return { error: 'All projects has nothing to reset to.' };
    const p = r.projects[scope];
    if (p) { delete p[key]; if (!Object.keys(p).length) delete r.projects[scope]; }
    return { rules: r };
  }
  let v: string;
  if (key === 'notes') v = String(value ?? '').slice(0, MAX_NOTES);
  else if (typeof value === 'string' && RULES[key].choices.includes(value)) v = value;
  else return { error: 'That is not one of the choices.' };
  if (scope) r.projects[scope] = { ...(r.projects[scope] || {}), [key]: v }; else r.all[key] = v;
  return { rules: r };
}

/** The lines a brief carries for one project, or '' when no rule adds one. areas: the project's areas' keys. */
export function brief(rules: unknown, projectId?: string | null, areas: readonly string[] = []): string {
  const p = forProject(rules, projectId, areas);
  const lines = KEYS.flatMap((k) => RULES[k].brief[p[k]] || []);
  const notes = String(p.notes || '').trim();
  if (!lines.length && !notes) return '';
  return '\n\n---\nRules (Yes Chef):\n' + lines.map((l) => `- ${l}`).join('\n') + (notes ? `\n\n${notes}` : '');
}

// Words that say a decision is about something you can see. A call that names none is not flagged.
// Not "design": "design choices" in an architecture call flagged it (Dan, 2026-11-08).
const VISUAL = /\b(screens?|screenshots?|layouts?|pills?|buttons?|cards?|colou?rs?|icons?|logos?|images?|pages?|headers?|headlines?|hero|modal|dialog|banner|badges?|chips?|tiles?|font|typography|spacing|padding|margins?|dark mode|light mode|mobile|phone|desktop view|ui|ux|visual|mock-?ups?|pickers?|menus?|sidebar|panel|tooltip|copy on)\b/i;

/** True when a call is about something you can see: its questions or options name a visual thing. */
export function visualCall(call: CallLike | null | undefined): boolean {
  if (!call || !Array.isArray(call.calls)) return false;
  return call.calls.some((c) => VISUAL.test(String(c.question || '')) || !!c.options?.some((o) => VISUAL.test(String(o.text || ''))));
}

/** The Pass's check: a call about something you can see, with no screenshots, when this project flags that. */
export function missingShots(rules: unknown, projectId: string | null | undefined, call: CallLike | null | undefined, imageCount: number, areas: readonly string[] = []): boolean {
  const p = forProject(rules, projectId, areas);
  return p.screens === 'on' && p.missing === 'flag' && imageCount === 0 && visualCall(call);
}

/** The reply the Pass sends when you ask for the screenshots. */
export const ASK_SHOTS = 'Send this call again with a screenshot of each option, labelled with its letter. Mock up an option that is not built yet. Rule: a decision about anything I can see shows the options.';
