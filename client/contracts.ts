// The shapes Yes Chef reads from T3 Code: rows of its MCP tools (t3_thread_list, t3_thread_read, t3_project_list,
// t3_pending_request) and the shells of its live stream (packages/contracts in T3 Code v0.1.7, MIT, T3 Tools Inc.).
// They are typed here, not checked: T3 Code may leave out any field marked optional, and the code reads them as such.

/** A pull request linked to a thread. state: GitHub's state as T3 Code last read it ('open', 'merged', 'closed'), or
 *  null when it has not read one. */
export interface PullRequestLink {
  host?: string | undefined;
  repository: string;
  number: number;
  url?: string | undefined;
  source?: string | undefined;
  state?: string | null | undefined;
}

/** One thread as the board reads it: a row of t3_thread_list, or the same row made from a live-stream shell
 *  (client/shells.mjs threadRow). */
export interface ThreadRow {
  threadId: string;
  projectId?: string | undefined;
  title?: string | undefined;
  link?: string | null | undefined;
  createdBy?: string | undefined;
  creationSource?: string | undefined;
  status: string;
  latestRunId?: string | null | undefined;
  providerInstanceId?: string | undefined;
  model?: string | undefined;
  runtimeMode?: string | undefined;
  interactionMode?: string | undefined;
  linkedPullRequest?: unknown;
  pullRequests?: PullRequestLink[] | undefined;
  settled?: boolean | undefined;
  settledAt?: string | null | undefined;
  snoozed?: boolean | undefined;
  snoozedUntil?: string | null | undefined;
  parentThreadId?: string | null | undefined;
  relationshipToParent?: string | null | undefined;
  itemCount?: number | undefined;
  createdAt?: string | undefined;
  updatedAt: string;
}

/** A project, from t3_project_list, with the icon Yes Chef reads from its folder when it can. */
export interface Project {
  id: string;
  title?: string | undefined;
  icon?: string | null | undefined;
  workspaceRoot?: string | undefined;
}

/** One option of a T3 question. */
export interface QuestionOption {
  label: string;
  value?: string | undefined;
  description?: string | undefined;
}

/** A question a thread waits on (t3_pending_request, action read), with the id of the request it came in. */
export interface QuestionItem {
  id: string;
  requestId: string;
  question: string;
  options?: QuestionOption[] | undefined;
  allowCustomAnswer?: boolean | undefined;
  required?: boolean | undefined;
}

/** One run of a thread, as t3_thread_read lists it with runLimit. */
export interface RunRecord {
  status?: string | undefined;
  startedAt?: string | null | undefined;
  completedAt?: string | null | undefined;
}

/** What t3_thread_read gives, as far as Yes Chef reads it. */
export interface ThreadRead {
  thread?: (ThreadRow & { runCount?: number | undefined }) | undefined;
  recentRuns?: RunRecord[] | undefined;
}

/** The one way Yes Chef acts in T3 Code: a tool call over MCP (client/t3mcp.ts connect). */
export interface T3Caller {
  call(name: string, args?: Record<string, unknown>): Promise<unknown>;
}
