"use client";

/**
 * Right sidebar shown after an answer cites books. Driven by the assistant
 * response's `sources`. Port of renderChatSidebar in app.js, simplified: we
 * surface the books that produced the answer (linking to /book/{id}) plus, when
 * the agents list is available, a few same-category "related" books.
 *
 * Reuses .chat-sidebar-right (.visible) + .sidebar-book-item classes so the
 * glass treatment + layout match the legacy.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { get } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow, type Book } from "@/lib/books";
import type { Source } from "@/lib/chat";
import styles from "./RelatedBooks.module.css";

export default function RelatedBooks({ sources }: { sources: Source[] }) {
  const [allBooks, setAllBooks] = useState<Book[]>([]);

  // Load the catalog once so we can resolve categories for "related" picks.
  // Failure is non-fatal — we still render the source books below.
  useEffect(() => {
    let alive = true;
    get<AgentRow[]>("/api/agents")
      .then((rows) => {
        if (alive) setAllBooks(mapAgentsToBooks(rows || []));
      })
      .catch(() => {
        /* keep allBooks empty; sources still render */
      });
    return () => {
      alive = false;
    };
  }, []);

  if (!sources.length) return null;

  const sourceIds = new Set(sources.map((s) => s.id));
  // Categories represented by the cited books.
  const cats = new Set<string>();
  for (const s of sources) {
    const b = allBooks.find((x) => x.id === s.id || x.agentId === s.id);
    if (b?.category) cats.add(b.category.toLowerCase());
  }
  const related = cats.size
    ? allBooks
        .filter(
          (b) => !sourceIds.has(b.id) && cats.has((b.category || "").toLowerCase()),
        )
        .slice(0, 4)
    : [];

  return (
    <aside className="chat-sidebar-right visible">
      <div className="sidebar-title">Sources</div>
      <div className="sidebar-list" id="sidebar-related">
        {sources.map((s) => (
          <Link
            key={s.id}
            href={`/book/${encodeURIComponent(s.id)}`}
            className="sidebar-book-item"
          >
            <div className="sidebar-book-info">
              <div className="sidebar-book-title">{s.name}</div>
            </div>
          </Link>
        ))}
      </div>

      {related.length > 0 && (
        <>
          <div className={`sidebar-title ${styles.relatedHeading}`}>Related</div>
          <div className="sidebar-list">
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
        </>
      )}
    </aside>
  );
}
