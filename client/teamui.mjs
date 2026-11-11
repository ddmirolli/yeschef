// The team screens (step 3b, PR 3): the lead's invite page with the asks drawer and the chart, the role dialog, and the
// dev's Join, waiting and joined screens. Built from mock v1 (Dan's picks 2026-11-10: 1b the chart, 2a the match
// code, 3a the Engineer sees only). Rendered here from the team client's view (client/team.mjs); the page posts each
// change to /act as kind=team, the same door every action uses. Dev words only: the modes are Open kitchen and French
// Brigade, in full.
import { PERMS, DEFAULTS, ROLE_NAMES } from './roles.mjs';

export const DEFAULT_RELAY = 'https://relay.yeschef.codes';
export const SITE = 'https://yeschef.codes';

const e = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const initials = (name) => (String(name || '').trim().split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('') || '?').toUpperCase();
// A colour per person, from their id: the same on every Mac.
const hue = (id) => { let h = 0; for (const c of String(id || '')) h = (h * 31 + c.charCodeAt(0)) >>> 0; return `c${(h % 6) + 1}`; };
const av = (p, size = '') => `<span class="av ${size} ${hue(p.id || p.m)}" aria-hidden="true">${e(initials(p.name))}</span>`;
const day = (ms) => new Date(ms).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const ago = (ms, now) => { const m = Math.max(0, Math.round((now - ms) / 60000)); return m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} d ago`; };
const and = (list) => (list.length < 2 ? list.join('') : `${list.slice(0, -1).join(', ')} and ${list[list.length - 1]}`);
const first = (name) => String(name || '').trim().split(/\s+/)[0] || 'the lead';
const use = (id, w = 14, h = 14) => `<svg width="${w}" height="${h}" aria-hidden="true"><use href="#${id}"/></svg>`;

const ICONS = `<svg width="0" height="0" style="position:absolute" aria-hidden="true"><defs>
  <symbol id="cloche" viewBox="0 0 24 24"><path d="M4.25 17.4a7.75 7.75 0 0 1 15.5 0" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="12" cy="7.4" r="1.75" fill="currentColor"/><path d="M2.75 19h18.5l-1.5 1.5H4.25z" fill="currentColor"/></symbol>
  <symbol id="person-plus" viewBox="0 0 24 24"><circle cx="10" cy="8.25" r="3.25" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M3.75 19.5a6.25 6.25 0 0 1 12.5 0" fill="none" stroke="currentColor" stroke-width="1.5"/><path d="M19.25 8.5v5M16.75 11h5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></symbol>
  <symbol id="plus" viewBox="0 0 16 16"><path d="M8 3v10M3 8h10" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round"/></symbol>
  <symbol id="back" viewBox="0 0 10 16"><path d="M7.5 2.5L2.5 8l5 5.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></symbol>
