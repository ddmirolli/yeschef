import type { DemoBoard, DemoKitchen, DemoProject, DemoRules } from '../../src/demo/types.ts';
export function act(input: {
  board: DemoBoard; t3: DemoKitchen['t3']; input: Record<string, string>;
  holds: Map<string, unknown>; answered: Map<string, unknown>; projects: DemoProject[]; rules: DemoRules;
}): Promise<{ status: number; text: string }>;
