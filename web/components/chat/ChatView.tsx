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

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { get } from "@/lib/api";
import {
  loadMessages,
  getSession,
  queueSaveMessage,
  renameSession,
  sendChat,
  responseToAssistant,
  chatErrorMessage,
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
import MindConsent from "./MindConsent";
import RelatedBooks from "./RelatedBooks";
import { ShareModal, PublishToast } from "./ShareModal";
import {
  bookToContext,
  type SelectedBook,
  type SelectedMind,
} from "./ComposerPickers";
import styles from "./ChatView.module.css";

const PENDING_KEY = "feynman:pendingChat";

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

export default function ChatView({ sessionId }: { sessionId: string }) {
  // Pro-gate for inviting minds (hosted build). On open-source, isProUser is
  // always true so requirePro() runs through.
  const { requirePro } = useProGate();

  // The session row (title + share state). Loaded client-side with a stub
  // fallback so the chat works even when the row can't be fetched.
  const sessionRef = useRef<Session>(stubSession(sessionId));

  const [messages, setMessages] = useState<Message[]>([]);
  const [books, setBooks] = useState<Map<string, SelectedBook>>(new Map());
  const [minds, setMinds] = useState<Map<string, SelectedMind>>(new Map());
  // Minds already active in this conversation (chips + auto-suggested that the
  // user allowed). Names drive @-mention rendering + suggest excludes.
  const activeMindsRef = useRef<Map<string, SelectedMind>>(new Map());
  const [sending, setSending] = useState(false);
  const [mindsBusy, setMindsBusy] = useState(false);
  const [consent, setConsent] = useState<ConsentState>(null);

  // Share state
  const [featuresOn, setFeaturesOn] = useState(false);
  const [shareOpen, setShareOpen] = useState(false);
  const [publicStatus, setPublicStatus] = useState("private");
  const [publicTitle, setPublicTitle] = useState<string | null>(null);
  const [publicHandle, setPublicHandle] = useState<string | null>(null);
  const [publicUrl, setPublicUrl] = useState<string>("");
  const [toastUrl, setToastUrl] = useState<string>("");

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
    getSession(sessionId)
      .then((s) => {
        if (!alive) return;
        sessionRef.current = s;
        setPublicStatus(s.publicStatus);
        setPublicTitle(s.publicTitle);
        setPublicHandle(s.publicHandle);
        if (s.publicStatus === "approved") setPublicUrl(`/discussions/${sessionId}`);
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
      for (const [id, m] of activeMindsRef.current) {
        if (joinedNames.includes(m.name) && !respondedNames.has(m.name)) {
          activeMindsRef.current.delete(id);
        }
      }
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
      setMindsBusy(true);
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

        // Phase 2: auto-suggest is skipped when the user @-mentioned minds
        // (they already chose who answers) — port of app.js skipSuggest.
        if (hasMentions) {
          setMindsBusy(false);
          return;
        }

        // Phase 2: auto-suggest 1-3 fresh minds, then ask consent.
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
        if (genRef.current !== gen) return;

        // The suggest endpoint returns NO id — each suggestion must be
        // materialized via /api/minds/generate to get a real mind id before it
        // can join. (Without this the whole "minds join in" auto-flow silently
        // never fired.) Mirror production's suggest→generate fan-out.
        const fresh: { id: string; name: string }[] = [];
        for (const s of suggested) {
          if (genRef.current !== gen) return;
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
            if (genRef.current !== gen) return;
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

        if (!fresh.length) {
          setMindsBusy(false);
          return;
        }

        // Stash them as active provisionally + ask for consent.
        for (const s of fresh) {
          activeMindsRef.current.set(s.id, { id: s.id, name: s.name });
        }
        setMindsBusy(false);
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
    [runPanel],
  );

  const onConsentAllow = useCallback(async () => {
    const c = consent;
    const ctx = pendingConsentRef.current;
    setConsent(null);
    if (!c || !ctx || genRef.current !== ctx.gen) {
      for (const id of c?.mindIds || []) activeMindsRef.current.delete(id);
      return;
    }
    // mind_joined — the user accepted the auto-suggested minds (app.js 2925).
    track("mind_joined", { minds: c.names, count: c.names.length });
    setMindsBusy(true);
    await runPanel(ctx.gen, c.mindIds, c.names, ctx.working, ctx.message, ctx.bookCtx, ctx.agentIds);
    setMindsBusy(false);
  }, [consent, runPanel]);

  const onConsentDecline = useCallback(() => {
    const c = consent;
    setConsent(null);
    // mind_declined — the user dismissed the suggestion (app.js 2929).
    if (c) track("mind_declined", { minds: c.names, count: c.names.length });
    for (const id of c?.mindIds || []) activeMindsRef.current.delete(id);
  }, [consent]);

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
      const contextBooks = [...effBooks.values()].map((b) => ({
        id: b.id,
        title: b.title,
        author: b.author,
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

  // ── Related sidebar source = last assistant message with sources ──
  const sidebarSources = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i];
      if (m.role === "assistant" && m.sources?.length) return m.sources;
    }
    return [];
  }, [messages]);

  // ── Share eligibility: feature on + ≥3 messages (matches backend gate) ──
  const shareEligible = featuresOn && messages.length >= 3;
  const isPublic = publicStatus === "approved";

  return (
    <div className={`chat-main-layout ${styles.layout}`}>
      <div className="chat-main">
        {shareEligible && (
          <div className={`chat-session-actions ${styles.shareActions}`} id="chat-session-actions">
            <button
              type="button"
              className={`composer-icon-btn ${styles.shareBtn}`}
              id="share-session-btn"
              onClick={() => (isPublic && publicUrl ? setToastUrl(publicUrl) : setShareOpen(true))}
            >
              {isPublic && (
                <span id="share-status-indicator" className={styles.shareDot} title="Public">
                  ●
                </span>
              )}
              <span className="share-btn-label">{isPublic ? "Manage share" : "Share publicly"}</span>
            </button>
          </div>
        )}

        <div className="chat-messages" id="chat-messages" ref={scrollRef}>
          <MessageList messages={messages} />
          {sending && (
            <div className="chat-message assistant">
              <span className="loading-dot">Thinking...</span>
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
            books={books}
            minds={minds}
            disabled={sending}
            onSend={handleSend}
            onToggleBook={toggleBook}
            onToggleMind={toggleMind}
            onRemoveBook={removeBook}
            onRemoveMind={removeMind}
          />
        </div>
      </div>

      <RelatedBooks sources={sidebarSources} />

      {shareOpen && (
        <ShareModal
          session={{ ...sessionRef.current, publicStatus, publicTitle, publicHandle }}
          onClose={() => setShareOpen(false)}
          onShared={(rec) => {
            setPublicStatus(rec.public_status);
            if (rec.public_title !== undefined) setPublicTitle(rec.public_title ?? null);
            if (rec.public_handle !== undefined) setPublicHandle(rec.public_handle ?? null);
            const url = rec.public_url || `/discussions/${sessionId}`;
            setPublicUrl(url);
            setShareOpen(false);
            setToastUrl(url);
          }}
        />
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
          }}
        />
      )}
    </div>
  );
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
