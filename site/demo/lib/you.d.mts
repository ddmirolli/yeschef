import type { DemoThread, DemoQuestion, DemoRun } from '../../src/demo/types.ts';
export function dayStart(now: number): number;
export function mayRunToday(thread: DemoThread, start: number): boolean;
export function readRuns(input: { recentRuns: DemoRun[]; thread: { runCount: number } }): unknown;
export function trackWaits(log: Map<string, unknown>, threads: DemoThread[], questions: Map<string, DemoQuestion[]>, now: number): Map<string, unknown>;
