"use client";

/**
 * Full-page chat list at /chats — faithful to the legacy #page-chats DOM
 * (index.html): title-row (h1 + New Chat button with + icon), a search header
 * (chats-search), the list, and the empty state. Fetches once auth resolves so
 * the bearer token is set before the authed /api/sessions call (hosted build).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import {
  listSessions,
  getCachedSessions,
  sessionsCacheFresh,
  SESSIONS_CHANGED,
  type Session,
} from "@/lib/chat";

export default function ChatsList() {
  const { ready, authEnabled, user } = useAuth();
  const router = useRouter();
  // Seed from the sessions cache so re-visiting /chats paints the last-known list
  // immediately (the sidebar's ChatHistory already does this) instead of
  // re-fetching the cold origin on every visit.
  const [sessions, setSessions] = useState<Session[] | null>(() => getCachedSessions());
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!ready) return;
    // Anonymous hosted visitors have no chats page — bounce to login
    // (port of the legacy navigate guard, app.js 1684).
    if (authEnabled && !user) {
      router.replace("/login");
      return;
    }
    let alive = true;
    const load = (force = false) => {
      // Fresh cache → paint it and skip the network round-trip (this removes the
      // multi-second reload on every visit). bumpSessions() invalidates the cache
      // on any mutation, so this stays correct.
      if (!force && sessionsCacheFresh()) {
        const cached = getCachedSessions();
        if (cached && alive) setSessions(cached);
        return;
      }
      listSessions()
        .then((s) => {
          if (alive) setSessions(s);
        })
        .catch(() => {
          if (alive && !getCachedSessions()) setSessions([]);
        });
    };
    load();
    // Live-refresh on session mutations (M16) — force past the TTL.
    const onChanged = () => load(true);
    window.addEventListener(SESSIONS_CHANGED, onChanged);
    return () => {
      alive = false;
      window.removeEventListener(SESSIONS_CHANGED, onChanged);
    };
  }, [ready, authEnabled, user, router]);

  const chats = useMemo(() => {
    const base = (sessions || []).filter(
      (s) => s.sessionType === "chat" || s.sessionType === "write_book",
    );
    const q = query.trim().toLowerCase();
    return q ? base.filter((s) => (s.title || "").toLowerCase().includes(q)) : base;
  }, [sessions, query]);

  return (
    <div className="chats-content">
      <div className="chats-title-row">
        <h1 className="page-title">Chats</h1>
        <Link className="chats-new-btn" href="/" title="New Chat">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="12" y1="5" x2="12" y2="19" />
            <line x1="5" y1="12" x2="19" y2="12" />
          </svg>
          New Chat
        </Link>
      </div>

      <div className="chats-header">
        <input
          type="text"
          className="chats-search"
          placeholder="Search chats..."
          autoComplete="off"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
      </div>

      {sessions === null ? (
        <div className="chats-empty">Loading…</div>
      ) : chats.length === 0 ? (
        <div className="chats-empty">No conversations yet</div>
      ) : (
        <div className="chats-list">
          {chats.map((s) => (
            <Link key={s.id} href={`/chat/${s.id}`} className="chats-list-item">
              <ChatTypeIcon session={s} />
              <div className="chats-item-body">
                <div className="chat-item-title">
                  {s.title}
                  {s.publicStatus === "approved" && (
                    <span className="history-public-dot" title="Public">
                      {" ●"}
                    </span>
                  )}
                </div>
                {s.updatedAt ? (
                  <div className="chats-item-time">Last message {timeAgo(s.updatedAt)}</div>
                ) : null}
              </div>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}

/** Relative "time ago" label (port of timeAgo in app.js 5596). */
function timeAgo(ts: number): string {
  if (!ts) return "";
  const diff = Date.now() - ts;
  if (diff < 0 || diff < 30000) return "Just now";
  const m = Math.floor(diff / 60000);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d}d ago`;
  return new Date(ts).toLocaleDateString();
}

/** Per-row type icon: write-book pencil / mind network / chat bubble
 *  (port of the chatIcon/mindIcon/bookIcon switch in _renderChatsList). */
function ChatTypeIcon({ session }: { session: Session }) {
  if (session.sessionType === "write_book") {
    return (
      <svg className="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="M12 20h9" />
        <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
      </svg>
    );
  }
  if (session.mindId) {
    return (
      <svg className="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <circle cx="6" cy="6" r="3" />
        <circle cx="18" cy="6" r="3" />
        <circle cx="6" cy="18" r="3" />
        <circle cx="18" cy="18" r="3" />
        <line x1="9" y1="6" x2="15" y2="6" />
        <line x1="6" y1="9" x2="6" y2="15" />
        <line x1="18" y1="9" x2="18" y2="15" />
        <line x1="9" y1="18" x2="15" y2="18" />
      </svg>
    );
  }
  return (
    <svg className="chat-item-icon" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  );
}
