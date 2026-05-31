"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Book, coverStyle, statusBadge } from "@/lib/books";

/**
 * Library book card. Faithful to the legacy card, with the #6 entry-point fix:
 *   • Cover  → Read (full text) / Preview (ready) when the book HAS content;
 *              for a catalog stub (no content) the cover falls back to Details.
 *   • Title/author (body) → the Details (SEO) page — the dedicated "more info"
 *              entry, distinct from the cover's read/preview action.
 *   • Chat (footer) → the reader, which carries the chat.
 * Real paths, no hash.
 */
export default function BookCard({ book }: { book: Book }) {
  const router = useRouter();
  const badge = statusBadge(book);
  const canRead = book.hasFullText;
  const canPreview = !book.hasFullText && book.status === "ready";
  const overlay = canRead ? "Read" : canPreview ? "Preview" : "";
  const detailHref = `/book/${encodeURIComponent(book.agentId)}`;
  const readHref = `/read/${encodeURIComponent(book.agentId)}`;
  // Cover goes to the reader when there's something to read/preview; otherwise
  // (catalog stub) there's nothing to read, so it opens the details page.
  const coverHref = overlay ? readHref : detailHref;

  return (
    <div className="book-card">
      <div
        className="card-cover-wrap"
        role="link"
        tabIndex={0}
        aria-label={overlay ? `${overlay} ${book.title}` : book.title}
        onClick={() => router.push(coverHref)}
        onKeyDown={(e) => {
          if (e.key === "Enter") router.push(coverHref);
        }}
      >
        <div className="card-cover-placeholder" style={{ background: coverStyle(book) }}>
          {!book.isAIGenerated && <span>{book.title.slice(0, 1).toUpperCase()}</span>}
        </div>
        {overlay && (
          <div className="card-cover-overlay">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
            <span>{overlay}</span>
          </div>
        )}
      </div>
      <Link href={detailHref} className="card-body" title={`About ${book.title}`}>
        <h3 className="card-title">{book.title}</h3>
        <p className="card-author">
          {book.isAIGenerated
            ? book.creatorName
              ? `by ${book.creatorName} · AI`
              : "AI-generated"
            : book.author}
        </p>
      </Link>
      <div className="card-footer">
        <Link className="card-chat-btn" href={readHref}>
          Chat
        </Link>
        {badge && <span className={`card-badge ${badge.cls}`}>{badge.text}</span>}
      </div>
    </div>
  );
}
