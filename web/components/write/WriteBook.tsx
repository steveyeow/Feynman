"use client";

import { Suspense, useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  startBook,
  chatBook,
  confirmBook,
  getStatus,
  getBook,
  cancelBook,
  retryBook,
  type Outline,
  type OutlineChapter,
  type BookStatus,
  type AiBookStatus,
  ApiError,
} from "@/lib/aibooks";
import { useAuth } from "@/lib/auth";
import { useProGate } from "@/components/pro/ProOverlay";
import styles from "./WriteBook.module.css";

/**
 * Write-book — standalone client island. Port of the legacy write-book flow
 * (_handleWriteBookMessage / _confirmWriteBook / _startWritingPoll in app.js),
 * lifted out of the chat session into a dedicated /write surface per the brief:
 *
 *   1. prompt textarea → POST /start → AI message + outline in a glass canvas
 *   2. chat refinement → POST /{id}/chat (outline updates live)
 *   3. Confirm → POST /{id}/confirm → setInterval poll of /{id}/status
 *   4. on completed → link to /read/{agentId}
 *
 * Framing follows MEMORY: "a book generated on-demand for your current needs",
 * and copy avoids first-person "we".
 *
 * LLM calls can take ~20s and may 503 without API keys in dev — every fetch is
 * guarded with a visible error state, and the poll interval is always cleared
 * on unmount / terminal status.
 */

type Phase = "prompt" | "outlining" | "writing";
type ChatMsg = { role: "user" | "assistant"; content: string };

const TERMINAL: AiBookStatus[] = ["completed", "failed", "cancelled"];
const POLL_MS = 5000;

/**
 * Public entry: wraps the inner component in a Suspense boundary because it
 * reads ?book={id} via useSearchParams to resume an in-progress write (App
 * Router requirement; mirrors HomePage's pattern).
 */
export default function WriteBook() {
  return (
    <Suspense fallback={<div className={styles.promptWrap} />}>
      <WriteBookInner />
    </Suspense>
  );
}

function WriteBookInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { authEnabled, user } = useAuth();
  // AI book write is pro-gated on the hosted build (legacy app.js 3700;
  // anon → login 3696). Open-source (auth off) → always allowed.
  const { requirePro } = useProGate();

  const [phase, setPhase] = useState<Phase>("prompt");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false); // outline generate / refine in-flight
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [bookId, setBookId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [outline, setOutline] = useState<Outline | null>(null);
  const [messages, setMessages] = useState<ChatMsg[]>([]);
  const [refineInput, setRefineInput] = useState("");
  const [expanded, setExpanded] = useState<Set<number>>(new Set([1]));

  const [status, setStatus] = useState<BookStatus | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messagesEndRef = useRef<HTMLDivElement | null>(null);

  // ── Cleanup poll on unmount ───────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  useEffect(() => () => stopPolling(), [stopPolling]);

  // Auto-scroll the refinement transcript.
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, busy]);

  function describeError(e: unknown, fallback: string): string {
    if (e instanceof ApiError) {
      if (e.status === 503)
        return "The book writer is unavailable right now (no AI provider configured). Try again later.";
      if (e.status === 401 || e.status === 403)
        return "You need to be signed in to write a book.";
      const detail =
        e.body && typeof e.body === "object" && "detail" in e.body
          ? String((e.body as { detail: unknown }).detail)
          : "";
      return detail || fallback;
    }
    return fallback;
  }

  // ── Phase 1: generate outline ─────────────────────────────────────────
  async function onStart(e?: React.FormEvent) {
    e?.preventDefault();
    const description = prompt.trim();
    if (description.length < 10) {
      setError("Tell me a little more — at least a sentence about the book.");
      return;
    }
    // Pro gate (hosted build only). Anonymous → login; signed-in non-pro →
    // upgrade overlay; open-source (auth off) → fall through.
    if (authEnabled && !user) {
      router.push("/login");
      return;
    }
    if (!requirePro()) return;
    setError(null);
    setBusy(true);
    setMessages([{ role: "user", content: description }]);
    setPhase("outlining");
    try {
      const res = await startBook(description);
      setBookId(res.bookId);
      setAgentId(res.agentId);
      setOutline(res.outline);
      setExpanded(new Set([1]));
      setMessages((m) => [...m, { role: "assistant", content: res.aiMessage }]);
    } catch (err) {
      setError(describeError(err, "Couldn't generate an outline. Try again."));
      // Allow the user to edit & retry their prompt.
      setPhase("prompt");
    } finally {
      setBusy(false);
    }
  }

  // ── Phase 2: refine outline ───────────────────────────────────────────
  async function onRefine(e?: React.FormEvent) {
    e?.preventDefault();
    const message = refineInput.trim();
    if (!message || !bookId || busy) return;
    setError(null);
    setRefineInput("");
    const history = messages.slice(-6).map((m) => ({ role: m.role, content: m.content }));
    setMessages((m) => [...m, { role: "user", content: message }]);
    setBusy(true);
    try {
      const res = await chatBook(bookId, message, history);
      setOutline(res.outline);
      setMessages((m) => [...m, { role: "assistant", content: res.response }]);
    } catch (err) {
      const msg = describeError(err, "Couldn't update the outline. Try again.");
      setError(msg);
      setMessages((m) => [...m, { role: "assistant", content: msg }]);
    } finally {
      setBusy(false);
    }
  }

  // ── Phase 3: confirm + poll ───────────────────────────────────────────
  async function onConfirm() {
    if (!bookId || confirming) return;
    setError(null);
    setConfirming(true);
    try {
      await confirmBook(bookId);
      setPhase("writing");
      // Stamp ?book={id} into the URL so a reload (or "leave and come back")
      // resumes this write via the resume effect above.
      router.replace(`/write?book=${encodeURIComponent(bookId)}`);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content:
            "Writing your book now — each chapter is drafted in turn. You can leave and come back; progress is saved.",
        },
      ]);
      startPolling(bookId);
    } catch (err) {
      setError(describeError(err, "Couldn't start writing. Try again."));
    } finally {
      setConfirming(false);
    }
  }

  // ── Stop an in-progress write (port of _cancelWriteBook) ──
  async function onCancel() {
    if (!bookId) return;
    if (!confirm("Stop writing? Chapters already completed will be kept.")) return;
    try {
      await cancelBook(bookId);
      stopPolling();
      // Reflect the cancelled state locally (poll is stopped, so refresh once).
      try {
        setStatus(await getStatus(bookId));
      } catch {
        setStatus((s) => (s ? { ...s, status: "cancelled" } : s));
      }
    } catch (err) {
      setError(describeError(err, "Couldn't stop writing. Try again."));
    }
  }

  // ── Retry a failed write (port of _retryWriteBook) ──
  async function onRetry() {
    if (!bookId) return;
    setError(null);
    try {
      await retryBook(bookId);
      setMessages((m) => [
        ...m,
        {
          role: "assistant",
          content: "Resuming — picking up from the chapter that failed.",
        },
      ]);
      startPolling(bookId);
    } catch (err) {
      setError(describeError(err, "Retry failed. Try again."));
    }
  }

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      const tick = async () => {
        try {
          const s = await getStatus(id);
          setStatus(s);
          if (TERMINAL.includes(s.status)) stopPolling();
        } catch {
          // Transient poll error — keep trying on the next tick.
        }
      };
      tick();
      pollRef.current = setInterval(tick, POLL_MS);
    },
    [stopPolling],
  );

  // ── Resume an in-progress write from ?book={id} (port of _restoreWriteBookState) ──
  // On mount, if the URL carries a book id, rehydrate the title/outline/state
  // from the server and resume polling when it's still writing. This makes the
  // "you can leave and come back" promise true across a reload.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (resumedRef.current) return;
    const resumeId = searchParams?.get("book");
    if (!resumeId) return;
    resumedRef.current = true;
    let alive = true;
    (async () => {
      try {
        const book = await getBook(resumeId);
        if (!alive) return;
        setBookId(book.id || resumeId);
        if (book.agentId) setAgentId(book.agentId);
        if (book.outline) setOutline(book.outline);
        if (book.outline?.chapters?.length) {
          setExpanded(new Set([book.outline.chapters[0].number]));
        }
        if (book.status === "outlining" || book.status === "confirmed") {
          // Outline still being refined / just confirmed — drop back to the
          // outlining workspace so the user can confirm (or it begins writing).
          setPhase(book.status === "confirmed" ? "writing" : "outlining");
          if (book.status === "confirmed") startPolling(resumeId);
        } else {
          // writing / completed / failed / cancelled → show the progress canvas.
          setPhase("writing");
          setStatus(book);
          if (book.status === "writing") startPolling(resumeId);
        }
      } catch {
        // Couldn't resume (gone / access denied) — leave the prompt phase as-is.
        if (alive) resumedRef.current = false;
      }
    })();
    return () => {
      alive = false;
    };
  }, [searchParams, startPolling]);

  function toggleChapter(n: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      next.has(n) ? next.delete(n) : next.add(n);
      return next;
    });
  }

  const chapters: OutlineChapter[] = outline?.chapters || [];
  const totalWords = chapters.reduce((s, c) => s + (c.estimated_words || 0), 0);

  // ── Render: prompt phase ──────────────────────────────────────────────
  if (phase === "prompt") {
    return (
      <div className={styles.promptWrap}>
        <div className={styles.promptCenter}>
          <h1 className={styles.promptHeading}>Write the book you need</h1>
          <p className={styles.promptSub}>
            Describe a person, an idea, a skill, or any topic. Feynman generates a
            complete book on-demand for your current needs — outline first, then
            full chapters you can read and chat with.
          </p>

          <form className={styles.promptForm} onSubmit={onStart}>
            <textarea
              className={styles.promptInput}
              rows={4}
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              onKeyDown={(e) => {
                if ((e.metaKey || e.ctrlKey) && e.key === "Enter") onStart();
              }}
              placeholder={
                'e.g. "A beginner\'s guide to quantum computing in plain language" · "The history of coffee and how it shaped civilization"'
              }
              autoFocus
            />
            <div className={styles.promptActions}>
              {error && <span className={styles.errorText}>{error}</span>}
              <button
                type="submit"
                className={styles.startBtn}
                disabled={busy || prompt.trim().length < 10}
              >
                <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M12 20h9" />
                  <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                </svg>
                Generate outline
              </button>
            </div>
          </form>
        </div>
      </div>
    );
  }

  // ── Render: outlining + writing phases (split: transcript | canvas) ───
  return (
    <div className={styles.workspace}>
      {/* Left: conversation */}
      <div className={styles.chatCol}>
        <div className={styles.transcript}>
          {messages.map((m, i) => (
            <div
              key={i}
              className={m.role === "user" ? styles.userMsg : styles.aiMsg}
            >
              {m.content}
            </div>
          ))}
          {busy && (
            <div className={styles.aiMsg}>
              <span className={styles.typing}>
                {phase === "outlining" && !outline
                  ? "Building your book outline…"
                  : "Updating the outline…"}
              </span>
            </div>
          )}
          <div ref={messagesEndRef} />
        </div>

        {phase === "outlining" && (
          <form className={styles.refineBar} onSubmit={onRefine}>
            <input
              type="text"
              className={styles.refineInput}
              value={refineInput}
              onChange={(e) => setRefineInput(e.target.value)}
              placeholder="Refine the outline — add a chapter, change the focus…"
              disabled={busy}
            />
            <button
              type="submit"
              className={styles.refineSend}
              disabled={busy || !refineInput.trim()}
              aria-label="Send"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <line x1="12" y1="19" x2="12" y2="5" />
                <polyline points="5 12 12 5 19 12" />
              </svg>
            </button>
          </form>
        )}
      </div>

      {/* Right: glass canvas — outline or writing progress */}
      <aside className={`book-canvas visible ${styles.canvas}`}>
        <div className={styles.canvasInner}>
          {phase === "outlining" && outline && (
            <>
              <div className={styles.canvasHeader}>
                <div className={styles.canvasTitle}>
                  {outline.title || "Untitled"}
                </div>
                {outline.subtitle && (
                  <div className={styles.canvasSubtitle}>{outline.subtitle}</div>
                )}
                <div className={styles.canvasMeta}>
                  <span className={styles.canvasStats}>
                    {chapters.length} chapters · ~{Math.round(totalWords / 1000)}k
                    words
                  </span>
                  <button
                    type="button"
                    className={styles.confirmBtn}
                    onClick={onConfirm}
                    disabled={confirming || chapters.length === 0}
                  >
                    {confirming ? (
                      <span className={styles.spinner} />
                    ) : (
                      <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M12 20h9" />
                        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
                      </svg>
                    )}
                    {confirming ? "Starting…" : "Start Writing"}
                  </button>
                </div>
              </div>

              <div className={styles.divider} />

              <div className={styles.chapters}>
                {chapters.map((c) => {
                  const isOpen = expanded.has(c.number);
                  return (
                    <div
                      key={c.number}
                      className={`${styles.chapter} ${isOpen ? styles.chapterOpen : ""}`}
                    >
                      <button
                        type="button"
                        className={styles.chHeader}
                        onClick={() => toggleChapter(c.number)}
                        aria-expanded={isOpen}
                      >
                        <span className={styles.chNum}>{c.number}</span>
                        <span className={styles.chTitle}>{c.title}</span>
                        <svg
                          className={styles.chChevron}
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <polyline points="6 9 12 15 18 9" />
                        </svg>
                      </button>
                      {isOpen && (
                        <div className={styles.chDetail}>
                          {c.summary && (
                            <p className={styles.chSummary}>{c.summary}</p>
                          )}
                          {c.key_points && c.key_points.length > 0 && (
                            <ul className={styles.chPoints}>
                              {c.key_points.map((p, i) => (
                                <li key={i}>{p}</li>
                              ))}
                            </ul>
                          )}
                          {!!c.estimated_words && (
                            <span className={styles.chWords}>
                              ~{c.estimated_words.toLocaleString()} words
                            </span>
                          )}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {phase === "writing" && (
            <WritingProgress
              status={status}
              fallbackChapters={chapters}
              agentId={agentId}
              onCancel={onCancel}
              onRetry={onRetry}
            />
          )}

          {error && <p className={styles.errorBanner}>{error}</p>}
        </div>
      </aside>
    </div>
  );
}

// ── Writing progress panel ───────────────────────────────────────────────
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
  const state = status?.status ?? "writing";
  const readId = status?.agentId || agentId;

  let label = "Writing…";
  if (state === "completed") label = "Completed";
  else if (state === "cancelled") label = "Cancelled";
  else if (state === "failed") label = "Failed";

  return (
    <div>
      <div className={styles.progHeader}>
        <span className={styles.progIcon}>📖</span>
        <span className={styles.progTitle}>{label}</span>
        <span className={styles.progCount}>
          {done} / {total}
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

      <div className={styles.progBarWrap}>
        <div className={styles.progBar}>
          <div
            className={`${styles.progFill} ${state === "cancelled" || state === "failed" ? styles.progFillStopped : ""}`}
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      <div className={styles.progChapters}>
        {chapters.map((c) => {
          let cls = styles.chPending;
          let icon = "—";
          let detail = "Waiting…";
          if (c.number <= done) {
            cls = styles.chDone;
            icon = "✓";
            detail = "Completed";
          } else if (state === "cancelled" || state === "failed") {
            detail = state === "failed" ? "Not written" : "Cancelled";
          } else if (c.number === done + 1) {
            cls = styles.chActive;
            icon = "✎";
            detail = "Writing…";
          }
          return (
            <div key={c.number} className={styles.progCh}>
              <div className={`${styles.progChIcon} ${cls}`}>{icon}</div>
              <div className={styles.progChInfo}>
                <div className={styles.progChTitle}>
                  Ch.{c.number}: {c.title}
                </div>
                <div className={styles.progChDetail}>{detail}</div>
              </div>
            </div>
          );
        })}
      </div>

      {state === "completed" && readId && (
        <>
          <div className={styles.divider} />
          <div className={styles.doneLabel}>Your book is ready.</div>
          <Link href={`/read/${encodeURIComponent(readId)}`} className={styles.readBtn}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
              <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
            </svg>
            Read it
          </Link>
        </>
      )}

      {state === "failed" && (
        <>
          <div className={styles.divider} />
          <div className={styles.failLabel}>
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
              <Link href={`/read/${encodeURIComponent(readId)}`} className="canvas-action-btn">
                Read what&apos;s done
              </Link>
            )}
          </div>
        </>
      )}

      {state === "cancelled" && (
        <>
          <div className={styles.divider} />
          <div className={styles.failLabel}>
            Writing stopped — {done} of {total} chapters written.
          </div>
          {readId && done > 0 && (
            <Link href={`/read/${encodeURIComponent(readId)}`} className={styles.readBtn}>
              Read the partial book
            </Link>
          )}
        </>
      )}
    </div>
  );
}
