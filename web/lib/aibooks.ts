/**
 * AI write-book data layer. Ports the legacy write-book flow (app.js
 * _handleWriteBookMessage / _confirmWriteBook / _startWritingPoll) against the
 * FastAPI endpoints in app/main.py:
 *
 *   POST /api/ai-books/start            → { id, agent_id, title, outline, ai_message }
 *   POST /api/ai-books/{id}/chat        → { outline, response }   (refine)
 *   POST /api/ai-books/{id}/confirm     → { status:"writing", chapters_total }
 *   GET  /api/ai-books/{id}/status      → lightweight status (no content)
 *   GET  /api/ai-books/{id}             → full book (incl. content)
 *
 * NOTE on contract drift vs the brief: the brief said start → `{book_id}` and
 * chat → `{ai_message}`. The live API uses `id` (+ `agent_id`) for start and
 * `response` for chat. We honor the live API and expose stable names here.
 */

import { get, post, ApiError } from "@/lib/api";

export type AiBookStatus =
  | "outlining"
  | "confirmed"
  | "writing"
  | "completed"
  | "failed"
  | "cancelled";

export interface OutlineChapter {
  number: number;
  title: string;
  summary?: string;
  key_points?: string[];
  estimated_words?: number;
}

export interface Outline {
  title?: string;
  subtitle?: string;
  category?: string;
  chapters?: OutlineChapter[];
}

export interface StartResult {
  /** AI-book id — used for all subsequent /api/ai-books/{id} calls. */
  bookId: string;
  /** Agent id — what the reader/library address by (`/read/{agentId}`). */
  agentId: string;
  title: string;
  outline: Outline;
  aiMessage: string;
}

export interface ChatResult {
  outline: Outline;
  /** The assistant's reply to the refinement message. */
  response: string;
}

/** Normalized status, derived fields included for progress UI. */
export interface BookStatus {
  id: string;
  agentId: string;
  status: AiBookStatus;
  title: string;
  outline: Outline;
  chaptersTotal: number;
  chaptersDone: number;
  /** 0–100, derived from chaptersDone / chaptersTotal. */
  progressPct: number;
  /** Failure reason when status is "failed" (else null) — surfaced in the canvas. */
  error?: string | null;
}

export interface FullBook extends BookStatus {
  /** Map of chapter-number → { content, word_count }. */
  content: Record<string, { content?: string; word_count?: number }>;
  creatorName?: string;
}

// ── Helpers ────────────────────────────────────────────────────────────
function toStatus(raw: any): BookStatus {
  const total = Number(raw?.chapters_total ?? raw?.outline?.chapters?.length ?? 0);
  const done = Number(raw?.chapters_written ?? 0);
  return {
    id: raw?.id ?? "",
    agentId: raw?.agent_id ?? "",
    status: (raw?.status ?? "outlining") as AiBookStatus,
    title: raw?.title ?? raw?.outline?.title ?? "Untitled",
    outline: (raw?.outline ?? {}) as Outline,
    chaptersTotal: total,
    chaptersDone: done,
    progressPct: total > 0 ? Math.round((done / total) * 100) : 0,
    error: raw?.error ?? null,
  };
}

/**
 * Detect the outline/content language from the description (port of
 * _detectLanguage). Best-effort; defaults to "en".
 */
export function detectLanguage(text: string): string {
  const cjk = text.match(/[一-鿿㐀-䶿]/g);
  if (cjk && cjk.length > text.length * 0.1) return "zh";
  const jp = text.match(/[぀-ゟ゠-ヿ]/g);
  if (jp && jp.length > 3) return "ja";
  const kr = text.match(/[가-힯]/g);
  if (kr && kr.length > 3) return "ko";
  return "en";
}

// ── Endpoints ────────────────────────────────────────────────────────────
/** Phase 1: generate an outline from a free-text description. (~20s LLM call) */
export async function startBook(
  description: string,
  language?: string,
): Promise<StartResult> {
  const data = await post<{
    id: string;
    agent_id: string;
    title: string;
    outline: Outline;
    ai_message: string;
  }>("/api/ai-books/start", {
    description,
    language: language || detectLanguage(description),
  });
  return {
    bookId: data.id,
    agentId: data.agent_id,
    title: data.title,
    outline: data.outline || {},
    aiMessage: data.ai_message || "",
  };
}

/** Phase 2: refine the outline conversationally. */
export async function chatBook(
  bookId: string,
  message: string,
  history: { role: string; content: string }[] = [],
): Promise<ChatResult> {
  const data = await post<{ outline: Outline; response: string }>(
    `/api/ai-books/${encodeURIComponent(bookId)}/chat`,
    { message, history },
  );
  return { outline: data.outline || {}, response: data.response || "" };
}

/** Confirm the outline; the backend starts writing chapters in the background. */
export async function confirmBook(
  bookId: string,
): Promise<{ status: AiBookStatus; chaptersTotal: number }> {
  const data = await post<{ status: AiBookStatus; chapters_total?: number }>(
    `/api/ai-books/${encodeURIComponent(bookId)}/confirm`,
    {},
  );
  return { status: data.status, chaptersTotal: data.chapters_total ?? 0 };
}

/**
 * Regenerate a finished book's chapters from scratch in `language` (the
 * post-completion Rewrite flow). Re-languages the outline + clears the old
 * chapters server-side, then re-runs the writer. Returns the writing status so
 * the caller can resume polling.
 */
export async function rewriteBook(
  bookId: string,
  language: string,
): Promise<{ status: AiBookStatus; chaptersTotal: number }> {
  const data = await post<{ status: AiBookStatus; chapters_total?: number }>(
    `/api/ai-books/${encodeURIComponent(bookId)}/rewrite`,
    { language },
  );
  return { status: data.status, chaptersTotal: data.chapters_total ?? 0 };
}

/**
 * Stop an in-progress write (port of _cancelWriteBook → POST /{id}/cancel).
 * Chapters already written are kept; the book transitions to `cancelled`.
 */
export async function cancelBook(bookId: string): Promise<void> {
  await post(`/api/ai-books/${encodeURIComponent(bookId)}/cancel`, {});
}

/**
 * Resume a failed write from the failed chapter (port of _retryWriteBook →
 * POST /{id}/retry). Returns the (typically `writing`) status so the caller can
 * resume polling.
 */
export async function retryBook(
  bookId: string,
): Promise<{ status: AiBookStatus }> {
  const data = await post<{ status?: AiBookStatus }>(
    `/api/ai-books/${encodeURIComponent(bookId)}/retry`,
    {},
  );
  return { status: (data.status ?? "writing") as AiBookStatus };
}

/** Lightweight poll for writing progress. */
export async function getStatus(bookId: string): Promise<BookStatus> {
  const raw = await get<any>(
    `/api/ai-books/${encodeURIComponent(bookId)}/status`,
  );
  return toStatus(raw);
}

/** Full book incl. chapter content (used after completion if needed). */
export async function getBook(bookId: string): Promise<FullBook> {
  const raw = await get<any>(`/api/ai-books/${encodeURIComponent(bookId)}`);
  return {
    ...toStatus(raw),
    content: (raw?.content ?? {}) as FullBook["content"],
    creatorName: raw?.creator_name ?? "",
  };
}

export { ApiError };
