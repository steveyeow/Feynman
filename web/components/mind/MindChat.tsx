"use client";

/**
 * Dedicated mind chat surface (/mind/[id]/chat). Faithful to production's
 * renderMindDetail + sendMindChat: an INVITE-CAPABLE chat where the mind is
 * pre-seeded as a participant (so it answers in phase 1), with the full composer
 * (book picker + "invite great minds" + @-mention autocomplete) and the
 * auto-join orchestration — all delegated to ChatView so this stays a thin
 * wrapper over one tested implementation. The right column is the mind's
 * agent-info card. Greets on open via POST /api/minds/{id}/greet (the mind
 * proactively opens the conversation), seeded as the first message — matches
 * production's renderMindDetail.
 *
 * Pro gating (hosted builds): mind chat is pro-only. Anonymous users (auth on,
 * not signed in) get a sign-in prompt; signed-in non-pro users get the paywall.
 * Open-source (auth off) → everything works (isProUser is always true).
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import { track } from "@/lib/analytics";
import { useProGate } from "@/components/pro/ProOverlay";
import { createSession, bumpSessions, queueSaveMessage } from "@/lib/chat";
import { post } from "@/lib/api";
import type { MindDetail } from "@/lib/seo-mind";
import ChatView from "@/components/chat/ChatView";
import type { SelectedMind } from "@/components/chat/ComposerPickers";
import { mindColor, mindInitials } from "@/components/chat/markdown";
import styles from "./MindChat.module.css";

export default function MindChat({
  mindId,
  mind,
}: {
  mindId: string;
  mind: MindDetail;
}) {
  const { ready, authEnabled, user } = useAuth();
  const { isProUser, requirePro } = useProGate();

  // Anonymous (auth on, not signed in) → sign-in prompt; signed-in non-pro
  // (hosted) → paywall. Open-source → isProUser always true so neither fires.
  const needsSignIn = authEnabled && !user;
  const needsPaywall = !needsSignIn && !isProUser;
  const gated = needsSignIn || needsPaywall;

  // Measure the gate itself: how many SEO-funnel visitors reach this surface
  // and which wall they hit. Together with chat_cta_clicked (EntityActions)
  // and upgrade_prompt_shown (ProOverlay) this makes the hard-gate funnel
  // readable in PostHog: cta → wall → login/upgrade → paid.
  useEffect(() => {
    if (!ready) return;
    if (needsSignIn) track("signin_wall_shown", { surface: "mind_chat", mind_id: mindId });
    else if (needsPaywall) track("paywall_shown", { surface: "mind_chat", mind_id: mindId });
  }, [ready, needsSignIn, needsPaywall, mindId]);

  // The session backing this chat (created once, when not gated).
  const [sessionId, setSessionId] = useState<string | null>(null);
  const creatingRef = useRef(false);

  useEffect(() => {
    if (!ready || gated || creatingRef.current) return;
    creatingRef.current = true;
    let alive = true;
    createSession({ title: `Chat with ${mind.name}`, sessionType: "chat", mindId })
      .then(async (s) => {
        // Greet on open — port of renderMindDetail's POST /api/minds/{id}/greet:
        // the mind proactively opens the conversation. Persist it as the first
        // `mind` message so ChatView loads it when it mounts. Best-effort — a
        // failed greet just leaves an empty chat (the legacy try/catch).
        try {
          const greet = await post<{ response?: string; usage?: unknown }>(
            `/api/minds/${encodeURIComponent(mindId)}/greet`,
            {},
          );
          if (greet?.response) {
            await queueSaveMessage(s.id, "mind", greet.response, {
              mindName: mind.name,
              usage: greet.usage,
            });
          }
        } catch (e) {
          console.warn("Mind greeting failed:", e);
        }
        if (alive) {
          setSessionId(s.id);
          bumpSessions();
        }
      })
      .catch((e) => {
        console.warn("Failed to create mind chat session:", e);
        // Degrade gracefully with a client-only id (no server persistence).
        if (alive) {
          try {
            setSessionId(crypto.randomUUID());
          } catch {
            setSessionId(`local-${mindId}`);
          }
        }
      });
    return () => {
      alive = false;
    };
  }, [ready, gated, mind.name, mindId]);

  const sidebar = (
    <aside className="chat-sidebar-right visible">
      <MindMetaSidebar mind={mind} />
    </aside>
  );

  // Pre-seed the mind as a composer chip so it answers (phase 1) and others can
  // auto-join (phase 2) — the production sendMindChat → _inviteMindsToChat path.
  const seedMind: SelectedMind = {
    id: mindId,
    name: mind.name,
    era: mind.era,
    domain: mind.domain,
  };

  // Gated (hosted) — show the prompt alongside the agent-info sidebar, no chat.
  if (gated) {
    return (
      <div className={`mind-page ${styles.page}`}>
        <div className="chat-with-sidebar">
          <div className="chat-main">
            <div className="chat-messages">
              <div className={styles.fallback}>
                {needsSignIn ? (
                  <>
                    <p>Sign in to chat with {mind.name}</p>
                    <Link
                      href={`/login?next=${encodeURIComponent(`/mind/${mind.slug || mindId}/chat`)}`}
                      className={styles.fallbackLink}
                    >
                      Sign in →
                    </Link>
                  </>
                ) : (
                  <>
                    <p>Chatting with {mind.name} is a Pro feature.</p>
                    <button
                      type="button"
                      className={styles.fallbackLink}
                      style={{ background: "none", border: "none", cursor: "pointer" }}
                      onClick={() => requirePro()}
                    >
                      Upgrade to Pro →
                    </button>
                  </>
                )}
              </div>
            </div>
          </div>
          {sidebar}
        </div>
      </div>
    );
  }

  return (
    <div className={`mind-page ${styles.page}`}>
      {sessionId ? (
        <ChatView sessionId={sessionId} initialMinds={[seedMind]} rightSidebar={sidebar} />
      ) : (
        <div className="chat-with-sidebar">
          <div className="chat-main">
            <div className="chat-messages">
              <div className="chat-message assistant">
                <span className="loading-dot">Starting your chat with {mind.name}…</span>
              </div>
            </div>
          </div>
          {sidebar}
        </div>
      )}
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
  // Slug (not uuid) → skip the middleware's blocking uuid→slug 301 hop.
  const profileHref = `/mind/${encodeURIComponent(mind.slug || mind.id)}`;

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
    const text = encodeURIComponent(`Chat with ${mind.name} on Feynman`);
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