</defs></svg>`;

export const TEAM_CSS = `
:root{
  --page:#FFFFFF;--panel:#F2F2F7;--card:#FFFFFF;--raised:#FFFFFF;--label:#1D1D1F;--label2:#636366;--label3:#8E8E93;
  --sep:rgba(60,60,67,.16);--fill:rgba(118,118,128,.12);--fill2:rgba(118,118,128,.24);
  --accent:#0071E3;--pass:#0071E3;--pass-t:rgba(0,113,227,.10);
  --green:#1F7A35;--red:#C8001A;
  --sh1:0 0 0 .5px rgba(0,0,0,.05),0 1px 3px rgba(0,0,0,.08);--sh4:0 0 0 .5px rgba(0,0,0,.08),0 32px 100px rgba(0,0,0,.30);
  --scrim:rgba(0,0,0,.28);
  --sans:-apple-system,BlinkMacSystemFont,"SF Pro Text","Helvetica Neue","Segoe UI",Roboto,system-ui,sans-serif;
  --mono:ui-monospace,"SF Mono",SFMono-Regular,Menlo,Consolas,monospace;
  color-scheme:light dark;
}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){
  --page:#1C1C1E;--panel:#2C2C2E;--card:#1C1C1E;--raised:#2C2C2E;--label:#F5F5F7;--label2:#AEAEB2;--label3:#8E8E93;
  --sep:rgba(235,235,245,.13);--fill:rgba(118,118,128,.24);--fill2:rgba(118,118,128,.36);
  --pass:#3B9BFF;--pass-t:rgba(10,132,255,.16);--green:#30D158;--red:#FF938A;
  --sh1:0 0 0 .5px rgba(255,255,255,.07),0 1px 3px rgba(0,0,0,.45);--sh4:0 0 0 .5px rgba(255,255,255,.1),0 36px 110px rgba(0,0,0,.6);
  --scrim:rgba(0,0,0,.5);
}}
:root[data-theme="dark"]{
  --page:#1C1C1E;--panel:#2C2C2E;--card:#1C1C1E;--raised:#2C2C2E;--label:#F5F5F7;--label2:#AEAEB2;--label3:#8E8E93;
  --sep:rgba(235,235,245,.13);--fill:rgba(118,118,128,.24);--fill2:rgba(118,118,128,.36);
  --pass:#3B9BFF;--pass-t:rgba(10,132,255,.16);--green:#30D158;--red:#FF938A;
  --sh1:0 0 0 .5px rgba(255,255,255,.07),0 1px 3px rgba(0,0,0,.45);--sh4:0 0 0 .5px rgba(255,255,255,.1),0 36px 110px rgba(0,0,0,.6);
  --scrim:rgba(0,0,0,.5);
}
*{box-sizing:border-box}
html,body{margin:0;background:var(--page)}
body{min-height:100vh;font:15px/1.4 var(--sans);color:var(--label);-webkit-font-smoothing:antialiased}
button,input{font:inherit;color:inherit}
h1{margin:0;font-size:28px;line-height:1.2;font-weight:700;letter-spacing:-.01em}
h2{margin:0;font-size:17px;font-weight:600}
p{margin:0}
:focus-visible{outline:2px solid var(--pass);outline-offset:2px}
.btn{text-decoration:none;display:inline-flex;align-items:center;justify-content:center;gap:8px;height:40px;padding:0 18px;border-radius:10px;border:0;font:600 15px/1 var(--sans);background:var(--fill);color:var(--label);cursor:pointer;white-space:nowrap}
.btn.primary{background:var(--accent);color:#fff}
.btn.sm{height:32px;padding:0 12px;font-size:13px;border-radius:8px}
.btn:disabled{opacity:.5;cursor:default}
.lnk{white-space:nowrap;border:0;background:none;padding:0;color:var(--pass);font-weight:600;font-size:13px;cursor:pointer}
.logo{display:grid;place-items:center;width:40px;height:40px;border-radius:11px;color:#fff;background:linear-gradient(180deg,#3B9BFF,#0066D6);box-shadow:inset 0 0 0 .5px rgba(0,0,0,.12);flex:none}
.logo svg{width:36px;height:36px}
.logo.cl{width:34px;height:34px;border-radius:9px}.logo.cl svg{position:relative;top:-1.5px;width:31px;height:31px}
.av{display:inline-grid;place-items:center;flex:none;width:30px;height:30px;border-radius:50%;font:700 11.5px/1 var(--sans);color:#fff;letter-spacing:.02em}
.av.lg{width:40px;height:40px;font-size:14px}
.av.xl{width:56px;height:56px;font-size:19px}
.c1{background:#5E5CE6}.c2{background:#30A46C}.c3{background:#E5484D}.c4{background:#D9822B}.c5{background:#0091FF}.c6{background:#8E4EC6}
.back{display:inline-flex;align-items:center;gap:6px;font-size:13.5px;font-weight:500;color:var(--pass);text-decoration:none}
.top{padding:24px 28px 0}
.muted{color:var(--label2)}
.code{display:inline-flex;align-items:center;gap:6px;height:26px;padding:0 9px;border-radius:7px;background:var(--fill);font:600 13px/1 var(--mono);letter-spacing:.06em;color:var(--label);white-space:nowrap}
.err{margin:14px 0 0;padding:10px 12px;border-radius:10px;background:var(--fill);color:var(--red);font-size:13.5px}
.err:empty{display:none}

/* The lead's page: the asks drawer on the left, the link and the chart beside it. */
.lead{display:grid;grid-template-columns:262px minmax(0,1fr);gap:44px;padding:20px 28px 40px;max-width:1380px}
.drawer{align-self:start;position:sticky;top:20px;padding:14px;border-radius:14px;background:var(--panel)}
.drawer .hd{display:flex;align-items:center;font-weight:600;font-size:14px}
.drawer .hd .n{margin-left:auto;color:var(--label2);font-size:13px}
.drawer .sub{margin:4px 0 10px;font-size:12.5px;color:var(--label2)}
.chip{display:flex;align-items:center;gap:10px;width:100%;padding:9px 10px;border:0;border-radius:10px;background:var(--card);box-shadow:var(--sh1);font-size:13.5px;margin-top:8px;text-align:left;cursor:grab}
.chip .who{flex:1;display:grid;line-height:1.3;min-width:0}.chip .who i{font-style:normal;font-size:12px;color:var(--label2);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.chip.lifted{opacity:.35;box-shadow:none;background:transparent;outline:1.5px dashed var(--fill2)}
.chip .code{height:22px;font-size:11.5px;padding:0 6px}
.drawer .hint{margin-top:10px;font-size:12px;color:var(--label3)}
.ih{display:flex;align-items:center;gap:14px}
.lede{margin-top:8px;font-size:15.5px;color:var(--label2);max-width:760px}
.linkcard{margin-top:16px;padding:16px 18px;border-radius:14px;background:var(--panel);max-width:1050px}
.linkcard .row{display:flex;align-items:center;gap:10px}
.field{flex:1;display:flex;align-items:center;height:40px;padding:0 14px;border-radius:10px;background:var(--card);font:13px var(--mono);color:var(--label2);min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis;border:0}
.linkcard .fine{display:flex;align-items:center;gap:12px;margin-top:10px;font-size:13px;color:var(--label2)}
.linkcard .fine .lnk{margin-left:auto}

/* The chart: you, your deputies, the areas with their owners and engineers, and the viewers aside. */
.chart{display:grid;grid-template-columns:minmax(0,1fr) 200px;gap:44px;margin-top:40px;max-width:1050px}
.tree{display:flex;flex-direction:column;align-items:center;min-width:0}
.tier{display:flex;justify-content:center;gap:12px;flex-wrap:wrap;position:relative}
.tier+.tier{margin-top:22px}
.tier+.tier::before{content:"";position:absolute;top:-22px;left:50%;height:22px;border-left:1.5px solid var(--fill2)}
.slot{min-height:46px;width:220px;padding:6px 12px;border:0;border-radius:14px;background:var(--panel);display:flex;align-items:center;gap:12px;text-align:left;font-size:14px}
.slot .who{display:grid;line-height:1.3}.slot .who i{font-style:normal;font-size:12px;color:var(--label2)}
.slot.you{min-height:62px;padding:10px 14px;background:var(--pass-t)}
button.slot{cursor:grab}
.slot.empty{justify-content:center;background:transparent;outline:1.5px dashed var(--fill2);outline-offset:-1.5px;color:var(--label3);font-size:13px}
.drop.over{outline:2px dashed var(--pass);outline-offset:-2px;background:var(--pass-t);color:var(--pass);font-weight:600}
.areas{display:flex;flex-wrap:wrap;justify-content:center;gap:8px;padding-top:12px;margin-top:22px;position:relative;align-self:stretch}
.areas::before{content:"";position:absolute;top:-22px;left:50%;height:22px;border-left:1.5px solid var(--fill2)}
.areas::after{content:"";position:absolute;top:0;left:100px;right:100px;border-top:1.5px solid var(--fill2)}
.area{width:200px;padding:10px;border-radius:14px;background:var(--panel);display:flex;flex-direction:column;gap:8px;position:relative}
.area::before{content:"";position:absolute;top:-12px;left:50%;height:12px;border-left:1.5px solid var(--fill2)}
.area .ah{display:flex;align-items:center;gap:6px;padding:2px 4px;font-size:14px;font-weight:600}
.area .ah span{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.area .ah details{position:relative}
.area .ah summary{list-style:none;cursor:pointer;color:var(--label3);font-weight:700;letter-spacing:.05em;padding:0 4px}
.area .ah summary::-webkit-details-marker{display:none}
.area .ah .menu{position:absolute;right:0;top:20px;z-index:3;display:grid;min-width:150px;padding:6px;border-radius:10px;background:var(--raised);box-shadow:var(--sh4)}
.area .ah .menu button{border:0;background:none;text-align:left;padding:7px 9px;border-radius:7px;font-size:13px;cursor:pointer}
.area .ah .menu button:hover{background:var(--fill)}
.area .s{width:auto;min-height:52px;padding:8px 10px;gap:10px;border-radius:10px;background:var(--card)}
.area .s.empty{background:transparent;font-size:12.5px}
.area.new{min-height:176px;align-items:center;justify-content:center;text-align:center;gap:6px;background:transparent;outline:1.5px dashed var(--fill2);outline-offset:-1.5px;color:var(--label2);font-size:12.5px;padding:16px;border:0;cursor:pointer}
.area.new b{font-size:14px;color:var(--pass);display:grid;justify-items:center;gap:4px}
.area.new::before{display:none}
.area form{display:grid;gap:8px;width:100%}
.area input,.dlg input[type=text],.join input[type=text],.start input{height:36px;padding:0 10px;border-radius:9px;border:0;background:var(--card);box-shadow:inset 0 0 0 1.5px var(--fill2);font-size:14px;width:100%}
.area input:focus,.dlg input:focus,.join input:focus,.start input:focus{outline:0;box-shadow:inset 0 0 0 1.5px var(--pass)}
.side{display:grid;gap:8px;align-content:start}
.side .t{font-size:12.5px;font-weight:600;color:var(--label3)}
.side .slot{width:auto}
.tag{margin-top:18px;font-size:12.5px;color:var(--label3)}

/* The role dialog */
dialog.dlg{width:480px;max-width:calc(100vw - 32px);padding:24px 26px 20px;border:0;border-radius:18px;background:var(--raised);color:var(--label);box-shadow:var(--sh4)}
dialog.dlg::backdrop{background:var(--scrim)}
.dlg .hd{display:flex;gap:14px;align-items:center}
.dlg h2{font-size:19px}
.dlg .sub{margin-top:3px;font-size:13.5px;color:var(--label2)}
.check{display:flex;align-items:center;gap:10px;margin-top:16px;padding:10px 12px;border-radius:10px;background:var(--panel);font-size:13.5px;color:var(--label2)}
.check .code{background:var(--card)}
.roles{display:grid;grid-template-columns:repeat(4,1fr);margin-top:16px;padding:3px;border-radius:10px;background:var(--fill)}
.roles button{border:0;background:none;height:32px;border-radius:8px;font-size:13.5px;font-weight:500;cursor:pointer;color:var(--label)}
.roles button[aria-pressed=true]{background:var(--card);box-shadow:var(--sh1);font-weight:600}
.checks{margin:12px 0 4px;display:grid}
.ck{display:flex;gap:12px;align-items:flex-start;padding:8px 4px;font-size:14.5px;cursor:pointer}
.ck input{appearance:none;flex:none;width:20px;height:20px;margin:1px 0 0;border-radius:6px;box-shadow:inset 0 0 0 1.5px var(--fill2);display:grid;place-items:center;cursor:pointer}
.ck input:checked{background:var(--accent);box-shadow:none}
.ck input:checked::after{content:"";width:9px;height:5px;margin-top:-3px;border-left:2px solid #fff;border-bottom:2px solid #fff;transform:rotate(-45deg)}
.ck input:disabled{background:var(--fill2);cursor:default}
.ck.locked{color:var(--label2);cursor:default}
.ck i{display:block;font-style:normal;font-size:12.5px;color:var(--label3);margin-top:1px}
.dlg .area-pick{display:flex;align-items:center;gap:10px;margin-top:6px;font-size:13.5px;color:var(--label2)}
.dlg select{height:32px;border-radius:8px;border:0;background:var(--fill);padding:0 8px;font:inherit;color:var(--label)}
.dlg .seen{margin-top:6px;font-size:13px;color:var(--label2)}
.dlg .btns{display:flex;align-items:center;justify-content:flex-end;gap:10px;margin-top:16px}
.dlg .btns .left{margin-right:auto}
.dlg .btns .left.danger{color:var(--red)}

/* The dev's side: Join, waiting, joined, and a team that ended */
.dev{width:640px;max-width:calc(100vw - 32px);margin:24px auto 48px}
.dev.own{margin:28px 0 0}
.from{display:flex;gap:14px;align-items:center}
.from h1{font-size:26px}
.from .who{font-size:13.5px;color:var(--label2);margin-top:3px}
.box2{margin-top:16px;border-radius:14px;background:var(--panel);overflow:hidden}
.box2 .bh{padding:13px 18px 5px;font-size:13px;font-weight:600;color:var(--label2)}
.rowi{display:flex;align-items:center;gap:12px;padding:11px 18px;border-top:.5px solid var(--sep);font-size:14.5px}
.box2 .bh+.rowi{border-top:0}
.rowi .grow{flex:1;display:grid;line-height:1.3;min-width:0}.rowi .grow i{font-style:normal;font-size:12.5px;color:var(--label2)}
.ok{color:var(--green);font-weight:600;font-size:13.5px}
.bad{color:var(--red);font-weight:600;font-size:13.5px}
.sw{appearance:none;width:42px;height:26px;margin:0;border-radius:13px;background:var(--fill2);position:relative;flex:none;cursor:pointer}
.sw::after{content:"";position:absolute;top:2px;left:2px;width:22px;height:22px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:left .15s}
.sw:checked{background:#34C759}.sw:checked::after{left:18px}
.pj{display:inline-grid;place-items:center;width:26px;height:26px;border-radius:7px;font:700 11px/1 var(--sans);color:#fff;flex:none}
.sees,.acts-li{display:grid;gap:6px;padding:2px 18px 14px;font-size:14px}
.sees div,.acts-li div{display:flex;gap:10px;align-items:flex-start}
.y{color:var(--green);font-weight:700;width:14px;flex:none}.n{color:var(--label3);font-weight:700;width:14px;flex:none}
.devfoot{display:flex;align-items:center;gap:10px;margin-top:18px}
.devfoot .fine{flex:1;font-size:13px;color:var(--label3)}
.wait{width:520px;max-width:calc(100vw - 32px);margin:110px auto 48px;text-align:center;display:flex;flex-direction:column;align-items:center;gap:12px}
.wait .lede{max-width:440px}
.unsaved{margin:0 0 14px;padding:10px 14px;border-radius:10px;font-size:14px;font-weight:600;color:var(--red);background:color-mix(in srgb,var(--red) 10%,transparent)}
.bigcode{margin-top:10px;padding:18px 26px 16px;border-radius:16px;background:var(--panel);display:grid;gap:6px}
.bigcode b{font:600 34px/1 var(--mono);letter-spacing:.12em}
.bigcode span{font-size:13px;color:var(--label2)}
.pending{display:flex;align-items:center;gap:8px;margin-top:6px;font-size:13.5px;color:var(--label2)}
.spin{width:14px;height:14px;border-radius:50%;border:2px solid var(--fill2);border-top-color:var(--pass);animation:spin 1s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation:none}}
.badge{display:inline-flex;align-items:center;height:24px;padding:0 9px;border-radius:7px;background:var(--pass-t);color:var(--pass);font-size:13px;font-weight:600}
.start{display:grid;gap:12px;margin-top:18px}
.start label{display:grid;gap:6px;font-size:13px;font-weight:600;color:var(--label2)}
.start .fine{font-size:12.5px;font-weight:400;color:var(--label3)}
.off{font-size:13px;color:var(--label2)}

@media (max-width:900px){
  .lead{grid-template-columns:1fr;gap:20px;padding:16px}
  .drawer{position:static}
  .chart{grid-template-columns:1fr}
  .areas::after{display:none}
}
`;

// ---- the pieces ----

const PROJECT_COLORS = ['#0A84FF', '#30A46C', '#8E4EC6', '#D9822B', '#E5484D', '#636366'];
const pj = (p, i) => `<span class="pj" style="background:${PROJECT_COLORS[i % PROJECT_COLORS.length]}" aria-hidden="true">${e(String(p.title || '?').slice(0, 2).toLowerCase())}</span>`;
const threads = (n) => (typeof n === 'number' ? `${n} ${n === 1 ? 'thread' : 'threads'}` : 'Threads not checked');

function linkCard(links, now) {
  const l = links[0];
  if (!l) {
    return `<div class="linkcard"><div class="row"><div class="field">No open link</div><button class="btn primary" data-op="invite">Make a link</button></div>
      <div class="fine"><span>A link works for 7 days. Anyone with it can ask to join, and you add each one. The link alone reads nothing.</span></div></div>`;
  }
  return `<div class="linkcard"><div class="row"><input class="field" readonly value="${e(l.link)}" aria-label="Invite link" id="link"><button class="btn primary" data-copy="#link">Copy link</button></div>
    <div class="fine"><span>Works until ${e(day(l.until))}. Anyone with it can ask to join, and you add each one. The link alone reads nothing.</span><button class="lnk" data-op="invite">New link</button></div></div>`;
}

function drawer(v, now) {
  const asks = v.pending || [];
  return `<aside class="drawer" aria-label="Asking to join">
    <div class="hd">Asking to join<span class="n">${asks.length}</span></div>
    <p class="sub">${asks.length ? 'Drag someone onto the chart.' : 'No one is waiting. Send the link.'}</p>
    ${asks.map((a) => `<button type="button" class="chip" draggable="true" data-ask="${e(a.m)}" title="Add ${e(a.name)}">${av(a)}<span class="who">${e(a.name)}<i>${e(a.projects.length ? a.projects.join(', ') : 'No projects named')} · ${e(ago(a.at, now))}</i></span><span class="code" title="Their screen shows the same code">${e(a.code)}</span></button>`).join('')}
    ${asks.length ? '<p class="hint">Check the code with them before you add them. Their screen shows the same six digits.</p>' : ''}
  </aside>`;
}

const roleLine = (p) => (p.role === 'viewer' ? 'Sees, sends no summary' : ROLE_NAMES[p.role] || 'Not checked');
const member = (p, cls = '') => `<button type="button" class="slot ${cls}" draggable="true" data-member="${e(p.id)}" title="Change ${e(p.name)}'s role">${av(p)}<span class="who">${e(p.name)}<i>${e(roleLine(p))}</i></span></button>`;
const drop = (label, role, area = '', cls = '') => `<div class="slot empty drop ${cls}" data-drop="${role}" data-area="${e(area)}">${e(label)}</div>`;

function chart(v) {
  const people = v.people.filter((p) => p.id !== v.me.id);
  const lead = v.people.find((p) => p.role === 'lead') || v.me;
  const by = (role, area) => people.filter((p) => p.role === role && (area === undefined || (p.area || '') === area));
  const deputies = by('deputy');
  const loose = people.filter((p) => (p.role === 'owner' || p.role === 'engineer') && !p.area);
  const areaCard = (a) => {
    const owners = by('owner', a.id), engineers = by('engineer', a.id);
    return `<div class="area" data-area-id="${e(a.id)}"><div class="ah"><span title="${e(a.name)}">${e(a.name)}</span>
      <details><summary aria-label="${e(a.name)} options">⋯</summary><div class="menu"><button type="button" data-rename="${e(a.id)}">Rename</button><button type="button" data-op="removeArea" data-id="${e(a.id)}">Remove area</button></div></details></div>
      ${owners.map((p) => member(p, 's')).join('') || drop('Drop an area owner', 'owner', a.id, 's')}
      ${engineers.map((p) => member(p, 's')).join('')}
      ${drop('Drop an engineer', 'engineer', a.id, 's')}</div>`;
  };
  return `<div class="chart">
    <div class="tree">
      <div class="tier"><div class="slot you">${av(lead)}<span class="who">${lead.id === v.me.id ? 'You' : e(lead.name)}<i>Lead</i></span></div></div>
      <div class="tier">${deputies.map((p) => member(p)).join('')}${drop('Drop a deputy', 'deputy')}</div>
      <div class="areas">
        ${v.areas.map(areaCard).join('')}
        ${loose.length ? `<div class="area"><div class="ah"><span>No area</span></div>${loose.map((p) => member(p, 's')).join('')}</div>` : ''}
        <button type="button" class="area new" data-new-area><b>${use('plus', 18, 18)}Add area</b><span>A kind of work, like site, data or design, with its own area owner</span></button>
      </div>
      <p class="tag">Areas hold names only until Rules gives them their projects and mode.</p>
    </div>
    <div class="side"><span class="t">Viewer</span>${by('viewer').map((p) => member(p)).join('')}${drop('Drop a viewer', 'viewer')}</div>
  </div>`;
}

function leadPage(v, links, now, own = '') {
  return `<div class="lead">${drawer(v, now)}<main>
    <h1 class="ih"><span class="logo">${use('person-plus', 36, 36)}</span>Invite your team</h1>
    <p class="lede">Send the link any way you like. Each dev connects their own T3 Code, picks the projects to share, and asks to join.</p>
    ${linkCard(links, now)}
    ${chart(v)}
    ${own}
  </main></div>`;
}

function projectRows(projects, shared, name = 'share') {
  if (!projects.length) return '<div class="rowi"><span class="grow"><i>No projects checked yet. Yes Chef reads them from T3 Code.</i></span></div>';
  const on = new Set(shared);
  return projects.map((p, i) => `<label class="rowi">${pj(p, i)}<div class="grow">${e(p.title)}<i>${e(threads(p.threads))}</i></div><input type="checkbox" class="sw" name="${name}" value="${e(p.id)}"${on.has(p.id) ? ' checked' : ''} aria-label="Share ${e(p.title)}"></label>`).join('');
}

const SEES = `<div class="box2"><div class="bh">What the team sees from shared projects</div><div class="sees">
  <div><span class="y">✓</span>Each thread's title, stage and pull requests</div>
  <div><span class="y">✓</span>How many agents are working, and whether a thread waits on you</div>
  <div><span class="n">✕</span>Your messages, code, diffs and file names, and every project you leave off</div></div></div>`;

function t3Row(t3) {
  return `<div class="box2"><div class="rowi"><span class="logo cl">${use('cloche', 31, 31)}</span><div class="grow">T3 Code on this Mac<i>${t3.ok
    ? 'Connected. Yes Chef reads it; teammates\' actions go through your own sign-in.'
    : 'Not checked. Yes Chef could not read T3 Code just now.'}</i></div>${t3.ok ? '<span class="ok">Connected</span>' : '<span class="bad">Not checked</span>'}</div></div>`;
}

function joinPage(inv, projects, t3, now) {
  const lead = inv.leadName || 'The lead';
  return `<form class="dev join" data-form="join"><input type="hidden" name="link" value="${e(inv.raw || '')}">
    <div class="from">${av({ id: inv.leadSignPub, name: lead }, 'xl')}<div><h1>Join ${e(inv.teamName || 'the team')}</h1><p class="who">${e(lead)} invited you. Nothing is shared until ${e(first(lead))} adds you.</p></div></div>
    <div class="box2"><div class="bh">Your name</div><div class="rowi"><input type="text" name="name" maxlength="60" required autocomplete="name" aria-label="Your name"></div><div class="rowi" style="border-top:0;padding-top:0"><span class="grow"><i>Your team sees this name next to your tickets.</i></span></div></div>
    ${t3Row(t3)}
    <div class="box2"><div class="bh">Share these projects with the team</div>${projectRows(projects, [])}</div>
    ${SEES}
    <p class="err" role="alert"></p>
    <div class="devfoot"><span class="fine">This invite works until ${e(day(inv.until))}.</span><button type="button" class="btn" data-op="forgetLink">Not now</button><button class="btn primary"${t3.ok ? '' : ' disabled'}>Ask to join</button></div>
  </form>`;
}

function waitingPage(v, projects) {
  const lead = v.leadName || 'The lead';
  const names = (v.asked || []).length ? and(v.asked) : 'Your projects';
  return `<div class="wait">
    <span class="logo">${use('person-plus', 36, 36)}</span>
    <h1>Asked to join ${e(v.teamName || 'the team')}</h1>
    <p class="lede">${e(lead)} adds each person. Yes Chef tells you when you're in, and you can close this window.</p>
    ${v.code ? `<div class="bigcode"><b>${e(v.code)}</b><span>${e(first(lead))} sees this code next to your name. Read it out if ${e(first(lead))} asks.</span></div>` : ''}
    <p class="pending"><span class="spin" aria-hidden="true"></span>${v.link === 'online' ? `Waiting for ${e(first(lead))}. ${e(names)} ${(v.asked || []).length === 1 ? 'is' : 'are'} shared once you're in.` : 'Not checked: Yes Chef is not connected to the team right now. It tries again on its own.'}</p>
    <button type="button" class="lnk" data-op="leave" data-confirm="Forget this ask on this Mac? The lead may still see it until the invite ends. Nothing is shared either way.">Forget this ask</button>
  </div>`;
}

const sharingBox = (me, projects, shared) => (me.role === 'viewer'
  ? '<div class="box2"><div class="bh">Sharing</div><div class="rowi"><span class="grow"><i>A Viewer shares nothing with the team.</i></span></div></div>'
  : `<form class="box2" data-form="share"><div class="bh">Sharing</div>${projectRows(projects, shared)}</form>`);

/** A member who may invite (a Deputy by default) keeps their own sharing switches under the chart (PR-Agent r1 on #8). */
function ownSharing(v, projects, shared) {
  if (v.lead) return '';
  return `<div class="dev own">${sharingBox(v.me, projects, shared)}
    <p class="err" role="alert"></p>
    ${v.me.role === 'viewer' ? '' : `<div class="devfoot"><span class="fine">Stop sharing takes your tickets off the team's board at once.</span><button type="button" class="btn" data-op="share">Stop sharing</button></div>`}
  </div>`;
}

function joinedPage(v, projects, shared) {
  const me = v.me;
  const lead = v.people.find((p) => p.role === 'lead');
  const mine = new Set(me.perms || []);
  const can = PERMS.filter((p) => mine.has(p.key));
  const actors = v.people.filter((p) => p.id !== me.id && (p.perms || []).some((k) => k === 'reply' || k === 'merge'));
  const area = v.areas.find((a) => a.id === me.area);
  const boss = me.under ? v.people.find((p) => p.id === me.under) : null;
  return `<div class="dev">
    <div class="from">${av(lead || { name: v.leadName })}<div><h1>You're on ${e(v.teamName || 'the team')}</h1><p class="who">${e(lead?.name || v.leadName || 'The lead')} added you as <span class="badge">${e(ROLE_NAMES[me.role] || 'Not checked')}</span>${area ? ` in ${e(area.name)}` : ''}${boss && boss.id !== lead?.id ? `, reporting to ${e(boss.name)}` : ''}</p></div></div>
    <div class="box2"><div class="bh">Your role lets you</div><div class="acts-li">
      ${can.map((p) => `<div><span class="y">✓</span>${e(p.label)}</div>`).join('')}
      <div class="muted">Ask ${e(first(lead?.name || v.leadName))} for more.</div></div></div>
    <div class="box2"><div class="bh">Who can act on your threads</div><div class="acts-li">
      <div>${actors.length ? `${e(and(actors.map((p) => `${p.name} (${ROLE_NAMES[p.role]})`)))} can act on your tickets. What they send lands in your thread with their name on it.` : 'No one else can act on your tickets.'}</div>
      <div class="muted">Your Yes Chef checks their role, and that the thread is in a project you share, before it sends anything.</div></div></div>
    ${sharingBox(me, projects, shared)}
    <p class="err" role="alert"></p>
    <div class="devfoot"><span class="fine">Stop sharing takes your tickets off the team's board at once.</span>${me.role === 'viewer' ? '' : '<button type="button" class="btn" data-op="share">Stop sharing</button>'}<a class="btn primary" href="/">Open The Pass</a></div>
  </div>`;
}

const ENDED = {
  declined: ['The lead did not add you', 'Your ask to join was declined. Nothing was shared.'],
  removed: ['You are off the team', 'The lead took you off the team. Yes Chef stopped sharing and dropped the team key.'],
  ended: ['The team was deleted', 'The lead deleted the team. Yes Chef stopped sharing and dropped the team key.'],
};
function endedPage(v) {
  const [title, text] = ENDED[v.status] || ENDED.ended;
  return `<div class="wait"><span class="logo">${use('person-plus', 36, 36)}</span><h1>${e(title)}</h1><p class="lede">${e(text)}</p>
    <button type="button" class="btn" data-op="leave">OK</button></div>`;
}

function startPage({ relay, name }) {
  return `<div class="dev">
    <h1 class="ih"><span class="logo">${use('person-plus', 36, 36)}</span>Your team</h1>
    <p class="lede">Make a team and send the link, or open a link a lead sent you.</p>
    <form class="box2 start" data-form="create" style="padding:16px 18px">
      <label>Team name<input type="text" name="teamName" maxlength="80" required></label>
      <label>Your name<input type="text" name="name" maxlength="60" required autocomplete="name" value="${e(name || '')}"></label>
      <label>Relay<input type="text" name="relay" value="${e(relay)}" inputmode="url" spellcheck="false"><span class="fine">Yes Chef's relay passes sealed summaries between your team's Macs and cannot read them. A team can run its own.</span></label>
      <div class="devfoot" style="margin-top:4px"><span class="fine"></span><button class="btn primary">Make a team</button></div>
    </form>
    <form class="box2 start" data-form="openLink" style="padding:16px 18px">
      <label>Invite link<input type="text" name="link" required spellcheck="false" placeholder="${e(SITE)}/join#…"></label>
      <div class="devfoot" style="margin-top:4px"><span class="fine">The link opens Join. Nothing is shared until the lead adds you.</span><button class="btn">Open</button></div>
    </form>
    <p class="err" role="alert"></p>
  </div>`;
}

/** The team page's body for one state. view: the team client's view() or null. join: a read invite the dev opened,
 *  or null. projects: [{ id, title, threads }]. shared: this dev's shared project ids. t3: { ok }. */
export function teamBody({ lost = '', view = null, join = null, links = [], projects = [], shared = [], t3 = { ok: false }, relay = DEFAULT_RELAY, now = Date.now(), name = '' } = {}) {
  if (lost) {
    return `<div class="wait"><span class="logo">${use('person-plus', 36, 36)}</span><h1>Your team: not checked</h1><p class="lede">Yes Chef could not read the team saved on this Mac (${e(lost)}). It is still there, untouched. Quit Yes Chef and start it again; macOS may ask to let Yes Chef use its Keychain key.</p></div>`;
  }
  if (!view) return join ? joinPage(join, projects, t3, now) : startPage({ relay, name });
  if (view.status === 'pending') return waitingPage(view, projects);
  if (view.status !== 'member') return endedPage(view);
  // The team's last change did not reach the disk: after a restart this Mac could read an older team (PR-Agent r4 on
  // public #7). Said above the page, in plain words.
  const warn = view.unsaved ? `<p class="unsaved" role="alert">Not saved: Yes Chef could not save the team's latest change on this Mac. It is in use now; check the disk and the Keychain, then restart Yes Chef.</p>` : '';
  if (view.lead || (view.me.perms || []).includes('invite')) return warn + leadPage(view, links, now, ownSharing(view, projects, shared));
  return warn + joinedPage(view, projects, shared);
}

// The page script. It runs in the page, so it is written here as a function and sent as its source: no template-literal
// escapes to get wrong (server.mjs's page script has that trap).
function pageScript() {
  var data = JSON.parse(document.getElementById('yc-team-data').textContent);
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var busy = false, dragging = null, queued = null;
  function post(body) {
    if (window.yeschef && typeof window.yeschef.act === 'function') return window.yeschef.act(body);
    return fetch('/act', { method: 'POST', body: body }).then(function (r) { return r.text().then(function (t) { return [r.status, t]; }); });
  }
  function say(text) { var el = $('.err'); if (el) el.textContent = text || ''; else if (text) alert(text); }
  // A sharing change made while another action runs is kept (the latest one) and sent next (PR-Agent r1 on #8).
  function next() { var q = queued; queued = null; return q ? act(q) : null; }
  function act(fields) {
    if (busy) { if (fields.op === 'share') queued = fields; return Promise.resolve(); }
    busy = true; say('');
    var q = new URLSearchParams({ kind: 'team' });
    Object.keys(fields).forEach(function (k) { if (fields[k] != null) q.append(k, Array.isArray(fields[k]) ? fields[k].join(',') : String(fields[k])); });
    return post(q.toString()).then(function (r) {
      busy = false;
      if (r[0] !== 200) { say(r[1] || 'Not done.'); return next() || false; }
      return next() || refresh(true);
    }, function () { busy = false; say('Not done: Yes Chef did not answer.'); return next() || false; });
  }
  function refresh(force) {
    if (!force && (busy || dragging || (dlg && dlg.open) || document.activeElement && /INPUT|SELECT/.test(document.activeElement.tagName) || $('details[open]'))) return Promise.resolve();
    return fetch('/team' + location.search, { cache: 'no-store' }).then(function (r) { return r.ok ? r.text() : null; }).then(function (h) {
      if (!h) return;
      var doc = new DOMParser().parseFromString(h, 'text/html');
      var next = doc.getElementById('yc-team'), d = doc.getElementById('yc-team-data');
      if (next) document.getElementById('yc-team').replaceWith(next);
      if (d) data = JSON.parse(d.textContent);
      return true;
    }, function () {});
  }
  setInterval(refresh, 2500);

  // The role dialog: opened by a drop, a click on an ask, or a click on a member.
  var dlg = $('#role-dlg');
  var pick = null; // { m, ask: bool, role, area }
  function boxes(role, perms) {
    var on = new Set(perms || data.defaults[role] || ['see']);
    $('.checks', dlg).innerHTML = data.perms.map(function (p) {
      var locked = p.key === 'see';
      return '<label class="ck' + (locked ? ' locked' : '') + '"><input type="checkbox" value="' + p.key + '"' + (on.has(p.key) || locked ? ' checked' : '') + (locked ? ' disabled' : '') + '><div>' + esc(p.label) + (p.hint ? '<i>' + esc(p.hint) + '</i>' : '') + '</div></label>';
    }).join('');
  }
  // Also quotes: esc() feeds attribute values too (PR-Agent r1 on #8).
  function esc(s) { var d = document.createElement('div'); d.textContent = String(s == null ? '' : s); return d.innerHTML.replace(/"/g, '&quot;').replace(/'/g, '&#39;'); }
  function setRole(role, perms) {
    pick.role = role;
    Array.prototype.forEach.call(dlg.querySelectorAll('.roles button'), function (b) { b.setAttribute('aria-pressed', String(b.dataset.role === role)); });
    boxes(role, perms);
    var ap = $('.area-pick', dlg), sel = $('select', ap);
    var inArea = (role === 'owner' || role === 'engineer') && data.areas.length;
    ap.hidden = !inArea;
    // The options follow the latest data: an area added since the page loaded is there (PR-Agent r1 on #8).
    sel.textContent = '';
    sel.appendChild(new Option('No area', ''));
    data.areas.forEach(function (a) { sel.appendChild(new Option(a.name, a.id)); });
    if (inArea) sel.value = pick.area && data.areas.some(function (a) { return a.id === pick.area; }) ? pick.area : '';
  }
  function open(m, role, area) {
    var ask = data.pending.filter(function (a) { return a.m === m; })[0];
    var person = data.people.filter(function (p) { return p.id === m; })[0];
    if (!ask && !person) return;
    var who = ask || person;
    pick = { m: m, ask: !!ask, role: role || (person ? person.role : 'engineer'), area: area != null ? area : (person ? person.area : '') };
    var her = who.name.split(/\s+/)[0];
    $('.av', dlg).className = 'av lg ' + (document.querySelector('[data-ask="' + m + '"] .av, [data-member="' + m + '"] .av') || { className: 'av c1' }).className.split(' ').filter(function (c) { return /^c\d$/.test(c); }).join(' ');
    $('.av', dlg).textContent = who.name.split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase();
    $('h2', dlg).textContent = ask ? 'Add ' + who.name + ' to ' + data.teamName + '?' : who.name + "'s role";
    $('.sub', dlg).textContent = ask
      ? (ask.projects.length ? her + ' shares ' + ask.projects.length + (ask.projects.length === 1 ? ' project' : ' projects') + ' from their Mac: ' + ask.projects.join(', ') + '.' : her + ' named no projects to share yet.')
      : 'On ' + data.teamName + ' as ' + (data.roleNames[person.role] || 'Not checked') + '.';
    var ck = $('.check', dlg);
    ck.hidden = !ask;
    if (ask) $('.code', ck).textContent = ask.code;
    $('.seen', dlg).textContent = her + ' sees the role on their Mac, and can stop sharing any time.';
    $('[data-go]', dlg).textContent = ask ? 'Add to team' : 'Save';
    var left = $('.btns .left', dlg);
    left.textContent = ask ? 'Decline' : 'Remove from team';
    left.classList.toggle('danger', !ask);
    setRole(pick.role, person && pick.role === person.role ? person.perms : null);
    dlg.showModal();
  }
  if (dlg) {
    dlg.addEventListener('click', function (ev) {
      var r = ev.target.closest('.roles button');
      if (r) { setRole(r.dataset.role); return; }
      if (ev.target.closest('[data-cancel]')) { dlg.close(); return; }
      if (ev.target.closest('.btns .left')) {
        var gone = pick.ask ? { op: 'decline', m: pick.m } : { op: 'remove', m: pick.m };
        if (!pick.ask && !confirm('Take this person off the team? Their Yes Chef stops sharing and drops the team key.')) return;
        dlg.close(); act(gone); return;
      }
      if (ev.target.closest('[data-go]')) {
        var perms = Array.prototype.filter.call(dlg.querySelectorAll('.checks input'), function (i) { return i.checked; }).map(function (i) { return i.value; });
        var area = $('.area-pick', dlg).hidden ? '' : $('.area-pick select', dlg).value;
        dlg.close();
        act({ op: pick.ask ? 'approve' : 'setRole', m: pick.m, role: pick.role, perms: perms, area: area });
      }
    });
  }

  // Drag an ask or a member onto a slot; or click one to open the dialog.
  document.addEventListener('dragstart', function (ev) {
    var c = ev.target.closest && ev.target.closest('[data-ask],[data-member]');
    if (!c) return;
    dragging = c.dataset.ask || c.dataset.member;
    ev.dataTransfer.setData('text/plain', dragging);
    ev.dataTransfer.effectAllowed = 'move';
    setTimeout(function () { c.classList.add('lifted'); }, 0);
  });
  document.addEventListener('dragend', function (ev) {
    var c = ev.target.closest && ev.target.closest('[data-ask],[data-member]');
    if (c) c.classList.remove('lifted');
    dragging = null;
    Array.prototype.forEach.call(document.querySelectorAll('.drop.over'), function (d) { d.classList.remove('over'); });
  });
  document.addEventListener('dragover', function (ev) {
    var d = ev.target.closest && ev.target.closest('[data-drop]');
    if (!d || !dragging) return;
    ev.preventDefault();
    ev.dataTransfer.dropEffect = 'move';
    Array.prototype.forEach.call(document.querySelectorAll('.drop.over'), function (x) { if (x !== d) x.classList.remove('over'); });
    d.classList.add('over');
  });
  document.addEventListener('dragleave', function (ev) { var d = ev.target.closest && ev.target.closest('[data-drop]'); if (d && !d.contains(ev.relatedTarget)) d.classList.remove('over'); });
  document.addEventListener('drop', function (ev) {
    var d = ev.target.closest && ev.target.closest('[data-drop]');
    if (!d) return;
    ev.preventDefault();
    d.classList.remove('over');
    var m = ev.dataTransfer.getData('text/plain') || dragging;
    dragging = null;
    open(m, d.dataset.drop, d.dataset.area || '');
  });

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    var c = t.closest('[data-ask],[data-member]');
    if (c) { open(c.dataset.ask || c.dataset.member); return; }
    var cp = t.closest('[data-copy]');
    if (cp) {
      var f = $(cp.dataset.copy);
      f.select();
      (navigator.clipboard ? navigator.clipboard.writeText(f.value) : Promise.reject()).then(function () { cp.textContent = 'Copied'; setTimeout(function () { cp.textContent = 'Copy link'; }, 1500); }, function () { document.execCommand('copy'); });
      return;
    }
    var na = t.closest('[data-new-area]');
    if (na) {
      na.outerHTML = '<div class="area new"><form data-form="addArea"><input type="text" name="name" maxlength="40" placeholder="Area name" aria-label="Area name" required><button class="btn sm primary">Add area</button></form></div>';
      $('[data-form=addArea] input').focus();
      return;
    }
    var rn = t.closest('[data-rename]');
    if (rn) {
      var a = data.areas.filter(function (x) { return x.id === rn.dataset.rename; })[0];
      var head = rn.closest('.ah');
      head.innerHTML = '<form data-form="renameArea" style="display:grid;gap:6px;width:100%"><input type="hidden" name="id" value="' + esc(a.id) + '"><input type="text" name="name" maxlength="40" value="' + esc(a.name) + '" aria-label="Area name" required><button class="btn sm primary">Rename</button></form>';
      $('input[name=name]', head).focus();
      return;
    }
    var op = t.closest('[data-op]');
    if (op) {
      if (op.dataset.confirm && !confirm(op.dataset.confirm)) return;
      var f2 = { op: op.dataset.op };
      if (op.dataset.id) f2.id = op.dataset.id;
      if (f2.op === 'share') f2.shared = [];
      act(f2).then(function (ok) { if (ok && f2.op === 'forgetLink') location.href = '/team'; });
    }
  });

  document.addEventListener('submit', function (ev) {
    var f = ev.target.closest('[data-form]');
    if (!f) return;
    ev.preventDefault();
    var fd = new FormData(f), out = { op: f.dataset.form };
    fd.forEach(function (v, k) { if (k === 'share') return; out[k] = v; });
    if (f.dataset.form === 'join') out.shared = fd.getAll('share');
    if (f.dataset.form === 'openLink') { location.href = '/team?join=' + encodeURIComponent(String(out.link).split('#')[1] || out.link); return; }
    act(out);
  });
  // A switch on the joined screen saves at once.
  document.addEventListener('change', function (ev) {
    var f = ev.target.closest('[data-form=share]');
    if (!f) return;
    act({ op: 'share', shared: new FormData(f).getAll('share') });
  });
}

/** The whole team page. data: what the dialog needs (asks, people, areas, the boxes). */
export function teamPage(opts = {}) {
  const v = opts.view;
  const data = {
    teamName: v?.teamName || '', pending: v?.pending || [], areas: v?.areas || [],
    people: (v?.people || []).map(({ id, name, role, perms, area }) => ({ id, name, role, perms, area })),
    perms: PERMS.map(({ key, label, hint }) => ({ key, label, hint: hint || '' })), defaults: DEFAULTS, roleNames: ROLE_NAMES,
  };
  const dialog = `<dialog class="dlg" id="role-dlg" aria-labelledby="role-h">
    <div class="hd"><span class="av lg c1"></span><div><h2 id="role-h"></h2><p class="sub"></p></div></div>
    <div class="check">Their code<span class="code"></span>Check it matches their screen.</div>
    <div class="roles" role="group" aria-label="Role">${['deputy', 'owner', 'engineer', 'viewer'].map((r) => `<button type="button" data-role="${r}" aria-pressed="false">${ROLE_NAMES[r]}</button>`).join('')}</div>
    <div class="checks"></div>
    <label class="area-pick" hidden>Area<select><option value="">No area</option>${(v?.areas || []).map((a) => `<option value="${e(a.id)}">${e(a.name)}</option>`).join('')}</select></label>
    <p class="seen"></p>
    <div class="btns"><button type="button" class="lnk left"></button><button type="button" class="btn" data-cancel>Not now</button><button type="button" class="btn primary" data-go>Add to team</button></div>
  </dialog>`;
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark"><title>Your team · Yes Chef</title><style>${TEAM_CSS}</style></head><body>
${ICONS}
<div class="top"><a class="back" href="/">${use('back', 10, 16)}The Pass</a></div>
<div id="yc-team">${teamBody(opts)}</div>
${dialog}
<script type="application/json" id="yc-team-data">${JSON.stringify(data).replace(/</g, '\\u003c')}</script>
<script>(${pageScript.toString()})();</script>
</body></html>`;
}

/** The fragment refresh swaps: the body and the dialog's data, from a fresh render. */
export { pageScript as _pageScript };
