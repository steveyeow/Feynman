"use client";

/**
 * Right sidebar shown after an answer cites books. Faithful port of
 * renderChatSidebar in app.js: it surfaces ONLY a "RELATED BOOKS" list of
 * same-category books (excluding the cited sources AND the currently-selected
 * books), and hides itself entirely when there are no related books
 * (hideChatRightSidebar). Production never renders a visible "Sources" list in
 * the real chat, so we don't either.
 *
 * Reuses .chat-sidebar-right (.visible) + .sidebar-book-item classes so the
 * glass treatment + layout match the legacy.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { get } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow, type Book } from "@/lib/books";
import type { Source } from "@/lib/chat";

export default function RelatedBooks({
  sources,
  excludeAgentIds = [],
}: {
  sources: Source[];
  /** Currently chip-selected books — excluded from "related" (app.js 3246). */
  excludeAgentIds?: string[];
}) {
  const [allBooks, setAllBooks] = useState<Book[]>([]);

  // Load the catalog once so we can resolve categories for "related" picks.
  useEffect(() => {
    let alive = true;
    get<AgentRow[]>("/api/agents")
      .then((rows) => {
        if (alive) setAllBooks(mapAgentsToBooks(rows || []));
      })
      .catch(() => {
        /* keep allBooks empty; the sidebar just stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!sources.length) return null;

  // Exclude both the cited source books and the currently-selected books.
  const excluded = new Set<string>([
    ...sources.map((s) => s.id),
    ...excludeAgentIds,
  ]);
  // Categories represented by the cited books.
  const cats = new Set<string>();
  for (const s of sources) {
    const b = allBooks.find((x) => x.id === s.id || x.agentId === s.id);
    if (b?.category) cats.add(b.category.toLowerCase());
  }
  const related = cats.size
    ? allBooks
        .filter(
          (b) =>
            !excluded.has(b.id) &&
            !excluded.has(b.agentId) &&
            cats.has((b.category || "").toLowerCase()),
        )
        .slice(0, 4)
    : [];

  // No same-category books → hide the sidebar entirely (matches production's
  // hideChatRightSidebar; the chat column then goes full-width).
  if (!related.length) return null;

  return (
    <aside className="chat-sidebar-right visible">
      <h3 className="sidebar-title">RELATED BOOKS</h3>
      <div className="sidebar-list" id="sidebar-related">
        {related.map((b) => (
          <Link
            key={b.id}
            href={`/book/${encodeURIComponent(b.agentId)}`}
            className="sidebar-book-item"
          >
            <div className="sidebar-book-info">
              <div className="sidebar-book-title">{b.title}</div>
              {b.author && <div className="sidebar-book-author">{b.author}</div>}
            </div>
          </Link>
        ))}
      </div>
    </aside>
  );
}
