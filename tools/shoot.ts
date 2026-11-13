// Screenshots of a local pass through Browserbase (cloud Chrome). Run it through shoot.sh.
// Usage: node shoot.ts <port> <out-dir> <label> [actions-json]
// Browserbase cannot reach 127.0.0.1, so the page loads http://pass.local and Node fetches each request locally.
// actions-json: optional list of steps run before the "open" shot, for example
//   '[{"click":"[data-dish=REV-905]"},{"press":"Enter"},{"wait":400}]'
// or {"scroll":"#bill"} to bring an element to the top of the view, and {"shotOf":"#bill"} to save
// that element alone as <label>-<scheme>-<width>-el.png (the marketing site); add "as":"name" to save it as
// <label>-<scheme>-<width>-name.png instead, so one run can save several elements. {"fill":"<selector>","text":"..."}
// types into a field. {"hover":"<selector>"} rests the pointer on an element (a tooltip). {"select":"<selector>","text":"<value>"}
// picks an option in a menu (a native menu takes no keys in the cloud browser).
// SHOOT_VIEWS picks other views than the four defaults, as scheme:width:height pairs, for example
// SHOOT_VIEWS=light:2560:1440,dark:2560:1440 for a large display. SHOOT_SCALE=2 shoots a desktop view at 2x
// (the site's phone screenshots of the app are 1440x900 at 2x). SHOOT_AT=<ISO time> stops the page's clock at that
// time in UTC, so a demo whose times count back from now looks the same whenever it is shot.
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';

/** One step of actions-json (see above). */
interface Step { click?: string; scroll?: string; shotOf?: string; as?: string; hover?: string; press?: string; fill?: string; select?: string; text?: string; wait?: number }
/** A view: colour scheme, width and height. */
type View = [scheme: string, width: number, height: number];

const [port, out, label, actionsJson] = process.argv.slice(2) as [string, string, string, string | undefined];
const actions: Step[] = actionsJson ? JSON.parse(actionsJson) : [];
mkdirSync(out, { recursive: true });
const H = { 'X-BB-API-Key': process.env.BROWSERBASE_API_KEY as string, 'Content-Type': 'application/json' };
const views: View[] = process.env.SHOOT_VIEWS ? process.env.SHOOT_VIEWS.split(',').map((v): View => { const [sc, w, h] = v.split(':'); return [sc!, Number(w), Number(h)]; })
  : [['light', 1440, 900], ['dark', 1440, 900], ['light', 390, 844], ['dark', 390, 844]];
// Each view saves as <label>-<scheme>-<width>, so two views with the same scheme and width would overwrite each other.
// A bad or repeated view stops the run before any session starts (PR-Agent r3 on #72).
const viewKeys = views.map(([sc, w]) => `${sc}-${w}`);
if (views.some(([sc, w, h]) => !['light', 'dark'].includes(sc) || !(w > 0) || !(h > 0)) || new Set(viewKeys).size !== viewKeys.length) {
  console.error(`SHOOT_VIEWS needs scheme:width:height views, light or dark, each scheme and width once. Got: ${process.env.SHOOT_VIEWS}`);
  process.exit(2);
}
const proj = (await (await fetch('https://api.browserbase.com/v1/projects', { headers: H })).json() as { id: string }[])[0]!.id;
const report: Record<string, { errors: string[] }> = {};
for (const [scheme, w, h] of views) {
  const s = await (await fetch('https://api.browserbase.com/v1/sessions', { method: 'POST', headers: H, body: JSON.stringify({ projectId: proj }) })).json() as { connectUrl: string };
  const browser = await chromium.connectOverCDP(s.connectUrl);
  const ctx = browser.contexts()[0]!, page = ctx.pages()[0] ?? await ctx.newPage();
  const errors: string[] = [];
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text().slice(0, 200)); });
  page.on('pageerror', e => errors.push('pageerror ' + String(e).slice(0, 200)));
  await page.route('http://pass.local/**', async route => {
    const req = route.request();
    const url = req.url().replace('http://pass.local', `http://127.0.0.1:${port}`);
    const headers = { ...req.headers() };
    if (headers.origin) headers.origin = `http://127.0.0.1:${port}`;
    const r = await fetch(url, { method: req.method(), headers, body: req.postData() ?? undefined, redirect: 'manual' } as RequestInit);
    const out: Record<string, string> = Object.fromEntries(r.headers);
    if (out.location) out.location = out.location.replace(`http://127.0.0.1:${port}`, 'http://pass.local');
    await route.fulfill({ status: r.status, headers: out, body: Buffer.from(await r.arrayBuffer()) });
  });
  await page.setViewportSize({ width: w, height: h });
  if (w < 500) {
    // A phone, not a narrow desktop window: mobile metrics, touch, and overlay scrollbars, so the page lays
    // out at the full 390 px an iPhone gives it (council round 1 on #12 found desktop scrollbars took 15 px).
    const cdp = await ctx.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: 3, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  // Playwright saves screenshots at its own 1x, so a scaled view takes its board shot through CDP.
  const scaled = w >= 500 && Number(process.env.SHOOT_SCALE) > 1 ? await ctx.newCDPSession(page) : null;
  if (scaled) await scaled.send('Emulation.setDeviceMetricsOverride', { width: w, height: h, deviceScaleFactor: Number(process.env.SHOOT_SCALE), mobile: false });
  await page.emulateMedia({ colorScheme: scheme as 'light' | 'dark' });
  if (process.env.SHOOT_AT) {
    const at = new Date(process.env.SHOOT_AT);
    if (Number.isNaN(at.getTime())) throw new Error(`SHOOT_AT needs an ISO time. Got: ${process.env.SHOOT_AT}`);
    await (await ctx.newCDPSession(page)).send('Emulation.setTimezoneOverride', { timezoneId: 'UTC' });
    await page.clock.setFixedTime(at);
  }
  await page.goto('http://pass.local/', { waitUntil: 'load', timeout: 60000 });
  await page.waitForTimeout(600);
  const key = `${label}-${scheme}-${w}`;
  if (scaled) writeFileSync(`${out}/${key}-board.png`, Buffer.from((await scaled.send('Page.captureScreenshot', { format: 'png' })).data, 'base64'));
  else await page.screenshot({ path: `${out}/${key}-board.png` });
  await page.screenshot({ path: `${out}/${key}-board-full.png`, fullPage: true });
  if (actions.length) {
    for (const a of actions) {
      if (a.click) await page.click(a.click, { timeout: 10000 });
      if (a.scroll) await page.$eval(a.scroll, e => e.scrollIntoView({ block: 'start', behavior: 'instant' }));
      if (a.shotOf) await page.locator(a.shotOf).screenshot({ path: `${out}/${key}-${a.as || 'el'}.png` });
      if (a.hover) await page.hover(a.hover, { timeout: 10000 });
      if (a.press) await page.keyboard.press(a.press);
      if (a.fill) await page.fill(a.fill, a.text ?? '', { timeout: 10000 });
      if (a.select) await page.selectOption(a.select, a.text ?? '', { timeout: 10000 });
      if (a.wait) await page.waitForTimeout(a.wait);
    }
    await page.waitForTimeout(500);
    await page.screenshot({ path: `${out}/${key}-open.png` });
  }
  report[key] = { errors };
  await browser.close();
}
writeFileSync(`${out}/${label}-report.json`, JSON.stringify(report, null, 2));
console.log(JSON.stringify(report));
process.exit(0);
