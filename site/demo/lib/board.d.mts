import type { DemoBoard, DemoProject } from '../../src/demo/types.ts';
export function buildBoard(input: {
  projects: DemoProject[]; threads: import('../../src/demo/types.ts').DemoThread[];
  questions: Map<string, import('../../src/demo/types.ts').DemoQuestion[]>;
  lastWords: Map<string, unknown>; runs: Map<string, unknown>; waits: Map<string, unknown>;
}): DemoBoard;
export function pickedFrom(params: URLSearchParams): string[] | null;
export function renderApp(input: {
  board: DemoBoard; picked: string[] | null; link: () => string;
  status: { ok: boolean; at: number; ms: number }; origin: string;
  answered: Map<string, unknown>; projects: DemoProject[];
  rules: import('../../src/demo/types.ts').DemoRules & { rev: number };
}): string;
