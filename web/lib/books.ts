/**
 * Agent-row → Book mapping. Faithful port of buildBookList() in the legacy
 * app.js (the DB agents table is the single source of truth; the frontend
 * derives display Books from it).
 */

export interface AgentRow {
  id: string;
  name: string;
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
      };
    });
}

/** Deterministic gradient cover (legacy coverColor): stable hue from the title. */
export function coverStyle(book: Book): string {
  if (book.isAIGenerated) {
    return "linear-gradient(135deg,#667eea 0%,#764ba2 100%)";
  }
  let h = 0;
  for (let i = 0; i < book.title.length; i++) {
    h = (h * 31 + book.title.charCodeAt(i)) % 360;
  }
  return `linear-gradient(135deg, hsl(${h} 42% 60%), hsl(${(h + 38) % 360} 44% 48%))`;
}

/** Status badge text, or null when the book is ready/normal. */
export function statusBadge(book: Book): { text: string; cls: string } | null {
  if (book.isAIGenerated && book.status === "failed") return { text: "Failed", cls: "coming" };
  if (book.isAIGenerated && book.status === "error") return { text: "Error", cls: "coming" };
  if (book.isAIGenerated && ["writing", "outlining", "confirmed"].includes(book.status))
    return { text: "Writing…", cls: "indexing" };
  if (book.status === "indexing") return { text: "Indexing…", cls: "indexing" };
  return null;
}
