"use client";

/**
 * Full-page chat list at /chats — faithful to the legacy #page-chats DOM
 * (index.html): title-row (h1 + New Chat button with + icon), a search header
 * (chats-search), the list, and the empty state. Fetches once auth resolves so
 * the bearer token is set before the authed /api/sessions call (hosted build).
 */

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { listSessions, type Session } from "@/lib/chat";

export default function ChatsList() {
  const { ready } = useAuth();
  const [sessions, setSessions] = useState<Session[] | null>(null);
  const [query, setQuery] = useState("");

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    listSessions()
      .then((s) => {
        if (alive) setSessions(s);
      })
      .catch(() => {
        if (alive) setSessions([]);
      });
    return () => {
      alive = false;
    };
  }, [ready]);

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
              <span className="chat-item-title">{s.title}</span>
              {s.publicStatus === "approved" && (
                <span className="history-public-dot" title="Public">
                  {" ●"}
                </span>
              )}
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
