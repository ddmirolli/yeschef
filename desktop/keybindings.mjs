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

/** The list in the file: { list }, with null when there is no file yet, or { error } in words. */
export function readKeybindings(file) {
  let text;
  try { text = readFileSync(file, 'utf8'); }
  catch (e) { return e.code === 'ENOENT' ? { list: null } : { error: `Yes Chef could not read keybindings.json (${e.code || 'error'}).` }; }
  if (Buffer.byteLength(text) > MAX_BYTES) return { error: 'keybindings.json is larger than 256 KB, so Yes Chef did not read it.' };
  if (!text.trim()) return { list: [] };
  try { return { list: JSON.parse(text) }; }
  catch { return { error: 'keybindings.json is not valid JSON. Fix it there, or change a key here to write it again.' }; }
}

/** The list as the board may save it: at most 500 entries, each with a command, and key, command and when as short
 *  text. An entry's other fields (an args for a command Yes Chef does not have) are kept as written, as JSON. */
export function cleanKeybindings(list) {
  if (!Array.isArray(list)) return { error: 'Shortcuts must be a list.' };
  if (list.length > MAX_ENTRIES) return { error: `Shortcuts hold at most ${MAX_ENTRIES} entries.` };
  const out = [];
  for (const e of list) {
    if (!e || typeof e !== 'object' || Array.isArray(e) || !Object.hasOwn(e, 'command') || typeof e.command !== 'string' || !e.command) return { error: 'Each shortcut needs a command.' };
    const entry = {};
    for (const f of FIELDS) {
      if (!Object.hasOwn(e, f) || e[f] === undefined) continue;
      if (typeof e[f] !== 'string' || e[f].length > MAX_FIELD) return { error: `A shortcut's ${f} must be text of at most ${MAX_FIELD} characters.` };
      entry[f] = e[f];
    }
    for (const f of Object.keys(e)) {
      if (FIELDS.includes(f) || e[f] === undefined) continue;
      let v;
      try { v = JSON.stringify(e[f]); } catch { return { error: `A shortcut's ${f.slice(0, 40)} is not JSON.` }; }
      if (v === undefined) continue;
      // A field named __proto__ stays a field: defineProperty never sets the prototype.
      Object.defineProperty(entry, f, { value: JSON.parse(v), enumerable: true, writable: true, configurable: true });
    }
    out.push(entry);
  }
  return { list: out };
}

/** Writes the list, one entry a line, through a temp file and a rename, so the file is never half written. */
export function writeKeybindings(file, list) {
  const clean = cleanKeybindings(list);
  if (clean.error) return clean;
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
    return { error: `Yes Chef could not save keybindings.json (${e.code || 'error'}).` };
  }
}

/** Open the file: every default first when there is none, as T3 Code writes a new file. */
export function ensureKeybindings(file, mac = process.platform === 'darwin') {
  const r = readKeybindings(file);
  if (r.list === null) return writeKeybindings(file, keysCore(mac).defaultList());
  return { ok: true };
}

/** T3 Code's start-up sync (apps/server/src/keybindings.ts, syncDefaultKeybindingsOnStartup). No file: every default.
 *  A file whose every entry Yes Chef uses: the defaults of each command it does not name go in before its entries, so
 *  its entries win a key both have, and a default whose key and when an entry already has is left out. A file with an
 *  entry Yes Chef cannot use, or that is not a list, is left as it is, as T3 Code leaves one with issues; the board
 *  names what is wrong. { ok, wrote } or { error }. */
export function syncKeybindings(file, mac = process.platform === 'darwin') {
  const K = keysCore(mac);
  const r = readKeybindings(file);
  if (r.error) return r;
  if (r.list === null) { const w = writeKeybindings(file, K.defaultList()); return w.error ? w : { ok: true, wrote: true }; }
  if (!Array.isArray(r.list)) return { ok: true, wrote: false };
  const rules = r.list.map((e, i) => K.compile(e, i).rule);
  if (rules.some((x) => !x)) return { ok: true, wrote: false };
  const named = new Set(rules.map((x) => x.id));
  const used = new Set(rules.map((x) => `${x.key}\u0000${x.when}`));
  const missing = K.defaultList().filter((d) => !named.has(d.command) && !used.has(`${d.key}\u0000${d.when || ''}`));
  if (!missing.length) return { ok: true, wrote: false };
  const w = writeKeybindings(file, [...missing, ...r.list]);
  return w.error ? w : { ok: true, wrote: true };
}
