/**
 * Minds-join data layer — suggestMinds() + panelChat().
 *
 * Ports the two network endpoints behind the "great minds want to join" flow
 * in app.js (_inviteMindsToChat, ~2904-3143). The consent UX + orchestration
 * lives in ChatView/MindConsent; this file is just the typed API surface.
 */

import { post } from "@/lib/api";

export interface SuggestedMind {
  id?: string;
  name: string;
  era?: string;
  domain?: string;
  bio_summary?: string;
}

export interface SuggestMindsArgs {
  topic?: string;
  bookTitle?: string;
  bookAuthor?: string;
  exclude?: string[];
  count?: number;
}

export interface SuggestMindsResponse {
  minds: SuggestedMind[];
}

/**
 * POST /api/minds/suggest → minds that would add a fresh perspective.
 * `exclude` keeps already-present minds out of the suggestions.
 */
export async function suggestMinds(
  args: SuggestMindsArgs,
): Promise<SuggestedMind[]> {
  const body: Record<string, unknown> = {
    count: args.count ?? 1,
    exclude: args.exclude || [],
  };
  if (args.bookTitle) {
    body.book_title = args.bookTitle;
    body.book_author = args.bookAuthor || "";
  } else if (args.topic) {
    body.topic = args.topic.slice(0, 100);
  }
  const data = await post<SuggestMindsResponse>("/api/minds/suggest", body);
  return data.minds || [];
}

export interface MaterializedMind {
  id: string;
  name: string;
}

/**
 * POST /api/minds/generate → mint a real mind (with an id) from a suggestion's
 * {name, era, domain}. The suggest endpoint returns NO id, so each suggestion
 * must be materialized here before it can join a panel-chat. Returns null on
 * failure (the caller then falls back to a seed mind). `link_works:false`
 * mirrors the production call (don't attach books during auto-join).
 */
export async function generateMind(s: SuggestedMind): Promise<MaterializedMind | null> {
  try {
    const m = await post<{ id?: string; name?: string }>("/api/minds/generate", {
      name: s.name,
      era: s.era || "",
      domain: s.domain || "",
      link_works: false,
    });
    if (m?.id && m.name) return { id: m.id, name: m.name };
    return null;
  } catch {
    return null;
  }
}

export interface PanelChatArgs {
  message: string;
  mindIds: string[];
  invitedMindIds?: string[];
  bookContext?: { title: string; author: string }[];
  agentIds?: string[];
  history?: { role: string; content: string }[];
  targetMinds?: string[];
  signal?: AbortSignal;
}

export interface MindResponse {
  mind_id: string;
  mind_name: string;
  response: string;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
  };
}

export interface PanelChatResponse {
  responses: MindResponse[];
}

/**
 * POST /api/minds/panel-chat → each invited mind's reply.
 *
 * `invited_mind_ids` flags minds new to the conversation (they get a join
 * notice). `target_minds` restricts who answers when the user @-mentioned
 * specific minds. Mirrors the panelBody assembly in runPanelChat.
 */
export async function panelChat(args: PanelChatArgs): Promise<MindResponse[]> {
  const body: Record<string, unknown> = {
    message: args.message,
    mind_ids: args.mindIds,
  };
  if (args.history?.length) body.history = args.history;
  if (args.bookContext?.length) body.book_context = args.bookContext;
  if (args.agentIds?.length) body.agent_ids = args.agentIds;
  if (args.invitedMindIds?.length) body.invited_mind_ids = args.invitedMindIds;
  if (args.targetMinds?.length) body.target_minds = args.targetMinds;
  const data = await post<PanelChatResponse>("/api/minds/panel-chat", body, {
    signal: args.signal,
  });
  // A response that starts with "[" is the model echoing the prompt scaffold,
  // not a real answer — the legacy app filters these out. We keep them here and
  // let the caller filter so it can distinguish "no real replies" (error) from
  // "no responses at all".
  return data.responses || [];
}

/** True when a panel response is a real answer (not an echoed "[Name]:" stub). */
export function isRealMindReply(r: MindResponse): boolean {
  return !!r.response && !r.response.startsWith("[");
}
