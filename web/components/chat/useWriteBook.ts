"use client";

/**
 * Write-book flow hook — owns the ai-books pipeline for one chat session.
 *
 * Faithful port of the app.js write-book functions, lifted out of the global
 * SPA state into a per-session React hook:
 *   - _handleWriteBookMessage (~4120): first user message → POST /start (outline);
 *     subsequent → POST /{id}/chat (refine). Persists session meta so reopen works.
 *   - _confirmWriteBook (~4213): POST /{id}/confirm → start polling.
 *   - _cancelWriteBook / _retryWriteBook (~4236/4249).
 *   - _startWritingPoll (~4265): setInterval poll of /{id}/status, cleared on
 *     terminal status / unmount / session change.
 *   - _restoreWriteBookState (~3679): on open, rehydrate from session.meta's
 *     ai_book_id + resume polling when still writing.
 *
 * The hook does NOT render anything in the transcript itself; it calls
 * `onAssistant` so ChatView appends + persists the AI's reply as a normal
 * assistant Message (matching production's appendMsg + _queueSessionMessage).
 * It returns the canvas-driving state (phase/outline/status/…) for BookCanvas.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  startBook,
  chatBook,
  confirmBook,
  getStatus,
  getBook,
  cancelBook,
  retryBook,
  ApiError,
  type Outline,
  type BookStatus,
  type FullBook,
  type AiBookStatus,
} from "@/lib/aibooks";
import { getSession, updateSession } from "@/lib/chat";
import type { CanvasPhase } from "./BookCanvas";

const TERMINAL: AiBookStatus[] = ["completed", "failed", "cancelled"];
const POLL_MS = 5000;

export interface UseWriteBookArgs {
  sessionId: string;
  /** True once we've classified this session as a write_book session. */
  active: boolean;
  /** The session's persisted meta (carries ai_book_id/agent_id for resume). */
  initialMeta: Record<string, unknown> | null;
  /**
   * Append + persist an assistant message in the chat transcript (ChatView
   * wires this to its setMessages + queueSaveMessage). The outline/refine
   * replies and the "writing now" notice flow through here.
   */
  onAssistant: (content: string) => void;
  /** Persist the user's message too (first send seeds it before /start). */
  onUser: (content: string) => void;
  /** Rename the session row in ChatView state when /start returns a title. */
  onTitle?: (title: string) => void;
  /**
   * Last few user/assistant turns for refinement context (port of the `history`
   * slice in _handleWriteBookMessage). ChatView owns the transcript, so it
   * supplies this lazily at send time.
   */
  getHistory: () => { role: string; content: string }[];
}

export interface WriteBookState {
  phase: CanvasPhase;
  outline: Outline | null;
  status: BookStatus | null;
  agentId: string | null;
  bookId: string | null;
  /** Per-chapter content (chapter# → {content, word_count}) — populated on
   *  resume of a finished/partial book so the canvas can show word counts;
   *  null during live polling (the /status poll carries no content). */
  bookContent: FullBook["content"] | null;
  busy: boolean;
  confirming: boolean;
  error: string | null;
  /** Send a composer message through the ai-books flow (start or refine). */
  send: (message: string) => Promise<void>;
  confirm: () => Promise<void>;
  cancel: () => Promise<void>;
  retry: () => Promise<void>;
}

function describeError(e: unknown, fallback: string): string {
  if (e instanceof ApiError) {
    if (e.status === 503)
      // 503 = all LLM providers were slow/unavailable for this call — a
      // transient capacity/timeout issue, NOT a missing config. Keep the
      // user-facing copy clean (no provider names or internals); the real
      // detail is still in the 503 response body for debugging.
      return "The book writer is busy right now. Please try again in a moment.";
    if (e.status === 401 || e.status === 403)
      return "You need to be signed in to write a book.";
    const detail =
      e.body && typeof e.body === "object" && "detail" in e.body
        ? String((e.body as { detail: unknown }).detail)
        : "";
    return detail || fallback;
  }
  if (e instanceof Error && e.message) return e.message;
  return fallback;
}

