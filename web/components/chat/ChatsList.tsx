"use client";

/**
 * Full-page chat list at /chats (the legacy #/chats surface). Mirrors the
 * sidebar ChatHistory but as a primary page with the standard page-title
 * chrome + empty state. Fetches once auth has resolved (so the bearer token
 * is set on the hosted build before the authed /api/sessions call fires).
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { listSessions, type Session } from "@/lib/chat";

export default function ChatsList() {
  const { ready } = useAuth();
  const [sessions, setSessions] = useState<Session[] | null>(null);

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

  const chats = (sessions || []).filter(
    (s) => s.sessionType === "chat" || s.sessionType === "write_book",
  );

  return (
    <div className="chats-content">
      <div className="chats-title-row">
        <h1 className="page-title">Chats</h1>
        <Link className="chats-new-btn" href="/">
          New Chat
        </Link>
      </div>

      {sessions === null ? (
        <div className="chats-empty">Loading…</div>
      ) : chats.length === 0 ? (
        <div className="chats-empty">No conversations yet</div>
      ) : (
        <div className="chats-list">
          {chats.map((s) => (
            <Link key={s.id} href={`/chat/${s.id}`} className="chats-list-item">
              <span className="chats-list-title">{s.title}</span>
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
