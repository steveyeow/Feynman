"use client";

/**
 * The chat orchestrator. Loads (or seeds) a session, renders the transcript +
 * composer + related sidebar, and drives the send → /api/chat → minds flow.
 *
 * Faithful port of sendGlobalChat + _inviteMindsToChat in app.js, adapted to
 * React state. Key behaviors preserved:
 *  - Chat is BLOCKING (no streaming). [future: stream the answer]
 *  - When minds are selected as chips, Feynman is skipped (skipFeynman).
 *  - Invited (chip) minds answer first (phase 1, no consent — user invited
 *    them). Then 1-3 fresh minds are auto-suggested; the user must consent
 *    (Allow / Not now) before they answer (phase 2).
 *  - Each message is persisted via POST /api/sessions/{id}/messages, serialized
 *    per session so writes never race.
 *  - Errors render an assistant/system error bubble; the shell never crashes.
 *  - Share affordance appears once the feature flag is on AND the session has
 *    ≥3 messages (matches the backend gate).
 */

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { get, post, ApiError } from "@/lib/api";
import {
  loadMessages,
  getSession,
  queueSaveMessage,
  renameSession,
  sendChat,
  responseToAssistant,
  chatErrorMessage,
  bumpSessions,
  type Message,
  type Session,
} from "@/lib/chat";
import {
  suggestMinds,
  generateMind,
  panelChat,
  isRealMindReply,
  type MindResponse,
} from "@/lib/minds-chat";
import { listMinds } from "@/lib/api";
import { parseMentions, stripMentions } from "@/lib/mentions";
import { useProGate } from "@/components/pro/ProOverlay";
import { track } from "@/lib/analytics";
import MessageList from "./MessageList";
import Composer from "./Composer";
import type { MentionMind } from "./useMentionAutocomplete";
import MindConsent from "./MindConsent";
import RelatedBooks from "./RelatedBooks";
import BookCanvas from "./BookCanvas";
import { useWriteBook } from "./useWriteBook";
import { PublishToast } from "./ShareModal";
import {
  bookToContext,
  type SelectedBook,
  type SelectedMind,
} from "./ComposerPickers";
import styles from "./ChatView.module.css";

const PENDING_KEY = "feynman:pendingChat";

// Stable empty selections passed to the Composer in write-book mode (the book/
// mind popovers don't drive the ai-books flow). Module-level so the Composer
// doesn't see a new Map identity each render.
const EMPTY_BOOKS: Map<string, SelectedBook> = new Map();
const EMPTY_MINDS: Map<string, SelectedMind> = new Map();

interface PendingChat {
  sessionId: string;
  message: string;
  books?: SelectedBook[];
  minds?: SelectedMind[];
}

/** True if a first-message handoff for this session is waiting (without
 *  consuming it) — lets the load effect avoid clobbering the optimistic
 *  transcript the handoff is about to render. */
function hasPending(sessionId: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return false;
    return (JSON.parse(raw) as PendingChat).sessionId === sessionId;
  } catch {
    return false;
  }
}

/** Read + clear the first-message handoff written by HomeComposer. */
function takePending(sessionId: string): PendingChat | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(PENDING_KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as PendingChat;
    if (data.sessionId !== sessionId) return null;
    sessionStorage.removeItem(PENDING_KEY);
    return data;
  } catch {
    return null;
  }
}

type ConsentState = {
  names: string[];
  mindIds: string[];
} | null;

/** Minimal session stub used before the real row loads (or if the load fails —
 *  e.g. unauthenticated SSR/dev). The chat is still fully usable; only the
 *  title + public-share state come from the row. */
function stubSession(id: string): Session {
  return {
    id,
    title: "New chat",
    messages: [],
    updatedAt: Date.now(),
    mindId: null,
    sessionType: "chat",
    meta: {},
    publicStatus: "private",
    publicHandle: null,
    publicTitle: null,
  };
}

/** Subset of POST /share's response the share button + toast actually read. */
interface ShareRecord {
  public_status: string;
  public_title?: string | null;
  public_handle?: string | null;
  public_url?: string | null;
}

/** macOS-style share glyph (box + up arrow) — the icon-only affordance that
 *  replaced the old "Share publicly" text button in the redesign. */
function ShareIcon() {
  return (
    <svg
      width="16"
      height="16"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M4 12v7a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-7" />
      <polyline points="8 6 12 2 16 6" />
      <line x1="12" y1="2" x2="12" y2="14" />
    </svg>
  );
}

