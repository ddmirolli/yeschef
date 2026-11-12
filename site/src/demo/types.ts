import type { Board } from '../../demo/lib/board.ts';

export interface DemoPr { repository: string; number: number; state: string; url: string; }
export interface DemoThread {
  threadId: string; title: string; projectId: string; status: string;
  parentThreadId: string | null; pullRequests: DemoPr[]; settled: boolean; snoozed: boolean;
  settledAt?: string; latestRunId: string | null; updatedAt: string; itemCount: number; model: string;
}
export interface DemoItem { type: string; position: number; itemId: string; text: string; }
export interface DemoQuestion {
  id: string; requestId: string; question: string; options: { label: string; description?: string }[];
}
export interface DemoRun { runId: string | null; status: string; startedAt: string; completedAt: string | null; }
export interface DemoProject { id: string; title: string; icon?: string; workspaceRoot?: string; faviconPath?: string; }
/** The app's own board (client/board.ts), from the copy in site/demo/lib. */
export type DemoBoard = Board;
export interface DemoRules { all: Record<string, string>; projects: Record<string, Record<string, string>>; }
export interface DemoOptions {
  now?: () => number;
  where: (directory: string) => Omit<DemoProject, 'id' | 'title'>;
  shot: (name: string) => string;
  onChange?: () => void;
  later?: ((callback: () => void, delay: number) => unknown) | null;
  /** The team demo: the made-up team (client/demo-team.ts) below the visitor, in this mode. Left out, the visitor is solo. */
  team?: DemoMode | null;
}
/** A team's mode: Open kitchen or French Brigade. */
export type DemoMode = 'open' | 'brigade';
export interface DemoToolArgs {
  threadId?: string; projectId?: string; action?: string; requestId?: string; settled?: boolean;
  afterPosition?: number; runLimit?: number; answers?: Record<string, string>; title?: string; message?: string;
}
export interface DemoKitchen {
  t3: { call(name: string, args?: DemoToolArgs): Promise<unknown> };
  board(): DemoBoard;
  page(search?: string): string;
  act(body: string): Promise<[number, string]>;
  /** The team demo's mode, which the site's mode cards set; null in the solo demo. */
  mode(next?: DemoMode): DemoMode | null;
}

declare global {
  interface Window {
    __demoTouch?: () => void;
    /** The team demo only: switch the made-up team between the two modes and redraw. */
    __demoMode?: (mode: DemoMode) => void;
    __demoTick: () => void;
    __demoReady: (kitchen: DemoKitchen) => void;
    yeschef: { act(body: string): Promise<[number, string]> };
  }
}
