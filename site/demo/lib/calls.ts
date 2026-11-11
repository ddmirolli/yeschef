// Calls and screenshots inside an agent's own T3 message (docs/pass-calls-v1_0.md). Dan, 2026-11-06: the Pass
// replaces the ATC, so a build thread asks Dan directly. It writes its decision as lettered options, and its
// screenshots as Markdown images; the Pass reads both from T3 and sends the answer back to that thread.
import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { basename, extname, join, sep } from 'node:path';

// "a. text", "a) text", "(a) text", "**a.** text", "- a. text". Letters run a, b, c... with no gaps.
const OPTION = /^\s*(?:[-*]\s+)?(?:\*\*)?\(?([a-zA-Z])[.)](?:\*\*)?\s+(\S.*?)\s*$/;
// "(recommended)", "- recommended", or a trailing "recommended"; never "not recommended" (PR-Agent r1 on #17).
const RECOMMENDED_INLINE = /\((?:my\s+)?recommend(?:ed|ation)\)|\s[-–—]\s*recommended\b|(?<!\b(?:not|never|n't)\s+)(?<!n't\s+)\brecommended\s*$/i;
// The letter must stand alone: "a." "a," "(a)" or the line's end, so "I recommend a phased rollout" names no option
// (PR-Agent r7 on #17). A capital letter before a word ("A for today") counts only when the options are capitals.
const RECOMMEND_LINE = /\brecommend(?:ation|ed|s)?\b\W{0,8}(?:option\s+)?\(?\*{0,2}([a-z])\b(?![a-z'])(?:(?=\s*[.,;:)*]|\s*$)|(?=\s+\w))/i;
// Options are lettered a, b, c or A, B, C; one block keeps one case.
const letterOf = (m: RegExpExecArray): string => m[1]!.toLowerCase();
// A lettered list is a call only when something says it is a choice.
const CUE = /\?\s*\**\s*$|\b(decision|decide|call|choose|pick|ruling|options?|your look|send it out)\b/i;
const LABEL_ONLY = /^(options?|choices?)\s*:?\s*$/i;

const strip = (s: string): string => s.replace(/^\s*(?:[-*]\s+|\d+[.)]\s+)/, '').replace(/\*\*/g, '').replace(/`/g, '').trim();
const clean = (s: string): string => s.replace(/\*\*/g, '').replace(RECOMMENDED_INLINE, '').trim();

/** One lettered option of a call. */
export interface CallOption { letter: string; text: string }
/** One decision in an agent's message: its question, its lettered options, and the letter it recommends. */
export interface Call { question: string; options: CallOption[]; recommend: string | null }
/** A screenshot a message shows: its path or https address, and its alt text. */
export interface Shot { src: string; alt: string }

/** Each lettered option block in a message, as { question, options: [{ letter, text }], recommend }. */
export const parseCalls = (text: unknown): Call[] => scanCalls(text).map(({ recLine, ...c }) => c);
/** For each call parseCalls finds, the line (of text.split('\n')) its recommendation came from, or -1. Kept out of the
 *  calls themselves, so a call's key does not change (PR-Agent r7 on #50). */
export const recommendLines = (text: unknown): number[] => scanCalls(text).map((c) => c.recLine);

function scanCalls(text: unknown): (Call & { recLine: number })[] {
  // Lines inside a code fence are examples, never a question (PR-Agent r3 on #17). They stay as blanks, so lines keep their places.
  let fenced = false;
  const lines = String(text || '').split('\n').map((line) => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return ''; }
    return fenced ? '' : line;
  });
  const calls: (Call & { recLine: number })[] = [];
  for (let i = 0; i < lines.length; i++) {
    const first = OPTION.exec(lines[i]!);
    if (!first || letterOf(first) !== 'a') continue;
    const upper = first[1] === 'A';
    const options: CallOption[] = [];
    const indent = (line: string) => line.length - line.trimStart().length;
    let j = i, recommend: string | null = null, recLine = -1;
    for (; j < lines.length; j++) {
      const line = lines[j]!;
      const m = OPTION.exec(line);
      if (m && m[1] === String.fromCharCode((upper ? 65 : 97) + options.length)) {
        if (RECOMMENDED_INLINE.test(m[2]!)) recommend = letterOf(m);
        options.push({ letter: letterOf(m), text: clean(m[2]!) });
      } else if (!line.trim()) {
        // A blank line inside the block: the next line decides whether the block goes on.
      } else if (!m && indent(line) > indent(lines[i]!)) {
        // A line indented under an option adds to it.
        options[options.length - 1]!.text += ' ' + clean(line.trim().replace(/^[-*]\s+/, ''));
      } else break;
    }
    if (options.length < 2) continue;
    // The question: the nearest line above the block that is not a bare "Options:" label.
    let q = '';
    for (let k = i - 1; k >= 0 && k >= i - 4; k--) {
      const s = strip(lines[k]!);
      if (!s || LABEL_ONLY.test(s)) continue;
      q = s; break;
    }
    // A recommendation line: inside the block's trailing lines, before the next block.
    if (!recommend) {
      for (let k = j, seen = 0; k < lines.length && seen < 3; k++) {
        const line = lines[k]!;
        if (!line.trim()) continue;
        if (OPTION.exec(line)) break;
        seen++;
        const m = RECOMMEND_LINE.exec(line);
        if (!m) continue;
        const letter = m[1]!;
        const alone = /^\s*[.,;:)*]|^\s*$/.test(line.slice(m.index + m[0].length));
        // A line that starts as a label, "Recommendation: a now.", names its option even with words after the letter (Dan, 2026-11-08).
        const label = /^\s*(?:[-*]\s+)?\**recommend(?:ation|ed|s)?\**\s*:/i.test(line);
        if ((alone || label || (upper && letter === letter.toUpperCase())) && options.some((o) => o.letter === letter.toLowerCase())) { recommend = letter.toLowerCase(); recLine = k; break; }
      }
    }
    // Only this block's own question or recommendation makes it a call, never the next section's heading (PR-Agent r2 on #17).
    if (!CUE.test(q) && !recommend) { i = j - 1; continue; }
    calls.push({ question: q.replace(/:\s*$/, '') || 'Your call', options, recommend, recLine });
    i = j - 1;
  }
  return calls;
}

/** One key per call message, so an answer always names the exact message it answers. */
export const callKey = (itemId: unknown, calls: unknown): string => createHash('sha1').update(String(itemId) + '\n' + JSON.stringify(calls)).digest('hex').slice(0, 16);

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;
const MD_IMAGE = /!\[([^\]\n]*)\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const CODE_PATH = /`((?:\/|~\/)[^`\s]+)`/g;

/** Screenshots a message shows: Markdown images (a local path or https), and image paths written in code. */
export function imagesIn(text: unknown): Shot[] {
  const out = new Map<string, Shot>();
  const s = String(text || '');
  for (const m of s.matchAll(MD_IMAGE)) { const src = m[2]!; if (usable(src)) out.set(src, { src, alt: m[1]!.trim() }); }
  for (const m of s.matchAll(CODE_PATH)) { const src = m[1]!; if (IMAGE_EXT.test(src) && usable(src) && !out.has(src)) out.set(src, { src, alt: src.split('/').pop()! }); }
  return [...out.values()];
}
const usable = (src: string): boolean => /^https:\/\//i.test(src) || ((src.startsWith('/') || src.startsWith('~/')) && IMAGE_EXT.test(src.replace(/[?#].*$/, '')));

/** The address the page uses for one screenshot: https as is, a local file through the Pass's /img route. */
export const imageUrl = (src: string): string => (/^https:\/\//i.test(src) ? src : '/img/' + imageId(src));
export const imageId = (src: string): string => createHash('sha1').update(src).digest('hex').slice(0, 20);

/** The text with its Markdown images taken out (the page shows them as a set of screenshots). */
export const withoutImages = (text: unknown): string => String(text || '').replace(MD_IMAGE, '').replace(/\n{3,}/g, '\n\n');

// Serving a screenshot from this Mac (client/server.ts, /img). The server serves only paths that an agent's
// message on the current board names; these checks then confine them further.
export const SHOT_TYPES: Readonly<Record<string, string>> = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp', '.gif': 'image/gif' };
const realOr = (p: string): string | null => { try { return realpathSync(p); } catch { return null; } };
const under = (file: string, root: string): boolean => file === root || file.startsWith(root.endsWith(sep) ? root : root + sep);

/** The real file behind a screenshot path, or null: an image extension, under one of `roots` (real paths),
 *  and no hidden folder on the way (keys, configs), except T3's own `~/.t3` (worktrees, attachments). */
export function shotPath(src: string, { home, roots }: { home: string; roots: string[] }): string | null {
  const file = realOr(src.startsWith('~/') ? join(home, src.slice(2)) : src);
  if (!file || !SHOT_TYPES[extname(file).toLowerCase()] || !roots.some((r) => under(file, r))) return null;
  const t3 = join(realOr(home) || home, '.t3');
  const rest = under(file, t3) ? file.slice(t3.length) : file;
  if (rest.split(sep).slice(0, -1).some((part) => part.startsWith('.')) || basename(file).startsWith('.')) return null;
  return file;
}

/** The bytes start like a PNG, JPEG, WebP, or GIF. */
export function isShot(bytes: Buffer): boolean {
  const head = bytes.subarray(0, 12).toString('latin1');
  return head.startsWith('\x89PNG') || (bytes[0] === 0xff && bytes[1] === 0xd8) || (head.startsWith('RIFF') && head.slice(8, 12) === 'WEBP') || head.startsWith('GIF8');
}