export default function ChatView({
  sessionId,
  initialMinds,
  rightSidebar,
}: {
  sessionId: string;
  /** Minds pre-seeded as composer chips — e.g. the subject of a /mind chat, so
   *  it answers in phase 1 and others can auto-join (production sendMindChat). */
  initialMinds?: SelectedMind[];
  /** Custom right column (e.g. the mind agent-info card). Defaults to the
   *  RelatedBooks sidebar when omitted. */
  rightSidebar?: ReactNode;
}) {
  // Pro-gate for inviting minds (hosted build). On open-source, isProUser is
  // always true so requirePro() runs through.
  const { requirePro, isProUser } = useProGate();

  // The session row (title + share state). Loaded client-side with a stub
  // fallback so the chat works even when the row can't be fetched.
  const sessionRef = useRef<Session>(stubSession(sessionId));

  const [messages, setMessages] = useState<Message[]>([]);
  // Write-book detection: set once the session row loads (sessionType
  // 'write_book' OR meta.write_book — port of _isWriteBookSession). When true,
  // the composer routes through the ai-books flow + the book-canvas renders
  // instead of the Related sidebar.
  const [isWriteBook, setIsWriteBook] = useState(false);
  const [writeMeta, setWriteMeta] = useState<Record<string, unknown> | null>(null);
  const [books, setBooks] = useState<Map<string, SelectedBook>>(new Map());
  // Pre-seed chips from initialMinds (mind-page subject). Lazy initializer so it
  // only seeds on first mount; absent → empty (the normal /chat behavior).
  const [minds, setMinds] = useState<Map<string, SelectedMind>>(
    () => new Map((initialMinds || []).map((m) => [m.id, m])),
  );
  // Minds already active in this conversation (chips + auto-suggested that the
  // user allowed). Names drive @-mention rendering + suggest excludes.
  const activeMindsRef = useRef<Map<string, SelectedMind>>(new Map());
  // Render-visible mirror of activeMindsRef (a ref never triggers a re-render):
  // drives the @-mention autocomplete list, the composer hint, and mention-tag
  // rendering (port of _getMentionableMinds + _updateComposerMentionHint).
  const [activeMindList, setActiveMindList] = useState<SelectedMind[]>([]);
  const syncActiveMinds = useCallback(() => {
    setActiveMindList([...activeMindsRef.current.values()]);
  }, []);
  // Non-Pro users get the auto-suggest → consent fan-out at most ONCE per
  // conversation (port of _mindsInvitedOnce). Reset per session in the load
  // effect below. Pro / open-source users are unaffected (the gate only reads
  // it when !isProUser).
  const invitedOnceRef = useRef(false);
  const [sending, setSending] = useState(false);
  const [mindsBusy, setMindsBusy] = useState(false);
  const [consent, setConsent] = useState<ConsentState>(null);

  // Share state
  const [featuresOn, setFeaturesOn] = useState(false);
  const [publicStatus, setPublicStatus] = useState("private");
  const [publicTitle, setPublicTitle] = useState<string | null>(null);
  const [publicHandle, setPublicHandle] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string>("");
  const [toastUrl, setToastUrl] = useState<string>("");
  // Transient inline hint beside the share icon (e.g. the <3-message gate). It
  // auto-clears and never opens a modal — the redesign dropped the form.
  const [shareHint, setShareHint] = useState("");
  const shareHintTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flashShareHint = useCallback((msg: string) => {
    setShareHint(msg);
    if (shareHintTimer.current) clearTimeout(shareHintTimer.current);
    shareHintTimer.current = setTimeout(() => setShareHint(""), 4000);
  }, []);

  // One-click publish (share redesign Phase 1). No title/handle form: POST
  // /share with the session's own title and NO handle, so the public page reads
  // "Anonymous" (ChatGPT-style), then surface the clean PublishToast. The
  // backend's <3-message gate (422, string detail — no code) becomes a small
  // inline hint instead of a modal.
  const doShare = useCallback(async () => {
    try {
      const rec = await post<ShareRecord>(
        `/api/chat-sessions/${encodeURIComponent(sessionId)}/share`,
        { title: sessionRef.current?.title || undefined },
      );
      setPublicStatus(rec.public_status);
      if (rec.public_title !== undefined) setPublicTitle(rec.public_title ?? null);
      if (rec.public_handle !== undefined) setPublicHandle(rec.public_handle ?? null);
      const url = rec.public_url || `/discussions/${sessionId}`;
      setPublicUrl(url);
      setToastUrl(url);
      bumpSessions(); // show the public ● dot in the sidebar
    } catch (e) {
      if (e instanceof ApiError && e.status === 422) {
        flashShareHint("Chat needs at least 3 messages to share.");
      } else {
        const detail =
          e instanceof ApiError
            ? (e.body as { detail?: unknown } | null)?.detail
            : null;
        flashShareHint(
          typeof detail === "string" && detail
            ? detail
            : "Couldn’t publish — please try again.",
        );
      }
    }
  }, [sessionId, flashShareHint]);

  // Abort guard: bump to invalidate in-flight minds work after a new send.
  const genRef = useRef(0);
  const chatAbortRef = useRef<AbortController | null>(null);

  const scrollRef = useRef<HTMLDivElement | null>(null);
  const sentPendingRef = useRef(false);

  const scrollToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, consent, mindsBusy, scrollToBottom]);

  // ── Load the session row, existing messages, and feature flags ──
  useEffect(() => {
    let alive = true;
    // New/switched conversation — reset the per-session minds state (mirrors
    // app.js resetting activeMinds + _mindsInvitedOnce on session change).
    activeMindsRef.current = new Map();
    invitedOnceRef.current = false;
    setActiveMindList([]);
    getSession(sessionId)
      .then((s) => {
        if (!alive) return;
        sessionRef.current = s;
        setPublicStatus(s.publicStatus);
        setPublicTitle(s.publicTitle);
        setPublicHandle(s.publicHandle);
        if (s.publicStatus === "approved") setPublicUrl(`/discussions/${sessionId}`);
        // Classify write-book sessions (port of _isWriteBookSession). The
        // useWriteBook hook reads writeMeta.ai_book_id to resume.
        if (s.sessionType === "write_book" || s.meta?.write_book) {
          setIsWriteBook(true);
          setWriteMeta(s.meta || {});
        }
      })
      .catch((e) => {
        // Non-fatal — keep the stub (title "New chat", private). Common in dev /
        // before auth lands.
        console.warn("Failed to load session row:", e);
      });
    // Skip loading persisted messages when a first-message handoff is pending
    // for this session: the handoff effect renders the user bubble + streams
    // the reply optimistically, and a fast loadMessages() resolving mid-send
    // would otherwise overwrite (clobber) that live transcript.
    if (!hasPending(sessionId)) {
      loadMessages(sessionId)
        .then((msgs) => {
          if (alive) setMessages(msgs);
        })
        .catch((e) => {
          console.warn("Failed to load session messages:", e);
        });
    }
    // Endpoint returns { public_discussions, ai_insights }. (The scope referred
    // to the ENABLE_PUBLIC_DISCUSSIONS env var; the JSON key is the lowercase
    // public_discussions — verified against app/main.py.)
    get<{ public_discussions?: boolean; ENABLE_PUBLIC_DISCUSSIONS?: boolean }>("/api/features")
      .then((f) => {
        if (alive) setFeaturesOn(!!(f?.public_discussions ?? f?.ENABLE_PUBLIC_DISCUSSIONS));
      })
      .catch(() => {
        /* features default off */
      });
    return () => {
      alive = false;
      if (chatAbortRef.current) chatAbortRef.current.abort();
      genRef.current++;
    };
  }, [sessionId]);

  // ── Build chat history from current messages (user/assistant turns) ──
  const buildHistory = useCallback(
    (msgs: Message[]) =>
      msgs
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => ({ role: m.role, content: m.content })),
    [],
  );

  // ── Build panel-chat history (includes mind turns, prefixed by name) ──
  const buildPanelHistory = useCallback(
    (msgs: Message[]) =>
      msgs
        .filter((m) => m.role !== "system-notice")
        .map((m) => {
          if (m.role === "mind")
            return { role: "assistant", content: `[${m.mindName}]: ${m.content}` };
          return {
            role: m.role === "user" ? "user" : "assistant",
            content: m.content,
          };
        }),
    [],
  );

  // ── Run a panel-chat round + append responses ──
  // `targetMinds` (the @-mentioned names) is sent so the backend restricts who
  // answers to the mentioned minds (port of runPanelChat's target_minds).
  const runPanel = useCallback(
    async (
      gen: number,
      panelMindIds: string[],
      joinedNames: string[],
      baseMsgs: Message[],
      message: string,
      bookCtx: { title: string; author: string }[],
      agentIds: string[],
      targetMinds?: string[],
    ): Promise<Message[]> => {
      if (!panelMindIds.length) return baseMsgs;
      const invitedIds = panelMindIds.filter((id) => {
        const m = activeMindsRef.current.get(id);
        return m && joinedNames.includes(m.name);
      });
      let responses: MindResponse[] = [];
      try {
        responses = await panelChat({
          message,
          mindIds: panelMindIds,
          invitedMindIds: invitedIds.length ? invitedIds : undefined,
          bookContext: bookCtx.length ? bookCtx : undefined,
          agentIds: agentIds.length ? agentIds : undefined,
          history: buildPanelHistory(baseMsgs),
          targetMinds: targetMinds?.length ? targetMinds : undefined,
        });
      } catch (e) {
        console.warn("[minds] panel-chat failed:", e);
        if (genRef.current !== gen) return baseMsgs;
        const names = panelMindIds
          .map((id) => activeMindsRef.current.get(id)?.name)
          .filter(Boolean) as string[];
        const next = [
          ...baseMsgs,
          mindErrorMessage(names),
        ];
        setMessages(next);
        return next;
      }
      if (genRef.current !== gen) return baseMsgs;

      const real = responses.filter(isRealMindReply);
      const respondedNames = new Set(real.map((r) => r.mind_name));
      // Drop freshly-joined minds that didn't actually respond.
      let dropped = false;
      for (const [id, m] of activeMindsRef.current) {
        if (joinedNames.includes(m.name) && !respondedNames.has(m.name)) {
          activeMindsRef.current.delete(id);
          dropped = true;
        }
      }
      if (dropped) syncActiveMinds();
      const joinedResponded = joinedNames.filter((n) => respondedNames.has(n));

      const appended: Message[] = [];
      if (joinedResponded.length) {
        appended.push({ role: "system-notice", content: "", mindNames: joinedResponded });
        queueSaveMessage(sessionId, "system-notice", "", { mindNames: joinedResponded });
      }
      for (const r of real) {
        appended.push({ role: "mind", content: r.response, mindName: r.mind_name, usage: r.usage });
        queueSaveMessage(sessionId, "mind", r.response, {
          mindName: r.mind_name,
          usage: r.usage,
        });
      }
      // If panel-chat returned but nobody actually answered, surface an error.
      if (respondedNames.size === 0) {
        const failed = panelMindIds
          .map((id) => activeMindsRef.current.get(id)?.name)
          .filter(Boolean) as string[];
        appended.push(mindErrorMessage(failed));
      }
      const next = [...baseMsgs, ...appended];
      setMessages(next);
      return next;
    },
    [buildPanelHistory, sessionId],
  );

  // Captures the context needed to resume the flow once the user consents to
  // the auto-suggested minds (set in inviteMinds, read in onConsentAllow).
  const pendingConsentRef = useRef<{
    gen: number;
    working: Message[];
    message: string;
    bookCtx: { title: string; author: string }[];
    agentIds: string[];
  } | null>(null);

  // ── The minds-join orchestration (phase 1 invited, phase 2 auto-suggest) ──
  // `selectedMinds` is passed explicitly (not read from state) so the first
  // send — fired right after seeding from the home handoff — uses the seeded
  // minds before React has committed the state update.
  const inviteMinds = useCallback(
    async (
      gen: number,
      baseMsgs: Message[],
      message: string,
      bookCtx: { title: string; author: string }[],
      agentIds: string[],
      selectedMinds: Map<string, SelectedMind>,
      mentionedNames: string[] = [],
    ) => {
      const hasMentions = mentionedNames.length > 0;
      try {
        // Move chip-selected minds into activeMinds (they're "invited").
        const invitedIds: string[] = [];
        const invitedNames: string[] = [];
        for (const [id, m] of selectedMinds) {
          if (!activeMindsRef.current.has(id)) {
            activeMindsRef.current.set(id, m);
            invitedIds.push(id);
            invitedNames.push(m.name);
          }
        }
        if (invitedIds.length) syncActiveMinds();

        let working = baseMsgs;

        // Phase 1: explicitly invited (chip) AND @-mentioned EXISTING minds
        // answer first — no consent needed (port of app.js phase1Set). Mentioned
        // names that aren't already active minds are skipped here (production
        // materializes them via generate; we keep this scoped to existing minds).
        const phase1Ids = new Set<string>();
        if (hasMentions) {
          for (const [id, m] of activeMindsRef.current) {
            if (mentionedNames.some((n) => n.toLowerCase() === m.name.toLowerCase())) {
              phase1Ids.add(id);
            }
          }
        }
        for (const id of invitedIds) phase1Ids.add(id);

        if (phase1Ids.size) {
          const ids = [...phase1Ids];
          // joinedNames: of the phase-1 minds, the ones newly invited this turn.
          const joined = ids
            .map((id) => activeMindsRef.current.get(id)?.name)
            .filter((n): n is string => !!n && invitedNames.includes(n));
          working = await runPanel(
            gen,
            ids,
            joined,
            working,
            message,
            bookCtx,
            agentIds,
            hasMentions ? mentionedNames : undefined,
          );
          if (genRef.current !== gen) return;
        }

        // Phase 2: auto-suggest is skipped when the user @-mentioned minds (they
        // already chose who answers) OR for a non-Pro user who already got the
        // fan-out once this conversation (port of skipSuggest = hasMentions ||
        // (!isProUser && _mindsInvitedOnce)). Production latches the flag here too.
        const skipSuggest = hasMentions || (!isProUser && invitedOnceRef.current);
        if (skipSuggest) {
          invitedOnceRef.current = true;
          return;
        }

        // Phase 2: auto-suggest 1-3 fresh minds, then ask consent. The "Inviting
        // great minds…" notice shows ONLY across this suggest→generate window
        // (production adds+removes it synchronously in phase 1, so it never
        // paints there — L4 parity).
        setMindsBusy(true);
        const exclude = [...activeMindsRef.current.values()].map((m) => m.name);
        const count = Math.floor(Math.random() * 3) + 1;
        let suggested: { id?: string; name: string }[] = [];
        try {
          suggested = await suggestMinds({
            count,
            exclude,
            bookTitle: bookCtx[0]?.title,
            bookAuthor: bookCtx[0]?.author,
            topic: bookCtx.length ? undefined : message,
          });
        } catch (e) {
          console.warn("[minds] suggest failed:", e);
        }
        if (genRef.current !== gen) {
          setMindsBusy(false);
          return;
        }

        // The suggest endpoint returns NO id — each suggestion must be
        // materialized via /api/minds/generate to get a real mind id before it
        // can join. (Without this the whole "minds join in" auto-flow silently
        // never fired.) Mirror production's suggest→generate fan-out.
        const fresh: { id: string; name: string }[] = [];
        for (const s of suggested) {
          if (genRef.current !== gen) {
            setMindsBusy(false);
            return;
          }
          const m = await generateMind(s);
          if (m && !activeMindsRef.current.has(m.id)) {
            fresh.push(m);
          }
        }

        // Fallback: if generate produced nothing, pick from existing seed minds
        // (scored by topic-word overlap) so the flow isn't silent — production
        // does the same.
        if (!fresh.length) {
          try {
            const all = await listMinds();
            if (genRef.current !== gen) {
              setMindsBusy(false);
              return;
            }
            const topic = (bookCtx[0]?.title || message || "").toLowerCase();
            const words = topic.split(/\s+/).filter((w) => w.length > 3);
            const scored = all
              .filter((m) => m.id && !activeMindsRef.current.has(m.id))
              .map((m) => {
                const hay = `${m.domain || ""} ${m.era || ""} ${m.name || ""}`.toLowerCase();
                return { m, score: words.reduce((acc, w) => acc + (hay.includes(w) ? 1 : 0), 0) };
              })
              .sort((a, b) => b.score - a.score);
            for (const { m } of scored.slice(0, 2)) {
              fresh.push({ id: m.id, name: m.name });
            }
          } catch {
            /* seed fallback best-effort */
          }
        }

        setMindsBusy(false);

        if (!fresh.length) {
          // No fresh minds materialized — production latches _mindsInvitedOnce
          // here too (app.js 3119) so a non-Pro user isn't re-attempted.
          invitedOnceRef.current = true;
          return;
        }

        // Stash them as active provisionally + ask for consent.
        for (const s of fresh) {
          activeMindsRef.current.set(s.id, { id: s.id, name: s.name });
        }
        syncActiveMinds();
        setConsent({
          names: fresh.map((s) => s.name),
          mindIds: fresh.map((s) => s.id),
        });
        // The consent buttons resolve via onAllow/onDecline below; they capture
        // `working`, message, bookCtx, agentIds through pendingConsentRef.
        pendingConsentRef.current = { gen, working, message, bookCtx, agentIds };
      } catch (e) {
        console.warn("[minds] invite failed:", e);
        setMindsBusy(false);
      }
    },
    [runPanel, isProUser, syncActiveMinds],
  );

  const onConsentAllow = useCallback(async () => {
    const c = consent;
    const ctx = pendingConsentRef.current;
    setConsent(null);
    if (!c || !ctx || genRef.current !== ctx.gen) {
      for (const id of c?.mindIds || []) activeMindsRef.current.delete(id);
      syncActiveMinds();
      return;
    }
    // mind_joined — the user accepted the auto-suggested minds (app.js 2925).
    track("mind_joined", { minds: c.names, count: c.names.length });
    setMindsBusy(true);
    await runPanel(ctx.gen, c.mindIds, c.names, ctx.working, ctx.message, ctx.bookCtx, ctx.agentIds);
    setMindsBusy(false);
    // Latch the once-per-conversation cap after a completed auto-join (app.js 3136).
    invitedOnceRef.current = true;
    syncActiveMinds();
  }, [consent, runPanel, syncActiveMinds]);

  const onConsentDecline = useCallback(() => {
    const c = consent;
    setConsent(null);
    // mind_declined — the user dismissed the suggestion (app.js 2929).
    if (c) track("mind_declined", { minds: c.names, count: c.names.length });
    for (const id of c?.mindIds || []) activeMindsRef.current.delete(id);
    syncActiveMinds();
  }, [consent, syncActiveMinds]);

  // ── The main send flow ──
  // `override` lets the first send (from the home handoff) supply the seeded
  // book/mind selections synchronously, since the corresponding setBooks/
  // setMinds calls won't have committed yet when this fires.
  const handleSend = useCallback(
    async (
      rawMessage: string,
      override?: { books?: Map<string, SelectedBook>; minds?: Map<string, SelectedMind> },
    ) => {
      const message = rawMessage.trim();
      if (!message) return;

      const effBooks = override?.books ?? books;
      const effMinds = override?.minds ?? minds;

      // Inviting minds requires pro on the hosted build (legacy app.js 3149).
      // The minds popover already gates selection; this is the backstop on send.
      if (effMinds.size && !requirePro()) return;

      // @-mention parsing (port of parseMentions). Known names = minds already
      // active in the conversation + the chip-selected minds. Mentions targeting
      // one of these route the question to that mind on send.
      const knownMindNames = [
        ...[...activeMindsRef.current.values()].map((m) => m.name),
        ...[...effMinds.values()].map((m) => m.name),
      ];
      const mentionedNames = parseMentions(message, knownMindNames);
      // The message the model sees has the @ stripped ("@Aristotle" → "Aristotle").
      const cleanMessage = mentionedNames.length
        ? stripMentions(message, knownMindNames)
        : message;

      // chat_sent — fired once per user send (port of app.js 2761).
      track("chat_sent", {
        has_books: effBooks.size > 0,
        has_minds: effMinds.size > 0,
        has_mentions: mentionedNames.length > 0,
      });

      // Invalidate any in-flight minds work + abort prior chat request.
      const gen = ++genRef.current;
      if (chatAbortRef.current) chatAbortRef.current.abort();
      setConsent(null);
      setMindsBusy(false);

      const bookCtx = [...effBooks.values()].map(bookToContext);
      const agentIds = [...effBooks.values()].map((b) => b.agentId);
      // Persisted context books are {id, title} only — matches production's
      // userMeta.contextBooks shape (the author-bearing payload goes to
      // /api/chat via bookCtx, not here) — L6 parity.
      const contextBooks = [...effBooks.values()].map((b) => ({
        id: b.id,
        title: b.title,
      }));
      // Context minds exclude @-mentioned ones — those render inline as mention
      // tags in the message text, not as duplicate context chips (port of
      // app.js 2755: contextMinds = selectedMinds.filter(!mentioned)).
      const contextMinds = [...effMinds.values()]
        .filter((m) => !mentionedNames.some((n) => n.toLowerCase() === m.name.toLowerCase()))
        .map((m) => ({ name: m.name }));

      // Rename "New chat" from the first user message.
      if (sessionRef.current.title === "New chat" && messages.length === 0) {
        const title = message.length > 40 ? message.slice(0, 40) + "..." : message;
        renameSession(sessionId, title);
        sessionRef.current.title = title;
        bumpSessions(); // refresh the sidebar pill from "New chat" → the title
      }

      // Append user message + persist.
      const userMsg: Message = {
        role: "user",
        content: message,
        ...(contextBooks.length ? { contextBooks } : {}),
        ...(contextMinds.length ? { contextMinds } : {}),
      };
      const afterUser = [...messages, userMsg];
      setMessages(afterUser);
      const userMeta: Record<string, unknown> = {};
      if (contextMinds.length) userMeta.contextMinds = contextMinds;
      if (contextBooks.length) userMeta.contextBooks = contextBooks;
      queueSaveMessage(
        sessionId,
        "user",
        message,
        Object.keys(userMeta).length ? userMeta : undefined,
      );

      // skipFeynman: when minds are chosen as chips OR the user @-mentioned a
      // mind, the panel answers instead of Feynman (port of app.js 2783, scoped
      // per the brief to fire whenever there are mentioned names).
      const skipFeynman = effMinds.size > 0 || mentionedNames.length > 0;

      let working = afterUser;

      if (!skipFeynman) {
        setSending(true);
        const abort = new AbortController();
        chatAbortRef.current = abort;
        try {
          const data = await sendChat({
            message: cleanMessage,
            agentIds,
            bookContext: bookCtx,
            // History must INCLUDE the just-sent user turn (port of app.js: the
            // user message is pushed into session.messages before history is
            // built). We send the stripped text so the model never sees @tokens.
            history: [...buildHistory(messages), { role: "user", content: cleanMessage }],
            signal: abort.signal,
          });
          if (genRef.current !== gen) return;
          const { sources, opts } = responseToAssistant(data);
          const assistantMsg: Message = {
            role: "assistant",
            content: data.answer,
            ...(sources.length ? { sources } : {}),
            ...(Object.keys(opts).length ? { opts } : {}),
          };
          working = [...afterUser, assistantMsg];
          setMessages(working);
          const meta: Record<string, unknown> = {};
          if (sources.length) meta.sources = sources;
          if (Object.keys(opts).length) meta.opts = opts;
          queueSaveMessage(
            sessionId,
            "assistant",
            data.answer,
            Object.keys(meta).length ? meta : undefined,
          );
        } catch (e) {
          if ((e as Error)?.name === "AbortError") return;
          if (genRef.current !== gen) return;
          const errMsg: Message = { role: "assistant", content: chatErrorMessage(e) };
          working = [...afterUser, errMsg];
          setMessages(working);
        } finally {
          if (genRef.current === gen) setSending(false);
          chatAbortRef.current = null;
        }
      }

      // Kick off the minds-join flow (phase 1 invited + @-mentioned, phase 2
      // auto-suggest). The panel sees the stripped message (no @tokens).
      if (genRef.current === gen) {
        await inviteMinds(gen, working, cleanMessage, bookCtx, agentIds, effMinds, mentionedNames);
      }
    },
    [books, minds, messages, sessionId, buildHistory, inviteMinds, requirePro],
  );

  // ── Write-book flow (ai-books pipeline for write_book sessions) ──
  // The hook owns start/refine/confirm/poll/cancel/retry/resume; it calls back
  // here to append + persist the AI's outline/refine replies as normal
  // assistant messages (mirrors production's appendMsg + _queueSessionMessage).
  const appendWriteAssistant = useCallback(
    (content: string) => {
      setMessages((m) => [...m, { role: "assistant", content }]);
      queueSaveMessage(sessionId, "assistant", content);
    },
    [sessionId],
  );
  const appendWriteUser = useCallback(
    (content: string) => {
      setMessages((m) => [...m, { role: "user", content }]);
      queueSaveMessage(sessionId, "user", content);
    },
    [sessionId],
  );
  const setWriteTitle = useCallback((title: string) => {
    sessionRef.current.title = title;
  }, []);

  const writeBook = useWriteBook({
    sessionId,
    active: isWriteBook,
    initialMeta: writeMeta,
    onAssistant: appendWriteAssistant,
    onUser: appendWriteUser,
    onTitle: setWriteTitle,
    // Refine context: reuse buildHistory (user/assistant turns only). Read at
    // send time so it reflects the current transcript.
    getHistory: () => buildHistory(messages),
  });

  // The composer's send is routed to the ai-books flow for write_book sessions,
  // and to the normal /api/chat + minds flow otherwise.
  const onComposerSend = useCallback(
    (message: string) => {
      if (isWriteBook) {
        // Pro gate is enforced at the write-book ENTRY (startWriteBook); inside
        // an existing write session every send just drives the flow.
        void writeBook.send(message);
      } else {
        void handleSend(message);
      }
    },
    [isWriteBook, writeBook, handleSend],
  );

  // ── First-message handoff from HomeComposer ──
  useEffect(() => {
    if (sentPendingRef.current) return;
    const pending = takePending(sessionId);
    if (!pending) return;
    sentPendingRef.current = true;
    // Seed selections so chips show immediately…
    const seededBooks = new Map((pending.books || []).map((b) => [b.id, b]));
    const seededMinds = new Map((pending.minds || []).map((m) => [m.id, m]));
    if (seededBooks.size) setBooks(seededBooks);
    if (seededMinds.size) setMinds(seededMinds);
    // …and pass them as overrides so the send uses them without waiting for the
    // setBooks/setMinds state updates to commit.
    handleSend(pending.message, { books: seededBooks, minds: seededMinds });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId]);

  // ── Selection toggles ──
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

  // Minds @-mentionable in the composer: auto-joined (active) ∪ chip-selected,
  // deduped by name (port of _getMentionableMinds). Drives the autocomplete +
  // the composer @-hint.
  const mentionableMinds = useMemo<MentionMind[]>(() => {
    const out: MentionMind[] = [];
    const seen = new Set<string>();
    for (const m of [...activeMindList, ...minds.values()]) {
      const key = m.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name: m.name, era: m.era, domain: m.domain });
    }
    return out;
  }, [activeMindList, minds]);

  // Names rendered as .mention-tag in user messages: mentionable minds ∪ any
  // mind that has spoken in this transcript ∪ stored context minds — so both
  // live and restored @-mentions tag (port of renderUserMsgWithMentions' union).
  const knownMindNames = useMemo<string[]>(() => {
    const names = new Set<string>();
    for (const m of mentionableMinds) names.add(m.name);
    for (const msg of messages) {
      if (msg.role === "mind" && msg.mindName) names.add(msg.mindName);
      for (const cm of msg.contextMinds || []) names.add(cm.name);
    }
    return [...names];
  }, [mentionableMinds, messages]);

  // ── Related sidebar source = last assistant message with sources ──
  const sidebarSources = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.sources?.length) return m.sources;
    }
    return [];
  }, [messages]);

  // ── Share eligibility: feature on + ≥3 messages (matches backend gate) ──
  // Write-book sessions are never share-eligible (they aren't discussions).
  const shareEligible = !isWriteBook && featuresOn && messages.length >= 3;
  const isPublic = publicStatus === "approved";

  // Show the book-canvas once there's an outline (after /start) or a writing
  // status to display — matches production's _showBookCanvas timing (before the
  // first message the chat is full-width, no canvas).
  const showCanvas = isWriteBook && (!!writeBook.outline || !!writeBook.status);

  // Drag the divider to resize the canvas (port of initCanvasResize). The chat
  // column flexes to fill the rest, so we only control the canvas width.
  const [canvasWidth, setCanvasWidth] = useState<number | null>(null);
  const onResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    const canvas = document.getElementById("book-canvas");
    if (!canvas) return;
    const startX = e.clientX;
    const startW = canvas.getBoundingClientRect().width;
    const handle = e.currentTarget as HTMLElement;
    handle.classList.add("dragging");
    document.body.classList.add("canvas-resizing");
    const onMove = (ev: MouseEvent) => {
      const dx = ev.clientX - startX;
      const max = Math.max(420, window.innerWidth - 360);
      setCanvasWidth(Math.min(max, Math.max(420, startW - dx)));
    };
    const onUp = () => {
      handle.classList.remove("dragging");
      document.body.classList.remove("canvas-resizing");
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, []);

  // Use the production .chat-with-sidebar wrapper so the global
  // `:has(.book-canvas.visible) .chat-main` rule shrinks the chat column when
  // the canvas is open.
  return (
    <div className={`chat-with-sidebar ${styles.layout}`}>
      <div className="chat-main">
        {shareEligible && (
          <div className={`chat-session-actions ${styles.shareActions}`} id="chat-session-actions">
            {shareHint && (
              <span className={styles.shareHint} role="status">
                {shareHint}
              </span>
            )}
            <button
              type="button"
              className={`composer-icon-btn ${styles.shareBtn}`}
              id="share-session-btn"
              aria-label={isPublic ? "Shared publicly — manage link" : "Share publicly"}
              title={isPublic ? "Shared publicly" : "Share publicly"}
              onClick={() => (isPublic && publicUrl ? setToastUrl(publicUrl) : doShare())}
            >
              <ShareIcon />
              {isPublic && (
                <span
                  id="share-status-indicator"
                  className={styles.shareDot}
                  aria-hidden="true"
                />
              )}
            </button>
          </div>
        )}

        <div className="chat-messages" id="chat-messages" ref={scrollRef}>
          <MessageList messages={messages} knownMindNames={knownMindNames} />
          {sending && (
            <div className="chat-message assistant">
              <span className="loading-dot">Thinking...</span>
            </div>
          )}
          {isWriteBook && writeBook.busy && (
            <div className="chat-message assistant">
              <WriteLoadingDot refine={!!writeBook.outline} />
            </div>
          )}
          {mindsBusy && (
            <div className="chat-system-notice minds-loading-notice">
              <div className="join-notice-inner">
                <span className="loading-dot">
                  Inviting great minds to share their perspectives...
                </span>
              </div>
            </div>
          )}
          {consent && (
            <MindConsent
              names={consent.names}
              onAllow={onConsentAllow}
              onDecline={onConsentDecline}
            />
          )}
        </div>

        <div className="chat-input-area">
          <Composer
            books={isWriteBook ? EMPTY_BOOKS : books}
            minds={isWriteBook ? EMPTY_MINDS : minds}
            mentionable={isWriteBook ? [] : mentionableMinds}
            // Never disable the in-chat composer during a Feynman answer — a
            // fresh send must reach the abort + genRef supersede path (M4 parity,
            // app.js never disables chat-input). Only write-book start blocks.
            disabled={isWriteBook ? writeBook.busy : false}
            onSend={onComposerSend}
            onToggleBook={toggleBook}
            onToggleMind={toggleMind}
            onRemoveBook={removeBook}
            onRemoveMind={removeMind}
          />
        </div>
      </div>

      {showCanvas && (
        <div className="book-canvas-resize" onMouseDown={onResizeStart} />
      )}
      {showCanvas ? (
        <BookCanvas
          width={canvasWidth}
          phase={writeBook.phase}
          outline={writeBook.outline}
          status={writeBook.status}
          agentId={writeBook.agentId}
          content={writeBook.bookContent}
          confirming={writeBook.confirming}
          error={writeBook.error}
          onConfirm={writeBook.confirm}
          onCancel={writeBook.cancel}
          onRetry={writeBook.retry}
        />
      ) : rightSidebar !== undefined ? (
        rightSidebar
      ) : (
        !isWriteBook && (
          <RelatedBooks
            sources={sidebarSources}
            excludeAgentIds={[...books.values()].map((b) => b.agentId)}
          />
        )
      )}

      {toastUrl && (
        <PublishToast
          url={toastUrl}
          sessionId={sessionId}
          onClose={() => setToastUrl("")}
          onUnshared={() => {
            setPublicStatus("withdrawn");
            setPublicUrl("");
            setToastUrl("");
            bumpSessions(); // clear the public ● dot in the sidebar
          }}
        />
      )}
    </div>
  );
}

