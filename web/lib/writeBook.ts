/**
 * Write-book entry helper — the single way to start a write-book session.
 *
 * Faithful port of app.js `startWriteBook` (~3727): write-book lives INSIDE a
 * chat session (sessionType "write_book"), not on a separate route. The entry:
 *
 *   1. gate (anon → /login; non-pro → upgrade overlay; open-source → allow)
 *   2. create a chat session titled "New book"
 *   3. PATCH its meta to {write_book:true} so a reopen detects the type
 *   4. seed the greeting assistant message (persisted so it survives reload)
 *   5. route to /chat/{id}
 *
 * ChatView then detects the write_book session and renders the book-canvas +
 * routes the composer through the ai-books flow (see useWriteBook).
 */

import type { useRouter } from "next/navigation";
import { createSession, updateSession, queueSaveMessage, bumpSessions } from "@/lib/chat";

type Router = ReturnType<typeof useRouter>;

/**
 * The exact greeting seeded into a new write-book session (verbatim from
 * app.js:3754). Markdown is rendered by MessageList's assistant renderer.
 */
export const WRITE_BOOK_GREETING =
  "I'd love to help you create a book. Tell me what you're interested in — a person, an idea, a skill, or any topic on your mind.\n\nYou can be as specific or broad as you like. For example:\n- *\"A biography of Elon Musk focused on his engineering decisions\"*\n- *\"A beginner's guide to quantum computing in plain language\"*\n- *\"The history of coffee and how it shaped civilization\"*";

interface StartWriteBookOpts {
  /** window.FEYNMAN_PRO equivalent — auth system is configured (hosted build). */
  authEnabled: boolean;
  /** The signed-in user (null when anonymous). */
  user: unknown | null;
  /**
   * Pro gate from useProGate(): shows the upgrade overlay + returns false for
   * non-pro signed-in users; returns true on open-source / pro.
   */
  requirePro: () => boolean;
}

// Module-level reentry guard (port of app.js `_startingWriteBook`) — prevents a
// double-click from creating two sessions.
let _starting = false;

/**
 * Gate, create the write-book session, seed the greeting, and navigate.
 * Returns the new session id (or null when gated / on failure).
 */
export async function startWriteBook(
  router: Router,
  opts: StartWriteBookOpts,
): Promise<string | null> {
  if (_starting) return null;

  // Gate (port of app.js 3729-3736). Anonymous on the hosted build → login;
  // signed-in non-pro → upgrade overlay; open-source (auth off) → fall through.
  if (opts.authEnabled && !opts.user) {
    router.push("/login");
    return null;
  }
  if (!opts.requirePro()) return null;

  _starting = true;
  try {
    // Create the session up front with the write_book meta so the very first
    // GET on the chat page already classifies it (no flash of a plain chat).
    const session = await createSession({
      title: "New book",
      sessionType: "chat",
      meta: { write_book: true },
    });

    // Belt-and-suspenders PATCH (mirrors production, which PATCHes after
    // createSession). Harmless if the create already persisted the meta.
    try {
      await updateSession(session.id, { meta: { write_book: true } });
    } catch (e) {
      console.warn("Failed to set write_book meta:", e);
    }

    // Seed the greeting assistant message, persisted so it survives a reload /
    // reopen (port of app.js `_queueSessionMessage(sessionId,'assistant',greeting)`).
    // AWAIT it before navigating so ChatView's loadMessages() on the new page is
    // guaranteed to read it back (the legacy app had it in in-memory state; here
    // the chat page reloads from the API, so the write must land first).
    await queueSaveMessage(session.id, "assistant", WRITE_BOOK_GREETING);

    bumpSessions(); // surface the new "New book" row in the sidebar
    router.push(`/chat/${session.id}`);
    return session.id;
  } catch (e) {
    console.warn("Failed to start write-book session:", e);
    return null;
  } finally {
    _starting = false;
  }
}
