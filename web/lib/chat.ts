/**
 * Chat data layer — session CRUD + the blocking /api/chat call.
 *
 * Faithful port of the session + sendGlobalChat plumbing in app.js
 * (~2426-2822). Chat is BLOCKING in the legacy app (no streaming); we
 * replicate that here. Streaming is a future improvement.
 *
 * All network goes through lib/api.ts (`get`/`post`/`apiFetch`). Callers are
 * expected to try/catch; the helpers here surface ApiError on failure so the
 * UI can render an error bubble instead of crashing the shell.
 */

import { get, post, apiFetch } from "@/lib/api";

// ── Message + session types ────────────────────────────────────────────

/** Reference (RAG chunk source) attached to an assistant answer. */
export interface Reference {
  index: number;
  book: string;
  snippet: string;
  full_text?: string;
}

/** A book/agent that produced an answer — drives the Related sidebar. */
export interface Source {
  id: string; // agent_id
  name: string; // agent_name
}

/** Web grounding citation (Gemini grounding etc.). */
export interface WebSource {
  url: string;
  title?: string;
}

export interface Usage {
  input_tokens?: number;
  output_tokens?: number;
  total_tokens?: number;
}

/** Extra render hints carried alongside an assistant message. */
export interface MessageOpts {
  references?: Reference[];
  webSources?: WebSource[];
  grounded?: boolean;
  usage?: Usage;
  skillUsed?: string;
}

export type MessageRole =
  | "user"
  | "assistant"
  | "mind"
  | "system-notice"
  // Display-only inline error (minds couldn't respond / chat failed). Never
  // persisted — used to surface a transient failure in the transcript.
  | "error-notice";

/** A book selected as chat context (subset of lib/books Book we need here). */
export interface ContextBook {
  id: string;
  title: string;
  author?: string;
}

export interface ContextMind {
  name: string;
}

/**
 * A chat message as held in client state. Mirrors the legacy session.messages
 * shape: { role, content, ...meta } flattened. `meta` fields live at the top
 * level so restore (which spreads `m.meta`) and live append agree.
 */
export interface Message {
  role: MessageRole;
  content: string;
  // assistant
  sources?: Source[];
  opts?: MessageOpts;
  // mind
  mindName?: string;
  usage?: Usage;
  // system-notice (minds joined)
  mindNames?: string[];
  // user context
  contextBooks?: ContextBook[];
  contextMinds?: ContextMind[];
}

export type SessionType = "chat" | "mind" | "book" | "write_book";

/** A chat session row, as the UI models it (port of restoreSessions map). */
export interface Session {
  id: string;
  title: string;
  messages: Message[];
  updatedAt: number;
  mindId: string | null;
  sessionType: SessionType;
  meta: Record<string, unknown>;
  // Public-share state (Phase 6 share flow)
  publicStatus: string; // 'private' | 'approved' | 'withdrawn'
  publicHandle: string | null;
  publicTitle: string | null;
  publicUrl?: string | null;
}

// ── Raw API row shapes ─────────────────────────────────────────────────

interface SessionRow {
  id: string;
  title: string;
  updated_at?: string;
  mind_id?: string | null;
  session_type?: string;
  meta?: Record<string, unknown> & { write_book?: boolean };
  public_status?: string;
  public_handle?: string | null;
  public_title?: string | null;
}

interface MessageRow {
  role: MessageRole;
  content: string;
  meta?: Partial<Message>;
}

/** Server response from POST /api/chat (blocking). */
export interface ChatResponse {
  answer: string;
  sources?: { agent_id: string; agent_name: string }[];
  references?: Reference[];
  web_sources?: WebSource[];
  grounded?: boolean;
  usage?: Usage;
  skill_used?: string;
}

// ── Session normalization ──────────────────────────────────────────────

