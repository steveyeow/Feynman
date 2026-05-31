"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Book, coverStyle, coverInitials, statusBadge } from "@/lib/books";

/**
 * Library book card — faithful to production selectBookForChat:
 *   • Cover click  → CHAT (/?book={id}, preselects the book in the composer),
 *                    exactly like production's card click. The Read/Preview
 *                    OVERLAY button (only when the book has content) is the
 *                    sole path to the reader.
 *   • Chat button  → CHAT (/?book={id}).
 *   • Title/author → the Details (SEO) page.
 * No /read dead-ends: a catalog stub (no readable content) never routes to the
 * reader; its cover and Chat both go to the conversational composer.
 */
export default function BookCard({ book }: { book: Book }) {
  const router = useRouter();
  const badge = statusBadge(book);
  const canRead = book.hasFullText;
  const canPreview = !book.hasFullText && book.status === "ready";
  const overlay = canRead ? "Read" : canPreview ? "Preview" : "";
  const detailHref = `/book/${encodeURIComponent(book.agentId)}`;
  const readHref = `/read/${encodeURIComponent(book.agentId)}`;
  const chatHref = `/?book=${encodeURIComponent(book.agentId)}`;

  return (
    <div className="book-card">
      <div
        className="card-cover-wrap"
        role="link"
        tabIndex={0}
        aria-label={`Chat about ${book.title}`}
        onClick={() => router.push(chatHref)}
        onKeyDown={(e) => {
          if (e.key === "Enter") router.push(chatHref);
        }}
      >
        <div className="card-cover-gen" style={{ background: coverStyle(book) }}>
          <span>{coverInitials(book.title)}</span>
        </div>
        {overlay && (
          <button
            type="button"
            className="card-cover-overlay"
            aria-label={`${overlay} ${book.title}`}
            onClick={(e) => {
              // Overlay is the ONLY path to the reader (book has content).
              e.stopPropagation();
              router.push(readHref);
            }}
          >
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
              <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
            </svg>
            <span>{overlay}</span>
          </button>
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
        <Link className="card-chat-btn" href={chatHref}>
          Chat
        </Link>
        {badge && <span className={`card-badge ${badge.cls}`}>{badge.text}</span>}
      </div>
    </div>
  );
}
