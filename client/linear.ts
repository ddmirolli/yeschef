// Linear tickets, from the Linear MCP calls the agents already made in T3 Code (Dan, 2026-11-13: each Linear call is
// fired once). Yes Chef never calls Linear and holds no Linear sign-in. T3 Code keeps each tool call as a dynamic_tool
// item in its thread, with the tool's name, input and output (packages/contracts/src/orchestrationV2.ts). This reads
// those items with t3_thread_read, keeps the newest read of each ticket, and links a ticket to the threads that read or
// wrote it, or that name it in their title or branch. A ticket no agent has read is "Not checked".
//
// Tool names as T3 records them (read 2026-11-13): Claude "mcp__linear-server__get_issue", Codex
// "linear-server.get_issue". The server's name is the user's own, so any name with "linear" in it counts.
//
// French Brigade (step 7 PR 2, Dan 2026-11-13, 1A/2A/3C) reads three more things from the same calls, never from calls
// of its own: a ticket's "blocked by" tickets (get_issue with includeRelations), a project's lead (get_project or
// list_projects), and a project's whole ticket list (list_issues filtered by that project alone, in one page).
import type { T3Caller } from './contracts.ts';

/** The Linear tools whose results name tickets. */
export type LinearTool = 'get_issue' | 'list_issues' | 'save_issue' | 'get_project' | 'list_projects';
/** A ticket that blocks another (Linear's "blocked by"), as the read gave it: its id and title. open: true when a read
 *  shows it is not done, false when one shows it done, null when no read of it says (not checked). */
export interface Blocker { id: string; title: string | null; open: boolean | null;
  /** When the read that gave open happened (left out with open null). */
  openAt?: number }
/** A ticket as Yes Chef shows it: each field from the newest read that had it. at: when that newest read happened. */
export interface LinearIssue {
  id: string; title: string | null; status: string | null; statusType: string | null; url: string | null;
  assignee: string | null;
  /** The Linear project the ticket is in: French Brigade's feature (brief, "Feature": a Linear project by default).
   *  null: in no project. Left out: not read yet (a part read says nothing about it). */
  project?: string | null; projectId?: string | null;
  /** The tickets it is blocked by. Left out: no read asked for its relations (not checked). */
  blockedBy?: Blocker[];
  at: number; by: string;
}
/** A Linear project as the agents' reads showed it. lead: its lead's name, null for none, left out when no project read
 *  said. tickets: every ticket in it, from one whole list read (listAt), left out when there was none. */
export interface LinearProject {
  id: string; name: string | null; lead?: string | null; leadAt?: number; tickets?: { id: string; statusType: string | null }[]; listAt?: number;
  /** When a read showed a ticket in the project that the whole list, read before it, lacks: the list is no longer whole. */
  listGone?: number;
}
/** What one project read gave: from get_project or list_projects. */
export interface ProjectRead { id: string; name: string | null; lead?: string | null }
/** A feature: a Linear project, by its id and name. */
export interface Feature { id: string; name: string }
/** A ticket on a Yes Chef ticket: read (with its fields), or named but never read ("Not checked"). */
export type LinearLink = ({ state: 'read' } & LinearIssue) | { state: 'not-checked'; id: string; url: string | null };
/** One Linear call in a thread: the tool, the ticket ids it was about, the tickets it returned, and when. */
export interface LinearCall { tool: LinearTool; about: string[]; issues: Partial<LinearIssue>[]; at: number;
  /** The projects a project read gave. */
  projects?: ProjectRead[];
  /** A whole project's tickets: a list_issues filtered by that project alone that came back in one page. */
  list?: { projectId: string; ids: string[] } }

