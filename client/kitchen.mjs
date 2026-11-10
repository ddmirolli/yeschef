// Rules (Dan, 2026-11-08; Kitchen rules until 2026-11-10): how your projects work, set in Settings -> Rules, like T3
// Code's settings. Yes Chef's stages and actions stay the same for everyone; these rules are each setup's own.
// The file keeps its name, kitchen-rules.json, so saved rules load as before. They reach agents
// two ways: the brief on every thread Yes Chef starts, and the checks the Pass runs on what comes back.
// Threads started elsewhere follow the agent's own instruction files (CLAUDE.md, AGENTS.md).

/** Each rule: its choices (the first is the built-in default) and the line it adds to a brief, per choice. */
export const RULES = {
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
const KEYS = Object.keys(RULES);

/** The built-in defaults: what a new setup starts with. */
export const DEFAULTS = Object.freeze({ ...Object.fromEntries(KEYS.map((k) => [k, RULES[k].choices[0]])), notes: '' });

/** Keep only known rules with allowed values. `full` fills the gaps with the defaults (for "All projects"). */
function clean(set, full) {
  const out = {};
  const src = set && typeof set === 'object' && !Array.isArray(set) ? set : {};
  for (const k of KEYS) {
    if (RULES[k].choices.includes(src[k])) out[k] = src[k];
    else if (full) out[k] = DEFAULTS[k];
  }
  if (typeof src.notes === 'string') out.notes = src.notes.slice(0, MAX_NOTES);
  else if (full) out.notes = '';
  return out;
}

/** A whole rules file, checked: { all: every rule, projects: { id: only the rules that project overrides } }. */
export function normalize(raw) {
  const r = raw && typeof raw === 'object' ? raw : {};
  const projects = {};
  if (r.projects && typeof r.projects === 'object' && !Array.isArray(r.projects)) {
    for (const [id, set] of Object.entries(r.projects)) {
      if (!/^[\w:.-]{1,200}$/.test(id)) continue;
      const c = clean(set, false);
      if (Object.keys(c).length) projects[id] = c;
    }
  }
  return { all: clean(r.all, true), projects };
}

/** The rules for one project: its overrides on top of "All projects". */
export function forProject(rules, projectId) {
  const r = normalize(rules);
  return { ...r.all, ...(projectId && r.projects[projectId] || {}) };
}

/** One change from Settings, applied to the current rules, so a stale page never puts back other rules
 *  (PR-Agent on #49). { scope: '' for All projects or a project id, key, value } or { scope, key, reset: true },
 *  which gives a project's rule back to All projects. Returns { rules } or { error }. */
export function change(rules, { scope = '', key, value, reset = false }) {
  const r = normalize(rules);
  if (scope && !/^[\w:.-]{1,200}$/.test(scope)) return { error: 'That project id is not valid.' };
  if (key !== 'notes' && !KEYS.includes(key)) return { error: 'There is no such rule.' };
  if (reset) {
    if (!scope) return { error: 'All projects has nothing to reset to.' };
    if (r.projects[scope]) { delete r.projects[scope][key]; if (!Object.keys(r.projects[scope]).length) delete r.projects[scope]; }
    return { rules: r };
  }
  const v = key === 'notes' ? String(value ?? '').slice(0, MAX_NOTES) : value;
  if (key !== 'notes' && !RULES[key].choices.includes(v)) return { error: 'That is not one of the choices.' };
  if (scope) r.projects[scope] = { ...(r.projects[scope] || {}), [key]: v }; else r.all[key] = v;
  return { rules: r };
}

/** The lines a brief carries for one project, or '' when no rule adds one. */
export function brief(rules, projectId) {
  const p = forProject(rules, projectId);
  const lines = KEYS.map((k) => RULES[k].brief[p[k]]).filter(Boolean);
  const notes = String(p.notes || '').trim();
  if (!lines.length && !notes) return '';
  return '\n\n---\nRules (Yes Chef):\n' + lines.map((l) => `- ${l}`).join('\n') + (notes ? `\n\n${notes}` : '');
}

// Words that say a decision is about something you can see. A call that names none is not flagged.
// Not "design": "design choices" in an architecture call flagged it (Dan, 2026-11-08).
const VISUAL = /\b(screens?|screenshots?|layouts?|pills?|buttons?|cards?|colou?rs?|icons?|logos?|images?|pages?|headers?|headlines?|hero|modal|dialog|banner|badges?|chips?|tiles?|font|typography|spacing|padding|margins?|dark mode|light mode|mobile|phone|desktop view|ui|ux|visual|mock-?ups?|pickers?|menus?|sidebar|panel|tooltip|copy on)\b/i;

/** True when a call is about something you can see: its questions or options name a visual thing. */
export function visualCall(call) {
  if (!call || !Array.isArray(call.calls)) return false;
  return call.calls.some((c) => VISUAL.test(String(c.question || '')) || (c.options || []).some((o) => VISUAL.test(String(o.text || ''))));
}

/** The Pass's check: a call about something you can see, with no screenshots, when this project flags that. */
export function missingShots(rules, projectId, call, imageCount) {
  const p = forProject(rules, projectId);
  return p.screens === 'on' && p.missing === 'flag' && imageCount === 0 && visualCall(call);
}

/** The reply the Pass sends when you ask for the screenshots. */
export const ASK_SHOTS = 'Send this call again with a screenshot of each option, labelled with its letter. Mock up an option that is not built yet. Rule: a decision about anything I can see shows the options.';