// Staged write-book loading copy (port of _OUTLINE_STAGES / _REFINE_STAGES +
// showLoading's 4000ms rotation). Outline generation cycles 6 stages over ~20s;
// a refine cycles 3. The label advances every 4s and stops at the last stage.
const OUTLINE_STAGES = [
  "Thinking...",
  "Researching the topic...",
  "Identifying key themes...",
  "Structuring chapters...",
  "Building your book outline...",
  "Almost there...",
];
const REFINE_STAGES = [
  "Thinking...",
  "Reviewing your feedback...",
  "Updating the outline...",
];

function WriteLoadingDot({ refine }: { refine: boolean }) {
  const [i, setI] = useState(0);
  useEffect(() => {
    setI(0);
    const stages = refine ? REFINE_STAGES : OUTLINE_STAGES;
    const id = window.setInterval(() => {
      setI((prev) => (prev < stages.length - 1 ? prev + 1 : prev));
    }, 4000);
    return () => window.clearInterval(id);
  }, [refine]);
  const stages = refine ? REFINE_STAGES : OUTLINE_STAGES;
  return <span className="loading-dot">{stages[Math.min(i, stages.length - 1)]}</span>;
}

/** Build the inline error notice when minds couldn't respond (port of appendChatErrorNotice). */
function mindErrorMessage(names: string[]): Message {
  let label: string;
  if (!names || !names.length) {
    label = "Couldn't reach the model right now. Please try again in a moment.";
  } else if (names.length === 1) {
    label = `${names[0]} couldn't respond right now. Please try again.`;
  } else {
    const joined = names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
    label = `${joined} couldn't respond right now. Please try again.`;
  }
  return { role: "error-notice", content: label };
}
