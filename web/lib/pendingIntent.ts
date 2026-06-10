/**
 * Pending book-chat intent (SEO/share → signup → resume chat).
 *
 * Faithful port of app.js ~77-163. When an anonymous visitor lands on a SEO
 * surface (e.g. /book/{id}, the Reader) and tries to chat, we stash the *book
 * they came for* in localStorage before bouncing them through login. After they
 * sign up, the home composer restores the intent so the original chat resumes —
 * the single biggest funnel leak from the SEO surface if dropped.
 *
 * Lifecycle:
 *   1. savePendingBookIntent(bookId, {question, via}) on the gated chat action.
 *   2. User signs up; the composer mounts and calls restorePendingBookIntent().
 *   3. Intent expires after 24h so stale storage never hijacks a later session.
 *
 * Analytics (pending_intent_saved / pending_intent_restored) is fired by the
 * call sites, not here, so this module stays storage-only and dependency-free.
 */

export const PENDING_INTENT_KEY = "feynman:pendingChat";
const TTL_MS = 24 * 60 * 60 * 1000;

/**
 * A pending chat intent carries the ENTITY the visitor came for — a book
 * (`bookId`, the original shape) or a great mind (`mindId`). Exactly one is
 * set. Minds were silently dropped through login before this field existed —
 * and mind pages are the majority of the SEO surface.
 */
export interface PendingChatIntent {
  bookId?: string;
  mindId?: string;
  question: string;
  via: string;
  ts: number;
}

/** Back-compat alias (original book-only shape). */
export type PendingBookIntent = PendingChatIntent;

function saveIntent(
  entity: Partial<PendingChatIntent>,
  opts: { question?: string; via?: string },
): void {
  if (typeof window === "undefined") return;
  try {
    const intent: PendingChatIntent = {
      ...entity,
      question: opts.question || "",
      via: opts.via || "reader",
      ts: Date.now(),
    };
    localStorage.setItem(PENDING_INTENT_KEY, JSON.stringify(intent));
  } catch (e) {
    console.warn("pendingChat save failed:", e);
  }
}

/** Persist a book-chat intent. Best-effort; storage failures are swallowed. */
export function savePendingBookIntent(
  bookId: string,
  opts: { question?: string; via?: string } = {},
): void {
  if (!bookId) return;
  saveIntent({ bookId }, opts);
}

/** Persist a mind-chat intent (the /?mind= composer + mind-page gates). */
export function savePendingMindIntent(
  mindId: string,
  opts: { question?: string; via?: string } = {},
): void {
  if (!mindId) return;
  saveIntent({ mindId }, opts);
}

/** Read + validate TTL. Returns the intent or null. Does NOT clear it. */
export function readPendingBookIntent(): PendingChatIntent | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = localStorage.getItem(PENDING_INTENT_KEY);
    if (!raw) return null;
    const intent = JSON.parse(raw) as Partial<PendingChatIntent>;
    if (!intent?.bookId && !intent?.mindId) return null;
    if (intent.ts && Date.now() - intent.ts > TTL_MS) {
      localStorage.removeItem(PENDING_INTENT_KEY);
      return null;
    }
    return {
      bookId: intent.bookId,
      mindId: intent.mindId,
      question: intent.question || "",
      via: intent.via || "reader",
      ts: intent.ts || Date.now(),
    };
  } catch {
    return null;
  }
}

/** Remove any stored intent. */
export function clearPendingBookIntent(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem(PENDING_INTENT_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * Read + validate TTL + clear, returning the intent (or null). This is the
 * "consume" path used on resume — matches the legacy _restorePendingBookIntent
 * which clears after reading so a restored intent never fires twice.
 */
export function restorePendingBookIntent(): PendingBookIntent | null {
  const intent = readPendingBookIntent();
  if (intent) clearPendingBookIntent();
  return intent;
}
