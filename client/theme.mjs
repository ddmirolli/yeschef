// Appearance (PR 3 of the ⌘K bar, docs/command-bar-v1_0.md): System, Light or Dark, T3 Code's names.
// The page's dark and light rules are @media (prefers-color-scheme:…) blocks: the base sheet's tokens (pass.css), the prototype's own
// rules and the bar's. onTheme() writes each block twice. Once for System: still inside its media query, under a
// root with no data-theme. Once for the theme you chose: under :root[data-theme=…], with no media query. The guard sits
// in :where(), so every selector keeps its specificity and its place in the sheet: with no choice made, the cascade is
// the one the page had before.

export const THEMES = ['system', 'light', 'dark'];
export const themeOf = (v) => (v === 'light' || v === 'dark' ? v : 'system');
// The order T3 Code's appearance.cycle uses (System, Light, Dark).
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

// The pictures in Settings → Appearance (Dan, 2026-11-10: "renders ... what the actual home view would look like", as
// T3 Code's appearance tiles do). Each one is drawn in a fixed theme, whatever the page's, so it takes the page's own
// light and dark tokens: every plain :root block in the sheet, in cascade order. A top-level block counts for both
// themes; one in a color-scheme query for its theme; one in any other query (a width) for neither. That covers pass.css's
// tokens, the app's "light mirrors dark" block and its stage colors. var() references resolve within the theme. The
// tokens are copied by name into --m-* properties on .mt-light and .mt-dark. A token the page drops fails the build
// instead of drawing a wrong picture.
export const MINI_TOKENS = ['bg', 'card', 'label', 'label2', 'sep', 'fill', 'accent', 'blue', 'blue-t', 'st-merged', 'st-ready', 'st-review', 'st-prog', 'st-planned', 'st-backlog'];
function decls(body) {
  const out = {}, re = /--([\w-]+)\s*:\s*([^;{}]+)/g;
  let m;
  while ((m = re.exec(body))) out[m[1]] = m[2].trim();
  return out;
}
export function rootTokens(sheet) {
  const css = sheet.replace(/\/\*[\s\S]*?\*\//g, '');
  const media = [], mre = /@media\s*([^{]*)\{/g;
  let m;
  while ((m = mre.exec(css))) {
    const open = m.index + m[0].length - 1, sc = /^\(\s*prefers-color-scheme\s*:\s*(dark|light)\s*\)$/.exec(m[1].trim());
    media.push({ open, close: closer(css, open), scheme: sc ? sc[1] : '' });
  }
  const out = { light: {}, dark: {} }, rre = /(^|[{};\s]):root\s*\{/g;
  while ((m = rre.exec(css))) {
    const open = m.index + m[0].length - 1, around = media.filter((b) => b.open < open && open < b.close);
    if (around.some((b) => !b.scheme) || new Set(around.map((b) => b.scheme)).size > 1) continue;
    const d = decls(css.slice(open + 1, closer(css, open)));
    (around.length ? [around[0].scheme] : ['light', 'dark']).forEach((t) => Object.assign(out[t], d));
  }
  const resolve = (map, v, n) => v.replace(/var\(--([\w-]+)\)/g, (all, k) => (k in map && n < 8 ? resolve(map, map[k], n + 1) : all));
  for (const t of ['light', 'dark']) for (const k of Object.keys(out[t])) out[t][k] = resolve(out[t], out[t][k], 0);
  return out;
}
export function miniCss(sheet) {
  const t = rootTokens(sheet);
  const one = (name) => MINI_TOKENS.map((k) => {
    if (!(k in t[name])) throw new Error(`miniCss: the page has no --${k} for ${name}`);
    return `--m-${k}:${t[name][k]}`;
  }).join(';');
  return `.mt-light{${one('light')}}.mt-dark{${one('dark')}}`;
}

// The pictures themselves: the home view in miniature (the rail, the ticket list, the open ticket), laid out as the
// page is at 1440 × 900 and drawn in cqw, so one picture scales from a Settings tile down to a thumbnail in the ⌘K bar.
// Lines are drawn thicker than text and small parts are left out, so the picture still reads at tile size.
// In both themes the page and the tickets are --bg and the panels around them --card.
const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join('');
const tk = (i, lines, chips) => `<i class="hv-tk${i === 0 ? ' on' : ''}"><i class="hv-l1"></i>${rep(lines, () => '<i class="hv-l2"></i>')}`
  + (chips ? `<i class="hv-chips">${i < 2 ? '<i class="hv-q"></i>' : ''}<i class="hv-st m${[1, 1, 0, 4, 2, 1, 3, 2][i % 8]}"></i></i>` : '') + '</i>';
function home(tc) {
  return `<i class="hv ${tc}"><i class="hv-rail"><i class="hv-top"><i class="hv-logo"></i><i class="hv-pill"></i></i>`
    + `<i class="hv-box">${rep(6, (i) => `<i class="hv-row"><i class="hv-dot m${i}"></i><i class="hv-bar"></i></i>`)}</i>`
    + `<i class="hv-box">${rep(2, (i) => `<i class="hv-row"><i class="hv-dot m${i ? 3 : 2}"></i><i class="hv-bar"></i></i>`)}</i>`
    + '<i class="hv-sp"></i><i class="hv-foot"><i class="hv-pill"></i><i class="hv-pill"></i></i></i>'
    + `<i class="hv-list">${rep(5, (i) => tk(i, 1, true))}</i>`
    + '<i class="hv-read"><i class="hv-paper"><i class="hv-h"></i><i class="hv-q"></i><i class="hv-prs"><i></i><i></i></i>'
    + '<i class="hv-shots"><i></i><i></i></i><i class="hv-tx"></i><i class="hv-tx hv-tx2"></i><i class="hv-sp"></i><i class="hv-ask"></i>'
    + '<i class="hv-opts"><i></i><i></i></i><i class="hv-acts"><i class="hv-send"></i><i class="hv-reply"></i></i></i></i></i>';
}
// Density: the ticket list up close, in the page's own theme, so it shows the choice in the look you have.
const dens = (d, n, lines) => `<i class="mini dm dm-${d}" aria-hidden="true"><i class="dm-list">${rep(n, (i) => tk(i, lines, d !== 'compact'))}</i></i>`;
export function minis() {
  return {
    system: `<i class="mini" aria-hidden="true">${home('mt-light')}${home('mt-dark hv-half')}</i>`,
    light: `<i class="mini" aria-hidden="true">${home('mt-light')}</i>`,
    dark: `<i class="mini" aria-hidden="true">${home('mt-dark')}</i>`,
    default: dens('default', 4, 2), comfortable: dens('comfortable', 5, 1), compact: dens('compact', 9, 0),
  };
}
export const MINI_CSS = `
.mini{position:relative;display:block;aspect-ratio:16/10;border-radius:8px;overflow:hidden;container-type:inline-size;box-shadow:0 0 0 .5px var(--sep)}
/* Weightless, so each part's own display (grid, flex) wins. */
:where(.mini) i{display:block;box-sizing:border-box;font-style:normal}
.hv,.dm{--m-page:var(--m-bg);--m-panel:var(--m-card)}
.hv{position:absolute;inset:0;display:grid;grid-template-columns:15cqw 27cqw minmax(0,1fr);gap:1.6cqw;padding:2cqw 2.2cqw;background:var(--m-page)}
.hv-half{clip-path:polygon(calc(50% + .5px) 0,100% 0,100% 100%,calc(50% + .5px) 100%)}
.hv-rail{display:flex;flex-direction:column;gap:1.6cqw;min-height:0}
.hv-top{flex:none;display:flex;gap:1.2cqw;height:3.4cqw}
.hv-logo{width:3.4cqw;border-radius:.9cqw;background:var(--m-accent)}
.hv-pill{flex:1;border-radius:1cqw;background:var(--m-fill)}
.hv-box{flex:none;display:flex;flex-direction:column;gap:2.2cqw;padding:2.2cqw 1.8cqw;border-radius:1.6cqw;background:var(--m-panel);box-shadow:inset 0 0 0 .5px var(--m-sep)}
.hv-row{display:flex;align-items:center;gap:1.4cqw;height:1.6cqw}
.hv-dot{flex:none;width:1.5cqw;height:1.5cqw;border-radius:50%}
.hv-bar{width:62%;height:1.2cqw;border-radius:.6cqw;background:var(--m-label);opacity:.55}
.m0{background:var(--m-st-merged)}.m1{background:var(--m-st-ready)}.m2{background:var(--m-st-review)}.m3{background:var(--m-st-prog)}.m4{background:var(--m-st-planned)}.m5{background:var(--m-st-backlog)}
.hv-sp{flex:1}
.hv-foot{flex:none;display:flex;gap:1cqw;height:3.4cqw}
.hv-list{display:flex;flex-direction:column;gap:1.2cqw;min-height:0;overflow:hidden;padding:1.2cqw;border-radius:2cqw;background:var(--m-panel);box-shadow:inset 0 0 0 .5px var(--m-sep)}
.hv-tk{flex:none;display:flex;flex-direction:column;gap:1.3cqw;padding:1.8cqw;border-radius:1.4cqw;background:var(--m-page)}
.hv-tk.on{box-shadow:inset 0 0 0 1.5px var(--m-accent)}
.hv-l1{width:70%;height:1.6cqw;border-radius:.8cqw;background:var(--m-label)}
.hv-l2{width:92%;height:1.2cqw;border-radius:.6cqw;background:var(--m-label2);opacity:.5}
.hv-chips{display:flex;gap:1cqw;height:1.6cqw}
.hv-q{flex:none;width:6cqw;height:1.6cqw;border-radius:.8cqw;background:var(--m-blue-t);box-shadow:inset 0 0 0 .5px var(--m-blue)}
.hv-st{width:8cqw;border-radius:.8cqw;opacity:.55}
.hv-read{display:flex;min-height:0;padding:1.2cqw;border-radius:2cqw;background:var(--m-panel)}
.hv-paper{flex:1;display:flex;flex-direction:column;align-items:flex-start;gap:1.6cqw;padding:2.4cqw 3cqw;border-radius:1.2cqw;background:var(--m-page)}
.hv-h{width:46%;height:2.8cqw;border-radius:1cqw;background:var(--m-label)}
.hv-prs{display:flex;gap:1cqw}.hv-prs i{width:13cqw;height:3cqw;border-radius:1.5cqw;background:var(--m-panel);box-shadow:inset 0 0 0 .5px var(--m-sep)}
/* An agent's screenshots, drawn in the theme's own surfaces so a dark picture has no white blocks in it. */
.hv-shots{display:flex;gap:1.2cqw}.hv-shots i{width:15cqw;height:9.5cqw;border-radius:.8cqw;background:linear-gradient(var(--m-fill) 0 22%,var(--m-panel) 22%);box-shadow:inset 0 0 0 .5px var(--m-sep)}
.hv-tx{width:76%;height:1.2cqw;border-radius:.6cqw;background:var(--m-label);opacity:.7}
.hv-tx2{width:44%}
.hv-ask{width:40%;height:1.6cqw;border-radius:.8cqw;background:var(--m-label)}
.hv-opts{display:flex;gap:1cqw;width:100%}.hv-opts i{flex:1;height:5cqw;border-radius:1.1cqw;background:var(--m-fill)}
.hv-acts{display:flex;gap:1cqw}.hv-send{width:10cqw;height:3.6cqw;border-radius:1cqw;background:var(--m-accent)}.hv-reply{width:9cqw;height:3.6cqw;border-radius:1cqw;background:var(--m-fill)}
.dm{--m-bg:var(--bg);--m-card:var(--card);--m-label:var(--label);--m-label2:var(--label2);--m-accent:var(--accent);--m-blue:var(--blue);--m-blue-t:var(--blue-t);--m-sep:var(--sep);--m-st-merged:var(--st-merged);--m-st-ready:var(--st-ready);--m-st-review:var(--st-review);--m-st-prog:var(--st-prog);--m-st-planned:var(--st-planned);--m-st-backlog:var(--st-backlog);background:var(--m-panel)}
.dm-list{position:absolute;inset:0;display:flex;flex-direction:column;gap:2cqw;padding:4cqw 5cqw}
.dm .hv-tk{gap:2.2cqw;padding:3.2cqw 3.6cqw;border-radius:2.6cqw}
.dm .hv-l1{width:50%;height:2.4cqw;border-radius:1cqw}.dm .hv-l2{height:1.9cqw;border-radius:1cqw}
.dm .hv-chips{gap:1.6cqw;height:2.4cqw}.dm .hv-q{width:12cqw;height:2.4cqw;border-radius:1.2cqw}.dm .hv-st{width:15cqw;border-radius:1cqw}
.dm-compact .dm-list{gap:1.4cqw}.dm-compact .hv-tk{padding:2.4cqw 3.6cqw}
/* Settings → Layout: each choice is its picture, as T3 Code's appearance tiles. The radio stays, unseen, for the keys. */
#settings .looks{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:12px}
.look{position:relative;display:flex;flex-direction:column;gap:8px;padding:6px 6px 8px;border-radius:12px;background:var(--bg);box-shadow:inset 0 0 0 .5px var(--sep);cursor:pointer;transition:background .15s,box-shadow .15s}
.look:hover{background:var(--fill)}
.look input{position:absolute;inset:0;width:100%;height:100%;margin:0;opacity:0;cursor:pointer;-webkit-appearance:none;appearance:none}
.look:has(input:checked){background:var(--blue-t);box-shadow:inset 0 0 0 2px var(--accent)}
.look:has(input:focus-visible){outline:2px solid var(--focus);outline-offset:2px}
.look-n{text-align:center;font-size:12.5px;font-weight:500;line-height:1.3;color:var(--label2)}
.look:has(input:checked) .look-n{font-weight:600;color:var(--label)}
`;
