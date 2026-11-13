// Starts the made-up kitchen for the site demo (see shim.js): the app's own modules, in this page. The team demo
// (demo/team.html, <html data-team="open">, or "brigade" to start there) adds the made-up team below you, and the buttons in the home page's modes section switch its mode.
import { createKitchen } from './kitchen.ts';

const dark = matchMedia('(prefers-color-scheme: dark)');
const tick = () => window.__demoTick();
const asked = document.documentElement.dataset.team;
const team = asked === 'open' || asked === 'brigade' ? asked : null;
const kitchen = createKitchen({
  where: (dir) => ({ icon: `icons/${dir}.svg` }),
  shot: (name) => `img/${name}-${dark.matches ? 'dark' : 'light'}.png`,
  // An agent's answer shows at once, not at the next tick.
  onChange: () => setTimeout(tick, 30),
  team,
});
if (team) window.__demoMode = (mode) => { kitchen.mode(mode); };
window.__demoReady(kitchen);
tick();
// On a wide screen the collapsed view opens the first ticket at the pass, as it would after a send. The expanded view
// the demos open on (Dan, 2026-11-13) shows its chart, so nothing opens over it.
if (matchMedia('(min-width: 761px)').matches && localStorage.getItem('yc.view') !== 'kitchen') {
  const first = () => [...document.querySelectorAll<HTMLElement>('#app .tile[data-plate]')].find((t) => t.offsetParent);
  const open = (n: number) => { const t = first(); if (t) t.click(); else if (n) setTimeout(() => open(n - 1), 100); };
  open(20);
}
// The screenshots follow the theme.
dark.addEventListener('change', tick);
