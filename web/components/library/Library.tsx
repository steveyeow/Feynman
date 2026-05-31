"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { get, post, listVotes } from "@/lib/api";
import { AgentRow, Book, mapAgentsToBooks, mergeVotes } from "@/lib/books";
import { startWriteBook } from "@/lib/writeBook";
import { useAuth } from "@/lib/auth";
import { useProGate } from "@/components/pro/ProOverlay";
import BookCard from "./BookCard";

/**
 * Library — faithful port of the legacy library surface:
 *   • Topic tags (.topic-tag): toggle active, "Clear all", loading state.
 *   • Discover-more bar: when a topic is active (and not searching), offers
 *     "+ Discover 1–3 more" → POST /api/discover {topic,count} to grow the
 *     catalog (port of renderDiscoverBar + discoverMore).
 *   • Real-time "find & add": a search with no local match → POST
 *     /api/search-book {query}.
 *   • All/Recent filter tabs; vote counts merged onto cards.
 */
export default function Library() {
  const router = useRouter();
  const { authEnabled, user } = useAuth();
  const { requirePro } = useProGate();
  const [books, setBooks] = useState<Book[]>([]);
  const [topics, setTopics] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [activeTopics, setActiveTopics] = useState<Set<string>>(new Set());
  const [loadingTopics, setLoadingTopics] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState<"recent" | "all">("recent");
  const [loading, setLoading] = useState(true);
  const [discovering, setDiscovering] = useState(false);
  const [adding, setAdding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const [agents, tops, votes] = await Promise.all([
        get<AgentRow[]>("/api/agents"),
        get<{ topics?: string[] } | string[]>("/api/topics").catch(() => ({ topics: [] })),
        listVotes().catch(() => []),
      ]);
      setBooks(mergeVotes(mapAgentsToBooks(agents), votes));
      setTopics(Array.isArray(tops) ? tops : tops.topics || []);
    } catch {
      setError("Couldn't load the library. Is the API running?");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function showToast(msg: string) {
    setToast(msg);
    window.setTimeout(() => setToast(null), 2600);
  }

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
    if (loadingTopics.has(t)) return;
    setActiveTopics((prev) => {
      const next = new Set(prev);
      next.has(t) ? next.delete(t) : next.add(t);
      return next;
    });
  }

  // Topic-driven discovery: grow the catalog for the active topics (port of
  // discoverMore → POST /api/discover {topic,count}).
  async function discoverMore() {
    const topicList = [...activeTopics];
    if (!topicList.length || discovering) return;
    setDiscovering(true);
    setLoadingTopics(new Set(topicList));
    try {
      let added = 0;
      for (const topic of topicList) {
        const count = Math.floor(Math.random() * 3) + 1;
        const data = await post<{ books?: { new?: boolean }[] }>("/api/discover", {
          topic,
          count,
        });
        added += (data.books || []).filter((b) => b.new).length;
      }
      await load();
      showToast(
        added > 0
          ? `Added ${added} new book${added > 1 ? "s" : ""}`
          : "These books are already in your library — try a different topic",
      );
    } catch {
      showToast("Discovery failed. Try again.");
    } finally {
      setLoadingTopics(new Set());
      setDiscovering(false);
    }
  }

  // Real-time "find & add" when a search has no local match.
  async function findAndAdd() {
    const q = query.trim();
    if (q.length < 2 || adding) return;
    setAdding(true);
    try {
      await post("/api/search-book", { query: q });
      await load();
    } catch {
      setError(`Couldn't add "${q}". Try again.`);
    } finally {
      setAdding(false);
    }
  }

  const searching = query.trim().length > 0;
  const noMatch = searching && !loading && filtered.length === 0;
  const showDiscoverBar = activeTopics.size > 0 && !searching;

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
        <button
          type="button"
          className="create-book-btn"
          title="Write the book you need, on-demand"
          onClick={() => startWriteBook(router, { authEnabled, user, requirePro })}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M12 20h9" />
            <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
          </svg>
          <span>Write the Book You Need</span>
        </button>
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

      {/* Topic tags (.topic-tag) — toggle active + Clear all, like production. */}
      {topics.length > 0 && (
        <div className="topic-tags-grid">
          {activeTopics.size > 0 && (
            <button
              className="topic-tag topic-tag-clear"
              onClick={() => setActiveTopics(new Set())}
            >
              Clear all ×
            </button>
          )}
          {topics.map((t) => {
            const isLoading = loadingTopics.has(t);
            const isActive = activeTopics.has(t);
            return (
              <button
                key={t}
                className={`topic-tag${isLoading ? " loading" : isActive ? " active" : ""}`}
                onClick={() => toggleTopic(t)}
              >
                {isLoading ? "… " : ""}
                {t}
              </button>
            );
          })}
        </div>
      )}

      {/* Discover-more bar: grow the catalog for the active topic(s). */}
      {showDiscoverBar && (
        <div className="library-discover-bar">
          <span className="discover-bar-text">
            Want more books on <strong>{[...activeTopics].join(", ")}</strong>?
          </span>
          <button className="discover-bar-btn" onClick={discoverMore} disabled={discovering}>
            {discovering ? "Discovering…" : "+ Discover 1–3 more"}
          </button>
        </div>
      )}

      {error && <p className="library-error">{error}</p>}

      {/* Real-time find & add when a search has no local match. */}
      {noMatch && (
        <div className="library-discover-bar">
          <span className="discover-bar-text">
            Can&apos;t find &ldquo;{query.trim()}&rdquo; in your library?
          </span>
          <button className="discover-bar-btn" onClick={findAndAdd} disabled={adding}>
            {adding ? "Adding…" : `Find & add it`}
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

      {toast && <div className="library-toast">{toast}</div>}
    </div>
  );
}
