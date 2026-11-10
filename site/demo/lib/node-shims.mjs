// Browser stand-ins for node:fs and node:path, for the site demo only. The demo serves no files from disk:
// realpathSync always fails, so the app's screenshot path checks find nothing and the demo maps its own images.
export function realpathSync() { throw new Error('demo: no file system'); }
export const sep = '/';
export const basename = (p) => String(p).split('/').filter(Boolean).pop() || '';
export const extname = (p) => { const b = basename(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i) : ''; };
export const join = (...parts) => parts.filter(Boolean).join('/').replace(/\/+/g, '/');
