"use client";

/**
 * Home composer. The interactive replacement for the static .chat-composer on
 * the landing page. Textarea + book-select popover + minds-invite popover +
 * send. Port of handleHomeSend in app.js.
 *
 * On send: create a chat session, hand the first message + selections to
 * ChatView via sessionStorage, then router.push(/chat/{id}). ChatView reads the
 * handoff and fires the actual /api/chat call so the answer renders in-session.
 *
 * Cross-surface contract: /?book={agentId}&q={question} preselects the book and
 * prefills the question (the Reader links here).
 */

import { useEffect, useRef, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { get, getAgent, type Agent } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow } from "@/lib/books";
import { createSession } from "@/lib/chat";
import { useProGate } from "@/components/pro/ProOverlay";
import { restorePendingBookIntent } from "@/lib/pendingIntent";
import { track } from "@/lib/analytics";
import {
  SelectedChips,
  BookPopover,
  MindsPopover,
  PopoverAnchor,
  BooksIcon,
  MindsIcon,
  SendIcon,
  type SelectedBook,
  type SelectedMind,
} from "./ComposerPickers";

const PENDING_KEY = "feynman:pendingChat";

export default function HomeComposer() {
  const router = useRouter();
  const params = useSearchParams();
  const { requirePro } = useProGate();

  const [value, setValue] = useState("");
  const [books, setBooks] = useState<Map<string, SelectedBook>>(new Map());
  const [minds, setMinds] = useState<Map<string, SelectedMind>>(new Map());
  const [booksOpen, setBooksOpen] = useState(false);
  const [mindsOpen, setMindsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const prefilled = useRef(false);

  // ── Preselect a book + prefill a question on mount ──
  // Two sources, in priority order:
  //   1. ?book & ?q query params — cross-surface links (the Reader's "ask").
  //   2. localStorage pending-intent — the post-signup resume path. An
  //      anonymous visitor who hit a pro/login gate on a SEO surface gets their
  //      book restored here after they sign in (port of _restorePendingBookIntent).
  // Query params win when both are present (an explicit link beats stale state).
  useEffect(() => {
    if (prefilled.current) return;
    prefilled.current = true;
    const q = params.get("q");
    const bookId = params.get("book");

    if (q || bookId) {
      if (q) setValue(q);
      if (bookId) preselectBook(bookId);
      return;
    }

    // No query params → try a pending intent (read+validate TTL+clear).
    const intent = restorePendingBookIntent();
    if (intent) {
      if (intent.question) setValue(intent.question);
      preselectBook(intent.bookId);
      track("pending_intent_restored", {
        via: intent.via,
        had_question: !!intent.question,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Resolve an agent/book id → a SelectedBook chip. Tries the catalog list
  // first (cheap, already cached), falling back to a direct /api/agents/{id}
  // fetch for books the catalog filter excludes (matches the legacy fallback).
  const preselectBook = (bookId: string) => {
    get<AgentRow[]>("/api/agents")
      .then((rows) => {
        const all = mapAgentsToBooks(rows || []);
        const b = all.find((x) => x.agentId === bookId || x.id === bookId);
        if (b) {
          setBooks(
            new Map([[b.id, { id: b.id, agentId: b.agentId, title: b.title, author: b.author }]]),
          );
          return null;
        }
        // Fallback: fetch the single agent directly.
        return getAgent(bookId).then((agent: Agent) => {
          if (agent?.id) {
            setBooks(
              new Map([
                [
                  agent.id,
                  {
                    id: agent.id,
                    agentId: agent.id,
                    title: agent.name,
                    author: (agent.author as string) || "",
                  },
                ],
              ]),
            );
          }
        });
      })
      .catch(() => {
        /* book preselect is best-effort */
      });
  };

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const submit = async () => {
    const msg = value.trim();
    if (!msg || busy) return;
    // Inviting minds requires pro on the hosted build (legacy app.js 3149).
    // The minds popover already gates selection; this is the backstop on send.
    if (minds.size && !requirePro()) return;
    setBusy(true);
    try {
      const session = await createSession({ title: "New chat", sessionType: "chat" });
      // Hand the first message + selections to ChatView.
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
        /* sessionStorage unavailable — ChatView will just show an empty chat */
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

  const hasContext = books.size > 0 || minds.size > 0;
  const placeholder = hasContext
    ? minds.size
      ? "Ask your question... Type @ to mention a mind"
      : "Ask your question..."
    : "Ask about books or topics — great minds will join in...";

  return (
    <div className="chat-composer">
      <SelectedChips
        books={books}
        minds={minds}
        onRemoveBook={removeBook}
        onRemoveMind={removeMind}
      />
      <textarea
        ref={taRef}
        className="composer-input"
        rows={1}
        placeholder={placeholder}
        value={value}
        onChange={(e) => {
          setValue(e.target.value);
          grow();
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <div className="composer-toolbar">
        <div className="composer-left">
          <PopoverAnchor>
            <button
              type="button"
              className="composer-icon-btn"
              title="Books & upload"
              aria-label="Books & upload"
              // stop the document mousedown (outside-click close) so toggling
              // the button doesn't close-then-reopen.
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                setBooksOpen((o) => !o);
                setMindsOpen(false);
              }}
            >
              <BooksIcon />
            </button>
            <BookPopover
              open={booksOpen}
              direction="up"
              selected={books}
              onToggle={toggleBook}
              onClose={() => setBooksOpen(false)}
            />
          </PopoverAnchor>
          <PopoverAnchor>
            <button
              type="button"
              className="composer-icon-btn composer-minds-btn"
              title="Invite great minds"
              aria-label="Invite great minds"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={() => {
                setMindsOpen((o) => !o);
                setBooksOpen(false);
              }}
            >
              <MindsIcon />
            </button>
            <MindsPopover
              open={mindsOpen}
              direction="up"
              selected={minds}
              onToggle={toggleMind}
              onClose={() => setMindsOpen(false)}
            />
          </PopoverAnchor>
        </div>
        <button
          type="button"
          className="composer-send-btn"
          title="Send"
          aria-label="Send"
          disabled={busy || !value.trim()}
          onClick={submit}
        >
          <SendIcon />
        </button>
      </div>
    </div>
  );
}
