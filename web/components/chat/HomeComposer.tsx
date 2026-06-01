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
import { get, getAgent, getMind, type Agent, type Mind } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow } from "@/lib/books";
import { createSession, bumpSessions } from "@/lib/chat";
import { startWriteBook } from "@/lib/writeBook";
import { useAuth } from "@/lib/auth";
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
import { useMentionAutocomplete } from "./useMentionAutocomplete";

const PENDING_KEY = "feynman:pendingChat";

// Default starter prompts (legacy generateStarters fallback when no books are
// loaded — app.js 1988-1995). When books are selected the legacy regenerates
// these from titles; the static fallback set is faithful for the empty state.
const DEFAULT_STARTERS = [
  "Learn quantitative trading from scratch",
  "Teach me the fundamentals of philosophy",
  "Best books on cognitive psychology?",
  "Help me understand machine learning",
];

/** Pixel-art book logo — verbatim from index.html (greeting-logo). */
function BookLogo({ size = 42 }: { size?: number }) {
  return (
    <svg className="greeting-logo" width={size} height={size} viewBox="0 0 56 56" xmlns="http://www.w3.org/2000/svg" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="24" y="0" width="8" height="4" fill="#FDCB6E" />
      <rect x="26" y="4" width="4" height="4" fill="#B8B8B8" />
      <rect x="8" y="8" width="40" height="28" fill="#DA7756" />
      <rect x="12" y="12" width="32" height="20" fill="#FFF1E0" />
      <rect x="16" y="16" width="8" height="8" fill="#2D3436" />
      <rect x="32" y="16" width="8" height="8" fill="#2D3436" />
      <rect x="18" y="18" width="4" height="4" fill="#fff" />
      <rect x="34" y="18" width="4" height="4" fill="#fff" />
      <rect x="22" y="28" width="12" height="2" fill="#C45E3E" />
      <rect x="18" y="38" width="4" height="8" fill="#B8B8B8" />
      <rect x="34" y="38" width="4" height="8" fill="#B8B8B8" />
    </svg>
  );
}

/** Feynman-diagram logo — verbatim from index.html (greeting-feynman-logo). */
function FeynmanLogo({ size = 42 }: { size?: number }) {
  return (
    <svg className="greeting-feynman-logo" width={size} height={size} viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="30" r="3.5" fill="currentColor" />
      <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** Write-book (pencil) icon — verbatim from index.html (home-write-book-btn). */
function WriteBookIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export default function HomeComposer() {
  const router = useRouter();
  const params = useSearchParams();
  const { authEnabled, user } = useAuth();
  const { requirePro } = useProGate();

  const [value, setValue] = useState("");
  const [books, setBooks] = useState<Map<string, SelectedBook>>(new Map());
  const [minds, setMinds] = useState<Map<string, SelectedMind>>(new Map());
  const [booksOpen, setBooksOpen] = useState(false);
  const [mindsOpen, setMindsOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Time-based greeting (legacy app.js 665-667: "Good morning/afternoon/evening
  // [, FirstName]"). Computed client-side after mount to avoid SSR/hydration
  // drift (the hour + the localStorage userName are client-only).
  const [greeting, setGreeting] = useState("");
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const prefilled = useRef(false);
  // @-mention autocomplete: the chip-selected minds are mentionable on home.
  const mention = useMentionAutocomplete({
    taRef,
    setValue,
    minds: [...minds.values()].map((m) => ({ name: m.name, era: m.era, domain: m.domain })),
  });

  useEffect(() => {
    const h = new Date().getHours();
    let g = h < 12 ? "Good morning" : h < 18 ? "Good afternoon" : "Good evening";
    let name = "";
    try {
      name = localStorage.getItem("userName") || "";
    } catch {
      /* ignore */
    }
    if (name) g += ", " + name.split(/\s+/)[0];
    setGreeting(g);
  }, []);

  // Starters mirror the book context: with a single selected book they become
  // title-specific (legacy generateStarters); with none, the default set.
  const starters = (() => {
    const sel = [...books.values()];
    const short = (t: string, max = 30) =>
      t.length <= max ? t : t.slice(0, max - 1).trimEnd() + "…";
    if (sel.length === 1) {
      const t = short(sel[0].title);
      return [
        `What are the key ideas in "${t}"?`,
        `Summarize the core argument of "${t}"`,
        `What makes "${t}" unique?`,
        `Quiz me on "${t}"`,
      ];
    }
    if (sel.length >= 2) {
      const a = short(sel[0].title);
      const b = short(sel[1].title);
      return [
        `Compare "${a}" and "${b}"`,
        `What do "${a}" and "${b}" have in common?`,
        `Key ideas in "${a}"?`,
        sel.length > 2 ? `What do these ${sel.length} books cover together?` : `Key ideas in "${b}"?`,
      ];
    }
    return DEFAULT_STARTERS;
  })();

  const pickStarter = (q: string) => {
    setValue(q);
    taRef.current?.focus();
  };

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
    const mindId = params.get("mind");

    if (q || bookId || mindId) {
      if (q) setValue(q);
      if (bookId) preselectBook(bookId);
      if (mindId) preselectMind(mindId);
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

  // Preselect a mind chip from a /?mind={id} link (the SEO mind page's Chat).
  const preselectMind = (mindId: string) => {
    getMind(mindId)
      .then((m: Mind) => {
        if (m?.id) {
          setMinds(new Map([[m.id, { id: m.id, name: m.name }]]));
        }
      })
      .catch(() => {
        /* mind preselect is best-effort */
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
      bumpSessions(); // surface the new row in the sidebar immediately
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
    <div className="home-center" id="home-center-main">
      <div className="greeting-row">
        <div
          className="greeting-logo-wrap"
          onClick={(e) => {
            // Logo easter-egg — ports app.js:7714-7719: bounce, then swap the
            // pixel-book ↔ Feynman-diagram logo mid-bounce.
            const wrap = e.currentTarget;
            wrap.classList.add("bounce");
            window.setTimeout(() => wrap.classList.toggle("swap"), 200);
            wrap.addEventListener("animationend", () => wrap.classList.remove("bounce"), { once: true });
          }}
        >
          <BookLogo />
          <FeynmanLogo />
        </div>
        <h1 className="greeting">{greeting}</h1>
      </div>

      <div className="chat-composer">
      {mention.dropdown}
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
          mention.refresh();
        }}
        onBlur={mention.onBlur}
        onKeyDown={(e) => {
          // Mention dropdown intercepts Arrow/Enter/Tab/Escape before send.
          if (mention.onKeyDown(e)) return;
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
              direction="down"
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
              direction="down"
              selected={minds}
              onToggle={toggleMind}
              onClose={() => setMindsOpen(false)}
            />
          </PopoverAnchor>
          <button
            type="button"
            className="composer-icon-btn"
            title="Write the book you need, on-demand"
            aria-label="Write the book you need"
            onClick={() => startWriteBook(router, { authEnabled, user, requirePro })}
          >
            <WriteBookIcon />
          </button>
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

      <div className="home-starters" id="home-starters">
        {starters.map((q) => (
          <button key={q} type="button" className="starter-pill" onClick={() => pickStarter(q)}>
            {q}
          </button>
        ))}
      </div>
    </div>
  );
}
