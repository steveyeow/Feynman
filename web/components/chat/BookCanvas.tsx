"use client";

/**
 * The write-book glass canvas, rendered alongside the chat transcript in a
 * write_book session. Faithful React port of app.js `_renderCanvasOutline`
 * (~3867) and `_renderCanvasWritingProgress` (~3972), using the SAME global
 * classes from styles/app.css (.canvas-book-*, .canvas-chapter, .canvas-*-btn,
 * .writing-progress-*, .progress-ch) so it matches production 1:1 and the
 * `.chat-with-sidebar:has(.book-canvas.visible) .chat-main` layout shrink fires.
 *
 * Two modes, driven by phase:
 *   - "outlining": title + stats + Start Writing, then a click-to-expand
 *     chapter accordion.
 *   - "writing":   progress header + bar + per-chapter status + done/failed/
 *     cancelled footer (Read / Retry).
 *
 * This component is presentational: all flow state + actions come from
 * useWriteBook via ChatView.
 */

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { bookShareSlug } from "@/lib/catalog";
import type { Outline, OutlineChapter, BookStatus, AiBookStatus } from "@/lib/aibooks";

export type CanvasPhase = "outlining" | "writing";

/** Per-chapter content map (chapter-number → {content, word_count}), available
 *  on resume of a finished/partial book (the live /status poll has no content). */
export type CanvasContent = Record<string, { content?: string; word_count?: number }>;

interface BookCanvasProps {
  phase: CanvasPhase;
  outline: Outline | null;
  status: BookStatus | null;
  agentId: string | null;
  confirming: boolean;
  error: string | null;
  content?: CanvasContent | null;
  width?: number | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
  onRewrite: (language: string) => void;
}

export default function BookCanvas({
  phase,
  outline,
  status,
  agentId,
  confirming,
  error,
  content,
  width,
  onConfirm,
  onCancel,
  onRetry,
  onRewrite,
}: BookCanvasProps) {
  return (
    <aside
      className="book-canvas visible"
      id="book-canvas"
      style={width != null ? { width } : undefined}
    >
      <div className="book-canvas-inner" id="book-canvas-content">
        {phase === "outlining" && outline && (
          <OutlineView outline={outline} confirming={confirming} onConfirm={onConfirm} />
        )}
        {phase === "writing" && (
          <WritingProgress
            status={status}
            fallbackChapters={outline?.chapters || []}
            agentId={agentId}
            content={content}
            onCancel={onCancel}
            onRetry={onRetry}
            onRewrite={onRewrite}
          />
        )}
        {error && <p className="canvas-error">{error}</p>}
      </div>
    </aside>
  );
}

// ── Post-write actions: Chat + Read + Share (port of the completed/cancelled
//    canvas footer) ──────────────────────────────────────────────────────────
function ReadIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  );
}
function ChatIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}

