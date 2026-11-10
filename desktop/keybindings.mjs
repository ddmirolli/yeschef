// Settings → Shortcuts on the Mac (client/keys.mjs): the keys you changed, in keybindings.json in the app's data
// folder, in the shape of T3 Code's keybindings.json: a list of { key, command, when? }. The board reads the file at
// start and each time the window comes back, so an edit made in the file applies, and writes it on each change in
// Settings. This module only reads and writes the list: what each entry means, and what is wrong with one, is the
// board's (client/keys.mjs build()).
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

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

/** The list as the board may save it: at most 500 entries, each with a command and only string fields. */
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
    out.push(entry);
  }
  return { list: out };
}

/** Writes the list, one entry a line, through a temp file and a rename, so the file is never half written. */
export function writeKeybindings(file, list) {
  const clean = cleanKeybindings(list);
  if (clean.error) return clean;
  const text = clean.list.length ? `[\n${clean.list.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n` : '[]\n';
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

/** Open the file: an empty list first when there is none, so there is a file to open. */
export function ensureKeybindings(file) {
  const r = readKeybindings(file);
  if (r.list === null) return writeKeybindings(file, []);
  return { ok: true };
}
