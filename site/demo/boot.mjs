// Starts the made-up kitchen for the site demo (see shim.js): the app's own modules, in this page.
import { createKitchen } from './kitchen.mjs';

const dark = matchMedia('(prefers-color-scheme: dark)');
const tick = () => window.__demoTick();
const kitchen = createKitchen({
  where: (dir) => ({ icon: `icons/${dir}.svg` }),
  shot: (name) => `img/${name}-${dark.matches ? 'dark' : 'light'}.png`,
  // An agent's answer shows at once, not at the next tick.
  onChange: () => setTimeout(tick, 30),
});
window.__demoReady(kitchen);
tick();
// On a wide screen the reader opens the first ticket at the pass, as it would after a send.
if (matchMedia('(min-width: 761px)').matches) {
  const first = () => [...document.querySelectorAll('#app .tile[data-plate]')].find((t) => t.offsetParent);
  const open = (n) => { const t = first(); if (t) t.click(); else if (n) setTimeout(() => open(n - 1), 100); };
  open(20);
}
// The screenshots follow the theme.
dark.addEventListener('change', tick);
