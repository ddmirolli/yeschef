// Linear tickets, from the Linear MCP calls the agents already made in T3 Code (Dan, 2026-11-13: each Linear call is
// fired once). Yes Chef never calls Linear and holds no Linear sign-in. T3 Code keeps each tool call as a dynamic_tool
// item in its thread, with the tool's name, input and output (packages/contracts/src/orchestrationV2.ts). This reads
// those items with t3_thread_read, keeps the newest read of each ticket, and links a ticket to the threads that read or
// wrote it, or that name it in their title or branch. A ticket no agent has read is "Not checked".
//
// Tool names as T3 records them (read 2026-11-13): Claude "mcp__linear-server__get_issue", Codex
// "linear-server.get_issue". The server's name is the user's own, so any name with "linear" in it counts.
import type { T3Caller } from './contracts.ts';

/** The Linear tools whose results name tickets. */
export type LinearTool = 'get_issue' | 'list_issues' | 'save_issue';
/** A ticket as Yes Chef shows it: each field from the newest read that had it. at: when that newest read happened. */
export interface LinearIssue {
  id: string; title: string | null; status: string | null; statusType: string | null; url: string | null;
  assignee: string | null; at: number; by: string;
}
/** A ticket on a Yes Chef ticket: read (with its fields), or named but never read ("Not checked"). */
export type LinearLink = ({ state: 'read' } & LinearIssue) | { state: 'not-checked'; id: string; url: string | null };
/** One Linear call in a thread: the tool, the ticket ids it was about, the tickets it returned, and when. */
export interface LinearCall { tool: LinearTool; about: string[]; issues: Partial<LinearIssue>[]; at: number }

const TOOL = /^(?:mcp__)?[a-z0-9_-]*linear[a-z0-9_-]*(?:__|\.|\/)(get_issue|list_issues|save_issue)$/i;
// A ticket id: the team key, a dash, the number (Linear's identifier, such as ENG-12).
const ID = /^[A-Z][A-Z0-9_]{0,9}-[0-9]{1,7}$/;
const STATUS_TYPES = new Set(['triage', 'backlog', 'unstarted', 'started', 'completed', 'canceled', 'duplicate']);
const MAX = { title: 300, status: 60, person: 80, issues: 5000, text: 400_000 };

const str = (v: unknown, max: number): string | null => {
  if (typeof v !== 'string') return null;
  // eslint-disable-next-line no-control-regex
  const s = v.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim();
  return s ? s.slice(0, max) : null;
};
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
  return out;
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
  const list = tool === 'list_issues' ? (body && typeof body === 'object' && Array.isArray((body as { issues?: unknown }).issues) ? (body as { issues: unknown[] }).issues : []) : [body];
  const issues = list.slice(0, 250).map(cleanIssue).filter((x): x is Partial<LinearIssue> => !!x);
  // What the call was about: the id it asked for, and for a single-ticket tool, the ticket it returned.
  const asked = input && typeof input === 'object' ? idOf((input as { id?: unknown }).id) : null;
  const about = tool === 'list_issues' ? [] : [...new Set([asked, ...issues.map((x) => x.id!)].filter((x): x is string => !!x))];
  return { tool, about, issues, at };
}

interface Stored { fields: Map<keyof LinearIssue, { v: string; at: number; by: string }>; at: number; by: string }
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
  subscribe(fn: () => void): () => boolean;
  stop(): void;
}

/** Follows the threads it is given and keeps the Linear tickets their agents read. Reads run when a thread gets new
 *  items (its stamp moves), a few at a time, never on a timer. A thread is read from where the last read stopped. */
export function createLinearReads({ call, now = Date.now, log = () => {}, days = 7, concurrency = 2, pages = 20 }: LinearReadsOptions): LinearReads {
  const issues = new Map<string, Stored>();
  const touched = new Map<string, Set<string>>();
  const followed = new Map<string, Followed>();
  const listeners = new Set<() => void>();
  const queue: string[] = [], queued = new Set<string>();
  let running = 0, stopped = false;

  const keep = (c: LinearCall, threadId: string): boolean => {
    let moved = false;
    for (const x of c.issues) {
      const s = issues.get(x.id!) ?? { fields: new Map(), at: 0, by: threadId };
      for (const k of ['title', 'status', 'statusType', 'url', 'assignee'] as const) {
        const v = x[k];
        if (typeof v !== 'string') continue;
        const had = s.fields.get(k);
        if (!had || had.at <= c.at) { if (had?.v !== v) moved = true; s.fields.set(k, { v, at: c.at, by: threadId }); }
      }
      if (c.at > s.at || (c.at === s.at && s.by !== threadId)) { s.at = c.at; s.by = threadId; moved = true; }
      issues.set(x.id!, s);
    }
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
        if (item.type !== 'dynamic_tool' || typeof item.itemId !== 'string' || !/"toolName":\s*"[^"]*linear[^"]*(get_issue|list_issues|save_issue)"/i.test(item.text || '')) continue;
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
    return { id, title: f('title'), status: f('status'), statusType: f('statusType'), url: f('url'), assignee: f('assignee'), at: st?.at ?? s.at, by: st?.by ?? s.by };
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
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    stop() { stopped = true; queue.length = 0; queued.clear(); },
  };
}