export function useWriteBook(args: UseWriteBookArgs): WriteBookState {
  const { sessionId, active, initialMeta, onAssistant, onUser, onTitle, getHistory } = args;

  const [phase, setPhase] = useState<CanvasPhase>("outlining");
  const [outline, setOutline] = useState<Outline | null>(null);
  const [status, setStatus] = useState<BookStatus | null>(null);
  const [bookId, setBookId] = useState<string | null>(null);
  const [agentId, setAgentId] = useState<string | null>(null);
  const [bookContent, setBookContent] = useState<FullBook["content"] | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Generation guard (port of _writeBookGen): bump to invalidate in-flight work.
  const genRef = useRef(0);
  // Keep refs of the latest callbacks so the poll/restore effects don't re-run
  // when ChatView re-renders new closures.
  const cbRef = useRef({ onAssistant, onUser, onTitle, getHistory });
  cbRef.current = { onAssistant, onUser, onTitle, getHistory };
  // Latest bookId for the poll guard (avoids stale closure when session changes).
  const bookIdRef = useRef<string | null>(null);
  bookIdRef.current = bookId;
  // Latest status for the post-refine refresh: a finished book's canvas title
  // reads `status`, not `outline`, so editing its title must refetch the book.
  const statusRef = useRef<BookStatus | null>(null);
  statusRef.current = status;

  // ── Polling lifecycle ──────────────────────────────────────────────────
  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);
  // Clear on unmount + whenever the session changes (each ChatView is keyed by
  // sessionId, so unmount covers session switches too).
  useEffect(() => () => stopPolling(), [stopPolling]);

  const startPolling = useCallback(
    (id: string) => {
      stopPolling();
      const tick = async () => {
        // Stop if this book is no longer the active one (session switched).
        if (bookIdRef.current !== id) {
          stopPolling();
          return;
        }
        try {
          const s = await getStatus(id);
          if (bookIdRef.current !== id) {
            stopPolling();
            return;
          }
          setStatus(s);
          if (TERMINAL.includes(s.status)) {
            stopPolling();
            // The lightweight /status poll carries no chapter bodies. On
            // completion, pull the full book once so the canvas can show the
            // written content inline (read-in-place) without needing a reopen.
            if (s.status === "completed") {
              try {
                const full = await getBook(id);
                if (bookIdRef.current === id) {
                  setStatus(full);
                  setOutline(full.outline);
                  setBookContent(full.content || null);
                }
              } catch {
                /* keep the lightweight status; content shows on next open */
              }
            }
          }
        } catch {
          // Transient poll error — keep trying on the next tick (port of the
          // app.js poll() try/catch console.warn).
        }
      };
      tick();
      pollRef.current = setInterval(tick, POLL_MS);
    },
    [stopPolling],
  );

  // ── Resume on open (port of _restoreWriteBookState) ────────────────────
  // When the session carries an ai_book_id in meta, rehydrate the book + canvas
  // and resume polling if it's still writing. Local meta may be stale (outline
  // generation persisted ai_book_id to the DB but the in-memory row predates
  // it), so refetch the session when ai_book_id is missing.
  const resumedRef = useRef(false);
  useEffect(() => {
    if (!active || resumedRef.current) return;
    resumedRef.current = true;
    let alive = true;
    const gen = ++genRef.current;

    (async () => {
      let meta = initialMeta || {};
      let aiBookId = meta.ai_book_id as string | undefined;
      if (!aiBookId) {
        try {
          const fresh = await getSession(sessionId);
          if (!alive || genRef.current !== gen) return;
          meta = fresh.meta || {};
          aiBookId = meta.ai_book_id as string | undefined;
        } catch (e) {
          console.warn("Failed to refresh session meta:", e);
        }
      }
      if (!aiBookId) return; // brand-new write session — nothing to resume.

      setBookId(aiBookId);
      bookIdRef.current = aiBookId;
      setAgentId((meta.agent_id as string) || null);
      try {
        const book = await getBook(aiBookId);
        if (!alive || genRef.current !== gen) return;
        setOutline(book.outline);
        setAgentId(book.agentId || (meta.agent_id as string) || null);
        // The full GET carries per-chapter content + word counts; surface them
        // so the canvas can show "N words" on completed chapters (L11/L12).
        setBookContent(book.content || null);
        if (book.status === "writing") {
          setPhase("writing");
          setStatus(book);
          startPolling(aiBookId);
        } else if (
          book.status === "completed" ||
          book.status === "cancelled" ||
          book.status === "failed"
        ) {
          setPhase("writing");
          setStatus(book);
        } else {
          // outlining / confirmed — show the outline so the user can confirm.
          setPhase("outlining");
        }
      } catch (e) {
        console.warn("Failed to restore write-book state:", e);
      }
    })();

    return () => {
      alive = false;
    };
    // initialMeta/onAssistant intentionally excluded — resume runs once per session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [active, sessionId, startPolling]);

  // ── Send: first message → outline; subsequent → refine ─────────────────
  const send = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || busy) return;
      setError(null);
      // Abort any in-flight work + bump generation.
      const gen = ++genRef.current;

      // Capture the prior transcript for refine context BEFORE appending the new
      // user turn (production's history slice excludes the current message).
      const priorHistory = cbRef.current.getHistory().slice(-6);

      // Append + persist the user's message (port of appendMsg + queue).
      cbRef.current.onUser(message);

      // Phase 1: no book yet → generate the outline. No abort: the outline call
      // takes ~20s and must survive navigating away and back.
      if (!bookIdRef.current) {
        setBusy(true);
        try {
          const res = await startBook(message);
          // Always persist session meta so resume can recover (production
          // persists even if the user navigated away mid-call).
          const meta = {
            write_book: true,
            ai_book_id: res.bookId,
            agent_id: res.agentId,
          };
          try {
            await updateSession(sessionId, { title: res.title, meta });
          } catch (e) {
            console.warn("Failed to persist write-book meta:", e);
          }
          cbRef.current.onAssistant(res.aiMessage);
          if (res.title) cbRef.current.onTitle?.(res.title);

          // Only update the live canvas if the user is still on this send.
          if (genRef.current !== gen) return;
          setBookId(res.bookId);
          bookIdRef.current = res.bookId;
          setAgentId(res.agentId);
          setOutline(res.outline);
          setPhase("outlining");
        } catch (err) {
          if (genRef.current !== gen) return;
          const msg = describeError(err, "Couldn't generate an outline. Try again.");
          setError(msg);
          cbRef.current.onAssistant("Sorry, I couldn't generate an outline: " + msg);
        } finally {
          if (genRef.current === gen) setBusy(false);
        }
        return;
      }

      // Phase 2: the book exists → the chat edits it. Outlining refines the
      // outline; a written book may be retitled, answered, or fully rewritten —
      // the backend decides and acts (no separate Rewrite button).
      setBusy(true);
      try {
        const res = await chatBook(bookIdRef.current, message, priorHistory);
        if (genRef.current !== gen) return;
        cbRef.current.onAssistant(res.response);

        // The chat triggered a full rewrite: the backend already re-languaged the
        // outline, cleared the bodies, and kicked the writer. Flip the canvas to
        // live writing progress (the new chapters stream in via the poll).
        if (res.status === "writing") {
          const id = bookIdRef.current;
          setBookContent(null);
          setStatus(null);
          setPhase("writing");
          if (id) startPolling(id);
          return;
        }

        if (res.outline) setOutline(res.outline);
        // A finished book's canvas shows `status.title` (not `outline.title`) and
        // polling is stopped — so after a retitle refetch once to surface it.
        const refetchId = bookIdRef.current;
        if (statusRef.current && refetchId) {
          try {
            const fresh = await getBook(refetchId);
            if (genRef.current === gen) {
              setStatus(fresh);
              setOutline(fresh.outline);
              setBookContent(fresh.content || null);
            }
          } catch {
            /* keep the result we already applied */
          }
        }
      } catch (err) {
        if (genRef.current !== gen) return;
        const msg = describeError(err, "Couldn't update the outline. Try again.");
        setError(msg);
        cbRef.current.onAssistant("Error updating outline: " + msg);
      } finally {
        if (genRef.current === gen) setBusy(false);
      }
    },
    [busy, sessionId, startPolling],
  );

  // ── Confirm + poll (port of _confirmWriteBook) ─────────────────────────
  const confirm = useCallback(async () => {
    const id = bookIdRef.current;
    if (!id || confirming) return;
    setError(null);
    setConfirming(true);
    try {
      await confirmBook(id);
      setPhase("writing");
      cbRef.current.onAssistant(
        "Great! I'm now writing your book. I'll update you as each chapter is completed. You can leave this chat and come back anytime.",
      );
      startPolling(id);
    } catch (err) {
      setError(describeError(err, "Couldn't start writing. Try again."));
    } finally {
      setConfirming(false);
    }
  }, [confirming, startPolling]);

  // ── Cancel (port of _cancelWriteBook) ──────────────────────────────────
  const cancel = useCallback(async () => {
    const id = bookIdRef.current;
    if (!id) return;
    if (!window.confirm("Stop writing? Chapters already completed will be kept.")) return;
    try {
      await cancelBook(id);
      stopPolling();
      try {
        setStatus(await getStatus(id));
      } catch {
        setStatus((s) => (s ? { ...s, status: "cancelled" } : s));
      }
    } catch (err) {
      setError(describeError(err, "Couldn't stop writing. Try again."));
    }
  }, [stopPolling]);

  // ── Retry (port of _retryWriteBook) ────────────────────────────────────
  const retry = useCallback(async () => {
    const id = bookIdRef.current;
    if (!id) return;
    setError(null);
    try {
      await retryBook(id);
      cbRef.current.onAssistant("Resuming — I'll pick up from the failed chapter.");
      startPolling(id);
    } catch (err) {
      setError(describeError(err, "Retry failed. Try again."));
    }
  }, [startPolling]);

  return {
    phase,
    outline,
    status,
    agentId,
    bookId,
    bookContent,
    busy,
    confirming,
    error,
    send,
    confirm,
    cancel,
    retry,
  };
}
