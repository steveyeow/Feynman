"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { get, post, listVotes } from "@/lib/api";
import { AgentRow, Book, mapAgentsToBooks, mergeVotes } from "@/lib/books";
import BookCard from "./BookCard";

/**
 * Library — client island. Faithful to the legacy flow: load /api/agents,
 * derive Books, client-side search + topic-tag filter + Recent/All, and the
 * real-time "we'll find and add it" discovery bar (POST /api/search-book) when
 * a search has no local match.
 */
export default function Library() {
  const [books, setBooks] = useState<Book[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [activeTopics, setActiveTopics] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"recent" | "all">("recent");
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [agents, tops, votes] = await Promise.all([
        get<AgentRow[]>("/api/agents"),
        // /api/topics returns { topics: [...] } — unwrap it (was read as a bare
        // array, so the tag row never rendered).
        get<{ topics?: string[] } | string[]>("/api/topics").catch(() => ({ topics: [] })),
        // Vote counts merged into Book.upvotes (port of buildBookList).
        listVotes().catch(() => []),
      ]);
      setBooks(mergeVotes(mapAgentsToBooks(agents), votes));
      setTopics(Array.isArray(tops) ? tops : tops.topics || []);
    } catch (e) {
      setError("Couldn't load the library. Is the API running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Remove a deleted book from the list immediately (BookCard already DELETEd
  // the agent). Port of deleteBook's loadAgents()+renderLibraryGrid refresh,
  // done as an optimistic filter so the card disappears without a refetch.
  const handleDeleted = useCallback((agentId: string) => {
    setBooks((prev) => prev.filter((b) => b.agentId !== agentId));
  }, []);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    let list = books;
    if (q) {
      list = list.filter(
        (b) => b.title.toLowerCase().includes(q) || b.author.toLowerCase().includes(q),
      );
    }
    if (activeTopics.size > 0) {
      list = list.filter((b) => activeTopics.has(b.category));
    }
    if (filter === "recent") {
      list = [...list].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    }
    return list;
  }, [books, query, activeTopics, filter]);

  function toggleTopic(t: string) {
    setActiveTopics((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  }

  async function discover() {
    const q = query.trim();
    if (!q) return;
    setDiscovering(true);
    try {
      // Backend SearchBookRequest requires `query` (min_length 2), not `title`
      // — sending `title` 422'd, so find-&-add never worked.
      await post("/api/search-book", { query: q });
      await load();
    } catch {
      setError(`Couldn't add "${q}". Try again.`);
    } finally {
      setDiscovering(false);
    }
  }

  const noMatch = query.trim().length > 0 && !loading && filtered.length === 0;

  return (
    <div className="library-content">
      <h1 className="page-title">Library</h1>

      <div className="library-toolbar">
        <input
          type="text"
          id="library-search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search by title or author — not here yet? We'll find and add it in real time"
          autoComplete="off"
        />
        <a className="create-book-btn" href="/write" title="Write the book you need, on-demand">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span>Write the Book You Need</span>
        </a>
        <div className="filter-tags">
          <button
            className={`filter-tag${filter === "all" ? " active" : ""}`}
            onClick={() => setFilter("all")}
          >
            All
          </button>
          <button
            className={`filter-tag${filter === "recent" ? " active" : ""}`}
            onClick={() => setFilter("recent")}
          >
            Recent
          </button>
        </div>
      </div>

      {topics.length > 0 && (
        <div className="topic-tags-grid">
          {topics.map((t) => (
            <button
              key={t}
              className={`filter-tag${activeTopics.has(t) ? " active" : ""}`}
              onClick={() => toggleTopic(t)}
            >
              {t}
            </button>
          ))}
        </div>
      )}

      {error && <p className="library-error">{error}</p>}

      {noMatch && (
        <div className="library-discover-bar">
          <span>Can&apos;t find &ldquo;{query.trim()}&rdquo;?</span>
          <button className="card-chat-btn" onClick={discover} disabled={discovering}>
            {discovering ? "Adding…" : `Find & add "${query.trim()}"`}
          </button>
        </div>
      )}

      {loading ? (
        <div className="library-loading">Loading…</div>
      ) : (
        <div id="library-grid" className="book-grid">
          {filtered.map((b) => (
            <BookCard key={b.id} book={b} onDeleted={handleDeleted} />
          ))}
        </div>
      )}
    </div>
  );
}
