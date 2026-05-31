"use client";

/**
 * Dedicated single-mind chat — a 1:1 conversation with ONE great mind.
 *
 * Faithful port of renderMindDetail + sendMindChat (app.js ~6912-7110). This is
 * NOT the multi-mind home composer: the mind is the conversation partner, not an
 * invited participant, so there are NO "X joined the discussion" notices and NO
 * auto-invite. On open we create a session, greet once, then each turn POSTs to
 * /api/minds/{id}/chat with the running history.
 *
 * Layout mirrors index.html #page-mind: a flex `.mind-detail-layout` →
 *   .chat-main (.chat-messages + .chat-input-area > .chat-composer-inline)
 *   aside.chat-sidebar-right > #mind-meta-sidebar (the agent-info card).
 *
 * Pro gating (hosted builds): mind chat is pro-only. Anonymous users (auth on,
 * not signed in) get a sign-in prompt; signed-in non-pro users get the paywall
 * overlay. Open-source (auth off) → everything works (isProUser is always true).
 */

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { useProGate } from "@/components/pro/ProOverlay";
import { post } from "@/lib/api";
import {
  createSession,
  queueSaveMessage,
  chatErrorMessage,
  type Message,
  type Usage,
} from "@/lib/chat";
import type { MindDetail } from "@/lib/seo-mind";
import MessageList from "@/components/chat/MessageList";
import { mindColor, mindInitials } from "@/components/chat/markdown";
import styles from "./MindChat.module.css";

/** Response shape of POST /api/minds/{id}/greet and /chat (mind_chat result). */
interface MindChatResponse {
  response: string;
  usage?: Usage;
}

