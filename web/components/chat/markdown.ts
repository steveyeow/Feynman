/**
 * Tiny markdown → HTML renderer, ported 1:1 from renderMarkdown() in app.js
 * (~5617). Deliberately minimal (headings, lists, bold/italic, links, code) so
 * assistant/mind output matches the legacy chat exactly. Output is consumed via
 * dangerouslySetInnerHTML after citation linking; every interpolation is
 * escaped here.
 */

export function esc(s: string | null | undefined): string {
  if (!s) return "";
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function renderMarkdown(text: string): string {
  if (!text) return "";
  const codeBlocks: string[] = [];
  let s = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    codeBlocks.push("<pre><code>" + esc(code) + "</code></pre>");
    return "\x00CB" + (codeBlocks.length - 1) + "\x00";
  });
  const inlineCodes: string[] = [];
  s = s.replace(/`([^`]+)`/g, (_m, code) => {
    inlineCodes.push("<code>" + esc(code) + "</code>");
    return "\x00IC" + (inlineCodes.length - 1) + "\x00";
  });

  function inline(t: string): string {
    t = esc(t);
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/\*(.+?)\*/g, "<em>$1</em>");
    t = t.replace(
      /\[([^\]]+)\]\(([^\s؀-ۿ)]+)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>',
    );
    t = t.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[+i]);
    return t;
  }

  const lines = s.split("\n");
  const out: string[] = [];
  let inList = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed.startsWith("### ")) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("<h4>" + inline(trimmed.slice(4)) + "</h4>");
      continue;
    }
    if (trimmed.startsWith("## ")) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("<h3>" + inline(trimmed.slice(3)) + "</h3>");
      continue;
    }
    if (trimmed.startsWith("# ")) {
      if (inList) { out.push("</ul>"); inList = false; }
      out.push("<h2>" + inline(trimmed.slice(2)) + "</h2>");
      continue;
    }
    const ulMatch = trimmed.match(/^[-*]\s+(.+)$/);
    if (ulMatch) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push("<li>" + inline(ulMatch[1]) + "</li>");
      continue;
    }
    const olMatch = trimmed.match(/^\d+[.)]\s+(.+)$/);
    if (olMatch) {
      if (!inList) { out.push("<ul>"); inList = true; }
      out.push("<li>" + inline(olMatch[1]) + "</li>");
      continue;
    }
    if (inList) { out.push("</ul>"); inList = false; }
    if (trimmed.startsWith("\x00CB")) { out.push(trimmed); continue; }
    if (!trimmed) { out.push("<br>"); continue; }
    out.push("<p>" + inline(trimmed) + "</p>");
  }
  if (inList) out.push("</ul>");

  let html = out.join("\n");
  html = html.replace(/\x00CB(\d+)\x00/g, (_m, i) => codeBlocks[+i]);
  html = html.replace(/\x00IC(\d+)\x00/g, (_m, i) => inlineCodes[+i]);
  return html;
}

// ── Mind avatar helpers (port of mindColor / mindInitials) ──────────────

const MIND_COLORS = [
  "#6d597a", "#355070", "#264653", "#2a9d8f", "#e76f51",
  "#b56576", "#0077b6", "#588157", "#9b2226", "#457b9d",
];

export function mindColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return MIND_COLORS[Math.abs(h) % MIND_COLORS.length];
}

export function mindInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => (w[0] || "").toUpperCase())
    .join("");
}
