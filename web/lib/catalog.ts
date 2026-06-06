/**
 * In-memory client cache for the near-static catalog reads.
 *
 * The book catalog (`/api/agents`) and the minds list (`/api/minds`) change at
 * most a few times an hour, but were re-fetched on EVERY navigation/mount —
 * Library, the composer book picker, a chat's related-books sidebar, the minds
 * graph. Worse, for a signed-in user the Bearer header makes Vercel's edge cache
 * skip these responses, so each fetch hit the COLD Python origin (~1.5-6s). That
 * was the "switching Chats/Library/Great Minds loads for seconds every time,
 * even when just visited" lag.
 *
 * Fix: cache them here with a short TTL + in-flight de-dup, so re-visits are
 * instant (no network). And fetch them with `auth: false` — these lists are
 * identity-independent (the endpoints take no user), so dropping the Bearer lets
 * the FIRST load hit the shared edge cache too.
 */

import { apiFetch, getAgent, type Agent } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow, type Book } from "@/lib/books";

// 5 min: a freshly created book/mind still appears within the window, and the
// lists are otherwise static across a browsing session.
const TTL = 5 * 60 * 1000;

// ── Catalog books (/api/agents) ──────────────────────────────────────────
let _books: Book[] | null = null;
let _booksAt = 0;
let _booksInflight: Promise<Book[]> | null = null;

/** The catalog as display Books — cached (TTL) + request-deduped. */
export async function getCatalogBooks(): Promise<Book[]> {
  if (_books && Date.now() - _booksAt < TTL) return _books;
  if (_booksInflight) return _booksInflight;
  _booksInflight = apiFetch<AgentRow[]>("/api/agents", { method: "GET", auth: false })
    .then((rows) => {
      _books = mapAgentsToBooks(rows || []);
      _booksAt = Date.now();
      return _books;
    })
    .catch((err) => {
      if (_books) return _books; // serve stale on a transient failure
      throw err;
    })
    .finally(() => {
      _booksInflight = null;
    });
  return _booksInflight;
}

/** Synchronous peek for instant first paint — null when no fresh cache. */
export function getCachedCatalogBooks(): Book[] | null {
  return _books && Date.now() - _booksAt < TTL ? _books : null;
}

/** Drop the cached catalog (e.g. after creating/deleting a book). */
export function invalidateCatalogBooks(): void {
  _books = null;
  _booksAt = 0;
}

// ── Single agent (/api/agents/{id}) ──────────────────────────────────────
// Memoizes per-id so re-opening the same book (composer preselect, chat resume)
// doesn't re-hit the origin. Stays authed (a single agent may be a private book).
const _agents = new Map<string, { at: number; agent: Agent }>();

export async function getAgentCached(id: string): Promise<Agent> {
  const hit = _agents.get(id);
  if (hit && Date.now() - hit.at < TTL) return hit.agent;
  const agent = await getAgent(id);
  _agents.set(id, { at: Date.now(), agent });
  return agent;
}