const TOOL = /^(?:mcp__)?[a-z0-9_-]*linear[a-z0-9_-]*(?:__|\.|\/)(get_issue|list_issues|save_issue|get_project|list_projects)$/i;
// The item text T3 keeps for a Linear call this reader looks at (the tool name sits in the item's JSON).
const ITEM = /"toolName":\s*"[^"]*linear[^"]*(get_issue|list_issues|save_issue|get_project|list_projects)"/i;
// A done ticket: completed, canceled or a duplicate. Anything else is still to do.
export const CLOSED = new Set(['completed', 'canceled', 'duplicate']);
// A list_issues that may be a whole project's list: filtered by project and nothing else. Any other filter (state,
// assignee, a search) or a cursor gives part of it.
const LIST_ONLY = new Set(['project', 'limit', 'orderBy', 'includeArchived', 'fields']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A ticket id: the team key, a dash, the number (Linear's identifier, such as ENG-12).
const ID = /^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,7}$/;
const STATUS_TYPES = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']);
const MAX = { title: 300, status: 60, person: 80, issues: 5000, text: 400_000, projects: 500, blockers: 20, list: 250 };

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
// A Linear project's id: a UUID (read 2026-11-13: projectId "ed93ef9c-..."), or any short id of that alphabet.
const projectIdOf = (v: unknown): string | null => (typeof v === 'string' && /^[A-Za-z0-9-]{1,64}$/.test(v.trim()) ? v.trim() : null);
const idOf = (v: unknown): string | null => (typeof v === 'string' && ID.test(v.trim().toUpperCase()) ? v.trim().toUpperCase() : null);
/** Linear's own address for a ticket, and only that: https://linear.app/<workspace>/issue/<id>[/<slug>]. */
const urlOf = (v: unknown, id: string): string | null => {
  if (typeof v !== 'string') return null;
  const m = /^https:\/\/linear\.app\/([a-z0-9][a-z0-9-]{0,63})\/issue\/([A-Za-z0-9_-]+)(?:\/[A-Za-z0-9._~%-]{0,200})?$/.exec(v.trim());
  return m && m[2]!.toUpperCase() === id ? v.trim() : null;
};

/** One ticket from a Linear tool's output, checked field by field. Anything else is dropped. */
export function cleanIssue(raw: unknown): Partial<LinearIssue> | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = idOf(r.id) ?? idOf(r.identifier);
  if (!id) return null;
  const out: Partial<LinearIssue> = { id };
  const title = str(r.title, MAX.title); if (title) out.title = title;
  const status = str(r.status, MAX.status) ?? str((r.state as Record<string, unknown> | null)?.name, MAX.status); if (status) out.status = status;
  const type = str(r.statusType, 20); if (type && STATUS_TYPES.has(type)) out.statusType = type;
  const url = urlOf(r.url, id); if (url) out.url = url;
  const assignee = str(r.assignee, MAX.person); if (assignee) out.assignee = assignee;
  // The project, as the Linear MCP gives it (read 2026-11-13): `project` (its name) and `projectId`, both left out when
  // the ticket is in none. A whole ticket (one with a title) that names no project is in none: '' records that, so a
  // ticket moved out of a project leaves it. A part read (no title) says nothing about the project.
  const p = r.project && typeof r.project === 'object' && !Array.isArray(r.project) ? r.project as Record<string, unknown> : null;
  const project = str(p ? p.name : r.project, MAX.title), projectId = projectIdOf(p ? p.id : r.projectId);
  if (project && projectId) { out.project = project; out.projectId = projectId; }
  else if (title && r.project == null && r.projectId == null) { out.project = ''; out.projectId = ''; }
  // Blocked by (read 2026-11-13: get_issue with includeRelations gives relations.blockedBy, a list of { id, title }).
  // Only a read that has the relations says anything: without them, blockedBy is left out (not checked).
  const rel = r.relations && typeof r.relations === 'object' && !Array.isArray(r.relations) ? r.relations as Record<string, unknown> : null;
  if (rel && Array.isArray(rel.blockedBy)) {
    const seen = new Set<string>();
    out.blockedBy = rel.blockedBy.flatMap((b): Blocker[] => {
      const x = b && typeof b === 'object' ? b as Record<string, unknown> : null;
      const bid = x ? idOf(x.id) ?? idOf(x.identifier) : null;
      if (!bid || bid === id || seen.has(bid)) return [];
      seen.add(bid);
      return [{ id: bid, title: str(x!.title, MAX.title), open: null }];
    }).slice(0, MAX.blockers);
  }
  return out;
}

/** A project from get_project or a list_projects item (read 2026-11-13: `uuid` is the id tickets carry as projectId;
 *  `lead` is { id, name }, or {} for none). Its id must be a UUID: the project's other id is not what tickets carry. */
export function cleanProject(raw: unknown): ProjectRead | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const id = [r.uuid, r.id].find((v): v is string => typeof v === 'string' && UUID.test(v.trim()))?.trim().toLowerCase();
  if (!id) return null;
  const out: ProjectRead = { id, name: str(r.name, MAX.title) };
  if ('lead' in r) {
    const l = r.lead && typeof r.lead === 'object' && !Array.isArray(r.lead) ? r.lead as Record<string, unknown> : null;
    if (r.lead === null || (l && !Object.keys(l).length)) out.lead = null;
    else if (l) { const name = str(l.name, MAX.person); if (name) out.lead = name; }
  }
  return out;
}

