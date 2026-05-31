"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Book, coverStyle, coverInitials, statusBadge } from "@/lib/books";
import { upvote, deleteAgent } from "@/lib/api";

/**
 * Library book card — faithful to production:
 *   • Cover color-block  → READ (full text) / PREVIEW (ready, no full text) via
 *                          /read/{id}; for a catalog stub (no content) it has no
 *                          read/preview affordance and instead opens chat.
 *   • Chat button (left) → CHAT (/?book={id}, preselects the book — production
 *                          selectBookForChat). NEVER the reader.
 *   • Details (ⓘ icon)   → the /book/{id} SEO detail page.
 *   • Upvote (▲)         → POST /api/votes {title}, optimistic.
 *   • Delete (×)         → DELETE /api/agents/{id}, uploaded/catalog/AI only.
 */
export default function BookCard({
  book,
  onDeleted,
}: {
  book: Book;
  onDeleted?: (id: string) => void;
}) {
  const router = useRouter();
  const badge = statusBadge(book);
  const canRead = book.hasFullText;
  const canPreview = !book.hasFullText && book.status === "ready";
  const overlay = canRead ? "Read" : canPreview ? "Preview" : "";
  const detailHref = `/book/${encodeURIComponent(book.agentId)}`;
  const readHref = `/read/${encodeURIComponent(book.agentId)}`;
  const chatHref = `/?book=${encodeURIComponent(book.agentId)}`;
  // The cover block reads/previews when there's content; a catalog stub has
  // nothing to read, so its cover opens chat instead (never a /read dead-end).
  const coverHref = overlay ? readHref : chatHref;

  const [upvotes, setUpvotes] = useState(book.upvotes || 0);
  const [voting, setVoting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const canDelete =
    (book.isUploaded || book.isCatalog || book.isAIGenerated) && !!book.agentId;
  const alwaysShowDelete =
    book.isAIGenerated && (book.status === "failed" || book.status === "error");

  async function handleUpvote(e: React.MouseEvent) {
    e.stopPropagation();
    if (voting) return;
    setVoting(true);
    setUpvotes((n) => n + 1);
    try {
      const res = await upvote(book.title);
      if (res && typeof res.count === "number") setUpvotes(res.count);
    } catch {
      /* keep optimistic */
    } finally {
      setVoting(false);
    }
  }

  async function handleDelete(e: React.MouseEvent) {
    e.stopPropagation();
    if (deleting) return;
    if (!confirm("Delete this book? This cannot be undone.")) return;
    setDeleting(true);
    try {
      await deleteAgent(book.agentId);
      onDeleted?.(book.agentId);
    } catch (err) {
      alert("Error deleting: " + (err instanceof Error ? err.message : "failed"));
      setDeleting(false);
    }
  }

  return (
    <div className="book-card">
      {canDelete && (
        <button
          type="button"
          className="card-delete-btn"
          title="Delete"
          aria-label={`Delete ${book.title}`}
          onClick={handleDelete}
          disabled={deleting}
          style={alwaysShowDelete ? { opacity: 1 } : undefined}
        >
          ×
        </button>
      )}
      {/* Cover color-block → Read / Preview (full text) or chat (stub). */}
      <div
        className="card-cover-wrap"
        role="link"
        tabIndex={0}
        aria-label={overlay ? `${overlay} ${book.title}` : `Chat about ${book.title}`}
        onClick={() => router.push(coverHref)}
        onKeyDown={(e) => {
          if (e.key === "Enter") router.push(coverHref);
        }}
      >
        <div className="card-cover-gen" style={{ background: coverStyle(book) }}>
          <span>{coverInitials(book.title)}</span>
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
      {/* Title/author: plain text (details is the ⓘ in the footer, not here). */}
      <div className="card-body">
        <h3 className="card-title">{book.title}</h3>
        <p className="card-author">
          {book.isAIGenerated
            ? book.creatorName
              ? `by ${book.creatorName} · AI`
              : "AI-generated"
            : book.author}
        </p>
      </div>
      <div className="card-footer">
        <Link className="card-chat-btn" href={chatHref}>
          Chat
        </Link>
        {badge && <span className={`card-badge ${badge.cls}`}>{badge.text}</span>}
        <Link
          className="card-details-btn"
          href={detailHref}
          title="Book details"
          aria-label={`Details about ${book.title}`}
          onClick={(e) => e.stopPropagation()}
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </Link>
        <button
          type="button"
          className="upvote-btn"
          title="Upvote"
          aria-label={`Upvote ${book.title}`}
          onClick={handleUpvote}
        >
          ▲{upvotes ? " " + upvotes : ""}
        </button>
      </div>
    </div>
  );
}
