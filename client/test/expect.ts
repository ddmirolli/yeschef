// Assertions that also narrow types, for the client tests. Each one fails the test, with a reason, when the value is
// not what the test needs. Lives in client/test/, which the app build leaves out.
import assert from 'node:assert/strict';

/** list[i], or the test fails. */
export function nth<X>(list: readonly X[] | null | undefined, i = 0): X {
  const x = list?.[i];
  assert.ok(x !== undefined, `nothing at ${i}`);
  return x;
}

/** The match of re in s (or its group i), or the test fails. */
export function grab(s: string, re: RegExp, i = 0): string {
  const v = s.match(re)?.[i];
  assert.ok(v !== undefined, `no match for ${re}`);
  return v;
}

/** A read that must be checked: the test fails on "not checked", with its reason. */
export function checked<R extends { state: string; why?: unknown }>(r: R): Extract<R, { state: 'checked' }> {
  assert.equal(r.state, 'checked', String(r.why ?? ''));
  return r as Extract<R, { state: 'checked' }>;
}

/** Why a read is not checked: the test fails if it is checked. */
export function whyOf(r: { state: string; why?: unknown }): string {
  assert.equal(r.state, 'not-checked');
  return String(r.why);
}

/** The first item of list that passes, or the test fails. */
export function one<X>(list: readonly X[], pass: (x: X) => boolean, what = 'match'): X {
  const x = list.find(pass);
  assert.ok(x !== undefined, `no ${what}`);
  return x;
}