/** A ticket's feature, from the Linear tickets its threads read (Board ticket `linear`): the project most of them are
 *  in (the first, on a tie). null: tickets were read and none is in a project. undefined: no ticket was read, so its
 *  feature is not checked. */
export function featureOf(links: readonly LinearLink[] | null | undefined): Feature | null | undefined {
  const read = (links || []).filter((l): l is Extract<LinearLink, { state: 'read' }> => l.state === 'read');
  if (!read.length) return undefined;
  const count = new Map<string, { f: Feature; n: number }>();
  let unread = false;
  for (const l of read) {
    if (l.project === undefined || l.projectId === undefined) { unread = true; continue; }
    if (!l.projectId || !l.project) continue;
    const had = count.get(l.projectId);
    if (had) had.n++; else count.set(l.projectId, { f: { id: l.projectId, name: l.project }, n: 1 });
  }
  let best: { f: Feature; n: number } | null = null;
  for (const c of count.values()) if (!best || c.n > best.n) best = c;
  // None in a project: "No feature" only when every ticket's project was read; else not checked (PR-Agent r1 on #76).
  return best ? best.f : unread ? undefined : null;
}

/** The text of a tool's output: Claude's { content: [{ type: 'text', text }] }, Codex's [{ type: 'text', text }], or a string. */
function outputText(output: unknown): string {
  if (typeof output === 'string') return output;
  const parts = Array.isArray(output) ? output : output && typeof output === 'object' && Array.isArray((output as { content?: unknown }).content) ? (output as { content: unknown[] }).content : null;
  if (!parts) return '';
  return parts.map((p) => (p && typeof p === 'object' && (p as { type?: unknown }).type === 'text' && typeof (p as { text?: unknown }).text === 'string' ? (p as { text: string }).text : '')).join('');
}

/** A Linear call from a dynamic_tool item's text (t3_thread_read: {"toolName", "input", "output"} as JSON), or null. */
export function linearCall(text: string, at: number): LinearCall | null {
  let item: unknown;
  try { item = JSON.parse(text); } catch { return null; }
  if (!item || typeof item !== 'object') return null;
  const { toolName, input, output } = item as { toolName?: unknown; input?: unknown; output?: unknown };
  const m = typeof toolName === 'string' ? TOOL.exec(toolName.trim()) : null;
  if (!m) return null;
  const tool = m[1]!.toLowerCase() as LinearTool;
  let body: unknown = null;
  try { body = JSON.parse(outputText(output)); } catch { body = null; }
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null;
  if (tool === 'get_project' || tool === 'list_projects') {
    const raw = tool === 'get_project' ? [body] : Array.isArray(b?.projects) ? b!.projects as unknown[] : [];
    const projects = raw.slice(0, MAX.projects).map(cleanProject).filter((x): x is ProjectRead => !!x);
    return { tool, about: [], issues: [], at, projects };
  }
  const list = tool === 'list_issues' ? (Array.isArray(b?.issues) ? b!.issues as unknown[] : []) : [body];
  const issues = list.slice(0, MAX.list).map(cleanIssue).filter((x): x is Partial<LinearIssue> => !!x);
  // What the call was about: the id it asked for, and for a single-ticket tool, the ticket it returned.
  const inp = input && typeof input === 'object' && !Array.isArray(input) ? input as Record<string, unknown> : {};
  const asked = idOf(inp.id);
  const about = tool === 'list_issues' ? [] : [...new Set([asked, ...issues.map((x) => x.id!)].filter((x): x is string => !!x))];
  const out: LinearCall = { tool, about, issues, at };
  // A whole project's list (1A, 2026-11-13): filtered by project alone, no cursor, one page (hasNextPage false), every
  // ticket read whole and in the same project. Anything less is part of the project, and says nothing of the rest.
  if (tool === 'list_issues' && inp.project !== undefined && Object.keys(inp).every((k) => LIST_ONLY.has(k)) && b?.hasNextPage === false
    && issues.length && issues.length === list.length && list.length <= MAX.list) {
    const pid = issues[0]!.projectId;
    if (pid && issues.every((x) => x.projectId === pid)) out.list = { projectId: pid.toLowerCase(), ids: issues.map((x) => x.id!) };
  }
  return out;
}

