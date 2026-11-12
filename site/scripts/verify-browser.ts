import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium, type BrowserContext, type Page, type Route } from 'playwright-core';
import { PNG } from 'pngjs';

const [beforePort, afterPort, output] = process.argv.slice(2);
if (!beforePort || !afterPort || !output) throw new Error('Usage: verify-browser.ts BEFORE_PORT AFTER_PORT OUTPUT');
const key = process.env.BROWSERBASE_API_KEY;
if (!key) throw new Error('Supply the Browserbase key through the service-account wrapper.');
await mkdir(output, { recursive: true });
const headers = { 'X-BB-API-Key': key, 'Content-Type': 'application/json' };
async function browserbase(path: string, body?: object): Promise<unknown> {
  const response = await fetch(`https://api.browserbase.com/v1/${path}`, {
    signal: AbortSignal.timeout(30000),
    headers, method: body ? 'POST' : 'GET', ...(body ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) throw new Error(`Browserbase ${path}: HTTP ${response.status}`);
  return response.json();
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
const projects = await browserbase('projects');
const project = Array.isArray(projects) ? projects[0] as unknown : null;
if (!isRecord(project) || typeof project.id !== 'string') throw new Error('No Browserbase project was returned.');
const session = await browserbase('sessions', { projectId: project.id, timeout: 600 });
if (!isRecord(session) || typeof session.connectUrl !== 'string' || typeof session.id !== 'string') {
  throw new Error('Browserbase did not return a session.');
}

const browser = await chromium.connectOverCDP(session.connectUrl, { timeout: 30000 }).catch(async (error: unknown) => {
  await browserbase(`sessions/${session.id}`, { projectId: project.id, status: 'REQUEST_RELEASE' });
  throw error;
});
const context: BrowserContext = browser.contexts()[0] ?? await browser.newContext();
const errors: string[] = [];
const report: Record<string, unknown> = {};
const stableUrl = 'https://github.com/ddmirolli/yeschef/releases/download/v0.2.0/Yes-Chef-0.2.0-arm64.dmg';
const nightlyUrl = 'https://github.com/ddmirolli/yeschef/releases/download/v0.2.1-nightly.1/Yes-Chef-0.2.1-nightly.1-arm64.dmg';
await context.route('https://api.github.com/repos/ddmirolli/yeschef/releases**', (route) => {
  const nightly = route.request().url().includes('per_page');
  const release = {
    tag_name: nightly ? 'v0.2.1-nightly.1' : 'v0.2.0', draft: false, prerelease: nightly,
    assets: [{ name: nightly ? 'Yes-Chef-0.2.1-nightly.1-arm64.dmg' : 'Yes-Chef-0.2.0-arm64.dmg',
      size: 120000000, browser_download_url: nightly ? nightlyUrl : stableUrl }],
  };
  return route.fulfill({ json: nightly ? [release] : release });
});
await context.route(/^http:\/\/(before|after)\.local\//, async (route: Route) => {
  try {
  const request = route.request();
  const url = new URL(request.url());
  const port = url.hostname === 'before.local' ? beforePort : afterPort;
  const response = await fetch(`http://127.0.0.1:${port}${url.pathname}${url.search}`, {
    method: request.method(), redirect: 'follow', signal: AbortSignal.timeout(10000),
  });
  const responseHeaders = Object.fromEntries(response.headers);
  delete responseHeaders['content-encoding'];
  delete responseHeaders['content-length'];
  if (responseHeaders.location) responseHeaders.location = responseHeaders.location.replace(`http://127.0.0.1:${port}`, url.origin);
  await route.fulfill({ status: response.status, headers: responseHeaders, body: Buffer.from(await response.arrayBuffer()) });
  } catch (error) {
    errors.push(`Local bridge: ${error instanceof Error ? error.message : String(error)}`);
    await route.fulfill({ status: 502, body: 'The local verification server did not answer.' }).catch(() => {});
  }
});

async function pageFor(width: number, scheme: 'light' | 'dark'): Promise<Page> {
  const page = await context.newPage();
  page.on('pageerror', (error) => { errors.push(`${page.url()}: ${error.message}`); });
  page.on('console', (message) => { if (message.type() === 'error') errors.push(`${page.url()}: ${message.text()}`); });
  await page.setViewportSize({ width, height: width < 500 ? 844 : 900 });
  if (width < 500) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 844, deviceScaleFactor: 1, mobile: true });
    await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
  }
  await page.emulateMedia({ colorScheme: scheme, reducedMotion: 'reduce' });
  await page.clock.setFixedTime(new Date('2026-11-10T20:00:00Z'));
  return page;
}
async function ready(page: Page, address: string): Promise<void> {
  await page.goto(address, { waitUntil: 'networkidle' });
  await page.evaluate(async () => { await document.fonts.ready; });
  await page.addStyleTag({ content: '*,*::before,*::after{animation:none!important;transition:none!important;caret-color:transparent!important}' });
}
async function geometry(page: Page): Promise<unknown> {
  return page.locator('main > section').evaluateAll((sections) => sections.map((element) => {
    const { x, y, width, height } = element.getBoundingClientRect();
    return { id: element.id, x, y, width, height };
  }));
}
function pixels(before: Buffer, after: Buffer): number {
  const a = PNG.sync.read(before), b = PNG.sync.read(after);
  assert.equal(b.width, a.width, 'page width changed');
  assert.equal(b.height, a.height, 'page height changed');
  let changed = 0;
  for (let index = 0; index < a.data.length; index += 4) {
    if ([0, 1, 2].some((channel) => Math.abs(a.data[index + channel] - b.data[index + channel]) > 24)) changed++;
  }
  return changed / (a.width * a.height);
}

