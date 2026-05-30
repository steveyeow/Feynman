"use client";

/**
 * Chat history list for the left sidebar. GET /api/sessions → links to
 * /chat/{id}. Port of renderChatHistory in app.js (the public dot + delete
 * affordance). The active row is derived from the real pathname.
 *
 * NOTE (integration): the orchestrator wires this into Sidebar.tsx, replacing
 * the empty `<div id="chat-history-list" />`. It owns no layout of its own
 * beyond the legacy .sidebar-history container contents.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  listSessions,
  deleteSession as apiDeleteSession,
  type Session,
} from "@/lib/chat";

function WriteBookIcon() {
  return (
    <svg className="history-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 0 1 3 3L7 19l-4 1 1-4L16.5 3.5z" />
    </svg>
  );
}

export default function ChatHistory() {
  const [sessions, setSessions] = useState<Session[]>([]);
  const pathname = usePathname() || "";
  const router = useRouter();

  const load = useCallback(() => {
    listSessions()
      .then(setSessions)
      .catch((e) => {
        // Non-fatal: an empty history is a valid state (and the common one in
        // dev before any chats exist). Never throw into the shell.
        console.warn("Failed to load sessions:", e);
        setSessions([]);
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Re-fetch when navigating between chats so a freshly created session and
  // updated titles show up without a full reload.
  useEffect(() => {
    if (pathname.startsWith("/chat/")) load();
  }, [pathname, load]);

  const onDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSessions((prev) => prev.filter((s) => s.id !== id));
    await apiDeleteSession(id);
    // If we deleted the open chat, fall back home.
    if (pathname === `/chat/${id}`) router.push("/");
  };

  if (!sessions.length) return null;

  return (
    <>
      {sessions
        // Book/mind sessions deep-link elsewhere in the legacy; here we list
        // chat sessions (the surface this migration owns).
        .filter((s) => s.sessionType === "chat" || s.sessionType === "write_book")
        .map((s) => {
          const active = pathname === `/chat/${s.id}`;
          const isWriteBook = s.sessionType === "write_book";
          const isPublic = s.publicStatus === "approved";
          return (
            <div className={`history-item-wrap${active ? " active" : ""}`} key={s.id}>
              <Link href={`/chat/${s.id}`} className="history-item">
                {isWriteBook && <WriteBookIcon />}
                {s.title}
                {isPublic && (
                  <span className="history-public-dot" title="Public">
                    {" ●"}
                  </span>
                )}
              </Link>
              <button
                className="history-delete"
                title="Delete"
                onClick={(e) => onDelete(e, s.id)}
              >
                ×
              </button>
            </div>
          );
        })}
    </>
  );
}
