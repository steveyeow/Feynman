"use client";

/**
 * Renders the chat transcript: user / assistant / mind / system-notice rows.
 *
 * Ported from appendMsg, appendMindMsg, appendJoinNotice in app.js. Reuses the
 * legacy classes (.chat-message.user/.assistant, .feynman-msg-*, .mind-msg-*,
 * .chat-system-notice, .msg-references, .cite-link …) so styles apply 1:1.
 *
 * Citation parsing: assistant text has [1], [1, 2] turned into hover
 * superscripts. Hover shows the reference snippet in a popover (net-new — the
 * legacy scrolled to a refs block; we keep that refs block too, below the
 * answer, and add the hover affordance the scope asks for).
 */

import { useRef, useState } from "react";
import type { Message, Reference, WebSource } from "@/lib/chat";
import { renderMarkdown, esc, mindColor, mindInitials } from "./markdown";
import styles from "./MessageList.module.css";

function FeynmanGlyph() {
  return (
    <svg width="18" height="18" viewBox="0 0 64 64" fill="none" aria-hidden="true">
      <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="30" r="3.5" fill="currentColor" />
      <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** macOS-style share glyph (box + up arrow), matching the session-share icon. */
function ShareGlyph() {
  return (
    <svg
      width="13"
      height="13"
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

/** Hover "Share" action under an assistant/mind answer (per-turn share entry). */
function ShareAnswerAction({ onClick }: { onClick: () => void }) {
  return (
    <div className={styles.msgActions}>
      <button
        type="button"
        className={styles.shareMsgBtn}
        onClick={onClick}
        aria-label="Share this answer"
        title="Share this answer"
      >
        <ShareGlyph />
        <span>Share</span>
      </button>
    </div>
  );
}

/**
 * Build assistant body HTML with citation markers replaced by a sentinel we can
 * tokenize into React nodes (so the hover popover is a real component, not an
 * onclick string). Returns an array of string | citation-token.
 */
type Token = { kind: "html"; html: string } | { kind: "cite"; num: number };

function tokenizeCitations(
  html: string,
  refsByIndex: Map<number, Reference>,
  webSrcs: WebSource[],
): Token[] {
  if (!refsByIndex.size && !webSrcs.length) return [{ kind: "html", html }];
  const tokens: Token[] = [];
  // Match [1], [1, 2], [3,4,5] — same pattern as the legacy.
  const re = /\[(\d+(?:\s*,\s*\d+)*)\]/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html)) !== null) {
    const nums = m[1].split(/\s*,\s*/).map((n) => parseInt(n, 10));
    // Production wraps EVERY [n,...] group whenever refs/web exist — an
    // unresolved number renders as a bare <sup> (via Citation's fallback), never
    // raw "[N]" text (L7 parity). So we no longer skip non-resolvable groups.
    if (m.index > last) tokens.push({ kind: "html", html: html.slice(last, m.index) });
    tokens.push({ kind: "html", html: "[" });
    nums.forEach((num, i) => {
      if (i > 0) tokens.push({ kind: "html", html: ", " });
      tokens.push({ kind: "cite", num });
    });
    tokens.push({ kind: "html", html: "]" });
    last = m.index + m[0].length;
  }
  if (last < html.length) tokens.push({ kind: "html", html: html.slice(last) });
  return tokens;
}

function Citation({
  num,
  ref,
  web,
  onJump,
}: {
  num: number;
  ref?: Reference;
  web?: WebSource;
  onJump?: (num: number) => void;
}) {
  const [open, setOpen] = useState(false);
  if (ref) {
    return (
      <span
        className={styles.cite}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
      >
        {/* Click jumps to the reference snippet below (scoped to this message),
            in addition to the hover popover — restores app.js scrollIntoView. */}
        <a
          className="cite-link"
          href="#"
          onClick={(e) => {
            e.preventDefault();
            onJump?.(num);
          }}
        >
          <sup>{num}</sup>
        </a>
        {open && (
          <span className={styles.citePopover} role="tooltip">
            <span className={styles.citePopoverBook}>{ref.book}</span>
            <span className={styles.citePopoverSnippet}>{ref.snippet}</span>
          </span>
        )}
      </span>
    );
  }
  if (web) {
    return (
      <a
        className="cite-link"
        href={web.url}
        target="_blank"
        rel="noopener noreferrer"
        title={web.title || web.url}
      >
        <sup>{num}</sup>
      </a>
    );
  }
  return <sup>{num}</sup>;
}

/** Friendly labels for the skill badge (port of app.js 2335 — exact strings). */
const SKILL_LABELS: Record<string, string> = {
  rag: "RAG",
  content_fetch: "Web APIs",
  web_search: "Web Search",
  llm_knowledge: "LLM Knowledge",
};

function AssistantMessage({
  msg,
  index,
  onShare,
}: {
  msg: Message;
  index: number;
  onShare?: (index: number) => void;
}) {
  const refs = msg.opts?.references || [];
  const webSrcs = msg.opts?.webSources || [];
  const usage = msg.opts?.usage;
  const skillUsed = msg.opts?.skillUsed;
  const refsByIndex = new Map<number, Reference>(refs.map((r) => [Number(r.index), r]));
  const cleaned = String(msg.content ?? "")
    .replace(/<div\b[^>]*>|<\/div>/gi, "")
    .trim();
  const html = renderMarkdown(cleaned);
  const tokens = tokenizeCitations(html, refsByIndex, webSrcs);

  // Group references by book (port of the grouped-refs block in appendMsg).
  const grouped: { book: string; chunks: Reference[] }[] = [];
  const bookMap = new Map<string, { book: string; chunks: Reference[] }>();
  for (const r of refs) {
    const existing = bookMap.get(r.book);
    if (existing) existing.chunks.push(r);
    else {
      const entry = { book: r.book, chunks: [r] };
      bookMap.set(r.book, entry);
      grouped.push(entry);
    }
  }

  // Scope the #ref-N lookup to THIS message (every assistant message emits its
  // own id="ref-1", id="ref-2"… so a document-level lookup would jump to the
  // wrong message's row).
  const rootRef = useRef<HTMLDivElement>(null);
  const jumpToRef = (num: number) => {
    rootRef.current
      ?.querySelector(`#ref-${num}`)
      ?.scrollIntoView({ behavior: "smooth", block: "center" });
  };

  return (
    <div className="chat-message assistant" dir="auto" ref={rootRef}>
      <div className="feynman-msg-avatar">
        <FeynmanGlyph />
      </div>
      <div className="feynman-msg-body">
        <div className="feynman-msg-name">Feynman</div>
        <div className="msg-content" dir="auto">
          {tokens.map((t, i) =>
            t.kind === "html" ? (
              <span key={i} dangerouslySetInnerHTML={{ __html: t.html }} />
            ) : (
              <Citation
                key={i}
                num={t.num}
                ref={refsByIndex.get(t.num)}
                web={!refsByIndex.has(t.num) ? webSrcs[t.num - 1] : undefined}
                onJump={jumpToRef}
              />
            ),
          )}
        </div>

        {grouped.length > 0 && (
          <div className="msg-references">
            <div className="refs-header">References</div>
            {grouped.map((g, gi) => (
              <RefGroup key={gi} group={g} multi={g.chunks.length > 1} />
            ))}
          </div>
        )}

        {webSrcs.length > 0 && (
          <div className="web-sources">
            {webSrcs.map((src, i) => (
              <a
                key={i}
                className="web-source-link"
                href={src.url}
                target="_blank"
                rel="noopener noreferrer"
              >
                <span className="web-source-num">{i + 1}</span> {src.title || src.url}
              </a>
            ))}
          </div>
        )}

        {skillUsed && skillUsed !== "none" && (
          <span className={`skill-badge skill-${skillUsed}`}>
            {SKILL_LABELS[skillUsed] || skillUsed}
          </span>
        )}

        {usage && (usage.total_tokens || 0) > 0 && (
          <div
            className="token-usage"
            title={`Input: ${usage.input_tokens} · Output: ${usage.output_tokens}`}
          >
            {usage.total_tokens} tokens
          </div>
        )}
        {onShare && <ShareAnswerAction onClick={() => onShare(index)} />}
      </div>
    </div>
  );
}

function RefGroup({
  group,
  multi,
}: {
  group: { book: string; chunks: Reference[] };
  multi: boolean;
}) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const nums = group.chunks.map((c) => c.index);
  return (
    <div className="ref-group">
      <div className="ref-group-header">
        {nums.map((n) => (
          <span className="ref-num" key={n}>
            {n}
          </span>
        ))}
        <span className="ref-book">{group.book}</span>
      </div>
      <div className="ref-snippets">
        {group.chunks.map((c) => {
          const hasFull =
            !!c.full_text &&
            c.full_text.length > (c.snippet || "").replace(/\.\.\.$/, "").length;
          const isExpanded = expanded.has(c.index);
          return (
            <div
              key={c.index}
              className={`ref-snippet-row${hasFull ? " expandable" : ""}${isExpanded ? " expanded" : ""}`}
              id={`ref-${c.index}`}
              onClick={() => {
                if (!hasFull) return;
                setExpanded((prev) => {
                  const next = new Set(prev);
                  if (next.has(c.index)) next.delete(c.index);
                  else next.add(c.index);
                  return next;
                });
              }}
            >
              {multi && <span className="ref-snippet-num">{c.index}</span>}
              <span className="ref-snippet">
                {isExpanded && c.full_text ? c.full_text : c.snippet}
              </span>
              {hasFull && (
                <svg
                  className="ref-expand-icon"
                  width="12"
                  height="12"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function UserMessage({
  msg,
  knownMindNames = [],
}: {
  msg: Message;
  knownMindNames?: string[];
}) {
  const cleaned = String(msg.content ?? "")
    .replace(/<div\b[^>]*>|<\/div>/gi, "")
    .trim();
  const contextBooks = msg.contextBooks || [];
  const contextMinds = msg.contextMinds || [];
  // Inline-tag any @Name matching a known mind in this chat (context ∪ active ∪
  // minds that have spoken) — not just contextMinds (M3 parity with
  // renderUserMsgWithMentions' allMinds union). Context minds not typed inline
  // are still prefixed (the legacy leading-chip behavior).
  const contextNames = contextMinds.map((m) => m.name);
  const inlineNames = [...new Set([...contextNames, ...knownMindNames])];
  const html = renderUserHtml(cleaned, inlineNames, contextNames);
  return (
    <div className="chat-message user" dir="auto">
      {contextBooks.length > 0 && (
        <div className="msg-context-books">
          {contextBooks.map((b, i) => (
            <span className="book-tag" key={i} title={b.title}>
              {b.title}
            </span>
          ))}
        </div>
      )}
      <span dangerouslySetInnerHTML={{ __html: html }} />
    </div>
  );
}

/** Escape + wrap @Mentions in tags (subset of renderUserMsgWithMentions). */
function renderUserHtml(
  text: string,
  inlineNames: string[],
  contextNames: string[],
): string {
  let html = esc(text);
  // Inline tagging: longest-first so a shorter name can't swallow a longer one.
  const names = [...inlineNames].sort((a, b) => b.length - a.length);
  for (const name of names) {
    const escaped = esc(name).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const pattern = new RegExp("@" + escaped + "(?=\\s|$|&)", "g");
    html = html.replace(pattern, `<span class="mention-tag">@${esc(name)}</span>`);
  }
  // Leading context mentions: minds attached as context but NOT typed inline
  // get prefixed (the legacy leading-chip behavior) — scoped to contextNames,
  // never the full known set.
  const escText = esc(text);
  const prefixed = contextNames
    .filter(
      (n) =>
        !new RegExp("@" + esc(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).test(escText),
    )
    .map((n) => `<span class="mention-tag">@${esc(n)}</span>`)
    .join(" ");
  return prefixed ? prefixed + " " + html : html;
}

function MindMessage({
  msg,
  index,
  onShare,
}: {
  msg: Message;
  index: number;
  onShare?: (index: number) => void;
}) {
  const name = msg.mindName || "";
  const raw = String(msg.content ?? "");
  const prefixRe = new RegExp(
    `^\\[${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\]:\\s*`,
    "i",
  );
  const cleaned = raw
    .replace(/<div\b[^>]*>|<\/div>/gi, "")
    .replace(prefixRe, "")
    .trim();
  const usage = msg.usage;
  return (
    <div className="chat-message mind-message" dir="auto">
      <div className="mind-msg-avatar" style={{ background: mindColor(name) }}>
        {mindInitials(name)}
      </div>
      <div className="mind-msg-body">
        <div className="mind-msg-name">{name}</div>
        <div
          className="msg-content mind-msg-content"
          dir="auto"
          dangerouslySetInnerHTML={{ __html: renderMarkdown(cleaned) }}
        />
        {usage && (usage.total_tokens || 0) > 0 && (
          <div
            className="token-usage"
            title={`Input: ${usage.input_tokens} · Output: ${usage.output_tokens}`}
          >
            {usage.total_tokens} tokens
          </div>
        )}
        {onShare && <ShareAnswerAction onClick={() => onShare(index)} />}
      </div>
    </div>
  );
}

function ErrorNotice({ text }: { text: string }) {
  return (
    <div className="chat-system-notice mind-error-notice">
      <div className="join-notice-inner">
        <span>{text}</span>
      </div>
    </div>
  );
}

function JoinNotice({ names }: { names: string[] }) {
  const label =
    names.length === 1
      ? names[0]
      : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  return (
    <div className="chat-system-notice mind-join-notice">
      <div className="join-notice-inner">
        {names.map((n) => (
          <span className="join-avatar" key={n} style={{ background: mindColor(n) }}>
            {mindInitials(n)}
          </span>
        ))}
        <span>{label} joined the discussion</span>
      </div>
    </div>
  );
}

export default function MessageList({
  messages,
  knownMindNames = [],
  onShareMessage,
}: {
  messages: Message[];
  knownMindNames?: string[];
  /** When provided, each assistant/mind answer shows a hover "Share" action
   *  that publishes that single turn (index = position in this list, which
   *  matches the persisted transcript order the backend indexes by). */
  onShareMessage?: (index: number) => void;
}) {
  return (
    <>
      {messages.map((msg, i) => {
        if (msg.role === "mind")
          return <MindMessage key={i} msg={msg} index={i} onShare={onShareMessage} />;
        if (msg.role === "system-notice")
          return <JoinNotice key={i} names={msg.mindNames || []} />;
        if (msg.role === "error-notice")
          return <ErrorNotice key={i} text={msg.content} />;
        if (msg.role === "assistant")
          return <AssistantMessage key={i} msg={msg} index={i} onShare={onShareMessage} />;
        return <UserMessage key={i} msg={msg} knownMindNames={knownMindNames} />;
      })}
    </>
  );
}
