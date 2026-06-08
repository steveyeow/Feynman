/**
 * Agent-row → Book mapping. Faithful port of buildBookList() in the legacy
 * app.js (the DB agents table is the single source of truth; the frontend
 * derives display Books from it).
 */

export interface AgentRow {
  id: string;
  name: string;
  slug?: string | null; // descriptive URL slug; null for un-backfilled rows
  type?: string; // "ai_book" | "upload" | "catalog" | ...
  status?: string;
  source?: string;
  user_id?: string;
  created_at?: string;
  meta?: {
    author?: string;
    isbn?: string;
    category?: string;
    description?: string;
    chunk_count?: number;
    skills?: Record<string, unknown>;
    creator_name?: string;
    creator_user_id?: string;
  };
}

export interface Book {
  id: string;
  agentId: string;
  /** Descriptive URL slug. Link to /book/{slug} to skip the uuid→slug 301 hop;
   *  null for un-backfilled rows (callers fall back to agentId). */
  slug: string | null;
  title: string;
  author: string;
  isbn: string | null;
  category: string;
  description: string;
  status: string;
  available: boolean;
  hasFullText: boolean;
  isUploaded: boolean;
  isCatalog: boolean;
  isAIGenerated: boolean;
  creatorName: string;
  userId: string;
  createdAt: string;
  /** Crowd vote count for this title (merged from /api/votes). 0 if none. */
  upvotes: number;
}

export function mapAgentsToBooks(agents: AgentRow[]): Book[] {
  return agents
    .filter((a) => a.status !== "error" || a.type === "ai_book")
    .map((a) => {
      const meta = a.meta || {};
      const hasFullText =
        a.type === "ai_book"
          ? a.status === "ready" || a.status === "writing"
          : (meta.chunk_count || 0) >= 10;
      return {
        id: a.id,
        agentId: a.id,
        slug: a.slug ?? null,
        title: a.name,
        author: meta.author || a.source || "",
        isbn: meta.isbn || null,
        category: meta.category || (a.type === "ai_book" ? "" : a.type || ""),
        description: meta.description || "",
        status: a.status || "",
        available: a.status === "ready",
        hasFullText,
        isUploaded: a.type === "upload",
        isCatalog: a.type === "catalog",
        isAIGenerated: a.type === "ai_book",
        creatorName: meta.creator_name || "",
        userId: a.user_id || meta.creator_user_id || "",
        createdAt: a.created_at || "",
        upvotes: 0,
      };
    });
}

/**
 * Merge crowd vote counts into a Book list by case-insensitive title match
 * (port of buildBookList's vote-merge loop). Mutates a copy, returns it.
 */
export function mergeVotes(
  books: Book[],
  votes: { title: string; count: number }[],
): Book[] {
  if (!votes?.length) return books;
  const byTitle = new Map(votes.map((v) => [v.title.toLowerCase(), v.count]));
  return books.map((b) => {
    const count = byTitle.get(b.title.toLowerCase());
    return count != null ? { ...b, upvotes: count } : b;
  });
}

// Verbatim from legacy app.js: fixed palette + FNV-ish hash (NOT an HSL hash),
// so a given title maps to the exact same cover color as production.
const COVER_COLORS = [
  "#264653", "#2a9d8f", "#e76f51", "#457b9d", "#6d597a",
  "#355070", "#b56576", "#0077b6", "#588157", "#9b2226",
];

/** Deterministic cover background. AI books → the purple gradient; everything
 *  else → a solid color from COVER_COLORS keyed on the title (legacy coverColor). */
export function coverStyle(book: Book): string {
  if (book.isAIGenerated) {
    return "linear-gradient(135deg,#667eea 0%,#764ba2 100%)";
  }
  let h = 0;
  for (let i = 0; i < book.title.length; i++) {
    h = ((h << 5) - h + book.title.charCodeAt(i)) | 0;
  }
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length];
}

/** Title-only cover color (for surfaces that have a title but not a full Book,
 *  e.g. the SEO book hero). Same palette + hash as coverStyle. */
export function coverStyleFromTitle(title: string, isAIGenerated = false): string {
  if (isAIGenerated) return "linear-gradient(135deg,#667eea 0%,#764ba2 100%)";
  let h = 0;
  for (let i = 0; i < title.length; i++) h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  return COVER_COLORS[Math.abs(h) % COVER_COLORS.length];
}

/** Cover initials — first letters of up to TWO words longer than 2 chars
 *  (legacy coverInitials). "Induction motor" → "IM", "Tesla coil" → "TC". */
export function coverInitials(title: string): string {
  return title
    .split(/[\s:—]+/)
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("");
}

/** Status badge text, or null when the book is ready/normal. */
export function statusBadge(book: Book): { text: string; cls: string } | null {
  // Both "failed" and "error" show a red "Failed" pill (app.js renderBookGrid
  // 3451-3454 — never an "Error" label, never grey).
  if (book.isAIGenerated && (book.status === "failed" || book.status === "error"))
    return { text: "Failed", cls: "failed" };
  if (book.isAIGenerated && ["writing", "outlining", "confirmed"].includes(book.status))
    return { text: "Writing…", cls: "indexing" };
  if (book.status === "indexing") return { text: "Indexing…", cls: "indexing" };
  return null;
}
