// Settings → Shortcuts on the Mac (client/keys.ts): your shortcuts, in keybindings.json in the app's data folder, in
// T3 Code's shape and with its rules: a list of { key, command, when? }. At start the app writes every default into a
// new file and adds the defaults of a command the file does not name, as T3 Code does (syncKeybindings). The board
// reads the file at start and each time the window comes back, so an edit made in the file applies, and writes it on
// each change in Settings. What each entry means, and what is wrong with one, is the board's (client/keys.ts).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { keysCore } from '../client/keys.ts';

export const MAX_ENTRIES = 500;
export const MAX_FIELD = 200;
const MAX_BYTES = 256 * 1024;
const FIELDS = ['key', 'command', 'when'];

/** An entry as the file holds it: key, command and when as text, and any other field as written. */
export type Entry = Record<string, unknown>;
/** What a read, clean, write or sync gives: the list, ok, or what went wrong in words. */
export type ReadResult = { list: unknown; error?: undefined } | { error: string; list?: undefined };
export type CleanResult = { list: Entry[]; error?: undefined } | { error: string; list?: undefined };
export type WriteResult = { ok: true; wrote?: boolean; error?: undefined } | { error: string; ok?: undefined };
/** A file system error's code, or 'error'. */
const codeOf = (e: unknown) => (e as { code?: string } | null)?.code || 'error';

/** The list in the file: { list }, with null when there is no file yet, or { error } in words. */
export function readKeybindings(file: string): ReadResult {
  let text: string;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { return codeOf(e) === 'ENOENT' ? { list: null } : { error: `Yes Chef could not read keybindings.json (${codeOf(e)}).` }; }
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'keybindings.json is larger than 256 KB, so Yes Chef did not read it.' };
  if (!text.trim()) return { list: [] };
  try { return { list: JSON.parse(text) as unknown }; }
  catch { return { error: 'keybindings.json is not valid JSON. Fix it there, or change a key here to write it again.' }; }
}

/** The list as the board may save it: at most 500 entries, each with a command, and key, command and when as short
 *  text. An entry's other fields (an args for a command Yes Chef does not have) are kept as written, as JSON. */
export function cleanKeybindings(list: unknown): CleanResult {
  if (!Array.isArray(list)) return { error: 'Shortcuts must be a list.' };
  if (list.length > MAX_ENTRIES) return { error: `Shortcuts hold at most ${MAX_ENTRIES} entries.` };
  const out: Entry[] = [];
  for (const x of list as unknown[]) {
    if (!x || typeof x !== 'object' || Array.isArray(x)) return { error: 'Each shortcut needs a command.' };
    const e = x as Entry;
    if (!Object.hasOwn(e, 'command') || typeof e.command !== 'string' || !e.command) return { error: 'Each shortcut needs a command.' };
    const entry: Entry = {};
    for (const f of FIELDS) {
      const v = e[f];
      if (!Object.hasOwn(e, f) || v === undefined) continue;
      if (typeof v !== 'string' || v.length > MAX_FIELD) return { error: `A shortcut's ${f} must be text of at most ${MAX_FIELD} characters.` };
      entry[f] = v;
    }
    for (const f of Object.keys(e)) {
      if (FIELDS.includes(f) || e[f] === undefined) continue;
      let v: string | undefined;
      try { v = JSON.stringify(e[f]); } catch { return { error: `A shortcut's ${f.slice(0, 40)} is not JSON.` }; }
      if (v === undefined) continue;
      // A field named __proto__ stays a field: defineProperty never sets the prototype.
      Object.defineProperty(entry, f, { value: JSON.parse(v) as unknown, enumerable: true, writable: true, configurable: true });
    }
    out.push(entry);
  }
  return { list: out };
}

/** Writes the list, one entry a line, through a temp file and a rename, so the file is never half written. */
export function writeKeybindings(file: string, list: unknown): WriteResult {
  const clean = cleanKeybindings(list);
  if (clean.error !== undefined) return clean;
  const text = clean.list.length ? `[\n${clean.list.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n` : '[]\n';
  // Never write a file the reader would refuse.
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'These shortcuts would make keybindings.json larger than 256 KB, so Yes Chef did not save them.' };
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(tmp, text);
    renameSync(tmp, file);
    return { ok: true };
  } catch (e) {
    try { rmSync(tmp, { force: true }); } catch { /* nothing to clean */ }
    return { error: `Yes Chef could not save keybindings.json (${codeOf(e)}).` };
  }
}

/** Open the file: every default first when there is none, as T3 Code writes a new file. */
export function ensureKeybindings(file: string, mac = process.platform === 'darwin'): WriteResult {
  const r = readKeybindings(file);
  if (r.list === null) return writeKeybindings(file, keysCore(mac).defaultList());
  return { ok: true };
}

/** T3 Code's start-up sync (apps/server/src/keybindings.ts, syncDefaultKeybindingsOnStartup). No file: every default.
 *  A file whose every entry Yes Chef uses: the defaults of each command it does not name go in before its entries, so
 *  its entries win a key both have, and a default whose key and when an entry already has is left out. A file with an
 *  entry Yes Chef cannot use, or that is not a list, is left as it is, as T3 Code leaves one with issues; the board
 *  names what is wrong. { ok, wrote } or { error }. */
export function syncKeybindings(file: string, mac = process.platform === 'darwin'): WriteResult {
  const K = keysCore(mac);
  const r = readKeybindings(file);
  if (r.error !== undefined) return r;
  if (r.list === null) { const w = writeKeybindings(file, K.defaultList()); return w.error !== undefined ? w : { ok: true, wrote: true }; }
  if (!Array.isArray(r.list)) return { ok: true, wrote: false };
  const list: unknown[] = r.list;
  const compiled = list.map((e, i) => K.compile(e, i).rule);
  const rules = compiled.filter((x) => !!x);
  if (rules.length < compiled.length) return { ok: true, wrote: false };
  const named = new Set(rules.map((x) => x.id));
  const used = new Set(rules.map((x) => `${x.key}\u0000${x.when}`));
  const missing = K.defaultList().filter((d) => !named.has(d.command) && !used.has(`${d.key}\u0000${d.when || ''}`));
  if (!missing.length) return { ok: true, wrote: false };
  const w = writeKeybindings(file, [...missing, ...list]);
  return w.error !== undefined ? w : { ok: true, wrote: true };
}