export default function MindChat({
  mindId,
  mind,
}: {
  mindId: string;
  mind: MindDetail;
}) {
  const router = useRouter();
  const { ready, authEnabled, user } = useAuth();
  const { isProUser, requirePro } = useProGate();

  const [messages, setMessages] = useState<Message[]>([]);
  const [sending, setSending] = useState(false);
  const [input, setInput] = useState("");

  // Session id for best-effort message persistence (mirrors currentSessionId).
  const sessionIdRef = useRef<string | null>(null);
  // Running turn history sent to /chat (port of mindChatHistory).
  const historyRef = useRef<{ role: "user" | "assistant"; content: string }[]>([]);
  // StrictMode-safe greet-once guard (the effect runs twice in dev).
  const greetedRef = useRef(false);
  // Abort any in-flight greet/chat on unmount.
  const abortRef = useRef<AbortController | null>(null);

  const taRef = useRef<HTMLTextAreaElement | null>(null);

  // Anonymous (auth on, not signed in) → sign-in prompt instead of greeting,
  // mirroring the legacy `!currentUser && FEYNMAN_PRO` branch.
  const needsSignIn = authEnabled && !user;
  // Signed-in but not pro (hosted) → paywall. Open-source → isProUser is always
  // true so this is false. Anonymous is handled above by needsSignIn.
  const needsPaywall = !needsSignIn && !isProUser;

  // ── Greet once on open ──────────────────────────────────────────────────
  useEffect(() => {
    // Gate on auth readiness so the bearer token is set before we create the
    // session / greet (hosted). Open-source resolves ready quickly too.
    if (!ready) return;
    // Don't greet for gated users — they see the prompt/paywall instead.
    if (needsSignIn || needsPaywall) return;
    if (greetedRef.current) return;
    greetedRef.current = true;

    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      // Create the session first (best-effort — failure shouldn't block chat).
      try {
        const session = await createSession({
          title: `Chat with ${mind.name}`,
          sessionType: "chat",
          mindId,
        });
        sessionIdRef.current = session.id;
      } catch (e) {
        console.warn("Failed to create mind chat session:", e);
      }

      // Greet (empty body) and render as the mind's first message.
      setSending(true);
      try {
        const greet = await post<MindChatResponse>(
          `/api/minds/${encodeURIComponent(mindId)}/greet`,
          {},
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        if (greet?.response) {
          setMessages([
            { role: "mind", content: greet.response, mindName: mind.name, usage: greet.usage },
          ]);
          historyRef.current.push({ role: "assistant", content: greet.response });
          if (sessionIdRef.current) {
            queueSaveMessage(sessionIdRef.current, "mind", greet.response, {
              mindName: mind.name,
              usage: greet.usage,
            });
          }
        }
      } catch (e) {
        if (!controller.signal.aborted) console.warn("Mind greeting failed:", e);
      } finally {
        if (!controller.signal.aborted) setSending(false);
      }
    })();

    return () => {
      controller.abort();
      if (abortRef.current === controller) abortRef.current = null;
    };
  }, [ready, needsSignIn, needsPaywall, mindId, mind.name]);

  // ── Send a turn ─────────────────────────────────────────────────────────
  const handleSend = useCallback(
    async (raw: string) => {
      const message = raw.trim();
      if (!message || sending) return;

      // Re-check the gate on interaction (matches the legacy guard). If a
      // not-pro user somehow reaches here, bounce to the overlay and bail.
      if (needsSignIn) {
        router.push("/login");
        return;
      }
      if (!requirePro()) return;

      // Append the user message immediately (optimistic).
      setMessages((prev) => [...prev, { role: "user", content: message }]);
      if (sessionIdRef.current) {
        queueSaveMessage(sessionIdRef.current, "user", message);
      }

      const controller = new AbortController();
      abortRef.current = controller;
      setSending(true);

      try {
        const body: Record<string, unknown> = { message };
        if (historyRef.current.length) body.history = historyRef.current;
        const data = await post<MindChatResponse>(
          `/api/minds/${encodeURIComponent(mindId)}/chat`,
          body,
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;

        setMessages((prev) => [
          ...prev,
          { role: "mind", content: data.response, mindName: mind.name, usage: data.usage },
        ]);
        // Maintain history with this completed turn (user then assistant).
        historyRef.current.push({ role: "user", content: message });
        historyRef.current.push({ role: "assistant", content: data.response });

        if (sessionIdRef.current) {
          queueSaveMessage(sessionIdRef.current, "mind", data.response, {
            mindName: mind.name,
            usage: data.usage,
          });
        }
      } catch (err) {
        if (controller.signal.aborted) return;
        setMessages((prev) => [
          ...prev,
          { role: "error-notice", content: chatErrorMessage(err) },
        ]);
      } finally {
        if (!controller.signal.aborted) setSending(false);
        if (abortRef.current === controller) abortRef.current = null;
      }
    },
    [sending, needsSignIn, requirePro, router, mindId, mind.name],
  );

  // Abort any in-flight request on unmount (full cleanup).
  useEffect(() => () => abortRef.current?.abort(), []);

  const grow = () => {
    const ta = taRef.current;
    if (!ta) return;
    ta.style.height = "auto";
    ta.style.height = Math.min(ta.scrollHeight, 200) + "px";
  };

  const submit = () => {
    const msg = input.trim();
    if (!msg || sending) return;
    setInput("");
    if (taRef.current) taRef.current.style.height = "auto";
    handleSend(msg);
  };

  return (
    <div className={`mind-page ${styles.page}`}>
      <div className="mind-detail-layout">
        <main className="chat-main">
          <div className="chat-messages">
            {needsSignIn ? (
              <div className={styles.fallback}>
                <p>Sign in to chat with {mind.name}</p>
                <Link href="/login" className={styles.fallbackLink}>
                  Sign in →
                </Link>
              </div>
            ) : needsPaywall ? (
              <div className={styles.fallback}>
                <p>Chatting one-on-one with {mind.name} is a Pro feature.</p>
                <button
                  type="button"
                  className={styles.fallbackLink}
                  style={{ background: "none", border: "none", cursor: "pointer" }}
                  onClick={() => requirePro()}
                >
                  Upgrade to Pro →
                </button>
              </div>
            ) : (
              <>
                <MessageList messages={messages} />
                {sending && (
                  <div className="chat-message assistant">
                    <span className="loading-dot">Thinking...</span>
                  </div>
                )}
              </>
            )}
          </div>

          {!needsSignIn && !needsPaywall && (
            <div className="chat-input-area">
              <div className="chat-composer chat-composer-inline">
                <textarea
                  ref={taRef}
                  className="composer-input"
                  rows={1}
                  placeholder={`Ask ${mind.name} a question...`}
                  value={input}
                  disabled={sending}
                  onChange={(e) => {
                    setInput(e.target.value);
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
                  <div className="composer-left" />
                  <button
                    type="button"
                    className="composer-send-btn"
                    title="Send"
                    aria-label="Send"
                    disabled={sending || !input.trim()}
                    onClick={submit}
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <line x1="12" y1="19" x2="12" y2="5" />
                      <polyline points="5 12 12 5 19 12" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          )}
        </main>

        <aside className="chat-sidebar-right">
          <MindMetaSidebar mind={mind} />
        </aside>
      </div>
    </div>
  );
}

// ── Agent-info sidebar (#mind-meta-sidebar) ─────────────────────────────────

/**
 * Port of the metaSidebar render block in renderMindDetail. Avatar circle with
 * initials on a deterministic color, name, era, "View full profile →", bio,
 * domain tags, works list, "N discussions", and a Share popup (Post on X / Copy
 * link). The avatar + profile link route to the SEO profile at /mind/{id}.
 */
function MindMetaSidebar({ mind }: { mind: MindDetail }) {
  const color = mindColor(mind.name);
  const initials = mindInitials(mind.name);
  const domains = (mind.domain || "")
    .split(",")
    .map((d) => d.trim())
    .filter(Boolean);
  const works = mind.works || [];
  // chat_count isn't always in the minds JSON; read it defensively (MindDetail
  // has an index signature). Falls back to 0 like the legacy `|| 0`.
  const chatCount = Number((mind as { chat_count?: number }).chat_count || 0);
  const profileHref = `/mind/${encodeURIComponent(mind.id)}`;

  const [shareOpen, setShareOpen] = useState(false);
  const [copied, setCopied] = useState(false);

  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/mind/${encodeURIComponent(mind.id)}`
      : profileHref;

  // Close the share popup on any outside click (port of the document listener).
  useEffect(() => {
    if (!shareOpen) return;
    const onDocClick = () => setShareOpen(false);
    document.addEventListener("click", onDocClick);
    return () => document.removeEventListener("click", onDocClick);
  }, [shareOpen]);

  const postOnX = (e: React.MouseEvent) => {
    e.stopPropagation();
    const text = encodeURIComponent(`Chat with ${mind.name} on feynman.wiki`);
    const url = encodeURIComponent(shareUrl);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank");
    setShareOpen(false);
  };

  const copyLink = (e: React.MouseEvent) => {
    e.stopPropagation();
    navigator.clipboard?.writeText(shareUrl).catch(() => {});
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1600);
    setShareOpen(false);
  };

  return (
    <div id="mind-meta-sidebar">
      <h3 className="sidebar-title">ABOUT</h3>
      <Link
        href={profileHref}
        className={`mind-avatar mind-avatar-clickable ${styles.metaAvatar}`}
        style={{ background: color }}
        title={`View ${mind.name}'s profile`}
      >
        {initials}
      </Link>
      <p className={styles.metaName}>{mind.name}</p>
      {mind.era ? <p className={styles.metaEra}>{mind.era}</p> : null}
      <p className={styles.metaProfileRow}>
        <Link href={profileHref} className="mind-view-profile-link">
          View full profile →
        </Link>
      </p>
      {mind.bio_summary ? <p className={styles.metaBio}>{mind.bio_summary}</p> : null}
      {domains.length ? (
        <div className={styles.metaTags}>
          {domains.map((d) => (
            <span className="mind-domain-tag" key={d}>
              {d}
            </span>
          ))}
        </div>
      ) : null}
      {works.length ? (
        <>
          <h3 className="sidebar-title" style={{ marginTop: 16 }}>
            WORKS
          </h3>
          <ul className={styles.metaWorks}>
            {works.map((w, i) => (
              <li key={i}>{w}</li>
            ))}
          </ul>
        </>
      ) : null}
      <p className={styles.metaCount}>{chatCount} discussions</p>

      <div className={`mind-share-wrap${shareOpen ? " open" : ""}`}>
        <button
          type="button"
          className="mind-share-btn mind-share-trigger"
          onClick={(e) => {
            e.stopPropagation();
            setShareOpen((o) => !o);
          }}
        >
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
          {copied ? "Copied" : "Share"}
        </button>
        <div className="mind-share-popup">
          <button type="button" className="mind-share-opt mind-share-x" onClick={postOnX}>
            <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
              <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
            </svg>
            Post on X
          </button>
          <button type="button" className="mind-share-opt mind-share-copy" onClick={copyLink}>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
              <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
            </svg>
            Copy link
          </button>
        </div>
      </div>
    </div>
  );
}
