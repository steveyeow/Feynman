"use client";

import { useEffect, useMemo, useState } from "react";
import { get, post } from "@/lib/api";
import { AgentRow, Book, mapAgentsToBooks } from "@/lib/books";
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

  async function load() {
    setLoading(true);
    setError(null);
    try {
      const [agents, tops] = await Promise.all([
        get<AgentRow[]>("/api/agents"),
        get<string[]>("/api/topics").catch(() => [] as string[]),
      ]);
      setBooks(mapAgentsToBooks(agents));
      setTopics(tops);
    } catch (e) {
      setError("Couldn't load the library. Is the API running?");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    load();
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
    const title = query.trim();
    if (!title) return;
    setDiscovering(true);
    try {
      await post("/api/search-book", { title });
      await load();
    } catch {
      setError(`Couldn't add "${title}". Try again.`);
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
        <a className="create-book-btn" href="/?write=1" title="Write the book you need, on-demand">
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
            <BookCard key={b.id} book={b} />
          ))}
        </div>
      )}
    </div>
  );
}
