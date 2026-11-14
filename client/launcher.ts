// New thread (Cmd+T or Cmd+N), built from T3 Code's own new-thread composer (Dan, 2026-11-14: "largely be derived
// from reusing as much as possible the code and UI from T3 code, so that this feels familiar"). The parts it copies:
//   - the composer box: the prompt, then a controls bar with the model picker's trigger and a round send button;
//   - the model picker: a rail of providers, their models, and an Effort column (ProviderModelPicker, ModelPickerSidebar,
//     ComposerEffortColumn), with T3's effort glyph (EffortGlyph.tsx) on the trigger;
//   - the context strip under the box (BranchToolbar): the workspace, New worktree or Current checkout, and the
//     permissions at its trailing end (ComposerContextPermissions), with T3's labels, descriptions and icons
//     (runtimeModeConfig.ts).
// T3 Code is MIT licensed, Copyright (c) 2026 T3 Tools Inc. The provider marks below are its ClaudeAI and OpenAI icons
// (apps/web/src/components/Icons.tsx); the other icons are Lucide's (ISC), as T3 uses them.
//
// The models come from T3 Code's orchestrator_capabilities, read when the dialog opens (GET /caps). Nothing picked
// sends nothing: T3 then starts the thread on the project's own default model and permissions, as its composer does,
// so the launcher says "Project default" and never guesses what that is. A list it could not read says "not checked".
//
// Three parts. capsFrom() and launchSettings() run on the server. launcherCore() is pure and tested. installLauncher()
// runs in the page: server.ts inlines launcherCore and installLauncher by their source text, so neither may use
// anything outside itself. Both are ES5 once Node strips their types, like the page script.

/** T3's runtime modes, least to most access (runtimeModeConfig.ts). */
export const RUNTIME_MODES = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'] as const;
export type RuntimeMode = typeof RUNTIME_MODES[number];
/** The option ids T3 gives a model's effort: Claude's and Codex's. */
const EFFORT_IDS = ['effort', 'reasoningEffort'] as const;

export interface CapModel { id: string; label: string; effort: { id: string; values: string[]; def: string | null } | null }
export interface CapProvider { id: string; driver: string; name: string; models: CapModel[]; modes: RuntimeMode[] | null }
/** What the page gets from GET /caps: the providers it can launch on and the most access Yes Chef was approved for. */
export type Caps = { ok: true; providers: CapProvider[]; ceiling: RuntimeMode | null } | { ok: false; why: string };

const str = (v: unknown): string => (typeof v === 'string' ? v : '');
const isMode = (v: unknown): v is RuntimeMode => (RUNTIME_MODES as readonly unknown[]).includes(v);
// A model id as T3 names it when its catalog gives no label: "gpt-6.1-sol" reads "GPT-6.1 Sol".
const named = (id: string): string => {
  const g = /^gpt-([\d.]+)-([a-z]+)$/.exec(id);
  if (g) return `GPT-${g[1]} ${g[2]!.charAt(0).toUpperCase()}${g[2]!.slice(1)}`;
  return id.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
};

/** orchestrator_capabilities as the launcher uses it. A disabled provider, or one with no models, is left out, as T3's
 *  picker greys them out of a new thread. */
export function capsFrom(raw: unknown): Caps {
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
  if (!Array.isArray(r.providers)) return { ok: false, why: 'T3 Code did not list its models.' };
  const providers: CapProvider[] = [];
  for (const p of r.providers as Record<string, unknown>[]) {
    if (!p || typeof p !== 'object') continue;
    const id = str(p.providerInstanceId);
    const constraints = Array.isArray(p.constraints) ? p.constraints.map(str) : [];
    if (!id || constraints.some((c) => /disabled/i.test(c))) continue;
    const models: CapModel[] = [];
    for (const m of (Array.isArray(p.models) ? p.models : []) as Record<string, unknown>[]) {
      const mid = str(m?.id);
      if (!mid) continue;
      const opts = (Array.isArray(m.options) ? m.options : []) as Record<string, unknown>[];
      const o = opts.find((x) => (EFFORT_IDS as readonly string[]).includes(str(x?.id)));
      const values = o && Array.isArray(o.values) ? o.values.filter((v): v is string => typeof v === 'string' && /^[a-z]{1,16}$/.test(v)) : [];
      models.push({ id: mid, label: str(m.label) || named(mid), effort: o && values.length ? { id: str(o.id), values, def: values.includes(str(o.default)) ? str(o.default) : null } : null });
    }
    if (!models.length) continue;
    const modes = Array.isArray(p.runtimeModes) ? p.runtimeModes.filter(isMode) : null;
    providers.push({ id, driver: str(p.driverKind), name: str(p.displayName) || id, models, modes: modes && modes.length ? modes : null });
  }
  return { ok: true, providers, ceiling: isMode(r.runtimeMode) ? r.runtimeMode : null };
}

/** What a launch form adds to t3_thread_launch: the model, its effort and the permissions, each only when picked. */
export interface LaunchSettings { modelSelection?: { instanceId: string; model: string; options?: { id: string; value: string }[] }; runtimeMode?: RuntimeMode }
export function launchSettings(input: Record<string, unknown>): LaunchSettings | { error: string } {
  const instance = str(input.instance), model = str(input.model), effortId = str(input.effortId), effort = str(input.effort), runtime = str(input.runtime);
  const out: LaunchSettings = {};
  if (instance || model) {
    if (!/^[\w.-]{1,64}$/.test(instance) || !/^[\w.:/-]{1,128}$/.test(model)) return { error: 'That model is not one T3 Code lists. Pick it again.' };
    out.modelSelection = { instanceId: instance, model };
    if (effortId || effort) {
      if (!(EFFORT_IDS as readonly string[]).includes(effortId) || !/^[a-z]{1,16}$/.test(effort)) return { error: 'That effort is not one T3 Code lists. Pick it again.' };
      out.modelSelection.options = [{ id: effortId, value: effort }];
    }
  }
  if (runtime) {
    if (!isMode(runtime)) return { error: 'Those permissions are not one of T3 Code’s. Pick them again.' };
    out.runtimeMode = runtime;
  }
  return out;
}

