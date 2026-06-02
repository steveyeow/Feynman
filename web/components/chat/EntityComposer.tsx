"use client";

/**
 * In-page chat composer for the SEO/GEO entity pages (/book, /book/q, …).
 *
 * The activation bridge. Instead of a small "Chat about this book" link that
 * drops the reader on the home composer (losing the page context), this starts
 * the REAL core chat right here, with the book pre-selected as a chip — so a
 * free reader lands straight in a grounded conversation, turning "read the
 * answer and bounce" into "read it and start talking".
 *
 * It WRAPS the same canonical <Composer> the in-chat surface uses (identical
 * styling + components: books / invite-great-minds popovers, chips, send), so
 * the experience is unified. Inviting specific minds stays the pro path (gated
 * on send exactly like the home composer); a plain book chat is free.
 *
 * Reuses the home/chat machinery: createSession → sessionStorage handoff
 * (feynman:pendingChat) → /chat/{id}, where ChatView fires /api/chat.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSession, bumpSessions } from "@/lib/chat";
import { useProGate } from "@/components/pro/ProOverlay";
import { track } from "@/lib/analytics";
import Composer from "./Composer";
import type { SelectedBook, SelectedMind } from "./ComposerPickers";

const PENDING_KEY = "feynman:pendingChat";

export default function EntityComposer({
  book,
  source,
  placeholder,
}: {
  book: { id: string; title: string; author?: string };
  /** analytics tag for where the chat was started (e.g. "book", "q"). */
  source?: string;
  placeholder?: string;
}) {
  const router = useRouter();
  const { requirePro } = useProGate();
  const [books, setBooks] = useState<Map<string, SelectedBook>>(
    () =>
      new Map([
        [book.id, { id: book.id, agentId: book.id, title: book.title, author: book.author || "" }],
      ]),
  );
  const [minds, setMinds] = useState<Map<string, SelectedMind>>(new Map());
  const [busy, setBusy] = useState(false);

  const start = async (message: string) => {
    const msg = message.trim();
    if (!msg || busy) return;
    // Inviting minds is the pro path — same backstop as the home composer.
    if (minds.size && !requirePro()) return;
    setBusy(true);
    try {
      const session = await createSession({ title: "New chat", sessionType: "chat" });
      bumpSessions();
      try {
        sessionStorage.setItem(
          PENDING_KEY,
          JSON.stringify({
            sessionId: session.id,
            message: msg,
            books: [...books.values()],
            minds: [...minds.values()],
          }),
        );
      } catch {
        /* sessionStorage unavailable — ChatView shows an empty chat */
      }
      try {
        track("seo_chat_started", { source: source || "entity", book_id: book.id });
      } catch {
        /* analytics best-effort */
      }
      router.push(`/chat/${session.id}`);
    } catch (e) {
      console.warn("Failed to start chat:", e);
      setBusy(false);
    }
  };

  const toggleBook = (b: SelectedBook) =>
    setBooks((prev) => {
      const next = new Map(prev);
      if (next.has(b.id)) next.delete(b.id);
      else next.set(b.id, b);
      return next;
    });
  const toggleMind = (m: SelectedMind) =>
    setMinds((prev) => {
      const next = new Map(prev);
      if (next.has(m.id)) next.delete(m.id);
      else next.set(m.id, m);
      return next;
    });
  const removeBook = (id: string) =>
    setBooks((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  const removeMind = (id: string) =>
    setMinds((prev) => {
      const next = new Map(prev);
      next.delete(id);
      return next;
    });

  return (
    <div className="entity-composer">
      <Composer
        books={books}
        minds={minds}
        mentionable={[...minds.values()].map((m) => ({ name: m.name, era: m.era, domain: m.domain }))}
        disabled={busy}
        direction="down"
        placeholder={placeholder || `Ask ${book.title} anything — great minds will join in…`}
        onSend={start}
        onToggleBook={toggleBook}
        onToggleMind={toggleMind}
        onRemoveBook={removeBook}
        onRemoveMind={removeMind}
      />
    </div>
  );
}
