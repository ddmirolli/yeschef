// The one style pass: radii on 6/10/16/22, text on five sizes (hill climb 2, r1).
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { onScale } from './scale.mjs';

test('radii and text sizes land on the scale; hairlines, pills and icon letters stay', () => {
  assert.equal(onScale('a{border-radius:9px}b{border-radius:22px 0 0 22px}c{border-radius:14px}d{border-radius:999px}e{border-radius:50%}f{border-radius:2px}'),
    'a{border-radius:10px}b{border-radius:22px 0 0 22px}c{border-radius:16px}d{border-radius:999px}e{border-radius:50%}f{border-radius:2px}');
  assert.equal(onScale('a{font-size:13px}b{font:600 11px/18px var(--sans)}c{font:15px/1.4 x}d{font-size:30px}e{font:700 9px/1 x}'),
    'a{font-size:14px}b{font:600 12px/18px var(--sans)}c{font:14px/1.4 x}d{font-size:24px}e{font:700 9px/1 x}');
});

test('the whole sheet uses at most five text sizes and four radii', () => {
  const pass = readFileSync(new URL('../pass.py', import.meta.url), 'utf8').match(/CSS = r"""([\s\S]*?)"""/)[1];
  const src = readFileSync(new URL('./server.mjs', import.meta.url), 'utf8');
  const app = src.slice(src.indexOf('const APP_CSS = `') + 17, src.indexOf('`;', src.indexOf('const APP_CSS = `')));
  const css = onScale(pass + app);
  const sizes = new Set([...css.matchAll(/(?:font-size:|font:(?:[0-9]{3} |italic )*)([0-9.]+)px/g)].map((m) => +m[1]).filter((n) => n >= 10));
  assert.deepEqual([...sizes].sort((a, b) => a - b), [12, 14, 16, 20, 24]);
  const radii = new Set([...css.matchAll(/border-radius:([^;}]+)/g)].flatMap((m) => [...m[1].matchAll(/([0-9.]+)px/g)].map((x) => +x[1])).filter((n) => n > 2 && n < 999));
  assert.deepEqual([...radii].sort((a, b) => a - b), [6, 10, 16, 22]);
});
