// The before and after shots of the made-up "Retry failed payouts" ticket (payouts-*.png in this folder), which the
// site demo shows: site/scripts/generate-demo.ts copies them to site/public/demo/img/. The plate drawing comes from
// the site's old "Run the pass" demo (site/service.js until 2026-11-09). The PNGs exist because the app shows only
// raster screenshots.
//
// To redraw:
//   node tools/hero-art/plates.ts <dir>     writes <dir>/index.html and <dir>/fonts/figtree-latin-var.woff2
//   python3 -m http.server <port> --bind 127.0.0.1 --directory <dir>
//   tools/shoot.sh <port> <out> plates '[{"shotOf":"#dark-before","as":"payouts-before-dark"}, ...]'
// then copy the PNGs here and run npm run demo:generate --prefix site.
import { copyFileSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** One theme's colours. */
export interface Palette {
  bg: string; side: string; panel: string; panel2: string; rule: string; ink: string; ink2: string; ink3: string;
  blue: string; blueT: string; red: string; redT: string; green: string; greenT: string; amber: string; amberT: string; odd: string;
}
type Tone = 'red' | 'green' | 'amber';
/** `hl` marks what the agent changed; the after screen outlines it. */
interface Hl { hl?: boolean }
/** A block of a screen: its kind and its options. */
export type Block =
  | ['head', Hl & { title: string; button: string }]
  | ['table', Hl & { rows: number; cols: number; status?: string; action?: string }]
  | ['list', Hl & { items: number; tag?: string }]
  | ['search', Hl & { text: string }]
  | ['empty', Hl & { text: string; button?: string }]
  | ['blank', Hl]
  | ['banner', Hl & { text: string; tone: Tone }]
  | ['chart', Hl & { spike?: boolean; limit?: boolean }]
  | ['stats', Hl & { n: number }]
  | ['cards', Hl & { n: number; odd?: boolean; price?: boolean }]
  | ['form', Hl & { fields: number }]
  | ['skeleton', Hl & { rows: number }]
  | ['timing', Hl & { text: string; tone: Tone }]
  | ['email', Hl & ({ branded: false } | { branded: true; title: string; button: string })]
  | ['login', Hl & { code?: boolean }]
  | ['profile', Hl & { photo: boolean }]
  | ['checklist', Hl & { items: number }]
  | ['modal', Hl & { title: string }];
/** A made-up ticket: its page, the screen before and after, and the agent's summary. */
export interface Dish { page: string; did: string; before: Block[]; after: Block[] }
/** A drawn block and its height, or a modal drawn last, over the screen. */
type Drawn = [svg: string, height: number] | [svg: null, height: 0, overlay: { title: string }];
type Options<K extends Block[0]> = Extract<Block, [K, unknown]>[1];

/** The menu of the old demo. Blocks: [type, options]. */
export const DISHES: Record<string, Dish> = {
  "Team invites": { page: "Members", did: "Invites go out by email with a role picker; pending invites list under the team.",
    before: [["head", { title: "Members", button: "" }], ["table", { rows: 4, cols: 3 }]],
    after: [["head", { title: "Members", button: "Invite", hl: true }], ["table", { rows: 4, cols: 3 }], ["list", { items: 2, tag: "Pending", hl: true }]] },
  "Search by phone": { page: "Customers", did: "Search matches phone numbers in any format, digits only.",
    before: [["search", { text: "Search name or email" }], ["empty", { text: "No results for 555 0142" }]],
    after: [["search", { text: "555 0142", hl: true }], ["table", { rows: 2, cols: 3, hl: true }]] },
  "Retry failed payouts": { page: "Payouts", did: "Failed payouts retry three times with backoff; each row shows its retry state.",
    before: [["banner", { text: "3 payouts failed", tone: "red" }], ["table", { rows: 5, cols: 4, status: "Failed" }]],
    after: [["banner", { text: "3 payouts retried and paid", tone: "green", hl: true }], ["table", { rows: 5, cols: 4, status: "Paid", hl: true }]] },
  "Rate limits on webhooks": { page: "Webhooks", did: "Webhooks back off on 429 and the log shows the wait.",
    before: [["chart", { spike: true }], ["table", { rows: 4, cols: 3, status: "429" }]],
    after: [["chart", { spike: false, hl: true }], ["table", { rows: 4, cols: 3, status: "Delivered", hl: true }]] },
  "Empty states": { page: "Projects", did: "Every empty list now says what goes there and offers the first step.",
    before: [["head", { title: "Projects", button: "" }], ["blank", {}]],
    after: [["head", { title: "Projects", button: "" }], ["empty", { text: "No projects yet", button: "New project", hl: true }]] },
  "Weekly digest email": { page: "Email", did: "A Monday digest: the week's numbers and the three items that need a look.",
    before: [["email", { branded: false }]],
    after: [["email", { branded: true, title: "Your week", button: "Open dashboard", hl: true }]] },
  "Dark mode tokens": { page: "Settings", did: "Colours come from tokens, so dark mode covers every screen.",
    before: [["head", { title: "Appearance", button: "" }], ["cards", { n: 3, odd: true }], ["form", { fields: 2 }]],
    after: [["head", { title: "Appearance", button: "" }], ["cards", { n: 3, hl: true }], ["form", { fields: 2 }]] },
  "CSV export": { page: "Reports", did: "Any report exports to CSV with the filters you set.",
    before: [["head", { title: "Reports", button: "" }], ["table", { rows: 5, cols: 4 }]],
    after: [["head", { title: "Reports", button: "Export CSV", hl: true }], ["table", { rows: 5, cols: 4 }]] },
  "Audit log": { page: "Audit log", did: "Every admin change lands in the audit log with who, what and when.",
    before: [["empty", { text: "No audit trail" }]],
    after: [["search", { text: "Filter by person or action" }], ["list", { items: 5, tag: "Admin", hl: true }]] },
  "Fix login redirect": { page: "Sign in", did: "After sign-in you land on the page you asked for, not the dashboard.",
    before: [["login", {}], ["banner", { text: "Redirected to /dashboard", tone: "amber" }]],
    after: [["login", {}], ["banner", { text: "Back to /reports/q3", tone: "green", hl: true }]] },
  "Invoice PDFs": { page: "Billing", did: "Each invoice downloads as a PDF with your logo and tax details.",
    before: [["head", { title: "Invoices", button: "" }], ["table", { rows: 5, cols: 3 }]],
    after: [["head", { title: "Invoices", button: "" }], ["table", { rows: 5, cols: 3, action: "PDF", hl: true }]] },
  "Two-factor sign-in": { page: "Sign in", did: "Sign-in asks for a six-digit code when two-factor is on.",
    before: [["login", {}]],
    after: [["login", { code: true, hl: true }]] },
  "Slow orders query": { page: "Orders", did: "The orders list loads in 180 ms; one index and one fewer join.",
    before: [["timing", { text: "4.2 s", tone: "red" }], ["skeleton", { rows: 5 }]],
    after: [["timing", { text: "0.18 s", tone: "green", hl: true }], ["table", { rows: 5, cols: 4 }]] },
  "Keyboard shortcuts": { page: "Inbox", did: "Press ? for shortcuts; j and k move, e archives.",
    before: [["list", { items: 5 }]],
    after: [["list", { items: 5 }], ["modal", { title: "Keyboard shortcuts", hl: true }]] },
  "Avatar uploads": { page: "Profile", did: "Upload a photo, crop it, and it shows everywhere your name does.",
    before: [["profile", { photo: false }], ["form", { fields: 2 }]],
    after: [["profile", { photo: true, hl: true }], ["form", { fields: 2 }]] },
  "Billing settings": { page: "Billing", did: "Change plan, card and billing email on one page.",
    before: [["form", { fields: 3 }]],
    after: [["cards", { n: 3, price: true, hl: true }], ["form", { fields: 2 }]] },
  "Password reset email": { page: "Email", did: "The reset email has one button, a 30-minute expiry and your brand.",
    before: [["email", { branded: false }]],
    after: [["email", { branded: true, title: "Reset your password", button: "Reset password", hl: true }]] },
  "Onboarding checklist": { page: "Home", did: "New teams see four steps to set up, ticked as they go.",
    before: [["stats", { n: 3 }], ["chart", {}]],
    after: [["checklist", { items: 4, hl: true }], ["stats", { n: 3 }]] },
  "Pricing page under 1 s": { page: "Pricing", did: "Pricing renders on the server; first paint is 0.8 s.",
    before: [["timing", { text: "2.8 s", tone: "red" }], ["skeleton", { rows: 3 }]],
    after: [["timing", { text: "0.8 s", tone: "green", hl: true }], ["cards", { n: 3, price: true }]] },
  "Webhook retries": { page: "Webhooks", did: "Failed deliveries retry and you can resend one by hand.",
    before: [["table", { rows: 5, cols: 3, status: "Failed" }]],
    after: [["table", { rows: 5, cols: 3, status: "Retried", action: "Resend", hl: true }]] },
  "Usage alerts": { page: "Usage", did: "Set a limit and get an alert at 80 percent.",
    before: [["stats", { n: 3 }], ["chart", {}]],
    after: [["banner", { text: "You have used 82% of your plan", tone: "amber", hl: true }], ["chart", { limit: true }]] },
  "Archive old projects": { page: "Projects", did: "Projects idle for 90 days can be archived and restored later.",
    before: [["list", { items: 6 }]],
    after: [["list", { items: 3 }], ["list", { items: 2, tag: "Archived", hl: true }]] },
};

export const THEMES: Record<'dark' | 'light', Palette> = {
  dark: { bg: "#111214", side: "#16171a", panel: "#1c1d21", panel2: "#24252a", rule: "#2c2d33", ink: "#e9eaee", ink2: "#9a9ca5", ink3: "#5d5f68", blue: "#3b9bff", blueT: "rgba(59,155,255,.16)", red: "#ff6b61", redT: "rgba(255,107,97,.14)", green: "#30d158", greenT: "rgba(48,209,88,.14)", amber: "#ffb340", amberT: "rgba(255,179,64,.14)", odd: "#f2f2f2" },
  light: { bg: "#f6f6f4", side: "#eeeeeb", panel: "#ffffff", panel2: "#f1f1ef", rule: "#e2e2de", ink: "#16171a", ink2: "#62656d", ink3: "#a3a6ad", blue: "#0a6fe0", blueT: "rgba(10,111,224,.1)", red: "#d1242f", redT: "rgba(209,36,47,.08)", green: "#1f8a3c", greenT: "rgba(31,138,60,.1)", amber: "#b26200", amberT: "rgba(178,98,0,.1)", odd: "#1c1d21" },
};

const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" };
function esc(s: string) { return String(s).replace(/[&<>"]/g, (c) => ESC[c]!); }
function R(x: number, y: number, w: number, h: number, r: number, fill: string, extra?: string) {
  return '<rect x="' + x + '" y="' + y + '" width="' + w + '" height="' + h + '" rx="' + r + '" fill="' + fill + '"' + (extra || "") + "/>";
}
function T(x: number, y: number, text: string, size: number, fill: string, weight?: number, anchor?: string) {
  return '<text x="' + x + '" y="' + y + '" font-size="' + size + '" fill="' + fill + '" font-weight="' + (weight || 500) + '"' + (anchor ? ' text-anchor="' + anchor + '"' : "") + ">" + esc(text) + "</text>";
}
function bar(x: number, y: number, w: number, c: string) { return R(x, y, w, 6, 3, c); }

// Each block draws itself at (x, y) with width w and returns [svg, height].
const BLOCKS: { [K in Block[0]]: (o: Options<K>, c: Palette, x: number, y: number, w: number) => Drawn } = {
  head(o, c, x, y, w) {
    let s = T(x, y + 16, o.title, 15, c.ink, 650);
    if (o.button) s += R(x + w - 96, y + 2, 96, 24, 6, c.blue) + T(x + w - 48, y + 18, o.button, 10.5, "#fff", 650, "middle");
    return [s, 34];
  },
  table(o, c, x, y, w) {
    const rows = o.rows, cols = o.cols, rh = 26;
    let s = R(x, y, w, 24 + rows * rh, 8, c.panel);
    s += R(x, y, w, 24, 8, c.panel2) + R(x, y + 16, w, 8, 0, c.panel2);
    const cw = (w - 24) / cols;
    for (let k = 0; k < cols; k++) s += bar(x + 12 + k * cw, y + 9, cw * 0.4, c.ink3);
    for (let i = 0; i < rows; i++) {
      const ry = y + 24 + i * rh;
      if (i) s += R(x + 12, ry, w - 24, 1, 0, c.rule);
      for (let j = 0; j < cols; j++) {
        const last = j === cols - 1;
        if (last && o.status) {
          const tone: Tone = /Fail|429/.test(o.status) ? "red" : /Paid|Delivered|Retried/.test(o.status) ? "green" : "amber";
          s += R(x + 12 + j * cw, ry + 7, 58, 13, 6.5, c[`${tone}T`]) + T(x + 12 + j * cw + 29, ry + 16.5, o.status, 8, c[tone], 650, "middle");
        } else if (last && o.action) {
          s += R(x + w - 12 - 50, ry + 6, 50, 15, 5, c.blueT) + T(x + w - 12 - 25, ry + 16.5, o.action, 8.5, c.blue, 650, "middle");
        } else {
          s += bar(x + 12 + j * cw, ry + 10, cw * (0.35 + ((i * 7 + j * 3) % 5) / 10), j ? c.ink3 : c.ink2);
        }
      }
    }
    return [s, 24 + rows * rh];
  },
  list(o, c, x, y, w) {
    let s = "";
    const h = 30;
    if (o.tag) { s += T(x, y + 10, o.tag, 9.5, c.ink2, 650); y += 16; }
    for (let i = 0; i < o.items; i++) {
      const ry = y + i * (h + 6);
      s += R(x, ry, w, h, 7, c.panel) + R(x + 10, ry + 9, 12, 12, 6, c.panel2) + bar(x + 30, ry + 9, 120 + (i * 37) % 90, c.ink2) + bar(x + 30, ry + 18, 70 + (i * 23) % 60, c.ink3);
      if (o.tag) s += R(x + w - 70, ry + 8, 58, 14, 7, o.tag === "Archived" ? c.panel2 : c.blueT) + T(x + w - 41, ry + 18, o.tag, 8, o.tag === "Archived" ? c.ink2 : c.blue, 650, "middle");
    }
    return [s, (o.tag ? 16 : 0) + o.items * (h + 6)];
  },
  search(o, c, x, y, w) {
    return [R(x, y, w, 30, 8, c.panel, ' stroke="' + c.rule + '"') + '<circle cx="' + (x + 16) + '" cy="' + (y + 15) + '" r="4.5" fill="none" stroke="' + c.ink3 + '" stroke-width="1.5"/>' + T(x + 28, y + 19, o.text, 10, o.hl ? c.ink : c.ink3, 500), 38];
  },
  empty(o, c, x, y, w) {
    const h = 150;
    let s = R(x, y, w, h, 10, c.panel, ' stroke="' + c.rule + '" stroke-dasharray="4 4"');
    s += '<circle cx="' + (x + w / 2) + '" cy="' + (y + 50) + '" r="16" fill="' + c.panel2 + '"/>' + T(x + w / 2, y + 90, o.text, 12, c.ink, 650, "middle");
    if (o.button) s += bar(x + w / 2 - 80, y + 102, 160, c.ink3) + R(x + w / 2 - 50, y + 116, 100, 22, 6, c.blue) + T(x + w / 2, y + 131, o.button, 9.5, "#fff", 650, "middle");
    return [s, h];
  },
  blank(_o, c, x, y, w) { return [R(x, y, w, 150, 10, c.panel), 150]; },
  banner(o, c, x, y, w) {
    return [R(x, y, w, 30, 8, c[`${o.tone}T`]) + '<circle cx="' + (x + 15) + '" cy="' + (y + 15) + '" r="4" fill="' + c[o.tone] + '"/>' + T(x + 26, y + 19, o.text, 10.5, c[o.tone], 650), 38];
  },
  chart(o, c, x, y, w) {
    const h = 120, pts: string[] = [];
    let s = R(x, y, w, h, 10, c.panel);
    for (let i = 0; i <= 12; i++) {
      let v = 0.35 + 0.18 * Math.sin(i * 0.9) + i * 0.025;
      if (o.spike && (i === 7 || i === 8)) v = 0.95;
      pts.push((x + 14 + i * (w - 28) / 12).toFixed(1) + "," + (y + h - 14 - v * (h - 34)).toFixed(1));
    }
    if (o.limit) s += R(x + 12, y + 30, w - 24, 1, 0, c.amber) + T(x + w - 14, y + 26, "Limit", 8.5, c.amber, 650, "end");
    s += '<polyline points="' + pts.join(" ") + '" fill="none" stroke="' + (o.spike ? c.red : c.blue) + '" stroke-width="2"/>';
    return [s, h];
  },
  stats(o, c, x, y, w) {
    let s = "";
    const cw = (w - (o.n - 1) * 10) / o.n;
    for (let i = 0; i < o.n; i++) s += R(x + i * (cw + 10), y, cw, 56, 8, c.panel) + bar(x + i * (cw + 10) + 12, y + 14, cw * 0.4, c.ink3) + R(x + i * (cw + 10) + 12, y + 28, cw * 0.5, 14, 4, c.ink2);
    return [s, 64];
  },
  cards(o, c, x, y, w) {
    let s = "";
    const cw = (w - 20) / 3, h = o.price ? 110 : 70;
    for (let i = 0; i < o.n; i++) {
      const cx = x + i * (cw + 10), fill = o.odd && i === 1 ? c.odd : c.panel;
      s += R(cx, y, cw, h, 9, fill, i === 1 && o.price ? ' stroke="' + c.blue + '" stroke-width="1.5"' : "");
      s += bar(cx + 12, y + 14, cw * 0.45, o.odd && i === 1 ? c.ink3 : c.ink2) + bar(cx + 12, y + 26, cw * 0.65, c.ink3);
      if (o.price) s += T(cx + 12, y + 62, ["$0", "$24", "$79"][i]!, 18, c.ink, 700) + R(cx + 12, y + 80, cw - 24, 18, 5, i === 1 ? c.blue : c.panel2);
    }
    return [s, h + 8];
  },
  form(o, c, x, y, w) {
    let s = "";
    for (let i = 0; i < o.fields; i++) s += bar(x, y + i * 46, 80, c.ink3) + R(x, y + i * 46 + 12, Math.min(w, 300), 26, 6, c.panel, ' stroke="' + c.rule + '"');
    return [s, o.fields * 46];
  },
  skeleton(o, c, x, y, w) {
    let s = "";
    for (let i = 0; i < o.rows; i++) s += R(x, y + i * 30, w, 22, 6, c.panel2);
    return [s, o.rows * 30];
  },
  timing(o, c, x, y) {
    return [T(x, y + 14, "First paint", 10, c.ink2, 500) + R(x + 70, y + 2, 54, 18, 9, c[`${o.tone}T`]) + T(x + 97, y + 15, o.text, 9.5, c[o.tone], 700, "middle"), 30];
  },
  email(o, c, x, y, w) {
    const ew = Math.min(w, 340), ex = x + (w - ew) / 2;
    let s = R(ex, y, ew, 260, 10, c.panel);
    if (o.branded) {
      s += R(ex, y, ew, 44, 10, c.blue) + R(ex, y + 34, ew, 10, 0, c.blue) + T(ex + 18, y + 27, o.title, 12, "#fff", 700);
      s += bar(ex + 18, y + 64, ew * 0.6, c.ink2) + bar(ex + 18, y + 78, ew * 0.75, c.ink3) + bar(ex + 18, y + 92, ew * 0.5, c.ink3);
      s += R(ex + 18, y + 112, ew - 36, 50, 8, c.panel2) + R(ex + 18, y + 176, 120, 26, 6, c.blue) + T(ex + 78, y + 193, o.button, 9.5, "#fff", 650, "middle");
    } else {
      for (let i = 0; i < 9; i++) s += bar(ex + 18, y + 22 + i * 14, ew * (0.4 + ((i * 13) % 5) / 10), c.ink3);
    }
    return [s, 268];
  },
  login(o, c, x, y, w) {
    const lw = 240, lx = x + (w - lw) / 2, h = o.code ? 200 : 176;
    let s = R(lx, y, lw, h, 12, c.panel);
    s += T(lx + lw / 2, y + 30, o.code ? "Enter your code" : "Sign in", 13, c.ink, 700, "middle");
    if (o.code) {
      for (let i = 0; i < 6; i++) s += R(lx + 24 + i * 33, y + 52, 27, 34, 6, c.panel2, i < 3 ? ' stroke="' + c.blue + '"' : "") + (i < 3 ? T(lx + 37.5 + i * 33, y + 74, String((i * 4 + 3) % 10), 13, c.ink, 650, "middle") : "");
      s += bar(lx + 24, y + 104, 150, c.ink3) + R(lx + 24, y + 130, lw - 48, 30, 7, c.blue) + T(lx + lw / 2, y + 149, "Verify", 10.5, "#fff", 650, "middle");
    } else {
      s += R(lx + 24, y + 48, lw - 48, 28, 6, c.panel2) + R(lx + 24, y + 86, lw - 48, 28, 6, c.panel2) + R(lx + 24, y + 128, lw - 48, 30, 7, c.blue) + T(lx + lw / 2, y + 147, "Continue", 10.5, "#fff", 650, "middle");
    }
    return [s, h + 10];
  },
  profile(o, c, x, y, w) {
    let s = R(x, y, w, 84, 10, c.panel) + '<circle cx="' + (x + 44) + '" cy="' + (y + 42) + '" r="26" fill="' + (o.photo ? "url(#ph)" : c.panel2) + '"/>';
    if (!o.photo) s += T(x + 44, y + 47, "DM", 13, c.ink2, 700, "middle");
    s += bar(x + 84, y + 30, 110, c.ink2) + bar(x + 84, y + 44, 80, c.ink3);
    if (o.photo) s += R(x + w - 108, y + 29, 92, 26, 6, c.blueT) + T(x + w - 62, y + 46, "Change photo", 9, c.blue, 650, "middle");
    return [s, 94];
  },
  checklist(o, c, x, y, w) {
    let s = R(x, y, w, 30 + o.items * 26, 10, c.panel) + T(x + 14, y + 20, "Set up your team", 11.5, c.ink, 700);
    for (let i = 0; i < o.items; i++) {
      const done = i < 2, ry = y + 34 + i * 26;
      s += '<circle cx="' + (x + 22) + '" cy="' + (ry + 6) + '" r="7" fill="' + (done ? c.green : "none") + '" stroke="' + (done ? c.green : c.ink3) + '" stroke-width="1.5"/>';
      if (done) s += '<path d="M' + (x + 18.5) + " " + (ry + 6) + "l2.5 2.5 4.5-5" + '" fill="none" stroke="#fff" stroke-width="1.6"/>';
      s += bar(x + 38, ry + 3, 120 + i * 24, done ? c.ink3 : c.ink2);
    }
    return [s, 38 + o.items * 26];
  },
  modal(o) { return [null, 0, o]; }, // drawn last, over the screen
};

/** Draws one block; the cast pairs each kind with its own options, which TypeScript cannot follow through a union. */
const draw = (b: Block, c: Palette, x: number, y: number, w: number) =>
  (BLOCKS[b[0]] as (o: Block[1], c: Palette, x: number, y: number, w: number) => Drawn)(b[1], c, x, y, w);

/** A drawn app screen, before or after, light or dark, as an SVG string. */
export function screen(spec: Dish, which: 'before' | 'after', theme: keyof typeof THEMES) {
  const c = THEMES[theme], W = 640, H = 400, cx = 148, cw = W - cx - 24;
  let s = '<svg viewBox="0 0 ' + W + " " + H + '" xmlns="http://www.w3.org/2000/svg" font-family="Figtree, system-ui, sans-serif" role="img" aria-label="' + esc(spec.page + ", " + which) + '">';
  s += '<defs><linearGradient id="ph" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#ffb36b"/><stop offset="1" stop-color="#d9480f"/></linearGradient></defs>';
  s += R(0, 0, W, H, 0, c.bg) + R(0, 0, 128, H, 0, c.side);
  s += R(16, 16, 18, 18, 5, c.blue) + bar(42, 22, 50, c.ink2);
  const nav = ["Home", "Inbox", "Reports", "Settings"];
  if (nav.indexOf(spec.page) === -1) nav.splice(2, 0, spec.page);
  nav.forEach((n, i) => {
    const y = 60 + i * 26, on = n === spec.page;
    if (on) s += R(10, y - 6, 108, 22, 6, c.panel2);
    s += T(22, y + 9, n, 10, on ? c.ink : c.ink2, on ? 650 : 500);
  });
  s += T(cx, 34, spec.page, 11, c.ink2, 600) + '<circle cx="' + (W - 36) + '" cy="30" r="10" fill="' + c.panel2 + '"/>' + R(cx, 48, cw, 1, 0, c.rule);
  let y = 64, overlay: { title: string } | null = null, outlines = "";
  for (const b of which === "after" ? spec.after : spec.before) {
    const out = draw(b, c, cx, y, cw);
    if (out[0] === null) { overlay = out[2]; continue; }
    if (b[1].hl && which === "after") {
      outlines += R(cx - 5, y - 5, cw + 10, out[1] + 4, 10, "none", ' stroke="' + c.blue + '" stroke-width="1.5" stroke-dasharray="5 4"');
      outlines += R(cx + cw - 30, y - 12, 36, 14, 7, c.blue) + T(cx + cw - 12, y - 2, "New", 8, "#fff", 700, "middle");
    }
    s += out[0];
    y += out[1] + 12;
  }
  s += outlines;
  if (overlay) {
    s += R(0, 0, W, H, 0, "rgba(0,0,0,.45)");
    const mw = 300, mx = (W - mw) / 2, my = 80, keys = [["?", "Show shortcuts"], ["j / k", "Next / previous"], ["e", "Archive"], ["/", "Search"]] as const;
    s += R(mx, my, mw, 200, 12, c.panel, ' stroke="' + c.blue + '" stroke-width="1.5"') + T(mx + 18, my + 30, overlay.title, 13, c.ink, 700);
    keys.forEach((k, i) => {
      s += R(mx + 18, my + 50 + i * 34, 44, 22, 5, c.panel2) + T(mx + 40, my + 65 + i * 34, k[0], 10, c.ink, 700, "middle") + T(mx + 74, my + 65 + i * 34, k[1], 10.5, c.ink2, 500);
    });
  }
  return s + "</svg>";
}

/** The plates page: four shots of one dish, each cropped to the page body and padded with its own background. */
export function platesPage(dish = 'Retry failed payouts') {
  const spec = DISHES[dish];
  if (!spec) throw new Error(`no dish named ${dish}`);
  let plates = '';
  for (const theme of ['dark', 'light'] as const) for (const which of ['before', 'after'] as const) {
    // The page body, no side bar: the app shows a shot in a frame about 370 x 340.
    const svg = screen(spec, which, theme).replace('viewBox="0 0 640 400"', 'viewBox="128 -90 512 470"');
    plates += `<div class="plate" id="${theme}-${which}" style="background: ${THEMES[theme].bg}">${svg}</div>\n`;
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Plates</title>
<link rel="preload" href="fonts/figtree-latin-var.woff2" as="font" type="font/woff2" crossorigin>
<style>
@font-face { font-family: "Figtree"; font-weight: 300 900; src: url("fonts/figtree-latin-var.woff2") format("woff2"); }
body { margin: 0; padding: 20px; background: #777; display: grid; gap: 20px; }
.plate { width: 960px; height: 881px; }
.plate svg { display: block; width: 100%; height: 100%; }
</style></head><body>
${plates}</body></html>
`;
}

if (import.meta.main) {
  const out = process.argv[2];
  if (!out) { console.error('usage: node tools/hero-art/plates.ts <dir>'); process.exit(2); }
  const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  mkdirSync(join(out, 'fonts'), { recursive: true });
  copyFileSync(join(root, 'site', 'public', 'fonts', 'figtree-latin-var.woff2'), join(out, 'fonts', 'figtree-latin-var.woff2'));
  writeFileSync(join(out, 'index.html'), platesPage());
  console.log(`Wrote ${join(out, 'index.html')}`);
}