function normalizeSession(s: SessionRow): Session {
  return {
    id: s.id,
    title: s.title,
    messages: [],
    updatedAt: s.updated_at ? new Date(s.updated_at).getTime() : 0,
    mindId: s.mind_id || null,
    sessionType: s.meta?.write_book
      ? "write_book"
      : ((s.session_type as SessionType) || "chat"),
    meta: s.meta || {},
    publicStatus: s.public_status || "private",
    publicHandle: s.public_handle || null,
    publicTitle: s.public_title || null,
  };
}

// ── Session CRUD ───────────────────────────────────────────────────────

/**
 * Cross-component signal that the session list changed (created / renamed /
 * deleted / public-status flip). The sidebar (ChatHistory) and /chats (ChatsList)
 * listen and refetch — restoring production's instant pill-text + public-dot
 * update without a navigation (renderChatHistory was called on every mutation).
 */
export const SESSIONS_CHANGED = "feynman:sessions-changed";
export function bumpSessions(): void {
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SESSIONS_CHANGED));
  }
}

/** GET /api/sessions → normalized list (newest first per server order). */
export async function listSessions(): Promise<Session[]> {
  const rows = await get<SessionRow[]>("/api/sessions");
  return (rows || []).map(normalizeSession);
}

/** GET /api/sessions/{id} → single session (no messages loaded yet). */
export async function getSession(id: string): Promise<Session> {
  const row = await get<SessionRow>(`/api/sessions/${encodeURIComponent(id)}`);
  return normalizeSession(row);
}

/** POST /api/sessions {title, session_type, mind_id?} → new session. */
export async function createSession(opts: {
  title?: string;
  sessionType?: SessionType;
  mindId?: string | null;
  meta?: Record<string, unknown>;
} = {}): Promise<Session> {
  const body: Record<string, unknown> = {
    title: opts.title || "New chat",
    session_type: opts.sessionType || (opts.mindId ? "mind" : "chat"),
  };
  if (opts.mindId) body.mind_id = opts.mindId;
  if (opts.meta) body.meta = opts.meta;
  const created = await post<SessionRow>("/api/sessions", body);
  return normalizeSession({ ...created, updated_at: created.updated_at });
}

/** DELETE /api/sessions/{id}. Swallows network errors (best-effort cleanup). */
export async function deleteSession(id: string): Promise<void> {
  try {
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, { method: "DELETE" });
  } catch (e) {
    // Match legacy: log + continue; the row is already gone from the UI.
    console.warn("Failed to delete session:", e);
  }
}

/** PATCH /api/sessions/{id} {title}. Best-effort (legacy fires-and-forgets). */
export async function renameSession(id: string, title: string): Promise<void> {
  try {
    await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ title }),
    });
  } catch {
    /* non-fatal */
  }
}

/**
 * PATCH /api/sessions/{id} {title?, meta?}. General-purpose update used by the
 * write-book flow to stamp `meta:{write_book, ai_book_id, agent_id}` so a reopen
 * can rehydrate the book (port of the PATCH calls in app.js startWriteBook /
 * _handleWriteBookMessage). Unlike renameSession this AWAITS + rethrows so
 * callers that depend on the persisted meta (resume) can react to failure.
 *
 * NOTE: the backend replaces meta_json wholesale (it does not merge), so callers
 * must pass the COMPLETE meta object they want persisted.
 */
