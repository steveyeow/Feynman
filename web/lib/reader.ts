/**
 * Reader data layer. Faithful port of the legacy reader's data flow
 * (renderReader in app.js): GET /api/agents/{id}/read returns either AI-book
 * chapters or reassembled paragraphs for an uploaded/catalog book; we normalize
 * both into a flat list of "sections" the Reader renders sequentially in a
 * scrollable serif column.
 *
 * NOTE on the API contract: the brief sketched `/read → {chunks:[{index,text}]}`,
 * but the live FastAPI endpoint (app/main.py `api_read_book`) returns the richer
 * shape below. We honor the real endpoint — it is the source of truth — and
 * collapse it to a clean reading model here.
 */

import { get, ApiError } from "@/lib/api";

// ── Raw API shapes (mirror app/main.py api_read_book) ──────────────────
export interface RawReaderChapter {
  number: number;
  title: string;
  content: string; // markdown-ish
  word_count?: number;
}

export interface RawReaderResponse {
  type: "ai_book" | "book";
  content_tier: "full" | "preview";
  title: string;
  subtitle?: string;
  author?: string;
  total_words: number;
  chapters?: RawReaderChapter[]; // AI books
  paragraphs?: string[]; // regular books
}

// ── Normalized reading model the Reader component consumes ─────────────
/** One contiguous block of reading content rendered as a serif HTML section. */
export interface ReaderSection {
  /** Chapter number for AI books / detected sections; 0 when there are none. */
  chapter: number | null;
  /** Chapter title, when this section opens a chapter. */
  title?: string;
  /** Pre-rendered, escaped HTML for the body (paragraphs + inline emphasis). */
  html: string;
}

export interface BookContent {
  type: "ai_book" | "book";
  contentTier: "full" | "preview";
  title: string;
  subtitle: string;
  /** Display author, e.g. "Jane · AI" or a real author name. */
  author: string;
  totalWords: number;
  /** ~minutes to read at 230 wpm (legacy parity), min 1. */
  readMinutes: number;
  sections: ReaderSection[];
  /** True when the book has structured chapters (drives the TOC). */
  hasChapters: boolean;
}

export interface BookMeta {
  id: string;
  name: string;
  author: string;
  type: string;
  status: string;
}

// ── HTML escaping (matches legacy esc()) ───────────────────────────────
const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};
export function esc(s: string): string {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/**
 * Render the book's lightweight markdown to safe HTML — port of
 * _renderReaderMarkdown in app.js. Supports #/##/### headings, blank-line
 * paragraph splitting, and **bold** / *italic* inline emphasis. All text is
 * escaped before emphasis substitution, so the only HTML produced is the tags
 * we generate (no injection from book content).
 */
export function renderReaderMarkdown(text: string): string {
  if (!text) return "";
  const out: string[] = [];
  for (let block of text.split(/\n{2,}/)) {
    block = block.trim();
    if (!block) continue;
    if (block.startsWith("### ")) {
      out.push(`<h4>${esc(block.slice(4))}</h4>`);
      continue;
    }
    if (block.startsWith("## ")) {
      out.push(`<h3>${esc(block.slice(3))}</h3>`);
      continue;
    }
    if (block.startsWith("# ")) {
      out.push(`<h2>${esc(block.slice(2))}</h2>`);
      continue;
    }
    let h = esc(block);
    h = h.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    h = h.replace(/\*(.+?)\*/g, "<em>$1</em>");
    // Preserve single newlines inside a paragraph as soft breaks.
    h = h.replace(/\n/g, "<br/>");
    out.push(`<p>${h}</p>`);
  }
  return out.join("");
}

function paragraphsToHtml(paragraphs: string[]): string {
  return paragraphs
    .filter((p) => p && p.trim())
    .map((p) => `<p>${esc(p.trim())}</p>`)
    .join("");
}

function normalize(raw: RawReaderResponse): BookContent {
  const sections: ReaderSection[] = [];
  const isAI = raw.type === "ai_book";
  const chapters = raw.chapters || [];
  const hasChapters = isAI && chapters.length > 0;

  if (hasChapters) {
    for (const c of chapters) {
      if (!c.content) continue;
      sections.push({
        chapter: c.number,
        title: c.title,
        html: renderReaderMarkdown(c.content),
      });
    }
  } else if (raw.paragraphs && raw.paragraphs.length) {
    sections.push({ chapter: null, html: paragraphsToHtml(raw.paragraphs) });
  }

  const totalWords = raw.total_words || 0;
  return {
    type: raw.type,
    contentTier: raw.content_tier,
    title: raw.title || "Untitled",
    subtitle: raw.subtitle || "",
    author: raw.author || "",
    totalWords,
    readMinutes: Math.max(1, Math.round(totalWords / 230)),
    sections,
    hasChapters,
  };
}

/**
 * Fetch + normalize reading content. Throws ApiError (with `.status`) so the
 * caller can distinguish 404 (no content / not found) from other failures.
 */
export async function getBookContent(id: string): Promise<BookContent> {
  const raw = await get<RawReaderResponse>(
    `/api/agents/${encodeURIComponent(id)}/read`,
  );
  return normalize(raw);
}

/** Lightweight agent meta for the topbar title / share. */
export async function getBookMeta(id: string): Promise<BookMeta> {
  const a = await get<{
    id: string;
    name?: string;
    source?: string;
    type?: string;
    status?: string;
    meta?: { author?: string; title?: string };
  }>(`/api/agents/${encodeURIComponent(id)}`);
  return {
    id: a.id,
    name: a.meta?.title || a.name || "Untitled",
    author: a.meta?.author || a.source || "",
    type: a.type || "",
    status: a.status || "",
  };
}

/**
 * Related "try asking" questions for the right sidebar. Tolerates a missing
 * endpoint / empty result — returns [] rather than throwing.
 */
export async function getQuestions(id: string): Promise<string[]> {
  try {
    const r = await get<{ questions?: string[] }>(
      `/api/agents/${encodeURIComponent(id)}/questions`,
    );
    return (r.questions || []).filter((q) => q && q.trim());
  } catch {
    return [];
  }
}

export { ApiError };
