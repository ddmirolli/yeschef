// The board window's one bridge to the app: send an action, get [status, text] back.
// A sandboxed preload must be CommonJS. It exposes no Electron or Node API to the page.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('yeschef', {
  act: (body) => ipcRenderer.invoke('yeschef:act', String(body)),
});

// The app's own card (desktop/updates.mjs): an update, or the one-time offer to move to Applications. The app sends
// its text; this draws it over whatever page the window shows (the board, or a waiting page) and sends back which
// button was clicked. It lives outside <body> in its own shadow root, so the board's styles and scripts never touch it.
const CSS = `
:host{all:initial}
.card{position:fixed;right:20px;bottom:20px;z-index:2147483647;box-sizing:border-box;width:320px;padding:14px 16px 12px;border-radius:14px;
  font:13px/1.4 -apple-system,BlinkMacSystemFont,system-ui,sans-serif;-webkit-font-smoothing:antialiased;
  background:var(--card,#2C2C2E);color:var(--label2,#AEAEB2);
  box-shadow:var(--sh2,0 0 0 .5px rgba(255,255,255,.09),0 8px 22px rgba(0,0,0,.5));animation:in .18s ease-out}
@media (prefers-color-scheme:light){.card{background:var(--card,#FFFFFF);color:var(--label2,#636366);box-shadow:var(--sh2,0 0 0 .5px rgba(0,0,0,.05),0 6px 18px rgba(0,0,0,.10))}}
@media (prefers-reduced-motion:reduce){.card{animation:none}}
@keyframes in{from{opacity:0;transform:translateY(6px)}}
.t{margin:0;font-weight:600;font-size:14px;color:var(--label,#F5F5F7)}
@media (prefers-color-scheme:light){.t{color:var(--label,#1D1D1F)}}
.v{white-space:nowrap}
.b{margin:2px 0 0}
.bar{height:4px;margin:10px 0 2px;border-radius:2px;background:var(--fill,rgba(118,118,128,.24));overflow:hidden}
.bar>i{display:block;height:100%;background:var(--accent,#0071E3);transition:width .2s}
.row{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
button{all:unset;box-sizing:border-box;height:28px;padding:0 12px;border-radius:7px;font:500 13px/28px -apple-system,BlinkMacSystemFont,system-ui,sans-serif;
  cursor:default;background:var(--fill,rgba(118,118,128,.24));color:var(--label,#F5F5F7)}
@media (prefers-color-scheme:light){button{color:var(--label,#1D1D1F)}}
button.p{background:var(--accent,#0071E3);color:#fff}
button:focus-visible{outline:2px solid var(--accent,#0071E3);outline-offset:2px}
`;

let host = null;
function draw(card) {
  if (!card) { if (host) { host.remove(); host = null; } return; }
  if (!host) {
    host = document.createElement('yeschef-card');
    host.attachShadow({ mode: 'open' });
  }
  if (!host.isConnected) document.documentElement.appendChild(host);
  const root = host.shadowRoot;
  root.textContent = '';
  const style = document.createElement('style');
  style.textContent = CSS;
  const box = document.createElement('div');
  box.className = 'card';
  box.setAttribute('role', card.id === 'move' ? 'alertdialog' : 'status');
  box.setAttribute('aria-live', 'polite');
  box.dataset.card = card.id;
  const title = document.createElement('p');
  title.className = 't';
  // The version stays on one line: 0.2.1-nightly.20261110.1 would otherwise break at its hyphen.
  const at = card.version ? card.title.indexOf(card.version) : -1;
  if (at < 0) title.textContent = card.title;
  else {
    const v = document.createElement('span');
    v.className = 'v';
    v.textContent = card.version;
    title.append(card.title.slice(0, at), v, card.title.slice(at + card.version.length));
  }
  box.appendChild(title);
  if (card.body) {
    const body = document.createElement('p');
    body.className = 'b';
    body.textContent = card.body;
    box.appendChild(body);
  }
  if (typeof card.progress === 'number') {
    const bar = document.createElement('div');
    bar.className = 'bar';
    const fill = document.createElement('i');
    fill.style.width = `${Math.max(0, Math.min(100, card.progress))}%`;
    bar.appendChild(fill);
    box.appendChild(bar);
  }
  if (card.buttons?.length) {
    const row = document.createElement('div');
    row.className = 'row';
    for (const b of card.buttons) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.textContent = b.label;
      btn.dataset.button = b.id;
      if (b.primary) btn.className = 'p';
      btn.addEventListener('click', () => ipcRenderer.invoke('yeschef:card', { card: card.id, button: b.id }));
      row.appendChild(btn);
    }
    box.appendChild(row);
  }
  root.append(style, box);
}

ipcRenderer.on('yeschef:card', (_event, card) => draw(card));
// Each page load starts without the card: ask for the current one.
const ask = () => ipcRenderer.invoke('yeschef:card', null).then(draw).catch(() => {});
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ask, { once: true });
else ask();
