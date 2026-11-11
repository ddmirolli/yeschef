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
export interface DemoBoard {
  tickets: { thread: DemoThread; place: string; atPass: boolean; asks: { thread: DemoThread; items: DemoQuestion[] }[] }[];
  verifiedToday: number; runsChecked: boolean;
}
export interface DemoRules { all: Record<string, string>; projects: Record<string, Record<string, string>>; }
export interface DemoOptions {
  now?: () => number;
  where: (directory: string) => Omit<DemoProject, 'id' | 'title'>;
  shot: (name: string) => string;
  onChange?: () => void;
  later?: ((callback: () => void, delay: number) => unknown) | null;
}
export interface DemoToolArgs {
  threadId?: string; projectId?: string; action?: string; settled?: boolean;
  afterPosition?: number; runLimit?: number; answers?: Record<string, string>; title?: string; message?: string;
}
export interface DemoKitchen {
  t3: { call(name: string, args?: DemoToolArgs): Promise<unknown> };
  board(): DemoBoard;
  page(search?: string): string;
  act(body: string): Promise<[number, string]>;
}

declare global {
  interface Window {
    __demoTouch?: () => void;
    __demoTick: () => void;
    __demoReady: (kitchen: DemoKitchen) => void;
    yeschef: { act(body: string): Promise<[number, string]> };
  }
}
