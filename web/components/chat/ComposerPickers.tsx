"use client";

/**
 * Shared composer affordances: selected chips + the book-select popover and
 * the minds-invite popover. Used by both HomeComposer and the in-chat Composer.
 *
 * Ported from renderSelectedChips, renderPopoverBookList, renderPopoverMindList
 * in app.js. Reuses the legacy classes (.selected-chips, .book-chip,
 * .mind-chip, .composer-popover, .popover-search, .popover-book-item,
 * .popover-mind-item …). Pro-gating is intentionally omitted here — auth lands
 * in a later phase; until then minds are freely selectable.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow, type Book } from "@/lib/books";
import { listMinds, type Mind } from "@/lib/api";
import { mindColor, mindInitials } from "./markdown";
import styles from "./ComposerPickers.module.css";

/** Positioning context for an icon button + its popover. */
export function PopoverAnchor({ children }: { children: React.ReactNode }) {
  return <div className={styles.anchor}>{children}</div>;
}

export interface SelectedBook {
  id: string;
  agentId: string;
  title: string;
  author: string;
}

export interface SelectedMind {
  id: string;
  name: string;
  domain?: string;
  era?: string;
}

export function bookToContext(b: SelectedBook) {
  return { title: b.title, author: b.author || "" };
}

// ── Selected chips (books + minds) ─────────────────────────────────────

export function SelectedChips({
  books,
  minds,
  onRemoveBook,
  onRemoveMind,
}: {
  books: Map<string, SelectedBook>;
  minds: Map<string, SelectedMind>;
  onRemoveBook: (id: string) => void;
  onRemoveMind: (id: string) => void;
}) {
  if (!books.size && !minds.size) return null;
  return (
    <div className="selected-chips">
      {[...books.entries()].map(([id, b]) => (
        <div className="book-chip" key={id}>
          <span>{b.title}</span>
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove ${b.title}`}
            onClick={() => onRemoveBook(id)}
          >
            ×
          </button>
        </div>
      ))}
      {[...minds.entries()].map(([id, m]) => (
        <div className="mind-chip" key={id}>
          <span className="mind-chip-avatar" style={{ background: mindColor(m.name) }}>
            {mindInitials(m.name)}
          </span>
          <span>{m.name}</span>
          <button
            type="button"
            className="chip-remove"
            aria-label={`Remove ${m.name}`}
            onClick={() => onRemoveMind(id)}
          >
            ×
          </button>
        </div>
      ))}
    </div>
  );
}

// ── Book popover ───────────────────────────────────────────────────────

type LoadState = "idle" | "loading" | "ready" | "error";

export function BookPopover({
  open,
  direction = "up",
  selected,
  onToggle,
  onClose,
}: {
  open: boolean;
  direction?: "up" | "down";
  selected: Map<string, SelectedBook>;
  onToggle: (book: SelectedBook) => void;
  onClose: () => void;
}) {
  const [books, setBooks] = useState<Book[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || state !== "idle") return;
    let alive = true;
    setState("loading");
    get<AgentRow[]>("/api/agents")
      .then((rows) => {
        if (!alive) return;
        setBooks(mapAgentsToBooks(rows || []));
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [open, state]);

  // Close on outside click / Escape.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    if (!query.trim()) return books;
    const q = query.toLowerCase();
    return books.filter(
      (b) =>
        b.title.toLowerCase().includes(q) ||
        (b.author || "").toLowerCase().includes(q) ||
        (b.category || "").toLowerCase().includes(q),
    );
  }, [books, query]);

  if (!open) return null;
  const emptyText =
    state === "loading"
      ? "Loading books..."
      : state === "error"
        ? "Could not load books. Try again."
        : query
          ? `No books match "${query}"`
          : "No books in library";

  return (
    <div
      ref={ref}
      className={`composer-popover${direction === "down" ? " composer-popover-down" : ""}`}
      // Stop the click that toggled it open from immediately closing it.
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        className="popover-search"
        placeholder="Search books..."
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="popover-book-list">
        {filtered.length === 0 ? (
          <div className="popover-empty">{emptyText}</div>
        ) : (
          filtered.map((b) => {
            const sel = selected.has(b.id);
            return (
              <div
                key={b.id}
                className={`popover-book-item${sel ? " selected" : ""}`}
                onClick={() =>
                  onToggle({
                    id: b.id,
                    agentId: b.agentId,
                    title: b.title,
                    author: b.author,
                  })
                }
              >
                <div className="popover-book-check">{sel ? "✓" : ""}</div>
                <span>{b.title}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Minds popover ──────────────────────────────────────────────────────

export function MindsPopover({
  open,
  direction = "up",
  selected,
  onToggle,
  onClose,
}: {
  open: boolean;
  direction?: "up" | "down";
  selected: Map<string, SelectedMind>;
  onToggle: (mind: SelectedMind) => void;
  onClose: () => void;
}) {
  const [minds, setMinds] = useState<Mind[]>([]);
  const [state, setState] = useState<LoadState>("idle");
  const [query, setQuery] = useState("");
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open || state !== "idle") return;
    let alive = true;
    setState("loading");
    listMinds()
      .then((rows) => {
        if (!alive) return;
        setMinds(rows || []);
        setState("ready");
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [open, state]);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", onDoc);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      document.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  const filtered = useMemo(() => {
    const sorted = [...minds].sort((a, b) => a.name.localeCompare(b.name));
    if (!query.trim()) return sorted;
    const q = query.toLowerCase();
    return sorted.filter(
      (m) =>
        (m.name || "").toLowerCase().includes(q) ||
        (m.domain || "").toLowerCase().includes(q) ||
        (m.era || "").toLowerCase().includes(q),
    );
  }, [minds, query]);

  if (!open) return null;
  const emptyText =
    state === "loading"
      ? "Loading minds..."
      : state === "error"
        ? "Could not load minds. Try again."
        : query
          ? `No minds match "${query}"`
          : "No minds yet";

  return (
    <div
      ref={ref}
      className={`composer-popover${direction === "down" ? " composer-popover-down" : ""}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <input
        className="popover-search"
        placeholder="Search minds..."
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="popover-mind-list">
        {filtered.length === 0 ? (
          <div className="popover-empty">{emptyText}</div>
        ) : (
          filtered.map((m) => {
            const sel = selected.has(m.id);
            return (
              <div
                key={m.id}
                className={`popover-mind-item${sel ? " selected" : ""}`}
                onClick={() =>
                  onToggle({ id: m.id, name: m.name, domain: m.domain, era: m.era })
                }
              >
                <div className="popover-mind-check">{sel ? "✓" : ""}</div>
                <div className="popover-mind-avatar" style={{ background: mindColor(m.name) }}>
                  {mindInitials(m.name)}
                </div>
                <span>{m.name}</span>
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}

// ── Icons reused by both composers ─────────────────────────────────────

export function BooksIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19" />
      <line x1="5" y1="12" x2="19" y2="12" />
    </svg>
  );
}

export function MindsIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="6" cy="6" r="2.5" />
      <circle cx="18" cy="8" r="2.5" />
      <circle cx="8" cy="18" r="2.5" />
      <circle cx="18" cy="18" r="2" />
      <line x1="8.2" y1="7.2" x2="15.8" y2="7.2" />
      <line x1="7" y1="8.3" x2="7.5" y2="15.5" />
      <line x1="10.2" y1="17.2" x2="16" y2="17.8" />
      <line x1="16.5" y1="10.3" x2="17.5" y2="16" />
    </svg>
  );
}

export function SendIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="19" x2="12" y2="5" />
      <polyline points="5 12 12 5 19 12" />
    </svg>
  );
}
