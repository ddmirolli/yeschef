// Too big's code (Dan, 2026-11-13: "do what t3 does and pipe it in from t3"). The board server asks T3 Code for a pull
// request's patch, as T3's own diff panel does (POST /api/pull-requests/diff, read-only key, host github.com, pages by
// cursor), and draws it with T3's renderer, @pierre/diffs, with T3's settings: stacked, no word-level marks, wrapped
// lines, pierre-dark and T3's readable light theme, files folded. The page puts what this module answers in a shadow
// root (client/page.ts), so pierre's styles stay inside it.
import * as Effect from 'effect/Effect';
import * as Option from 'effect/Option';
import * as Schema from 'effect/Schema';
import * as FetchHttpClient from 'effect/http/FetchHttpClient';
import * as HttpClient from 'effect/http/HttpClient';
import * as HttpClientRequest from 'effect/http/HttpClientRequest';
import * as HttpClientResponse from 'effect/http/HttpClientResponse';
import { getResolvedOrResolveTheme, parsePatchFiles, registerCustomTheme, SVGSpriteSheet } from '@pierre/diffs';
import type { DiffsTheme, FileDiffMetadata } from '@pierre/diffs';
import { preloadFileDiff } from '@pierre/diffs/ssr';
import { isTestChangedFile } from './changed-file-kind.ts';

// ----- T3 Code's readable light theme (apps/web/src/lib/readableSyntaxTheme.ts, MIT) -----
/** pierre-light with every syntax color darkened until it reads on every light code surface. */
export const T3_LIGHT = 't3-light';
const MIN_CONTRAST = 4.5;
// The darkest light code surface is a changed word on a deleted line (#f8d3d4, luminance 0.71), rounded down.
const DARKEST_SURFACE_LUMINANCE = 0.69;
// Pairs that differ only in lightness would merge at one floor, so the darker of each goes further.
const FURTHER_COLORS = new Set(['#1ca1c7', '#636363', '#1a85d4']);
const FURTHER_MIN_CONTRAST = 6;
const channel = (c: number): number => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4; };
const onLightCode = (rgb: readonly [number, number, number]): number => {
  const [r, g, b] = rgb.map(channel) as [number, number, number];
  return (DARKEST_SURFACE_LUMINANCE + 0.05) / (0.2126 * r + 0.7152 * g + 0.0722 * b + 0.05);
};
/** Darkens a #rrggbb(aa) color in steps that keep its hue until it reads on light code. */
export function readableOnLightCode(color: string, min = MIN_CONTRAST): string {
  const m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color);
  if (!m) return color;
  let rgb = [0, 2, 4].map((at) => Number.parseInt(m[1]!.slice(at, at + 2), 16)) as [number, number, number];
  if (onLightCode(rgb) >= min) return color;
  while (onLightCode(rgb) < min) rgb = rgb.map((c) => Math.floor(c * 0.96)) as [number, number, number];
  return `#${rgb.map((c) => c.toString(16).padStart(2, '0')).join('')}${m[2] ?? ''}`;
}
const readableSyntaxColor = (color: string): string => readableOnLightCode(color, FURTHER_COLORS.has(color.toLowerCase()) ? FURTHER_MIN_CONTRAST : MIN_CONTRAST);
type ZedTheme = NonNullable<DiffsTheme['zed']>;
function withReadableSyntax(theme: ZedTheme): ZedTheme {
  const syntax = Object.fromEntries(Object.entries(theme.style.syntax ?? {}).map(([scope, style]) => [scope,
    typeof style === 'string' ? readableSyntaxColor(style) : style.color ? { ...style, color: readableSyntaxColor(style.color) } : style]));
  return { ...theme, name: T3_LIGHT, style: { ...theme.style, syntax } };
}
let registered = false;
function registerLight(): void {
  if (registered) return;
  registered = true;
  registerCustomTheme(T3_LIGHT, async () => {
    const base = await getResolvedOrResolveTheme('pierre-light', 'highlights');
    if (!base.zed) throw new Error('pierre-light has no Highlights palette');
    return withReadableSyntax(base.zed);
  }, 'zed');
}

// ----- Drawing a patch -----
/** T3's diff panel settings at their defaults (DiffPanel.tsx; settings.ts: diffLayout stacked, wordWrap on). Both
 *  themes go in one page, and the page's color scheme picks one, as pierre's light-dark() colors do. */
