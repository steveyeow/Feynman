"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  // IDs of books found+added by search — kept visible across keystrokes even
  // when the corrected title ≠ the typed query (port of _searchDiscoveredIds).
  const [discoveredIds, setDiscoveredIds] = useState<Set<string>>(new Set());
  const [autoSearching, setAutoSearching] = useState(false);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
      // title / author / category match, OR a freshly discovered book — kept
      // visible across keystrokes even if its corrected title ≠ the query
      // (port of renderLibraryGrid's predicate, app.js 3322-3324).
      list = list.filter(
        (b) =>
          b.title.toLowerCase().includes(q) ||
          b.author.toLowerCase().includes(q) ||
          (b.category || "").toLowerCase().includes(q) ||
          discoveredIds.has(b.id),
      );
    }
    if (activeTopics.size > 0) {
      // Case-insensitive, null-safe topic match (app.js 3316-3319).
      const t = new Set([...activeTopics].map((x) => x.toLowerCase()));
      list = list.filter((b) => t.has((b.category || "").toLowerCase()));
    }
    if (filter === "recent") {
      list = [...list].sort((a, b) => (b.createdAt || "").localeCompare(a.createdAt || ""));
    } else {
      // "All" → alphabetical by title (app.js 3314-3315 else branch).
      list = [...list].sort((a, b) => a.title.localeCompare(b.title));
    }
    return list;
  }, [books, query, activeTopics, filter, discoveredIds]);

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

  // Search the catalog for a title not present locally and add the best match
  // (port of autoSearchBook). Records discovered IDs so the added book stays
  // visible across keystrokes even when its corrected title ≠ the typed query.
  const runSearch = useCallback(
    async (q: string) => {
      if (q.length < 2) return;
      if (searchAbortRef.current) searchAbortRef.current.abort();
      const ac = new AbortController();
      searchAbortRef.current = ac;
      setAutoSearching(true);
      setError(null);
      try {
        const data = await post<{ books?: { id?: string }[] }>(
          "/api/search-book",
          { query: q },
          { signal: ac.signal },
        );
        const ids = (data.books || []).map((b) => b.id).filter(Boolean) as string[];
        if (ids.length) {
          setDiscoveredIds((prev) => {
            const next = new Set(prev);
            ids.forEach((id) => next.add(id));
            return next;
          });
        }
        await load();
      } catch (e) {
        if ((e as Error)?.name !== "AbortError") setError(`Couldn't find "${q}". Try again.`);
      } finally {
        if (searchAbortRef.current === ac) searchAbortRef.current = null;
        setAutoSearching(false);
      }
    },
    [load],
  );

  // Manual "Find & add it" button — fires the same search immediately.
  function findAndAdd() {
    const q = query.trim();
    if (q.length < 2 || autoSearching) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    void runSearch(q);
  }

  // Debounced auto-search (1200ms) when a query has no local match — honors the
  // placeholder's "find and add it in real time" promise (port of the
  // #library-search listener + autoSearchBook, app.js 7611-7636 / 3384-3416).
  useEffect(() => {
    const q = query.trim();
    if (!q) {
      // Clear the discovered set when the query empties (app.js 7615).
      setDiscoveredIds((prev) => (prev.size ? new Set() : prev));
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
      return;
    }
    if (q.length < 2) return;
    const ql = q.toLowerCase();
    const localMatch = books.some(
      (b) =>
        b.title.toLowerCase().includes(ql) ||
        b.author.toLowerCase().includes(ql) ||
        (b.category || "").toLowerCase().includes(ql),
    );
    if (localMatch) return;
    if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    searchTimerRef.current = setTimeout(() => void runSearch(q), 1200);
    return () => {
      if (searchTimerRef.current) clearTimeout(searchTimerRef.current);
    };
  }, [query, books, runSearch]);

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

      {/* Real-time find & add when a search has no local match. The debounced
          auto-search shows "Looking up…"; the button is the manual fallback. */}
      {noMatch && (
        <div className="library-discover-bar">
          {autoSearching ? (
            <span className="discover-bar-text">
              Looking up &ldquo;{query.trim()}&rdquo; — we&apos;ll add it if we find it…
            </span>
          ) : (
            <>
              <span className="discover-bar-text">
                Can&apos;t find &ldquo;{query.trim()}&rdquo; in your library?
              </span>
              <button className="discover-bar-btn" onClick={findAndAdd}>
                Find &amp; add it
              </button>
            </>
          )}
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
