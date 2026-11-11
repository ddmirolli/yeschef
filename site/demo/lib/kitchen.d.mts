import type { DemoRules } from '../../src/demo/types.ts';
export function normalize(input: unknown): DemoRules;
export function change(rules: DemoRules, input: { scope: string; key: string; value: string; reset: boolean }):
  { error: string; rules?: never } | { error?: never; rules: DemoRules };