interface Stored { fields: Map<keyof LinearIssue, { v: string; at: number; by: string }>; at: number; by: string }
interface StoredProject { name: { v: string; at: number } | null; lead: { v: string | null; at: number } | null; list: { ids: string[]; at: number } | null; at: number }
interface Followed { stamp: string; next: number }
/** A thread as the reader follows it: its id, title, branch, and what changes when it gets new items. */
export interface LinearThread { threadId: string; title?: string | undefined; branch?: string | null | undefined; updatedAt: string; itemCount?: number | undefined }
// T3's item states before an item is done (OrchestrationV2TurnItemStatus): its output may not be there yet.
const UNFINISHED = new Set(['idle', 'pending', 'running', 'waiting']);
interface ReadPage { items?: { position?: number; itemId?: string; type?: string; status?: string; text?: string; textTruncated?: boolean; nextTextOffset?: number | null; updatedAt?: string }[]; nextPosition?: number | null; hasMore?: boolean }

export interface LinearReadsOptions { call: T3Caller['call']; now?: () => number; log?: (line: string) => void; days?: number; concurrency?: number; pages?: number }
export interface LinearReads {
  want(threads: LinearThread[]): void;
  /** The tickets for one Yes Chef ticket's threads: the ones they read or wrote first, then the ones they name. */
  forThreads(threads: LinearThread[]): LinearLink[];
  get(id: string): LinearIssue | null;
  /** A Linear project as the reads showed it (its UUID, any case), or null when no read named it. */
  project(id: string): LinearProject | null;
  subscribe(fn: () => void): () => boolean;
  stop(): void;
}

/** Follows the threads it is given and keeps the Linear tickets their agents read. Reads run when a thread gets new
 *  items (its stamp moves), a few at a time, never on a timer. A thread is read from where the last read stopped. */
