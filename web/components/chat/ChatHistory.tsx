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
import { useAuth } from "@/lib/auth";
import {
  listSessions,
  deleteSession as apiDeleteSession,
  bumpSessions,
  getCachedSessions,
  sessionsCacheFresh,
  SESSIONS_CHANGED,
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
  const { ready, authEnabled, user } = useAuth();
  // Seed from the module cache so a shell remount (every navigation) paints the
  // last-known list immediately instead of flashing empty → fetch → refill.
  const [sessions, setSessions] = useState<Session[]>(() => getCachedSessions() ?? []);
  const pathname = usePathname() || "";
  const router = useRouter();

  // On the hosted build, sessions are per-user — don't issue the authed
  // /api/sessions call until auth has resolved AND a user is signed in. This
  // avoids (a) the token race (request before setAuthToken) and (b) a wasted
  // Supabase read on every anonymous SEO pageview (the sidebar is global).
  // On the open-source build (authEnabled=false) sessions are anonymous, so
  // we still load.
  const canLoad = ready && (!authEnabled || !!user);

  const load = useCallback((force = false) => {
    if (!canLoad) return;
    // Fresh cache → paint it and skip the network round-trip. This is what
    // removes the per-navigation flicker: on a remount the list is already in
    // state (seeded from cache), so we only re-fetch when stale or forced.
    if (!force && sessionsCacheFresh()) {
      const cached = getCachedSessions();
      if (cached) setSessions(cached);
      return;
    }
    listSessions()
      .then(setSessions)
      .catch((e) => {
        // Non-fatal: an empty history is a valid state (and the common one in
        // dev before any chats exist). Never throw into the shell. Keep the
        // last-known list (cache) rather than blanking on a transient failure.
        console.warn("Failed to load sessions:", e);
        if (!getCachedSessions()) setSessions([]);
      });
  }, [canLoad]);

  // Mount: TTL-gated (no fetch when the cache is fresh) → no remount flicker.
  useEffect(() => {
    load();
  }, [load]);

  // Re-fetch when navigating between chats so a freshly created session and
  // updated titles show up without a full reload (force past the TTL).
  useEffect(() => {
    if (canLoad && pathname.startsWith("/chat/")) load(true);
  }, [pathname, load, canLoad]);

  // Live-refresh on any session mutation (create / rename / delete / public flip)
  // so the pill text + public dot update without navigation (M16).
  useEffect(() => {
    const onChanged = () => load(true);
    window.addEventListener(SESSIONS_CHANGED, onChanged);
    return () => window.removeEventListener(SESSIONS_CHANGED, onChanged);
  }, [load]);

  const onDelete = async (e: React.MouseEvent, id: string) => {
    e.preventDefault();
    e.stopPropagation();
    setSessions((prev) => prev.filter((s) => s.id !== id));
    await apiDeleteSession(id);
    bumpSessions(); // keep /chats (and any other list) in sync
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
