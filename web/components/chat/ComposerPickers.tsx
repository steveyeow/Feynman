"use client";

/**
 * Shared composer affordances: selected chips + the book-select popover and
 * the minds-invite popover. Used by both HomeComposer and the in-chat Composer.
 *
 * Ported from renderSelectedChips, renderPopoverBookList, renderPopoverMindList
 * in app.js. Reuses the legacy classes (.selected-chips, .book-chip,
 * .mind-chip, .composer-popover, .popover-search, .popover-book-item,
 * .popover-mind-item …).
 *
 * Pro-gating (hosted build): selecting a mind to invite is a pro feature
 * (legacy app.js 4804). When auth is enabled and the user isn't pro, mind items
 * render with a `.locked` class and a click opens the upgrade overlay instead
 * of selecting. On the open-source build (auth off) every mind is freely
 * selectable — isProUser is always true there.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { get } from "@/lib/api";
import { mapAgentsToBooks, type AgentRow, type Book } from "@/lib/books";
import { listMinds, type Mind } from "@/lib/api";
import { generateMind } from "@/lib/minds-chat";
import { useProGate } from "@/components/pro/ProOverlay";
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
  // Guard so the fetch runs once per open. CRITICAL: deps must be [open] only —
  // putting `state` in deps made setState("loading") re-run the effect, whose
  // cleanup flipped the in-flight fetch's `alive=false`, so the .then was skipped
  // and the popover hung on "Loading…" forever.
  const loadedRef = useRef(false);

  useEffect(() => {
    if (!open || loadedRef.current) return;
    let alive = true;
    setState("loading");
    get<AgentRow[]>("/api/agents")
      .then((rows) => {
        if (!alive) return;
        setBooks(mapAgentsToBooks(rows || []));
        setState("ready");
        loadedRef.current = true;
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [open]);

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
  const [inviting, setInviting] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);
  // See BookPopover: fetch once per open, deps [open] only (state in deps caused
  // the in-flight fetch to be cancelled by the cleanup → stuck on "Loading…").
  const loadedRef = useRef(false);
  // Inviting minds is a pro feature on the hosted build (legacy app.js 4804).
  const { isProUser, showProOverlay } = useProGate();

  // Mint a brand-new mind from the search query and select it (port of
  // _inviteComposerMind → /api/minds/generate {name, link_works:false}).
  async function inviteToNetwork() {
    const name = query.trim();
    if (!name || inviting) return;
    setInviting(true);
    try {
      const m = await generateMind({ name });
      if (m) {
        setMinds((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, { id: m.id, name: m.name }],
        );
        onToggle({ id: m.id, name: m.name });
        setQuery("");
        onClose();
      }
    } catch {
      // Best-effort — leave the popover open so the user can retry.
    } finally {
      setInviting(false);
    }
  }

  useEffect(() => {
    if (!open || loadedRef.current) return;
    let alive = true;
    setState("loading");
    listMinds()
      .then((rows) => {
        if (!alive) return;
        setMinds(rows || []);
        setState("ready");
        loadedRef.current = true;
      })
      .catch(() => {
        if (alive) setState("error");
      });
    return () => {
      alive = false;
    };
  }, [open]);

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

  // Empty-state branching (port of renderPopoverMindList's !filtered.length):
  //   • non-pro  → "Upgrade to Pro to invite minds" (click → overlay)
  //   • pro + a query → an "Invite '<query>' to the network" action button
  //   • pro + no query (or loading/error) → the default empty text
  const noMatch = filtered.length === 0;
  const showInvite = noMatch && isProUser && !!query.trim() && state === "ready";
  const showUpgradeHint = noMatch && !isProUser && state === "ready";

  return (
    <div
      ref={ref}
      className={`composer-popover${direction === "down" ? " composer-popover-down" : ""}`}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {/* Pro badge row — only shown to non-pro users (legacy index.html:247). */}
      {!isProUser && (
        <div className="popover-pro-row">
          <button
            type="button"
            className="popover-pro-badge"
            onClick={() => {
              onClose();
              showProOverlay();
            }}
          >
            <span className="popover-pro-label">Pro</span> Upgrade
          </button>
        </div>
      )}
      {/* Hint line (legacy index.html:248). */}
      <div className="popover-hint">
        Invite minds to join the discussion. More relevant minds will also join
        automatically.
      </div>
      <input
        className="popover-search"
        placeholder="Search minds..."
        value={query}
        autoFocus
        onChange={(e) => setQuery(e.target.value)}
      />
      <div className="popover-mind-list">
        {noMatch ? (
          showInvite ? (
            <button
              type="button"
              className="popover-action popover-invite-mind-btn"
              onClick={(e) => {
                e.stopPropagation();
                inviteToNetwork();
              }}
              disabled={inviting}
            >
              {inviting ? (
                <>
                  <span className="popover-invite-spinner" /> Inviting &ldquo;
                  {query.trim()}&rdquo;...
                </>
              ) : (
                <>
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3" />
                    <circle cx="4" cy="6" r="2" />
                    <circle cx="20" cy="6" r="2" />
                    <circle cx="4" cy="18" r="2" />
                    <circle cx="20" cy="18" r="2" />
                    <line x1="9.5" y1="10" x2="5.5" y2="7.5" />
                    <line x1="14.5" y1="10" x2="18.5" y2="7.5" />
                    <line x1="9.5" y1="14" x2="5.5" y2="16.5" />
                    <line x1="14.5" y1="14" x2="18.5" y2="16.5" />
                  </svg>
                  Invite &ldquo;{query.trim()}&rdquo; to the network
                </>
              )}
            </button>
          ) : showUpgradeHint ? (
            <button
              type="button"
              className="popover-empty"
              onClick={() => {
                onClose();
                showProOverlay();
              }}
              style={{ cursor: "pointer", background: "none", border: "none", width: "100%", textAlign: "left" }}
            >
              Upgrade to Pro to invite minds
            </button>
          ) : (
            <div className="popover-empty">{emptyText}</div>
          )
        ) : (
          filtered.map((m) => {
            const sel = selected.has(m.id);
            return (
              <div
                key={m.id}
                className={`popover-mind-item${sel ? " selected" : ""}${!isProUser ? " locked" : ""}`}
                onClick={() => {
                  // Hosted build: non-pro users get the upgrade overlay instead
                  // of selecting (legacy: closeAllPopovers(); showProOverlay()).
                  if (!isProUser) {
                    onClose();
                    showProOverlay();
                    return;
                  }
                  onToggle({ id: m.id, name: m.name, domain: m.domain, era: m.era });
                }}
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
