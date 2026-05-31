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
import { useState } from "react";
import type { Outline, OutlineChapter, BookStatus, AiBookStatus } from "@/lib/aibooks";

export type CanvasPhase = "outlining" | "writing";

interface BookCanvasProps {
  phase: CanvasPhase;
  outline: Outline | null;
  status: BookStatus | null;
  agentId: string | null;
  confirming: boolean;
  error: string | null;
  onConfirm: () => void;
  onCancel: () => void;
  onRetry: () => void;
}

export default function BookCanvas({
  phase,
  outline,
  status,
  agentId,
  confirming,
  error,
  onConfirm,
  onCancel,
  onRetry,
}: BookCanvasProps) {
  return (
    <aside className="book-canvas visible" id="book-canvas">
      <div className="book-canvas-inner" id="book-canvas-content">
        {phase === "outlining" && outline && (
          <OutlineView outline={outline} confirming={confirming} onConfirm={onConfirm} />
        )}
        {phase === "writing" && (
          <WritingProgress
            status={status}
            fallbackChapters={outline?.chapters || []}
            agentId={agentId}
            onCancel={onCancel}
            onRetry={onRetry}
          />
        )}
        {error && <p className="canvas-error">{error}</p>}
      </div>
    </aside>
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
  onCancel,
  onRetry,
}: {
  status: BookStatus | null;
  fallbackChapters: OutlineChapter[];
  agentId: string | null;
  onCancel: () => void;
  onRetry: () => void;
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
          let stateClass = "pending";
          let icon = "—";
          let detail = "Waiting...";
          if (c.number <= done) {
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
          return (
            <div key={c.number} className={`progress-ch ${stateClass}`}>
              <div className={`progress-ch-icon ${stateClass}`}>{icon}</div>
              <div className="progress-ch-info">
                <div className="progress-ch-title">
                  Ch.{c.number}: {c.title}
                </div>
                <div className="progress-ch-detail">{detail}</div>
              </div>
            </div>
          );
        })}
      </div>

      {state === "completed" && readId && (
        <>
          <div className="canvas-divider" />
          <div className="canvas-done-label">Your book is ready!</div>
          <div className="canvas-done-actions">
            <Link className="canvas-action-btn" href={`/read/${encodeURIComponent(readId)}`}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
                <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
              </svg>
              Read it
            </Link>
          </div>
        </>
      )}

      {isFailed && (
        <>
          <div className="canvas-divider" />
          <div className="canvas-done-label" style={{ color: "var(--text-secondary)" }}>
            Writing stopped before finishing.
            {readId && done > 0 ? " You can read the chapters that completed." : ""}
          </div>
          <div className="canvas-done-actions">
            <button type="button" className="canvas-action-btn" onClick={onRetry}>
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="23 4 23 10 17 10" />
                <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10" />
              </svg>
              Retry
            </button>
            {readId && done > 0 && (
              <Link className="canvas-action-btn" href={`/read/${encodeURIComponent(readId)}`}>
                Read what&apos;s done
              </Link>
            )}
          </div>
        </>
      )}

      {isCancelled && (
        <>
          <div className="canvas-divider" />
          <div className="canvas-done-label" style={{ color: "var(--text-secondary)" }}>
            Writing stopped — {done} of {total} chapters written.
          </div>
          {readId && done > 0 && (
            <div className="canvas-done-actions">
              <Link className="canvas-action-btn" href={`/read/${encodeURIComponent(readId)}`}>
                Read the partial book
              </Link>
            </div>
          )}
        </>
      )}
    </>
  );
}
