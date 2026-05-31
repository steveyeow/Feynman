"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Book, coverStyle, coverInitials, statusBadge } from "@/lib/books";
import { upvote, deleteAgent } from "@/lib/api";

/**
 * Library book card — faithful to production selectBookForChat:
 *   • Cover click  → CHAT (/?book={id}, preselects the book in the composer),
 *                    exactly like production's card click. The Read/Preview
 *                    OVERLAY button (only when the book has content) is the
 *                    sole path to the reader.
 *   • Chat button  → CHAT (/?book={id}).
 *   • Title/author → the Details (SEO) page.
 *   • Upvote (▲)   → POST /api/votes {title} (port of handleUpvote), optimistic.
 *   • Delete (×)   → DELETE /api/agents/{id} for uploaded/catalog/AI books only
 *                    (mirrors the production deleteBtn condition), with confirm.
 * No /read dead-ends: a catalog stub (no readable content) never routes to the
 * reader; its cover and Chat both go to the conversational composer.
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

  // Optimistic upvote count (incremented on click; reconciled with the server
  // count when the POST resolves).
  const [upvotes, setUpvotes] = useState(book.upvotes || 0);
  const [voting, setVoting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  // Production condition: only uploaded / catalog / AI-generated books with an
  // agent id are deletable.
  const canDelete =
    (book.isUploaded || book.isCatalog || book.isAIGenerated) && !!book.agentId;
  // Failed/errored AI books always show the delete affordance (production
  // _alwaysShowDelete); others reveal it on hover via .book-card:hover css.
  const alwaysShowDelete =
    book.isAIGenerated && (book.status === "failed" || book.status === "error");

  async function handleUpvote(e: React.MouseEvent) {
    // Don't trigger the cover→chat navigation.
    e.stopPropagation();
    if (voting) return;
    setVoting(true);
    setUpvotes((n) => n + 1); // optimistic
    try {
      const res = await upvote(book.title);
      if (res && typeof res.count === "number") setUpvotes(res.count);
    } catch {
      // Keep the optimistic increment (matches production's catch path).
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