export function createLinearReads({ call, now = Date.now, log = () => {}, days = 7, concurrency = 2, pages = 20 }: LinearReadsOptions): LinearReads {
  const issues = new Map<string, Stored>();
  const projects = new Map<string, StoredProject>();
  const touched = new Map<string, Set<string>>();
  const followed = new Map<string, Followed>();
  const listeners = new Set<() => void>();
  const queue: string[] = [], queued = new Set<string>();
  let running = 0, stopped = false;

  const keep = (c: LinearCall, threadId: string): boolean => {
    let moved = false;
    for (const x of c.issues) {
      const s = issues.get(x.id!) ?? { fields: new Map(), at: 0, by: threadId };
      for (const k of ['title', 'status', 'statusType', 'url', 'assignee', 'project', 'projectId', 'blockedBy'] as const) {
        // blockedBy is kept as JSON, [[id, title], ...]: a field holds one string.
        const v = k === 'blockedBy' ? (x.blockedBy ? JSON.stringify(x.blockedBy.map((y) => [y.id, y.title])) : undefined) : x[k];
        if (typeof v !== 'string') continue;
        const had = s.fields.get(k);
        if (!had || had.at <= c.at) { if (had?.v !== v) moved = true; s.fields.set(k, { v, at: c.at, by: threadId }); }
      }
      if (c.at > s.at || (c.at === s.at && s.by !== threadId)) { s.at = c.at; s.by = threadId; moved = true; }
      issues.set(x.id!, s);
    }
    // Projects: each field from its newest read, as a ticket's are.
    const proj = (id: string): StoredProject => { const p = projects.get(id) ?? { name: null, lead: null, list: null, at: 0 }; projects.set(id, p); return p; };
    for (const r of c.projects ?? []) {
      const p = proj(r.id);
      if (r.name && (!p.name || p.name.at <= c.at)) { if (p.name?.v !== r.name) moved = true; p.name = { v: r.name, at: c.at }; }
      if (r.lead !== undefined && (!p.lead || p.lead.at <= c.at)) { if (p.lead?.v !== r.lead) moved = true; p.lead = { v: r.lead, at: c.at }; }
      p.at = Math.max(p.at, c.at);
    }
    if (c.list) {
      const p = proj(c.list.projectId);
      if (!p.list || p.list.at <= c.at) { if (p.list?.ids.join() !== c.list.ids.join()) moved = true; p.list = { ids: c.list.ids, at: c.at }; }
      const named = c.issues.find((x) => x.project)?.project;
      if (named && (!p.name || p.name.at <= c.at)) p.name = { v: named, at: c.at };
      p.at = Math.max(p.at, c.at);
    }
    if (projects.size > MAX.projects) for (const [id] of [...projects].sort((a, z) => a[1].at - z[1].at).slice(0, projects.size - MAX.projects)) projects.delete(id);
    if (c.about.length) {
      const set = touched.get(threadId) ?? new Set<string>();
      for (const id of c.about) if (!set.has(id)) { set.add(id); moved = true; }
      touched.set(threadId, set);
    }
    // The oldest reads go first once the store is full.
    if (issues.size > MAX.issues) for (const [id] of [...issues].sort((a, b) => a[1].at - b[1].at).slice(0, issues.size - MAX.issues)) issues.delete(id);
    return moved;
  };

  // The whole text of one item, page by page (t3_thread_read: itemId with textOffset).
  async function fullText(threadId: string, itemId: string): Promise<string | null> {
    let text = '', offset = 0;
    for (let i = 0; i < 10 && text.length < MAX.text; i++) {
      const page = await call('t3_thread_read', { threadId, itemId, maxCharsPerItem: 50000, ...(offset ? { textOffset: offset } : {}) }) as ReadPage | null;
      const item = page?.items?.find((x) => x.itemId === itemId);
      if (!item || typeof item.text !== 'string') return null;
      text += item.text;
      if (!item.textTruncated || typeof item.nextTextOffset !== 'number' || item.nextTextOffset <= offset) return text;
      offset = item.nextTextOffset;
    }
    return null;
  }

  // progress.moved: something this read stored, kept even when a later page fails.
  async function readThread(threadId: string, progress: { moved: boolean }): Promise<{ more: boolean }> {
    const f = followed.get(threadId);
    if (!f) return { more: false };
    let more = false, at = f.next, hold: number | null = null;
    for (let i = 0; i < pages; i++) {
      const page = await call('t3_thread_read', { threadId, view: 'activity', afterPosition: at, limit: 100, maxCharsPerItem: 200 }) as ReadPage | null;
      const items = Array.isArray(page?.items) ? page!.items : [];
      for (const item of items) {
        if (item.type !== 'dynamic_tool' || typeof item.itemId !== 'string' || !ITEM.test(item.text || '')) continue;
        // Still running: the next read starts just before it, once the thread moves again.
        if (UNFINISHED.has(String(item.status))) { if (hold === null && typeof item.position === 'number') hold = Math.max(f.next, item.position - 1); continue; }
        const text = await fullText(threadId, item.itemId);
        const when = Date.parse(item.updatedAt || '');
        const c = text ? linearCall(text, Number.isFinite(when) ? when : now()) : null;
        if (c && keep(c, threadId)) progress.moved = true;
      }
      const before = at;
      if (typeof page?.nextPosition === 'number' && page.nextPosition > at) at = page.nextPosition;
      more = !!page?.hasMore && at > before;
      if (!more) break;
    }
    f.next = hold ?? at;
    return { more: more && hold === null };
  }

  function pump(): void {
    while (!stopped && running < concurrency && queue.length) {
      const id = queue.shift()!; queued.delete(id); running++;
      const progress = { moved: false };
      const tell = () => { if (progress.moved) for (const fn of [...listeners]) { try { fn(); } catch (ex) { log(`a Linear listener failed: ${String(ex)}`); } } };
      readThread(id, progress).then(({ more }) => {
        tell();
        // A long thread's pages ran out: read on from where this read stopped.
        if (more && !queued.has(id)) { queued.add(id); queue.push(id); }
      }, (ex: unknown) => {
        // A failed read is tried again at the next want, even if the thread has not moved.
        const f = followed.get(id); if (f) f.stamp = '';
        tell();
        log(`Linear read of ${id} failed: ${String((ex as Error)?.message || ex).slice(0, 200)}`);
      })
        .finally(() => { running--; pump(); });
    }
  }

  // A ticket as shown: at and by are the status's own read when there is one, so an old status never wears a new age.
  const view = (id: string, s: Stored): LinearIssue => {
    const f = (k: keyof LinearIssue) => s.fields.get(k)?.v ?? null;
    const st = s.fields.get('status');
    const out: LinearIssue = { id, title: f('title'), status: f('status'), statusType: f('statusType'), url: f('url'), assignee: f('assignee'),
      at: st?.at ?? s.at, by: st?.by ?? s.by };
    // The project: '' is stored for a whole ticket in none (null here); never read, it is left out (not checked).
    const p = s.fields.get('project')?.v, pid = s.fields.get('projectId')?.v;
    if (p !== undefined && pid !== undefined) { out.project = p || null; out.projectId = pid || null; }
    // Blocked by: each blocker open or done as its own newest read says, else not checked (null).
    const bb = s.fields.get('blockedBy')?.v;
    if (bb !== undefined) {
      let pairs: unknown = null;
      try { pairs = JSON.parse(bb); } catch { pairs = null; }
      out.blockedBy = (Array.isArray(pairs) ? pairs : []).flatMap((x): Blocker[] => {
        if (!Array.isArray(x) || typeof x[0] !== 'string') return [];
        const t = issues.get(x[0])?.fields.get('statusType');
        return [{ id: x[0], title: typeof x[1] === 'string' ? x[1] : null, ...(t ? { open: !CLOSED.has(t.v), openAt: t.at } : { open: null }) }];
      });
    }
    return out;
  };
  const projectView = (id: string, p: StoredProject): LinearProject => {
    const out: LinearProject = { id, name: p.name?.v ?? null };
    if (p.lead) { out.lead = p.lead.v; out.leadAt = p.lead.at; }
    if (!p.list) return out;
    // A ticket read in this project after the list, and not on it, proves the list is no longer whole: no list
    // (PR-Agent r1 on #78), so Ready for your look waits for the next whole read.
    // Its time goes with the summary, so a teammate's older whole list cannot stand in for it (PR-Agent r2 on #78).
    const on = new Set(p.list.ids), list = p.list;
    let gone = 0;
    for (const [t, s] of issues) {
      const pid = s.fields.get('projectId');
      if (pid && pid.at > list.at && pid.v.toLowerCase() === id.toLowerCase() && !on.has(t)) gone = Math.max(gone, pid.at);
    }
    if (gone) { out.listGone = gone; return out; }
    // Each ticket's status from its own newest read: a ticket done since the list was read counts as done. listAt is
    // when the list itself was read: across Macs the newest whole list wins, never an older one with newer statuses
    // (PR-Agent r2 on #78).
    out.tickets = list.ids.map((t) => ({ id: t, statusType: issues.get(t)?.fields.get('statusType')?.v ?? null }));
    out.listAt = list.at;
    return out;
  };

  return {
    want(threads) {
      const since = now() - days * 86_400_000;
      const ids = new Set<string>();
      for (const t of threads) {
        ids.add(t.threadId);
        const stamp = `${t.updatedAt}|${t.itemCount ?? ''}`;
        const f = followed.get(t.threadId);
        if (f) { if (f.stamp === stamp) continue; f.stamp = stamp; }
        else {
          // A thread untouched for `days` is not read back from its start: its old reads would show as stale anyway.
          if (!(Date.parse(t.updatedAt) >= since)) continue;
          followed.set(t.threadId, { stamp, next: 0 });
        }
        if (!queued.has(t.threadId)) { queued.add(t.threadId); queue.push(t.threadId); }
      }
      for (const id of [...followed.keys()]) if (!ids.has(id)) { followed.delete(id); touched.delete(id); }
      pump();
    },
    forThreads(threads) {
      const order: string[] = [];
      const add = (id: string) => { if (!order.includes(id)) order.push(id); };
      for (const t of threads) for (const id of touched.get(t.threadId) ?? []) add(id);
      // Ids the threads name in their title or branch, for team keys a read has shown (so "PR-12" is no ticket).
      const keys = [...new Set([...issues.keys()].map((id) => id.split('-')[0]!))].filter((k) => /^[A-Z][A-Z0-9_]{0,9}$/.test(k));
      if (keys.length) {
        const re = new RegExp(`(?:^|[^A-Za-z0-9])(${keys.join('|')})-([0-9]{1,7})(?![0-9])`, 'gi');
        for (const t of threads) for (const text of [t.title || '', t.branch || '']) for (const m of text.matchAll(re)) add(`${m[1]!.toUpperCase()}-${Number(m[2])}`);
      }
      return order.slice(0, 6).map((id): LinearLink => {
        const s = issues.get(id);
        if (!s) {
          // Not read: Linear's address only when a read of the same team showed its workspace.
          const twin = [...issues.values()].map((x) => x.fields.get('url')?.v).find((u) => u && u.includes(`/issue/${id.split('-')[0]}-`));
          return { state: 'not-checked', id, url: twin ? twin.replace(/\/issue\/.*$/, `/issue/${id}`) : null };
        }
        return { state: 'read', ...view(id, s) };
      });
    },
    get(id) {
      const s = issues.get(id);
      return s ? view(id, s) : null;
    },
    project(id) {
      const key = String(id || '').toLowerCase(), p = projects.get(key);
      return p ? projectView(key, p) : null;
    },
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { stopped = true; queue.length = 0; queued.clear(); },
  };
}