export async function updateSession(
  id: string,
  patch: { title?: string; meta?: Record<string, unknown> },
): Promise<void> {
  const body: Record<string, unknown> = {};
  if (patch.title !== undefined) body.title = patch.title;
  if (patch.meta !== undefined) body.meta = patch.meta;
  await apiFetch(`/api/sessions/${encodeURIComponent(id)}`, {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

/** GET /api/sessions/{id}/messages → flattened Message[] (port of switchToSession). */
export async function loadMessages(id: string): Promise<Message[]> {
  const rows = await get<MessageRow[]>(
    `/api/sessions/${encodeURIComponent(id)}/messages`,
  );
  return (rows || []).map((m) => ({ role: m.role, content: m.content, ...(m.meta || {}) }));
}

/**
 * POST /api/sessions/{id}/messages {role, content, meta?}.
 *
 * Persists one message. The legacy app chains these per-session so writes
 * never race; here each ChatView keeps its own promise chain (see persistChain).
 */
export async function saveMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const body: Record<string, unknown> = { role, content: content || "" };
  if (meta && Object.keys(meta).length) body.meta = meta;
  await post(`/api/sessions/${encodeURIComponent(sessionId)}/messages`, body);
}

/**
 * Per-session serialized save queue (port of _sessionSaveChains). Keeps
 * message writes in order and isolates failures so one bad write doesn't drop
 * later ones. Errors are logged, not thrown (UI already rendered the message).
 */
const _saveChains = new Map<string, Promise<unknown>>();
export function queueSaveMessage(
  sessionId: string,
  role: MessageRole,
  content: string,
  meta?: Record<string, unknown>,
): Promise<void> {
  const prev = _saveChains.get(sessionId) || Promise.resolve();
  const next = prev
    .catch(() => {})
    .then(() => saveMessage(sessionId, role, content, meta).catch((e) => {
      console.warn("Failed to save message:", e);
    }));
  _saveChains.set(sessionId, next);
  next.finally(() => {
    if (_saveChains.get(sessionId) === next) _saveChains.delete(sessionId);
  });
  return next as Promise<void>;
}

// ── The blocking chat call ─────────────────────────────────────────────

export interface SendChatArgs {
  message: string;
  agentIds?: string[];
  bookContext?: { title: string; author: string }[];
  history?: { role: string; content: string }[];
  signal?: AbortSignal;
}

/**
 * POST /api/chat → {answer, sources, references, usage}. BLOCKING.
 *
 * Mirrors sendGlobalChat's body assembly: agent_ids + book_context only sent
 * when books are selected; history is the prior user/assistant turns.
 */
export async function sendChat(args: SendChatArgs): Promise<ChatResponse> {
  const body: Record<string, unknown> = { message: args.message };
  if (args.agentIds?.length) body.agent_ids = args.agentIds;
  if (args.bookContext?.length) body.book_context = args.bookContext;
  if (args.history?.length) body.history = args.history;
  return apiFetch<ChatResponse>("/api/chat", {
    method: "POST",
    body: JSON.stringify(body),
    signal: args.signal,
  });
}

/** Map a ChatResponse into the assistant Message stored/rendered in the UI. */
export function responseToAssistant(data: ChatResponse): {
  sources: Source[];
  opts: MessageOpts;
} {
  const sources: Source[] = (data.sources || []).map((s) => ({
    id: s.agent_id,
    name: s.agent_name,
  }));
  const opts: MessageOpts = {};
  if (data.references?.length) opts.references = data.references;
  if (data.web_sources?.length) opts.webSources = data.web_sources;
  if (data.grounded) opts.grounded = true;
  if (data.usage) opts.usage = data.usage;
  // NOTE: skill_used is intentionally NOT mapped here. The global /api/chat
  // response never carries it (only /api/agents/{id}/chat does), and production
  // sendGlobalChat builds msgOpts without skill_used — so the global path must
  // not surface a skill badge (L1 parity). The book-chat path routes through
  // the same global endpoint in the port, so there is no book mapping to keep.
  return { sources, opts };
}

/**
 * Translate a chat error into a user-facing bubble string. The legacy app
 * special-cases the missing-LLM-key case ("No available provider") which is the
 * common failure in dev with no API keys set.
 */
export function chatErrorMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  // ApiError stuffs the server JSON on `.body`; check it too.
  const detail =
    typeof (err as { body?: { detail?: string } })?.body?.detail === "string"
      ? (err as { body: { detail: string } }).body.detail
      : "";
  const haystack = `${msg} ${detail}`;
  if (haystack.includes("No available provider")) {
    return "No LLM API key configured. Please add GEMINI_API_KEY, OPENAI_API_KEY, or KIMI_API_KEY to your .env file and restart the server.";
  }
  return "Error: " + (detail || msg);
}