try {
  const accessible = await pageFor(1440, 'light');
  // The team demo opens on Your team, in Open kitchen, with the made-up team's calls at the pass.
  await ready(accessible, 'http://after.local/demo/team.html');
  await accessible.locator('html.s-team').waitFor({ state: 'attached' });
  await accessible.locator('#app .tile:visible').first().waitFor();
  assert.equal(await accessible.locator('.vmenu .seg [data-scope="team"]').first().getAttribute('aria-checked'), 'true');
  await ready(accessible, 'http://after.local/demo/app.html');
  await accessible.locator('#app .tile:visible').first().waitFor();
  assert.equal(await accessible.evaluate(() => {
    for (const id of ['focus-entry', 'focus-followup']) {
      const input = document.createElement('input'); input.id = id; document.body.append(input);
    }
    document.querySelector<HTMLElement>('#focus-followup')?.focus();
    return document.activeElement?.id;
  }), '', 'the demo must not steal focus on load');
  const focusSession = await context.newCDPSession(accessible);
  const { root } = await focusSession.send('DOM.getDocument');
  const { nodeId } = await focusSession.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#focus-entry' });
  await focusSession.send('DOM.focus', { nodeId });
  assert.equal(await accessible.evaluate(() => {
    document.querySelector<HTMLElement>('#focus-followup')?.focus();
    return document.activeElement?.id;
  }), 'focus-followup', 'native focus entry must release the demo focus gate');
  await accessible.close();
  report.accessibility = 'Native focus entry releases the focus gate; selected tickets, filters, and views expose ARIA state';

  for (const width of [1440, 390]) for (const scheme of ['light', 'dark'] as const) {
    const before = await pageFor(width, scheme), after = await pageFor(width, scheme);
    for (const view of ['team', 'solo']) {
      const name = `${view}-${scheme}-${width}`;
      await ready(before, `http://before.local/?view=${view}`);
      await ready(after, `http://after.local/?view=${view}`);
      const frame = after.frameLocator(`.demo [data-swap="${view}"] iframe`);
      await frame.locator('#app .tile:visible').first().waitFor();
      assert.deepEqual(await geometry(after), await geometry(before), `${name}: section layout changed`);
      const beforePixels = await before.screenshot({ fullPage: true, mask: [before.locator('iframe')] });
      const afterPixels = await after.screenshot({ fullPage: true, mask: [after.locator('iframe')] });
      const difference = pixels(beforePixels, afterPixels);
      assert.ok(difference < 0.005, `${name}: ${(difference * 100).toFixed(3)}% of page pixels changed`);
      await after.screenshot({ path: `${output}/after-${name}.png`, fullPage: true });
      await before.screenshot({ path: `${output}/before-${name}.png`, fullPage: true });
      report[name] = { geometry: 'identical', changedPixelPercent: Number((difference * 100).toFixed(4)) };
    }
    await before.close(); await after.close();
  }

  const page = await pageFor(1440, 'light');
  await ready(page, 'http://after.local/');
  assert.equal(await page.locator('html').getAttribute('data-view'), 'team');
  await page.locator('.hero button[data-view="solo"]').click();
  assert.equal(new URL(page.url()).searchParams.get('view'), 'solo');
  await page.locator('.hero button[data-view="solo"]').press('ArrowRight');
  assert.equal(await page.locator('html').getAttribute('data-view'), 'team');
  assert.equal(await page.locator('button[data-view="team"][aria-pressed="true"]').count(), 2);
  await page.locator('[data-demo-mode="brigade"]').click();
  const team = page.frameLocator('.demo [data-swap="team"] iframe');
  await team.locator('.tboard .fx-wrap:not(.ok-box)').first().waitFor({ state: 'attached' });
  await page.locator('[data-demo-mode="open"]').click();
  await team.locator('.tboard .ok-p').first().waitFor({ state: 'attached' });
  assert.equal(await team.locator('.tboard .fx-wrap:not(.ok-box)').count(), 0);
  report.teamActions = 'The mode cards switch the team demo between French Brigade and Open kitchen'

  const widths = [1440, 1366, 1280, 1200, 1100, 1024, 980, 900, 820, 768, 700, 600, 540, 480, 430, 390, 360, 320];
  for (const width of widths) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(() => { scrollTo(0, 0); });
    await page.locator('.hero button[data-view="team"]').click();
    const teamGeometry = await geometry(page);
    await page.locator('.hero button[data-view="solo"]').click();
    assert.deepEqual(await geometry(page), teamGeometry, `${width}: switching views moved a section`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}: horizontal overflow`);
  }
  report.responsive = { widths, viewSwapLayout: 'identical', horizontalOverflow: false };
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.locator('[data-demo-rules]').click();
  const solo = page.frameLocator('.demo [data-swap="solo"] iframe');
  await solo.locator('#settings[open] [data-pane="rules"]:visible').waitFor();
  assert.equal(await solo.locator('[data-kr="reviewer"]').inputValue(), 'coderabbit');
  report.soloActions = 'Rules opens in the isolated demo with the existing CodeRabbit setting';

  await ready(page, 'http://after.local/download');
  await page.waitForFunction((url) => document.querySelector<HTMLAnchorElement>('[data-dl-card]')?.href === url, stableUrl);
  await page.locator('[data-channel-pick="nightly"]').click();
  await page.waitForFunction((url) => document.querySelector<HTMLAnchorElement>('[data-dl-card]')?.href === url, nightlyUrl);
  assert.equal(new URL(page.url()).searchParams.get('channel'), 'nightly');
  await page.screenshot({ path: `${output}/after-download-light-1440.png`, fullPage: true });
  report.downloads = 'Stable and Nightly resolve the correct arm64 DMGs';
  await page.close();
  assert.deepEqual(errors, [], 'browser runtime errors');
  report.errors = errors;
  report.result = 'passed';
} catch (error) {
  report.result = 'failed';
  report.failure = error instanceof Error ? error.message : String(error);
  report.errors = errors;
  report.pages = await Promise.all(context.pages().map(async (page) => ({
    url: page.url(),
    frames: page.frames().map((frame) => frame.url()),
    state: await page.evaluate(() => ({ view: document.documentElement.getAttribute('data-view'),
      frames: Array.from(document.querySelectorAll('iframe')).map((frame) => ({ src: frame.src, html: frame.contentDocument?.body?.innerHTML.slice(-400) })) })).catch(() => null),
  })));
  throw error;
} finally {
  await writeFile(`${output}/browser-report.json`, JSON.stringify(report, null, 2));
  await browser.close();
  await browserbase(`sessions/${session.id}`, { projectId: project.id, status: 'REQUEST_RELEASE' });
}
console.log(JSON.stringify(report));
