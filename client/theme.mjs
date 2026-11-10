// Appearance (PR 3 of the ⌘K bar, docs/command-bar-v1_0.md): Match system, Light or Dark.
// The page's dark and light rules are @media (prefers-color-scheme:…) blocks: pass.py's tokens, the prototype's own
// rules and the bar's. onTheme() writes each block twice. Once for Match system: still inside its media query, under a
// root with no data-theme. Once for the theme you chose: under :root[data-theme=…], with no media query. The guard sits
// in :where(), so every selector keeps its specificity and its place in the sheet: with no choice made, the cascade is
// the one the page had before. pass.py's own page (the live pass) is not changed.

export const THEMES = ['system', 'light', 'dark'];
export const themeOf = (v) => (v === 'light' || v === 'dark' ? v : 'system');
// The order T3 Code's appearance.cycle uses (Match system, light, dark).
export const nextTheme = (t) => THEMES[(THEMES.indexOf(themeOf(t)) + 1) % THEMES.length];

// The '}' that closes the '{' at open.
function closer(css, open) {
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return i;
  }
  throw new Error('onTheme: a color-scheme block has no closing brace');
}

// Walks a selector at its top level: outside (), [] and quotes, past escapes. stop(c, i) ends the walk at i.
function walk(sel, stop) {
  let depth = 0, q = '';
  for (let i = 0; i < sel.length; i++) {
    const c = sel[i];
    if (c === '\\') { i++; continue; }
    if (q) { if (c === q) q = ''; continue; }
    if (c === '"' || c === "'") q = c;
    else if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth--;
    else if (depth === 0 && stop(c, i)) return i;
  }
  return sel.length;
}

// A selector list split at its top-level commas, so :is(a, b) and [x="a,b"] stay whole.
function split(list) {
  const out = [];
  let from = 0;
  walk(list, (c, i) => { if (c === ',') { out.push(list.slice(from, i)); from = i + 1; } return false; });
  out.push(list.slice(from));
  return out.map((s) => s.trim()).filter(Boolean);
}

// One selector under the guard. Its first compound is the outermost element it names, and that element may be the root
// itself: the page puts its view and density classes on <html> (.v-kitchen .rail .tile, .d-compact …). So the guard
// goes on that compound, as "the root, or anything in it": :where(:root G,:root G *). It goes before a pseudo-element,
// which must end a compound. A selector that starts at :root or html takes the plain guard.
const PSEUDO_EL = /^:(:|(before|after|first-line|first-letter)(?![\w-]))/i;
function guard(sel, g) {
  const m = /^(:root|html)(?![\w-])/i.exec(sel);
  if (m) return `${m[1]}:where(${g})${sel.slice(m[1].length)}`;
  const at = walk(sel, (c, i) => /[\s>+~]/.test(c) || (c === ':' && PSEUDO_EL.test(sel.slice(i))));
  return `${sel.slice(0, at)}:where(:root${g},:root${g} *)${sel.slice(at)}`;
}

// A run of plain rules (selector{declarations}) with each selector under the guard.
function scope(body, g) {
  let out = '', i = 0;
  while (i < body.length) {
    const open = body.indexOf('{', i);
    if (open < 0) { out += body.slice(i); break; }
    const sel = body.slice(i, open).trim(), close = closer(body, open);
    // A rule inside a rule here would need its own guard; none exists, so a new one fails loudly instead of slipping by.
    if (sel.startsWith('@') || body.slice(open + 1, close).includes('{')) throw new Error(`onTheme: a nested rule in a color-scheme block: ${sel}`);
    out += split(sel).map((s) => guard(s, g)).join(',') + body.slice(open, close + 1);
    i = close + 1;
  }
  return out;
}

export function onTheme(css) {
  const re = /@media\s*\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)\s*\{/g;
  let out = '', i = 0, n = 0, m;
  while ((m = re.exec(css))) {
    n++;
    const open = m.index + m[0].length - 1, close = closer(css, open), body = css.slice(open + 1, close);
    out += css.slice(i, m.index)
      + `@media (prefers-color-scheme:${m[1]}){${scope(body, ':not([data-theme])')}}`
      + scope(body, `[data-theme=${m[1]}]`);
    i = close + 1;
    re.lastIndex = i;
  }
  // A query this does not read, such as (prefers-color-scheme:dark) and (hover:none), would keep following the system.
  if ((css.match(/prefers-color-scheme/g) || []).length !== n) throw new Error('onTheme: a color-scheme query it cannot read');
  // Form controls, scroll bars and the page canvas follow the chosen theme too. Last, so they win over color-scheme:light dark.
  return out + css.slice(i) + ':root:where([data-theme=light]){color-scheme:light}:root:where([data-theme=dark]){color-scheme:dark}';
}