export const DIFF_OPTIONS = {
  diffStyle: 'unified', lineDiffType: 'none', overflow: 'wrap', theme: { dark: 'pierre-dark', light: T3_LIGHT },
  themeType: 'system', preferredHighlighter: 'highlights',
} as const;

/** One file of the patch: its header (folded, with T3's chevron) and its code, apart, so the page sends the code only
 *  when a file opens. `test` is T3's test file (changed-file-kind.ts), which the panel's switch can hide. */
export interface DrawnFile { path: string; prev: string | null; type: string; add: number; del: number; test: boolean; header: string; code: string }
/** A drawn patch: pierre's styles and icons once, then the files. */
export interface Drawn { style: string; sprite: string; files: DrawnFile[] }

const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
// T3's file toggle (DiffFileCollapseToggle): a chevron, right when folded and down when open, labelled with the path.
const CHEVRON = '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg>';
const fold = (path: string): string => `<button type="button" data-fold aria-expanded="false" aria-label="Expand ${esc(path)}" title="Expand diff">${CHEVRON}</button>`;
const PREFIX_SLOT = '<slot name="header-prefix"></slot>';
const HEADER = '<div data-diffs-header=';

/** pierre's file page is its icons, its styles, the header, then the code. Split it, or say what was not there. */
export function splitFile(html: string): { style: string; header: string; code: string } {
  if (!html.startsWith(SVGSpriteSheet)) throw new Error('the diff renderer gave no icons');
  let rest = html.slice(SVGSpriteSheet.length), style = '';
  while (rest.startsWith('<style')) {
    const end = rest.indexOf('</style>');
    if (end < 0) throw new Error('the diff renderer gave an open style');
    style += rest.slice(0, end + 8);
    rest = rest.slice(end + 8);
  }
  // Text in the header and the code is escaped, so a path or a line can never hold these tags.
  const at = rest.indexOf('<pre data-diff');
  if (!style || !rest.startsWith(HEADER) || at < 0 || !rest.slice(0, at).includes(PREFIX_SLOT)) throw new Error('the diff renderer gave a page Yes Chef cannot read');
  return { style, header: rest.slice(0, at), code: rest.slice(at) };
}

const count = (f: FileDiffMetadata, k: 'additionLines' | 'deletionLines'): number => f.hunks.reduce((n, h) => n + h[k], 0);

/** A file whose code GitHub left out, with its counts, as T3 hands them over (omittedFileStats). */
export interface Withheld { path: string; additions: number; deletions: number }
const METADATA = /<div data-metadata="">[^]*?<slot name="header-metadata"><\/slot>/;
// T3 Code's PR code tab shows a withheld file's counts in its header and the host's reason (PullRequestCodeTab.tsx).
const WITHHELD = '<div class="ld">GitHub withheld this file\'s code: a binary file, or a change too large to inline.</div>';

/** Draws a patch, every file, with T3's settings. A file GitHub withheld keeps T3's counts and says why it has no
 *  code. Throws when the renderer gives something this module cannot split. */
export async function drawPatch(patch: string, withheld: readonly Withheld[] = []): Promise<Drawn> {
  const held = new Map(withheld.map((w) => [w.path, w]));
  registerLight();
  const metas = parsePatchFiles(patch).flatMap((p) => p.files);
  const pages = await Promise.all(metas.map((fileDiff) => preloadFileDiff({ fileDiff, options: DIFF_OPTIONS })));
  let style = '';
  const files = pages.map(({ fileDiff, prerenderedHTML }) => {
    const part = splitFile(prerenderedHTML);
    style ||= part.style;
    // The header sticks to the top of the list while its file scrolls, as stickyHeaders does in T3.
    let header = part.header.replace(HEADER, '<div data-sticky="" data-diffs-header=').replace(PREFIX_SLOT, fold(fileDiff.name));
    let add = count(fileDiff, 'additionLines'), del = count(fileDiff, 'deletionLines'), code = part.code;
    const w = add + del === 0 ? held.get(fileDiff.name) : undefined;
    if (w) {
      ({ additions: add, deletions: del } = w);
      // As pierre draws counts: each one that is not zero.
      const counts = (del ? `<span data-deletions-count="">-${del}</span>` : '') + (add ? `<span data-additions-count="">+${add}</span>` : '');
      header = header.replace(METADATA, `<div data-metadata="">${counts}<slot name="header-metadata"></slot>`);
      code = WITHHELD;
    }
    return { path: fileDiff.name, prev: fileDiff.prevName ?? null, type: fileDiff.type, add, del, test: isTestChangedFile(fileDiff.name), header, code };
  });
  return { style, sprite: SVGSpriteSheet, files };
}

