/**
 * Shared design tokens + helpers for the unified social-share cards
 * (`/api/og`). One editorial system across every share node — adapted from
 * Noosphere's white-card / serif-hero / hairline-footer doc-row card, but with
 * Feynman's distinctive identity assets as the hero (a mind's portrait + voice,
 * a book's cover, an answer's attribution).
 *
 * Pure module: NO React, NO server imports. Safe to pull into the Satori route
 * and anywhere else. Palettes mirror the in-app cover/avatar colors so a share
 * card matches what the user sees in the product.
 */

export const OG_SIZE = { width: 1200, height: 630 } as const;

// ── Editorial palette (light "paper" card, ink type) ───────────────────────
export const PAPER_BG = "linear-gradient(180deg, #fdfcfa 0%, #f4f2ec 100%)";
export const INK = "#1d1d1f";
export const INK_SOFT = "#3d3b39";
export const INK_MUTE = "#6e6e73";
export const HAIRLINE = "rgba(0,0,0,0.10)";
export const BRAND = "#0071e3";
// Chat-with CTA color — a deep, elegant ink-navy (not pure black, not the loud
// brand blue). Share cards are always light, so the pill uses this directly;
// the live on-page buttons mirror it via the --chat-cta-* CSS tokens (which go
// white in dark mode). Keep this hex in sync with --chat-cta-bg in app.css.
export const CHAT_CTA = "#2b3553";

// ── Book cover colors — verbatim from lib/books.ts (so the share cover matches
//    the in-app cover for the same title). AI books use the purple gradient. ──
export const BOOK_PALETTE = [
  "#264653", "#2a9d8f", "#e76f51", "#457b9d", "#6d597a",
  "#355070", "#b56576", "#0077b6", "#588157", "#9b2226",
];
export const AI_BOOK_GRADIENT = "linear-gradient(135deg,#667eea 0%,#764ba2 100%)";

// ── Mind avatar colors — the hex of og_image.py's MIND_COLORS RGB tuples, so a
//    generated glyph matches the backend/app avatar color for the same name. ──
export const MIND_PALETTE = [
  "#428585", "#855e42", "#5e4285", "#425e85", "#85425e",
  "#42855e", "#786450", "#507864", "#645078",
];

/** Deterministic mind accent — sum of char codes (matches og_image.py). */
export function mindAccent(name: string): string {
  let h = 0;
  for (const c of name || "") h += c.charCodeAt(0);
  return MIND_PALETTE[h % MIND_PALETTE.length];
}

/** Mind initials — first + last initial (matches og_image.py _mind_initials). */
export function mindInitials(name: string): string {
  const parts = (name || "").trim().split(/\s+/).filter(Boolean);
  if (parts.length >= 2) {
    return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
  }
  return ((name || "?").slice(0, 2)).toUpperCase();
}

/** Solid accent for a book (FNV-ish title hash — matches books.ts coverStyle). */
export function bookAccent(title: string, isAi = false): string {
  if (isAi) return AI_BOOK_GRADIENT;
  let h = 0;
  for (let i = 0; i < (title || "").length; i++) {
    h = ((h << 5) - h + title.charCodeAt(i)) | 0;
  }
  return BOOK_PALETTE[Math.abs(h) % BOOK_PALETTE.length];
}

/** Cover initials — first letters of up to TWO words >2 chars (books.ts). */
export function bookInitials(title: string): string {
  return (title || "")
    .split(/[\s:—]+/)
    .filter((w) => w.length > 2)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join("") || (title || "?").slice(0, 2).toUpperCase();
}

/**
 * Collapse whitespace and clip to ~n chars on a word boundary, adding an
 * ellipsis. Satori has no line-clamp, so every text slot is bounded here in JS
 * (same approach as Noosphere's server-side _smart_excerpt).
 */
export function clip(text: string, n: number): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= n) return t;
  const cut = t.slice(0, n);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trimEnd() + "…";
}
