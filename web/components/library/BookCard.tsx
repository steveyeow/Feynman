"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { Book, coverStyle, statusBadge } from "@/lib/books";

/**
 * Glass book card. Inherits the Liquid Glass treatment from liquid.css
 * (.book-card). Cover/body → canonical /book/[id] (exploration). Read/Preview
 * overlay + Chat → /read/[id] (the reader carries chat). Real paths, no hash.
 */
export default function BookCard({ book }: { book: Book }) {
  const router = useRouter();
  const badge = statusBadge(book);
  const canRead = book.hasFullText;
  const canPreview = !book.hasFullText && book.status === "ready";
  const overlay = canRead ? "Read" : canPreview ? "Preview" : "";
  const detailHref = `/book/${encodeURIComponent(book.agentId)}`;
  const readHref = `/read/${encodeURIComponent(book.agentId)}`;

  return (
    <div className="book-card">
      <div
        className="card-cover-wrap"
        role="link"
        tabIndex={0}
        aria-label={book.title}
        onClick={() => router.push(detailHref)}
        onKeyDown={(e) => {
          if (e.key === "Enter") router.push(detailHref);
        }}
      >
        <div className="card-cover-placeholder" style={{ background: coverStyle(book) }}>
          {!book.isAIGenerated && <span>{book.title.slice(0, 1).toUpperCase()}</span>}
        </div>
        {overlay && (
          <button
            type="button"
            className="card-cover-overlay"
            onClick={(e) => {
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
      <Link href={detailHref} className="card-body">
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