// ----- Asking T3 Code -----
const OmittedFile = Schema.Struct({ path: Schema.String, additions: Schema.Number, deletions: Schema.Number });
const DiffReply = Schema.Struct({
  patch: Schema.String, truncated: Schema.Boolean, nextCursor: Schema.NullOr(Schema.String),
  omittedFileStats: Schema.optional(Schema.Array(OmittedFile)),
});
type DiffReply = typeof DiffReply.Type;

/** Why the code is not shown. `auth` marks a key T3 Code refused. */
export class DiffError extends Schema.TaggedError<DiffError>()('DiffError', {
  reason: Schema.String,
  auth: Schema.optional(Schema.Boolean),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string { return this.reason; }
}

const isOk = (status: number): boolean => status >= 200 && status < 300;
/** One page of a PR's patch, as T3's diff panel asks for it. */
const askPage = Effect.fn('diffs.ask_page')(function* (origin: string, token: string, body: Record<string, unknown>) {
  const http = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(`${origin}/api/pull-requests/diff`).pipe(
    HttpClientRequest.bearerToken(token),
    HttpClientRequest.bodyJsonUnsafe(body),
    http.execute,
    Effect.mapError((cause) => new DiffError({ reason: `could not reach T3 Code: ${cause.message}`, cause })),
  );
  if (response.status === 401 || response.status === 403) return yield* new DiffError({ reason: `T3 Code refused the read-only key (${response.status})`, auth: true });
  const reply = yield* HttpClientResponse.schemaBodyJson(DiffReply)(response).pipe(Effect.option);
  if (!isOk(response.status) || Option.isNone(reply)) return yield* new DiffError({ reason: `T3 Code gave no diff (${response.status})` });
  return reply.value;
});

/** A PR this board may show the code of: owner/name and its number. */
export interface PrRef { repo: string; n: number }
/** What the page reads: the files, folded, or why there is no code. */
export type DiffView =
  | { ok: true; style: string; sprite: string; files: (Omit<DrawnFile, 'code'>)[]; rest: boolean }
  | { ok: false; why: string };
/** One file's code, or why there is none. */
export type FileView = { ok: true; code: string } | { ok: false; why: string; stale?: true };

export interface DiffsOptions {
  origin: string;
  /** The board's read-only T3 key (client/t3live.ts createKeys). */
  keys: { get(): Promise<string>; drop(): void };
  /** A T3 project to ask through. With host github.com, T3 reads any PR its GitHub sign-in can see. */
  project: () => string | null;
  fetchImpl?: typeof globalThis.fetch;
  now?: () => number;
  draw?: (patch: string, withheld: readonly Withheld[]) => Promise<Drawn>;
}

/** Pages and size kept small: a Too big PR is large by definition, and GitHub stops a diff at 300 files. */
export const LIMITS = { pages: 4, bytes: 6 * 1024 * 1024, keep: 60000, cached: 4 } as const;

interface Kept { at: number; got: Promise<{ ok: true; drawn: Drawn; rest: boolean } | { ok: false; why: string }> }

export function createDiffs({ origin, keys, project, fetchImpl = fetch, now = Date.now, draw = drawPatch }: DiffsOptions) {
  const kept = new Map<string, Kept>();
  const run = <A>(program: Effect.Effect<A, DiffError, HttpClient.HttpClient>): Promise<A> =>
    Effect.runPromise(program.pipe(Effect.provide(FetchHttpClient.layer), Effect.provideService(FetchHttpClient.Fetch, fetchImpl)));

  /** One page, with one fresh key if T3 refused the old one (it restarts, or the key timed out). */
  async function page(body: Record<string, unknown>): Promise<DiffReply> {
    try { return await run(askPage(origin, await keys.get(), body)); } catch (ex) {
      if (!(ex as { auth?: boolean } | null)?.auth) throw ex;
      keys.drop();
      return run(askPage(origin, await keys.get(), body));
    }
  }

  async function pull({ repo, n }: PrRef): Promise<Awaited<Kept['got']>> {
    const projectId = project();
    if (!projectId) return { ok: false, why: 'T3 Code lists no project to ask through' };
    let patch = '', cursor: string | null = null, truncated = false;
    const withheld: Withheld[] = [];
    try {
      for (let i = 0; i < LIMITS.pages; i++) {
        const r = await page({ projectId, host: 'github.com', repository: repo, number: n, ...(cursor ? { cursor } : {}) });
        patch += patch && !patch.endsWith('\n') ? `\n${r.patch}` : r.patch;
        withheld.push(...(r.omittedFileStats ?? []));
        truncated ||= r.truncated;
        cursor = r.nextCursor;
        if (!cursor || patch.length >= LIMITS.bytes) break;
      }
    } catch (ex) {
      return { ok: false, why: String((ex as Error)?.message || ex).slice(0, 160) };
    }
    try {
      const drawn = await draw(patch, withheld);
      // A withheld file is still in the list. Files are missing only when pages are left, or when T3 says it cut the
      // diff and no withheld file accounts for it: then the panel links to the rest.
      return { ok: true, drawn, rest: !!cursor || (truncated && withheld.length === 0) };
    } catch (ex) {
      return { ok: false, why: String((ex as Error)?.message || ex).slice(0, 160) };
    }
  }

  /** A PR's drawn patch at the board's revision of it. A list is read again after a minute; a file comes from the
   *  read its list came from, so its code always matches the header it opens under. */
  const keyOf = (pr: PrRef, rev: string | null): string => `${pr.repo.toLowerCase()}#${pr.n}@${rev ?? ''}`;
  function get(pr: PrRef, rev: string | null, pinned: boolean): Kept['got'] {
    const key = keyOf(pr, rev), t = now();
    const hit = kept.get(key);
    if (hit && (pinned || t - hit.at < LIMITS.keep)) return hit.got;
    const got = pull(pr);
    kept.delete(key);
    kept.set(key, { at: t, got });
    // A failure is not kept: the next open asks again.
    got.then((g) => { if (!g.ok && kept.get(key)?.got === got) kept.delete(key); });
    while (kept.size > LIMITS.cached) kept.delete(kept.keys().next().value!);
    return got;
  }

  return {
    async view(pr: PrRef, rev: string | null = null): Promise<DiffView> {
      const g = await get(pr, rev, false);
      if (!g.ok) return g;
      return { ok: true, style: g.drawn.style, sprite: g.drawn.sprite, files: g.drawn.files.map(({ code: _, ...f }) => f), rest: g.rest };
    },
    async file(pr: PrRef, path: string, rev: string | null = null): Promise<FileView> {
      // A read no longer kept gives no newer code under the old list: the page reads the list again.
      if (!kept.has(keyOf(pr, rev))) return { ok: false, why: 'Its list was read too long ago', stale: true };
      const g = await get(pr, rev, true);
      if (!g.ok) return g;
      const f = g.drawn.files.find((x) => x.path === path);
      return f ? { ok: true, code: f.code } : { ok: false, why: 'This file is not in the PR now' };
    },
  };
}
export type Diffs = ReturnType<typeof createDiffs>;

// ----- The page's address -----
const REPO = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
/** /diff?repo=owner/name&n=440[&f=path], as Too big's panel asks (diffPanel in client/board.ts): the PR, checked, and
 *  the file asked for, or null for anything else. */
export function readDiffUrl(url: URL): { pr: PrRef; file: string | null; rev: string | null } | null {
  if (url.pathname !== '/diff') return null;
  const repo = url.searchParams.get('repo') || '', n = Number(url.searchParams.get('n')), f = url.searchParams.get('f'), rev = url.searchParams.get('v');
  if (!REPO.test(repo) || repo.split('/').some((p) => p === '.' || p === '..') || !Number.isSafeInteger(n) || n < 1) return null;
  if (f !== null && (!f || f.length > 1000)) return null;
  if (rev !== null && !/^[\w.-]{1,64}$/.test(rev)) return null;
  return { pr: { repo, n }, file: f, rev };
}

/** A page answer, as the board server's routes give them. */
export interface DiffRouted { status: number; headers: Record<string, string>; body: string }
const json = (status: number, body: unknown): DiffRouted => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' }, body: JSON.stringify(body) });

/** The /diff route: only a PR a Too big call on the board names (`shown`), else 404. */
export async function diffRoute(url: URL, { diffs, shown }: { diffs: Diffs; shown: () => readonly PrRef[] }): Promise<DiffRouted | null> {
  if (url.pathname !== '/diff') return null;
  const ask = readDiffUrl(url);
  const on = ask && shown().some((p) => p.repo.toLowerCase() === ask.pr.repo.toLowerCase() && p.n === ask.pr.n);
  if (!ask || !on) return json(404, { ok: false, why: 'Not a PR this board shows' });
  return json(200, ask.file === null ? await diffs.view(ask.pr, ask.rev) : await diffs.file(ask.pr, ask.file, ask.rev));
}