/** Share popup (Twitter / Copy URL / Email) building ${origin}/book/{id}. */
function CanvasShare({ title, readId }: { title: string; readId: string }) {
  const [open, setOpen] = useState(false);
  // Share the canonical SLUG, not the uuid: /book/{uuid} 301-redirects to the
  // slug and X's card crawler won't follow it, so the OG card doesn't render in
  // the tweet. Resolve once on mount (cached); falls back to readId.
  const [slug, setSlug] = useState(readId);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bookShareSlug(readId).then(setSlug).catch(() => {});
  }, [readId]);
  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/book/${encodeURIComponent(slug)}`
      : `https://feynman.wiki/book/${encodeURIComponent(slug)}`;

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);

  const shareOnX = () => {
    const text = encodeURIComponent(`${title || "A book"} — written on Feynman`);
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${encodeURIComponent(shareUrl)}`,
      "_blank",
      "noopener,noreferrer",
    );
    setOpen(false);
  };
  const copyUrl = () => {
    navigator.clipboard?.writeText(shareUrl).catch(() => {});
    setOpen(false);
  };
  const sendMail = () => {
    window.location.href = `mailto:?subject=${encodeURIComponent(title || "A book")}&body=${encodeURIComponent(shareUrl)}`;
    setOpen(false);
  };

  return (
    <div className={`canvas-share-wrap${open ? " open" : ""}`} ref={wrapRef}>
      <button
        type="button"
        className="canvas-action-btn canvas-share-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        Share
      </button>
      <div className="canvas-share-popup">
        <button type="button" className="canvas-share-opt canvas-share-x" onClick={shareOnX}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
          </svg>
          Share on Twitter
        </button>
        <button type="button" className="canvas-share-opt canvas-share-copy" onClick={copyUrl}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
            <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
          </svg>
          Copy URL
        </button>
        <button type="button" className="canvas-share-opt canvas-share-mail" onClick={sendMail}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" />
            <polyline points="22,6 12,13 2,6" />
          </svg>
          Send via Email
        </button>
      </div>
    </div>
  );
}

/** Chat + Read + Share row shown on the completed / cancelled canvas. The Chat
 *  link uses the universal ?book={id} contract HomeComposer consumes (a fresh
 *  chat preselected to the just-written book — port of chatWithBookByAgent). */
function CanvasActions({ readId, title }: { readId: string; title: string }) {
  return (
    <div className="canvas-done-actions">
      <Link className="canvas-action-btn" href={`/?book=${encodeURIComponent(readId)}`}>
        <ChatIcon />
        Chat
      </Link>
      <Link className="canvas-action-btn" href={`/read/${encodeURIComponent(readId)}`}>
        <ReadIcon />
        Read
      </Link>
      <CanvasShare title={title} readId={readId} />
    </div>
  );
}

// ── Rewrite menu: regenerate the whole book in another language ──────────────
const REWRITE_LANGS: { code: string; label: string }[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "中文" },
  { code: "es", label: "Español" },
  { code: "fr", label: "Français" },
  { code: "ja", label: "日本語" },
  { code: "ko", label: "한국어" },
  { code: "de", label: "Deutsch" },
];

/** "Rewrite" control on a finished book — the ONLY way to change the chapter
 *  bodies / language (chat refine edits the outline, never the written text).
 *  Picks a language → confirm → regenerate every chapter. */
function RewriteMenu({
  chapterCount,
  onRewrite,
}: {
  chapterCount: number;
  onRewrite: (language: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("click", onDoc);
    return () => document.removeEventListener("click", onDoc);
  }, [open]);
  const pick = (code: string, label: string) => {
    setOpen(false);
    const n = chapterCount || 0;
    if (
      window.confirm(
        `Rewrite ${n ? `all ${n} chapters` : "the book"} in ${label}? This replaces the current text and takes a few minutes.`,
      )
    ) {
      onRewrite(code);
    }
  };
  return (
    <div className={`canvas-share-wrap${open ? " open" : ""}`} ref={wrapRef} style={{ marginTop: 8 }}>
      <button
        type="button"
        className="canvas-action-btn canvas-share-trigger"
        onClick={(e) => {
          e.stopPropagation();
          setOpen((o) => !o);
        }}
        title="Regenerate the chapters, optionally in another language"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="23 4 23 10 17 10" />
          <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
        </svg>
        Rewrite
      </button>
      <div className="canvas-share-popup">
        {REWRITE_LANGS.map((l) => (
          <button
            key={l.code}
            type="button"
            className="canvas-share-opt"
            onClick={() => pick(l.code, l.label)}
          >
            Rewrite in {l.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Outline accordion (port of _renderCanvasOutline) ─────────────────────────
function OutlineView({
  outline,
  confirming,
  onConfirm,
}: {
  outline: Outline;
  confirming: boolean;
  onConfirm: () => void;
}) {
  const chapters: OutlineChapter[] = outline.chapters || [];
  const totalWords = chapters.reduce((s, c) => s + (c.estimated_words || 0), 0);
  // First chapter expanded by default (production: `i === 0 ? ' expanded'`).
  const [expanded, setExpanded] = useState<Set<number>>(
    () => new Set(chapters[0] ? [chapters[0].number] : []),
  );
  const toggle = (n: number) =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(n)) next.delete(n);
      else next.add(n);
      return next;
    });

  return (
    <>
      <div className="canvas-book-header">
        <div className="canvas-book-title">{outline.title || "Untitled"}</div>
        {outline.subtitle && <div className="canvas-book-subtitle">{outline.subtitle}</div>}
        <div className="canvas-book-meta">
          <span className="canvas-book-stats">
            {chapters.length} chapters · ~{Math.round(totalWords / 1000)}k words
          </span>
          <button
            type="button"
            className="canvas-confirm-btn"
            onClick={onConfirm}
            disabled={confirming || chapters.length === 0}
          >
            {confirming ? (
              <span className="btn-spinner" />
            ) : (
              <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 20h9" />
                <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
              </svg>
            )}
            {confirming ? "Starting..." : "Start Writing"}
          </button>
        </div>
      </div>

      <div className="canvas-divider" />

      <div className="canvas-chapters">
        {chapters.map((c) => {
          const isOpen = expanded.has(c.number);
          return (
            <div
              key={c.number}
              className={`canvas-chapter${isOpen ? " expanded" : ""}`}
              onClick={() => toggle(c.number)}
            >
              <div className="canvas-ch-header">
                <span className="canvas-ch-num">{c.number}</span>
                <span className="canvas-ch-title">{c.title}</span>
                <svg className="canvas-ch-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <polyline points="6 9 12 15 18 9" />
                </svg>
              </div>
              <div className="canvas-ch-detail">
                {c.summary && <p className="canvas-ch-summary">{c.summary}</p>}
                {c.key_points && c.key_points.length > 0 && (
                  <ul className="canvas-ch-points">
                    {c.key_points.map((p, i) => (
                      <li key={i}>{p}</li>
                    ))}
                  </ul>
                )}
                <span className="canvas-ch-words">
                  ~{(c.estimated_words || 0).toLocaleString()} words
                </span>
              </div>
            </div>
          );
        })}
      </div>
    </>
  );
}

// ── Writing progress (port of _renderCanvasWritingProgress) ──────────────────
function WritingProgress({
  status,
  fallbackChapters,
  agentId,
  content,
  onCancel,
  onRetry,
  onRewrite,
}: {
  status: BookStatus | null;
  fallbackChapters: OutlineChapter[];
  agentId: string | null;
  content?: CanvasContent | null;
  onCancel: () => void;
  onRetry: () => void;
  onRewrite: (language: string) => void;
}) {
  const chapters = status?.outline?.chapters?.length
    ? status.outline.chapters
    : fallbackChapters;
  const total = status?.chaptersTotal || chapters.length;
  const done = status?.chaptersDone || 0;
  const pct = status?.progressPct ?? (total > 0 ? Math.round((done / total) * 100) : 0);
  const state: AiBookStatus = status?.status ?? "writing";
  const readId = status?.agentId || agentId;
  const isCancelled = state === "cancelled";
  const isFailed = state === "failed";

  let statusLabel = "Writing...";
  if (state === "completed") statusLabel = "Completed";
  else if (isCancelled) statusLabel = "Cancelled";
  else if (isFailed) statusLabel = "Failed";

  const title = status?.title || status?.outline?.title || "Untitled";
  const headerStat =
    state === "completed"
      ? "All chapters complete"
      : `Chapter ${Math.min(done + 1, total)} of ${total}`;

  // Inline reading: a chapter with saved body text can be expanded to read it
  // right here in the canvas (no jump to /read). Single-open keeps the panel
  // tidy; the first written chapter auto-opens once the book is complete.
  const [openCh, setOpenCh] = useState<number | null>(null);
  const autoOpened = useRef(false);
  const firstWritten =
    chapters.find((c) => (content?.[String(c.number)]?.content || "").trim())?.number ?? null;
  useEffect(() => {
    if (!autoOpened.current && state === "completed" && firstWritten != null) {
      setOpenCh(firstWritten);
      autoOpened.current = true;
    }
  }, [state, firstWritten]);

  return (
    <>
      <div className="canvas-book-header">
        <div className="canvas-book-title">{title}</div>
        <div className="canvas-book-subtitle">{statusLabel}</div>
        <div className="canvas-book-meta">
          <span className="canvas-book-stats">
            {headerStat} · {pct}%
          </span>
          {state === "writing" && (
            <button type="button" className="canvas-cancel-btn" onClick={onCancel}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <rect x="6" y="6" width="12" height="12" rx="2" />
              </svg>
              Stop Writing
            </button>
          )}
        </div>
        <div className="canvas-progress-bar" style={{ marginTop: 12 }}>
          <div className="writing-progress-bar">
            <div
              className={`writing-progress-fill${isCancelled || isFailed ? " cancelled" : ""}`}
              style={{ width: `${pct}%` }}
            />
          </div>
        </div>
      </div>

      <div className="canvas-divider" />

      <div className="writing-progress-chapters">
        {chapters.map((c) => {
          // Once content is loaded (on completion / resume) the full book carries
          // per-chapter body + word_count; the live /status poll does not — so a
          // chapter only becomes readable here once its body is present.
          const chData = content?.[String(c.number)];
          const body = (chData?.content || "").trim();
          const hasBody = !!body;
          let stateClass = "pending";
          let icon = "—";
          let detail = "Waiting...";
          let words = "";
          if (chData?.content) {
            stateClass = "done";
            icon = "✓";
            detail = "Completed";
            words = `${(chData.word_count || 0).toLocaleString()} words`;
          } else if (c.number <= done) {
            stateClass = "done";
            icon = "✓";
            detail = "Completed";
          } else if (isCancelled || isFailed) {
            detail = isFailed ? "Not written" : "Cancelled";
          } else if (c.number === done + 1) {
            stateClass = "active";
            icon = "✎";
            detail = "Writing...";
          }
          const isOpen = hasBody && openCh === c.number;
          return (
            <div key={c.number}>
              <div
                className={`progress-ch ${stateClass}`}
                onClick={hasBody ? () => setOpenCh(isOpen ? null : c.number) : undefined}
                style={hasBody ? { cursor: "pointer" } : undefined}
                role={hasBody ? "button" : undefined}
                aria-expanded={hasBody ? isOpen : undefined}
                title={hasBody ? (isOpen ? "Hide chapter" : "Read chapter") : undefined}
              >
                <div className={`progress-ch-icon ${stateClass}`}>{icon}</div>
                <div className="progress-ch-info">
                  <div className="progress-ch-title">
                    Ch.{c.number}: {c.title}
                  </div>
                  <div className="progress-ch-detail">{isOpen ? "Reading" : detail}</div>
                </div>
                {words && <div className="progress-ch-words">{words}</div>}
                {hasBody && (
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    style={{
                      flexShrink: 0,
                      marginLeft: 8,
                      opacity: 0.45,
                      transform: isOpen ? "rotate(180deg)" : undefined,
                      transition: "transform .15s ease",
                    }}
                  >
                    <polyline points="6 9 12 15 18 9" />
                  </svg>
                )}
              </div>
              {isOpen && (
                <div
                  className="canvas-ch-body"
                  style={{
                    padding: "4px 10px 18px 40px",
                    fontSize: 14,
                    lineHeight: 1.75,
                    color: "var(--text-primary, #1d1d1f)",
                  }}
                >
                  {body.split(/\n{2,}/).map((para, i) => (
                    <p key={i} style={{ margin: "0 0 12px", whiteSpace: "pre-wrap" }}>
                      {para.trim()}
                    </p>
                  ))}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {state === "completed" && readId && (
        <>
          <div className="canvas-divider" />
          <div className="canvas-done-label">Your book is ready!</div>
          {/* Chat + Read + Share — the full production completed footer. */}
          <CanvasActions readId={readId} title={title} />
          {/* The only way to change the written chapters / their language: a full
              regenerate (chat refine edits the outline, not the bodies). */}
          <RewriteMenu chapterCount={total} onRewrite={onRewrite} />
        </>
      )}

      {isFailed && (
        <>
          <div className="canvas-divider" />
          {/* Red, specific failure point + Retry only — matches production
              (no read/chat/share on failure). */}
          <div className="canvas-done-label" style={{ color: "var(--error-color, #e55)" }}>
            {done >= total
              ? "Writing failed while finalizing the book"
              : `Writing failed at chapter ${done + 1} of ${total}`}
          </div>
          {status?.error && <p className="canvas-error">{status.error}</p>}
          <div className="canvas-done-actions">
            <button
              type="button"
              className="canvas-action-btn"
              style={{ background: "var(--accent, #5b8a72)", color: "#fff" }}
              onClick={onRetry}
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Retry
            </button>
          </div>
        </>
      )}

      {isCancelled && (
        <>
          <div className="canvas-divider" />
          <div className="canvas-done-label" style={{ color: "var(--text-secondary)" }}>
            Writing stopped — {done} of {total} chapters
          </div>
          {/* Chat + Read + Share, like production's cancelled (written>0) footer. */}
          {readId && done > 0 && <CanvasActions readId={readId} title={title} />}
        </>
      )}
    </>
  );
}