/** The parts of the page script the launcher uses. */
export interface LauncherApp {
  $<T extends Element = HTMLElement>(sel: string, root?: ParentNode | null): T | null;
  $$<T extends Element = HTMLElement>(sel: string, root?: ParentNode | null): T[];
  store(k: string, v?: string): string | null | undefined;
}
export type LauncherCore = ReturnType<typeof launcherCore>;
export interface LauncherApi {
  /** The dialog opened: show the picks, then read T3's models again. */
  open(): void;
  /** The form's picks changed from outside (a draft put back): show them. */
  sync(): void;
  /** Whether a picker or menu is open, so Esc closes it before the dialog. */
  popped(): boolean;
}

/** The pure part: T3's labels, icons and effort glyph, and the rules for what a pick may be. */
export function launcherCore() {
  // T3's effort words (ComposerModelEffort) and the levels it names instead of drawing (EffortGlyph.tsx: NAMED_LEVELS,
  // the prompt-injected ultrathink, and OFF_LEVELS).
  var WORDS: Record<string, string> = { low: 'Low', medium: 'Medium', high: 'High', xhigh: 'Extra high', max: 'Max', ultrathink: 'Ultrathink', ultra: 'Ultra', auto: 'Auto', off: 'Off', none: 'Off' };
  var NAMED = ['ultracode', 'max', 'ultrathink', 'ultra', 'auto', 'off', 'none'];
  var MAX_BARS = 7;
  var ORDER = ['approval-required', 'auto-accept-edits', 'auto', 'full-access'];
  // runtimeModeConfig.ts: the label, the line under it, and its Lucide icon.
  var MODES: Record<string, { label: string; d: string; icon: string }> = {
    'approval-required': { label: 'Supervised', d: 'Ask before commands and file changes.', icon: '<rect width="18" height="11" x="3" y="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>' },
    'auto-accept-edits': { label: 'Auto-accept edits', d: 'Auto-approve edits, ask before other actions.', icon: '<path d="M13 21h8"/><path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/>' },
    'auto': { label: 'Auto', d: 'Supported providers approve routine actions; others still ask.', icon: '<path d="M20 13c0 5-3.5 7.5-7.66 8.95a1 1 0 0 1-.67-.01C7.5 20.5 4 18 4 13V6a1 1 0 0 1 1-1c2 0 4.5-1.2 6.24-2.72a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1z"/><path d="m9 12 2 2 4-4"/>' },
    'full-access': { label: 'Full access', d: 'Allow commands and edits without prompts.', icon: '<path d="m2 2 20 20"/><path d="M5 5a1 1 0 0 0-1 1v7c0 5 3.5 7.5 7.67 8.94a1 1 0 0 0 .67.01c2.35-.82 4.48-1.97 5.9-3.71"/><path d="M9.309 3.652A12.252 12.252 0 0 0 11.24 2.28a1.17 1.17 0 0 1 1.52 0C14.51 3.81 17 5 19 5a1 1 0 0 1 1 1v7a9.784 9.784 0 0 1-.08 1.264"/>' }
  };
  var LUCIDE = {
    folderGit: '<path d="M18 19a5 5 0 0 1-5-5v8"/><path d="M9 20H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.81 1.2a2 2 0 0 0 1.67.9H20a2 2 0 0 1 2 2v5"/><circle cx="13" cy="12" r="2"/><circle cx="20" cy="19" r="2"/>',
    folder: '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    chevron: '<path d="m6 9 6 6 6-6"/>',
    project: '<path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>'
  };
  function icon(paths: string, cls?: string): string { return '<svg class="' + (cls || 'lx-i') + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + paths + '</svg>'; }
  // T3's provider marks (Icons.tsx): Claude's in its own colour, OpenAI's in the text colour; others by initial.
  var CLAUDE = 'm50.228 170.321 50.357-28.257.843-2.463-.843-1.361h-2.462l-8.426-.518-28.775-.778-24.952-1.037-24.175-1.296-6.092-1.297L0 125.796l.583-3.759 5.12-3.434 7.324.648 16.202 1.101 24.304 1.685 17.629 1.037 26.118 2.722h4.148l.583-1.685-1.426-1.037-1.101-1.037-25.147-17.045-27.22-18.017-14.258-10.37-7.713-5.25-3.888-4.925-1.685-10.758 7-7.713 9.397.649 2.398.648 9.527 7.323 20.35 15.75L94.817 91.9l3.889 3.24 1.555-1.102.195-.777-1.75-2.917-14.453-26.118-15.425-26.572-6.87-11.018-1.814-6.61c-.648-2.723-1.102-4.991-1.102-7.778l7.972-10.823L71.42 0 82.05 1.426l4.472 3.888 6.61 15.101 10.694 23.786 16.591 32.34 4.861 9.592 2.592 8.879.973 2.722h1.685v-1.556l1.36-18.211 2.528-22.36 2.463-28.776.843-8.1 4.018-9.722 7.971-5.25 6.222 2.981 5.12 7.324-.713 4.73-3.046 19.768-5.962 30.98-3.889 20.739h2.268l2.593-2.593 10.499-13.934 17.628-22.036 7.778-8.749 9.073-9.657 5.833-4.601h11.018l8.1 12.055-3.628 12.443-11.342 14.388-9.398 12.184-13.48 18.147-8.426 14.518.778 1.166 2.01-.194 30.46-6.481 16.462-2.982 19.637-3.37 8.88 4.148.971 4.213-3.5 8.62-20.998 5.184-24.628 4.926-36.682 8.685-.454.324.519.648 16.526 1.555 7.065.389h17.304l32.21 2.398 8.426 5.574 5.055 6.805-.843 5.184-12.962 6.611-17.498-4.148-40.83-9.721-14-3.5h-1.944v1.167l11.666 11.406 21.387 19.314 26.767 24.887 1.36 6.157-3.434 4.86-3.63-.518-23.526-17.693-9.073-7.972-20.545-17.304h-1.36v1.814l4.73 6.935 25.017 37.59 1.296 11.536-1.814 3.76-6.481 2.268-7.13-1.297-14.647-20.544-15.1-23.138-12.185-20.739-1.49.843-7.194 77.448-3.37 3.953-7.778 2.981-6.48-4.925-3.436-7.972 3.435-15.749 4.148-20.544 3.37-16.333 3.046-20.285 1.815-6.74-.13-.454-1.49.194-15.295 20.999-23.267 31.433-18.406 19.702-4.407 1.75-7.648-3.954.713-7.064 4.277-6.286 25.47-32.405 15.36-20.092 9.917-11.6-.065-1.686h-.583L44.07 198.125l-12.055 1.555-5.185-4.86.648-7.972 2.463-2.593 20.35-13.999-.064.065Z';
  var OPENAI = 'M252.794 108.802C289.191 99.0484 326.265 110.305 351.148 135.135C385.113 126.072 422.85 134.862 449.492 161.505C476.136 188.149 484.925 225.888 475.862 259.85V259.854C500.696 284.735 511.95 321.81 502.198 358.207C492.447 394.602 464.161 421.084 430.215 430.217C421.083 464.162 394.603 492.448 358.206 502.199C321.812 511.951 284.734 500.693 259.852 475.864C225.887 484.927 188.15 476.137 161.507 449.495C134.864 422.851 126.073 385.111 135.136 351.149C110.304 326.266 99.0496 289.192 108.801 252.795C118.552 216.4 146.84 189.918 180.784 180.785C189.917 146.841 216.396 118.553 252.794 108.802ZM374.292 407.145C374.292 411.271 372.092 415.086 368.517 417.148L283.723 466.102C302.487 480.585 327.555 486.459 352.217 479.852C386.997 470.532 410.068 439.312 410.555 405.006V317.717C410.555 315.08 409.125 312.621 406.843 311.303L374.292 292.509V407.145ZM251.868 415.897C248.296 417.959 243.893 417.959 240.317 415.897L155.526 366.942C152.366 390.436 159.811 415.08 177.866 433.136H177.863C203.325 458.594 241.896 462.962 271.85 446.232L347.449 402.586C349.735 401.268 351.148 398.8 351.148 396.163V358.579L251.868 415.897ZM368.602 220.628C366.319 219.309 363.474 219.318 361.191 220.637L328.641 239.431L427.921 296.749C431.496 298.811 433.697 302.627 433.697 306.752V404.661C455.622 395.654 473.244 376.881 479.851 352.218C489.169 317.442 473.668 281.85 444.201 264.274L368.602 220.628ZM177.303 206.34C155.377 215.348 137.756 234.122 131.148 258.783C121.832 293.561 137.331 329.153 166.799 346.727L242.398 390.373C244.68 391.692 247.525 391.684 249.807 390.366L282.357 371.572L183.078 314.253C179.504 312.189 177.303 308.375 177.303 304.251V206.34ZM259.849 279.145V331.858L305.5 358.213L351.15 331.858V279.145L305.5 252.789L259.849 279.145ZM327.276 144.9C308.512 130.418 283.445 124.543 258.782 131.15C224.002 140.471 200.931 171.691 200.445 205.995V293.286C200.445 295.923 201.875 298.381 204.158 299.7L236.707 318.493V203.856C236.707 199.731 238.909 195.916 242.483 193.853L327.276 144.9ZM433.137 177.867C407.675 152.407 369.103 148.038 339.149 164.769L263.55 208.415C261.265 209.734 259.852 212.202 259.852 214.838V252.423L359.132 195.105C362.703 193.041 367.108 193.041 370.682 195.105L455.473 244.06C458.635 220.567 451.189 195.922 433.135 177.867H433.137Z';
  function mark(driver: string, name: string): string {
    if (driver === 'claudeAgent') return '<svg class="lx-pv" viewBox="0 0 256 257" aria-hidden="true"><path fill="#d97757" d="' + CLAUDE + '"/></svg>';
    if (driver === 'codex') return '<svg class="lx-pv" viewBox="100 100 411 411" aria-hidden="true"><path fill="currentColor" fill-rule="evenodd" clip-rule="evenodd" d="' + OPENAI + '"/></svg>';
    return '<span class="lx-pv lx-pv-t" aria-hidden="true">' + esc((name || '?').charAt(0).toUpperCase()) + '</span>';
  }
  function esc(s: string): string { return String(s).replace(/[&<>"']/g, function(c){ return '&#' + c.charCodeAt(0) + ';'; }); }
  function word(v: string): string { return WORDS[v] || (v ? v.charAt(0).toUpperCase() + v.slice(1) : ''); }
  // EffortGlyph.tsx: the drawn levels are the values that are not named; the bars rise to maxBar in even steps.
  function glyph(values: string[], v: string): { count: number; filled: number } | null {
    if (!v || NAMED.indexOf(v) >= 0) return null;
    var lv = values.filter(function(x){ return NAMED.indexOf(x) < 0; });
    var at = lv.indexOf(v); if (at < 0 || lv.length < 2) return null;
    var count = Math.min(lv.length, MAX_BARS);
    return { count: count, filled: Math.min(at + 1, count) };
  }
  function heights(count: number, maxBar: number): number[] {
    var step = Math.max(1, Math.round(maxBar / 2 / Math.max(count - 1, 1))), out: number[] = [];
    for (var i = 0; i < count; i++) out.push(Math.max(2, maxBar - (count - 1 - i) * step));
    return out;
  }
  function glyphSvg(g: { count: number; filled: number }): string {
    var hs = heights(g.count, 10), w = g.count * 4 - 2, out = '';
    for (var i = 0; i < hs.length; i++) out += '<rect x="' + (i * 4) + '" y="' + (12 - hs[i]!) + '" width="2" height="' + hs[i] + '" rx="1"' + (i < g.filled ? '' : ' opacity=".4"') + '/>';
    return '<svg class="lx-g" viewBox="0 0 ' + w + ' 14" width="' + w + '" height="14" fill="currentColor" aria-hidden="true">' + out + '</svg>';
  }
  // The trigger's name for a model: T3 drops the brand the provider mark already shows ("Claude Opus 5.5" reads "Opus 5.5").
  function short(label: string): string { return label.replace(/^Claude\s+/, ''); }
  /** The modes a launch may ask for: no more than Yes Chef was approved for, and only those the provider runs. An
   *  approval not read yet allows none: only the project default (PR-Agent r1 on #79). */
  function modesFor(ceiling: string | null, provider: { modes: string[] | null } | null): string[] {
    var top = ceiling ? ORDER.indexOf(ceiling) : -1;
    return ORDER.filter(function(m, i){ return i <= top && (!provider || !provider.modes || provider.modes.indexOf(m) >= 0); });
  }
  return { WORDS: WORDS, MODES: MODES, LUCIDE: LUCIDE, ORDER: ORDER, icon: icon, mark: mark, esc: esc, word: word, glyph: glyph, heights: heights, glyphSvg: glyphSvg, short: short, modesFor: modesFor };
}

/** The dialog. Its fields keep the names the page and the server already read (nonce, project, prompt, title,
 *  workspace), plus the picks: instance, model, effortId, effort and runtime. Empty means T3's project default. */
export function launchDialog(): string {
  const c = launcherCore();
  const chev = c.icon(c.LUCIDE.chevron, 'lx-chev');
  return `<dialog id="launch" aria-labelledby="launch-t"><form class="act launch" method="post" action="/act">
<input type="hidden" name="nonce" value=""><input type="hidden" name="title" value="">
<input type="hidden" name="instance" value=""><input type="hidden" name="model" value=""><input type="hidden" name="effortId" value=""><input type="hidden" name="effort" value=""><input type="hidden" name="runtime" value="">
<h2 id="launch-t">New thread</h2>
<div class="lx-box">
<textarea name="prompt" rows="4" maxlength="60000" placeholder="Ask anything" aria-label="What should the agent do?"></textarea>
<div class="lx-bar">
<button type="button" class="lx-ctl lx-mt" data-lx-open="pick" aria-haspopup="true" aria-expanded="false"><span class="lx-mk"></span><span class="lx-ml">Project default</span><span class="lx-ef"></span>${chev}</button>
<span class="lx-sp"></span>
<button type="submit" name="kind" value="launch" class="primary lx-send" data-what="the new thread" data-tip="Launch ⌘↵" aria-label="Launch"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m5 12 7-7 7 7"/><path d="M12 19V5"/></svg><span class="bl"></span></button>
</div>
<div class="lx-pop lx-pick" data-lx-pop="pick" role="dialog" aria-label="Model and effort" hidden><div class="lx-rail" role="tablist" aria-label="Providers" aria-orientation="vertical"></div><div class="lx-col lx-models" role="listbox" aria-label="Models"></div><div class="lx-col lx-effs" role="listbox" aria-label="Effort"></div></div>
</div>
<div class="lx-strip">
<label class="lx-ctl lx-proj">${c.icon(c.LUCIDE.project)}<select name="project" required aria-label="Project"></select>${chev}</label>
<span class="lx-anchor"><button type="button" class="lx-ctl" data-lx-open="ws" aria-haspopup="menu" aria-expanded="false"><span class="lx-wsi">${c.icon(c.LUCIDE.folderGit)}</span><span class="lx-wsl">New worktree</span>${chev}</button>
<div class="lx-pop lx-menu" data-lx-pop="ws" role="menu" aria-label="Workspace" hidden>
<p class="lx-mh">Workspace</p>
<label class="lx-row" role="menuitemradio"><input type="radio" name="workspace" value="root">${c.icon(c.LUCIDE.folder)}<span>Current checkout</span>${c.icon(c.LUCIDE.check, 'lx-ck')}</label>
<label class="lx-row" role="menuitemradio"><input type="radio" name="workspace" value="worktree" checked>${c.icon(c.LUCIDE.folderGit)}<span>New worktree</span>${c.icon(c.LUCIDE.check, 'lx-ck')}</label>
</div></span>
<span class="lx-sp"></span>
<span class="lx-anchor"><button type="button" class="lx-ctl" data-lx-open="perm" aria-haspopup="menu" aria-expanded="false"><span class="lx-pmi"></span><span class="lx-pml">Project default</span>${chev}</button>
<div class="lx-pop lx-menu lx-end" data-lx-pop="perm" role="menu" aria-label="Permissions" hidden></div></span>
</div>
<p class="result" role="status"></p>
</form></dialog>`;
}

export const LAUNCH_CSS = `
/* New thread, after T3 Code's new-thread composer (client/launcher.ts). */
#launch{width:min(640px,calc(100vw - 32px));padding:16px 16px 12px;border:0;border-radius:18px;background:var(--card);color:var(--label);box-shadow:var(--sh4);overflow:visible}
#launch::backdrop{background:rgba(0,0,0,.36);-webkit-backdrop-filter:blur(4px);backdrop-filter:blur(4px)}
#launch h2{margin:0 0 10px 4px;font-size:15px;font-weight:600}
#launch form{display:flex;flex-direction:column;gap:0;margin:0}
.lx-box{position:relative;border-radius:14px;background:var(--inset);box-shadow:inset 0 0 0 .5px var(--sep)}
.lx-box:focus-within{box-shadow:inset 0 0 0 .5px var(--sep),0 0 0 3px color-mix(in srgb,var(--focus) 28%,transparent)}
.lx-box textarea{display:block;width:100%;min-height:104px;max-height:46vh;padding:14px 14px 4px;border:0;background:none;color:var(--label);font:15px/1.45 var(--sans);resize:none;outline:none}
.lx-box textarea::placeholder{color:var(--label2)}
.lx-bar,.lx-strip{display:flex;align-items:center;gap:2px}
.lx-bar{padding:4px 8px 8px}
.lx-strip{margin:6px 0 0;padding:0 2px}
.lx-sp{flex:1}
.lx-anchor{position:relative;display:inline-flex}
.lx-ctl{display:inline-flex;align-items:center;gap:6px;height:28px;min-width:0;padding:0 8px;border:0;border-radius:8px;background:none;color:var(--label2);font:500 13px var(--sans);white-space:nowrap;cursor:pointer}
.lx-strip .lx-ctl{font-size:12px;height:26px;gap:5px}
.lx-ctl:hover,.lx-ctl[aria-expanded=true],.lx-proj:focus-within{background:var(--fill);color:var(--label)}
.lx-ctl:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}
.lx-i{width:14px;height:14px;flex:none}
.lx-strip .lx-i{width:12px;height:12px}
.lx-chev{width:12px;height:12px;flex:none;opacity:.7}
.lx-proj{position:relative}
.lx-proj select{appearance:none;-webkit-appearance:none;max-width:220px;padding:0;border:0;background:none;color:inherit;font:inherit;cursor:pointer;outline:none;text-overflow:ellipsis}
.lx-mt .lx-ml{max-width:180px;overflow:hidden;text-overflow:ellipsis}
.lx-pv{width:16px;height:16px;flex:none}
.lx-pv-t{display:inline-grid;place-items:center;border-radius:4px;background:var(--fill2);color:var(--label);font:700 10px/1 var(--sans)}
.lx-mk:empty,.lx-ef:empty{display:none}
.lx-ef{display:inline-flex;align-items:center;gap:4px;margin-left:-1px}
.lx-g{display:block}
.lx-send{display:grid;place-items:center;width:30px;height:30px;padding:0;border:0;border-radius:50%;background:var(--accent);color:#fff;cursor:pointer}
.lx-send svg{width:16px;height:16px}
.lx-send:disabled{opacity:.4;cursor:default}
.lx-send .bl:empty{display:none}
.lx-send:has(.bl:not(:empty)){display:inline-flex;gap:6px;width:auto;padding:0 12px 0 10px;border-radius:15px;font:600 13px var(--sans)}
.lx-pop{position:fixed;z-index:6;border-radius:12px;background:var(--card2);box-shadow:0 0 0 .5px var(--sep),0 18px 50px rgba(0,0,0,.35);overflow:hidden}
.lx-pop[hidden]{display:none}
.lx-pick{display:grid;grid-template-columns:44px minmax(0,1fr) 150px;width:min(500px,calc(100vw - 32px));height:300px}
.lx-rail{display:flex;flex-direction:column;gap:4px;padding:4px;background:var(--fill)}
.lx-rail button{position:relative;display:grid;place-items:center;height:36px;border:0;border-radius:8px;background:none;color:var(--label);cursor:pointer}
.lx-rail button:hover{background:var(--fill)}
.lx-rail button[aria-selected=true]{background:var(--fill2)}
.lx-rail button[aria-selected=true]::after{content:"";position:absolute;right:-4px;top:8px;width:3px;height:20px;border-radius:2px;background:var(--accent)}
.lx-rail .lx-pv{width:20px;height:20px}
.lx-col{display:flex;flex-direction:column;gap:2px;min-height:0;padding:6px;overflow:auto;overscroll-behavior:contain}
.lx-models{border-right:.5px solid var(--sep)}
.lx-mh{margin:0;padding:4px 8px 6px;font-size:12px;font-weight:600;color:var(--label2)}
.lx-row{display:flex;align-items:center;gap:8px;width:100%;min-height:32px;padding:0 8px;border:0;border-radius:6px;background:none;color:var(--label);font:400 13px var(--sans);text-align:left;cursor:pointer}
.lx-row:hover,.lx-row:focus-visible,.lx-row:has(input:focus-visible){background:var(--fill);outline:none}
.lx-row>span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.lx-row small{color:var(--label2);font-size:11px}
.lx-row input{position:absolute;opacity:0;pointer-events:none}
.lx-ck{width:14px;height:14px;flex:none;visibility:hidden;color:var(--label)}
.lx-row[aria-checked=true] .lx-ck,.lx-row:has(input:checked) .lx-ck{visibility:visible}
.lx-row .lx-i{color:var(--label2)}
.lx-menu{width:250px;padding:4px;overflow:auto}
.lx-menu.lx-end{width:300px}
.lx-menu .lx-row{min-height:0;padding:6px 8px;align-items:flex-start}
.lx-menu .lx-row .lx-i,.lx-menu .lx-row .lx-ck{margin-top:2px}
.lx-two{display:flex;flex-direction:column;gap:1px;flex:1;min-width:0}
.lx-two b{font-weight:500}
.lx-two small{white-space:normal}
.lx-none{padding:8px;color:var(--label2);font-size:12px}
#launch .result{margin:8px 4px 0;font-size:13px}
#launch .result:empty{display:none}
@media (prefers-reduced-motion:no-preference){.lx-pop:not([hidden]){animation:lx-in .14s ease-out}}
@keyframes lx-in{from{opacity:0;transform:translateY(4px)}}
@media (max-width:520px){.lx-pick{grid-template-columns:44px minmax(0,1fr) 116px}.lx-strip .lx-wsl,.lx-strip .lx-pml{display:none}}
`;

/** The launcher in the page. */
export function installLauncher(app: LauncherApp, core: LauncherCore): LauncherApi | null {
  var $ = app.$, $$ = app.$$;
  var dlg = document.getElementById('launch') as HTMLDialogElement | null; if (!dlg) return null;
  var form = $<HTMLFormElement>('form.launch', dlg)!;
  var F = function(n: string): HTMLInputElement { return form.elements.namedItem(n) as HTMLInputElement; };
  var trigger = $<HTMLButtonElement>('.lx-mt', dlg)!, pick = $<HTMLElement>('.lx-pick', dlg)!, rail = $<HTMLElement>('.lx-rail', dlg)!, models = $<HTMLElement>('.lx-models', dlg)!, effs = $<HTMLElement>('.lx-effs', dlg)!;
  var permPop = $<HTMLElement>('[data-lx-pop=perm]', dlg)!;
  type Provider = { id: string; driver: string; name: string; models: { id: string; label: string; effort: { id: string; values: string[]; def: string | null } | null }[]; modes: string[] | null };
  var caps: { ok: boolean; providers?: Provider[]; ceiling?: string | null; why?: string } | null = null;
  var shownProvider = '';
  // The last model you picked stays picked for the next thread, as T3's composer keeps its model.
  var KEY = 'yc.launchPick';

  function provider(id: string): Provider | null { var ps = caps && caps.providers || []; for (var i = 0; i < ps.length; i++) if (ps[i]!.id === id) return ps[i]!; return null; }
  function modelOf(p: Provider | null, id: string) { if (!p) return null; for (var i = 0; i < p.models.length; i++) if (p.models[i]!.id === id) return p.models[i]!; return null; }
  function setPick(inst: string, model: string, effort: string, remember?: boolean): void {
    var p = provider(inst), m = modelOf(p, model);
    F('instance').value = m ? inst : ''; F('model').value = m ? model : '';
    var e = m && m.effort && m.effort.values.indexOf(effort) >= 0 ? effort : m && m.effort ? (m.effort.def || '') : '';
    F('effortId').value = e && m && m.effort ? m.effort.id : ''; F('effort').value = e;
    // Permissions a new provider does not run go back to the project default.
    var r = F('runtime').value; if (r && core.modesFor(caps && caps.ceiling || null, p).indexOf(r) < 0) F('runtime').value = '';
    if (remember && m) app.store(KEY, JSON.stringify({ inst: inst, model: model, effort: e }));
    form.dispatchEvent(new Event('input', { bubbles: true }));
    draw();
  }
  function draw(): void {
    var p = provider(F('instance').value), m = modelOf(p, F('model').value);
    $('.lx-mk', trigger)!.innerHTML = p ? core.mark(p.driver, p.name) : '';
    // A pick from a list T3 has not given yet keeps its id, so a draft put back still says what it will send.
    var label = m ? core.short(m.label) : F('model').value ? F('model').value : 'Project default';
    $('.lx-ml', trigger)!.textContent = label;
    var ef = $('.lx-ef', trigger)!, v = F('effort').value, g = m && m.effort && v ? core.glyph(m.effort.values, v) : null;
    ef.innerHTML = g ? core.glyphSvg(g) : v ? '<span>' + core.esc(core.word(v)) + '</span>' : '';
    trigger.setAttribute('aria-label', 'Model: ' + label + (v ? ', effort ' + core.word(v) : ''));
    // The workspace and the permissions name what they will send.
    var ws = $<HTMLInputElement>('input[name=workspace]:checked', form), root = !!ws && ws.value === 'root';
    $('.lx-wsl', dlg)!.textContent = root ? 'Current checkout' : 'New worktree';
    $('.lx-wsi', dlg)!.innerHTML = core.icon(root ? core.LUCIDE.folder : core.LUCIDE.folderGit);
    var r = F('runtime').value, md = core.MODES[r];
    $('.lx-pml', dlg)!.textContent = md ? md.label : 'Project default';
    $('.lx-pmi', dlg)!.innerHTML = md ? core.icon(md.icon) : '';
    $('[data-lx-open=perm]', dlg)!.setAttribute('aria-label', 'Permissions: ' + (md ? md.label : 'Project default'));
    if (!pick.hidden) drawPick();
    if (!permPop.hidden) drawPerm();
  }
  function row(attrs: string, body: string, on: boolean): string {
    return '<button type="button" class="lx-row" role="option" aria-selected="' + on + '" aria-checked="' + on + '" ' + attrs + '>' + body + core.icon(core.LUCIDE.check, 'lx-ck') + '</button>';
  }
  function drawPick(): void {
    if (!caps) { rail.innerHTML = ''; models.innerHTML = '<p class="lx-none">Reading T3 Code’s models…</p>'; effs.innerHTML = ''; return; }
    if (!caps.ok || !caps.providers || !caps.providers.length) {
      rail.innerHTML = ''; effs.innerHTML = '';
      models.innerHTML = '<p class="lx-none">Models: not checked. ' + core.esc(caps.why || 'T3 Code listed none.') + ' The thread starts on the project’s default model.</p>';
      return;
    }
    var ps = caps.providers, cur = F('instance').value;
    if (!provider(shownProvider)) shownProvider = provider(cur) ? cur : ps[0]!.id;
    rail.innerHTML = ps.map(function(p){ return '<button type="button" role="tab" data-lx-prov="' + core.esc(p.id) + '" aria-selected="' + (p.id === shownProvider) + '" title="' + core.esc(p.name) + '" aria-label="' + core.esc(p.name) + '">' + core.mark(p.driver, p.name) + '</button>'; }).join('');
    var p = provider(shownProvider)!;
    // Project default first, so a pick can always go back to T3's own choice for the project (PR-Agent r1 on #79).
    models.innerHTML = row('data-lx-model=""', '<span>Project default</span>', !F('model').value) + '<p class="lx-mh">' + core.esc(p.name) + '</p>' + p.models.map(function(m){
      return row('data-lx-model="' + core.esc(m.id) + '"', '<span>' + core.esc(m.label) + '</span>', cur === p.id && F('model').value === m.id);
    }).join('');
    var m = modelOf(provider(cur), F('model').value);
    var e = m && m.effort;
    effs.innerHTML = '<p class="lx-mh">Effort</p>' + (e ? e.values.map(function(v){
      return row('data-lx-eff="' + core.esc(v) + '"', '<span>' + core.esc(core.word(v)) + '</span>' + (v === e!.def ? '<small>Default</small>' : ''), F('effort').value === v);
    }).join('') : '<p class="lx-none">' + (m ? 'No effort levels' : 'Pick a model') + '</p>');
  }
  function drawPerm(): void {
    var modes = core.modesFor(caps && caps.ok ? caps.ceiling || null : null, provider(F('instance').value)), r = F('runtime').value;
    var why = !caps ? 'Reading the level Yes Chef was approved for…' : !caps.ok || !caps.ceiling ? 'Others: not checked. T3 Code did not say the level Yes Chef was approved for.' : '';
    permPop.innerHTML = '<p class="lx-mh">Permissions</p>' + row('data-lx-mode="" role="menuitemradio"', '<span class="lx-two"><b>Project default</b><small>What T3 Code starts this project with.</small></span>', !r) +
      (why ? '<p class="lx-none">' + why + '</p>' : '') + modes.map(function(k){ var md = core.MODES[k]!; return row('data-lx-mode="' + k + '" role="menuitemradio"', core.icon(md.icon) + '<span class="lx-two"><b>' + md.label + '</b><small>' + md.d + '</small></span>', r === k); }).join('');
    $$('.lx-row', permPop).forEach(function(b){ b.removeAttribute('aria-selected'); });
  }
  function pops(): HTMLElement[] { return $$<HTMLElement>('[data-lx-pop]', dlg); }
  function popped(): boolean { return pops().some(function(p){ return !p.hidden; }); }
  function closePops(focusBack?: boolean): void {
    pops().forEach(function(p){
      if (p.hidden) return; p.hidden = true;
      var t = $<HTMLElement>('[data-lx-open=' + p.dataset.lxPop + ']', dlg); if (t) { t.setAttribute('aria-expanded', 'false'); if (focusBack) t.focus(); }
    });
  }
  // T3's popovers open beside their trigger on the side with room, and never leave the window.
  function place(p: HTMLElement, t: HTMLElement): void {
    p.style.height = ''; p.style.maxHeight = '';
    var r = t.getBoundingClientRect(), w = p.offsetWidth, h = p.offsetHeight, vw = window.innerWidth, vh = window.innerHeight, m = 8;
    var below = vh - r.bottom - m - 4, above = r.top - m - 4, down = below >= h || below >= above, room = Math.max(120, down ? below : above);
    if (h > room) { p.style.height = room + 'px'; p.style.maxHeight = room + 'px'; h = room; }
    var left = p.classList.contains('lx-end') ? r.right - w : r.left;
    p.style.left = Math.max(m, Math.min(vw - w - m, left)) + 'px';
    p.style.top = (down ? r.bottom + 4 : r.top - 4 - h) + 'px';
  }
  function openPop(name: string): void {
    var p = $<HTMLElement>('[data-lx-pop=' + name + ']', dlg)!, t = $<HTMLElement>('[data-lx-open=' + name + ']', dlg)!;
    var was = !p.hidden; closePops(); if (was) return;
    if (name === 'pick') { shownProvider = F('instance').value; drawPick(); }
    if (name === 'perm') drawPerm();
    p.hidden = false; t.setAttribute('aria-expanded', 'true');
    place(p, t);
    // Focus goes to the current pick, as T3's menus open on the checked item.
    var first = $<HTMLElement>('[aria-checked=true]', p) || $<HTMLElement>('input:checked', p) || $<HTMLElement>('.lx-row', p) || $<HTMLElement>('[role=tab]', p);
    if (first) ((first.tagName === 'LABEL' && $<HTMLElement>('input', first)) || first).focus({ preventScroll: true });
  }
  dlg.addEventListener('click', function(ev){
    var t = ev.target as Element, o = t.closest<HTMLElement>('[data-lx-open]');
    if (o) { ev.preventDefault(); openPop(o.dataset.lxOpen!); return; }
    var pv = t.closest<HTMLElement>('[data-lx-prov]');
    if (pv) { shownProvider = pv.dataset.lxProv!; drawPick(); var fm = $<HTMLElement>('[data-lx-model]', models); if (fm) fm.focus(); return; }
    var mb = t.closest<HTMLElement>('[data-lx-model]');
    if (mb && !mb.dataset.lxModel) { setPick('', '', ''); app.store(KEY, 'null'); closePops(true); return; }
    if (mb) { setPick(shownProvider, mb.dataset.lxModel!, F('effort').value, true); var fe = $<HTMLElement>('[aria-checked=true][data-lx-eff]', effs) || $<HTMLElement>('[data-lx-eff]', effs); if (fe) fe.focus(); else { closePops(true); } return; }
    var eb = t.closest<HTMLElement>('[data-lx-eff]');
    if (eb) { setPick(F('instance').value, F('model').value, eb.dataset.lxEff!, true); closePops(); trigger.focus(); return; }
    var mo = t.closest<HTMLElement>('[data-lx-mode]');
    if (mo) { F('runtime').value = mo.dataset.lxMode!; form.dispatchEvent(new Event('input', { bubbles: true })); draw(); closePops(true); return; }
    // A click outside an open picker or menu closes it, as T3's popovers do.
    if (popped() && !t.closest('[data-lx-pop]')) closePops();
  });
  form.addEventListener('change', function(ev){
    var t = ev.target as HTMLInputElement;
    if (t.name === 'workspace') { draw(); closePops(true); }
  });
  // Esc closes the open picker or menu first, then the dialog.
  dlg.addEventListener('cancel', function(ev){ if (popped()) { ev.preventDefault(); closePops(true); } });
  dlg.addEventListener('close', function(){ closePops(); });
  window.addEventListener('resize', function(){ closePops(); });
  // Arrows move through a column (rows) or the rail (providers), Left and Right between the picker's columns, and Enter
  // or Space picks, as in T3's picker.
  dlg.addEventListener('keydown', function(ev){
    if (ev.key === 'Escape' && popped()) { ev.preventDefault(); ev.stopPropagation(); closePops(true); return; }
    var pop = (ev.target as Element).closest && (ev.target as Element).closest<HTMLElement>('[data-lx-pop]'); if (!pop) return;
    var group = (ev.target as Element).closest<HTMLElement>('.lx-col, .lx-rail, .lx-menu'); if (!group) return;
    var items = $$<HTMLElement>('.lx-row, [role=tab]', group).filter(function(x){ return !x.hidden; });
    var here = items.indexOf((ev.target as Element).closest<HTMLElement>('.lx-row, [role=tab]')!);
    var go = function(el: HTMLElement | null | undefined){ if (!el) return; ev.preventDefault(); var inp = $<HTMLInputElement>('input', el); (inp || el).focus(); };
    if (ev.key === 'ArrowDown') return go(items[Math.min(items.length - 1, here + 1)]);
    if (ev.key === 'ArrowUp') return go(items[Math.max(0, here - 1)]);
    if (pop === pick && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      var cols = [rail, models, effs], at = cols.indexOf(group), next = cols[at + (ev.key === 'ArrowRight' ? 1 : -1)];
      if (next) go($<HTMLElement>('[aria-checked=true], [aria-selected=true]', next) || $<HTMLElement>('.lx-row, [role=tab]', next));
      return;
    }
    if ((ev.key === 'Enter' || ev.key === ' ') && (ev.target as Element).matches('input')) { ev.preventDefault(); var i = ev.target as HTMLInputElement; i.checked = true; i.dispatchEvent(new Event('change', { bubbles: true })); }
  }, true);
  function read(): void {
    fetch('/caps', { headers: { accept: 'application/json' } }).then(function(r){ return r.json(); }).then(function(c){
      caps = c && typeof c === 'object' ? c : { ok: false, why: 'T3 Code did not answer.' };
    }, function(){ caps = { ok: false, why: 'T3 Code did not answer.' }; }).then(function(){
      // A pick T3 no longer lists goes back to the project default, which the trigger then names, rather than being
      // sent anyway; so do permissions past the approval, or any while it is unknown (PR-Agent r1 on #79).
      if (caps && caps.ok && F('model').value && !modelOf(provider(F('instance').value), F('model').value)) { setPick('', '', ''); app.store(KEY, 'null'); }
      var r = F('runtime').value; if (r && core.modesFor(caps && caps.ok ? caps.ceiling || null : null, provider(F('instance').value)).indexOf(r) < 0) { F('runtime').value = ''; form.dispatchEvent(new Event('input', { bubbles: true })); }
      // Nothing picked yet: the last model you picked, if T3 still lists it.
      if (!F('model').value && caps && caps.ok) {
        var last: { inst?: string; model?: string; effort?: string } | null = null; try { last = JSON.parse(app.store(KEY) || 'null'); } catch (x) { last = null; }
        if (last && modelOf(provider(last.inst || ''), last.model || '')) setPick(last.inst!, last.model!, last.effort || '');
      }
      draw();
    });
  }
  return {
    open: function(){ draw(); read(); },
    sync: draw,
    popped: popped
  };
}
