/* eslint-disable @next/next/no-img-element */
/**
 * The unified share-card visual system, rendered by Satori in `/api/og`.
 *
 * One editorial language across every node — white "paper" card, Georgia serif
 * hero, hairline footer with a small identity mark + `feynman.wiki` wordmark
 * (the Noosphere doc-row pattern). What changes per node is the HERO, always a
 * Feynman-distinctive asset:
 *   - Mind        → portrait + first-person voice
 *   - Book        → cover + title/author
 *   - Answer      → question headline + answer, with WHO answered (attribution)
 *   - Book Q&A    → question + cited passage, attributed to the book cover
 *   - Mind essay  → "{Mind} on {Topic}" op-ed
 *   - Topic       → masthead + a curated-shelf collage
 *   - Discussion  → a two-turn conversation preview
 *
 * Satori rules observed throughout: every element with >1 child sets
 * display:flex; all text is bounded in JS (no line-clamp); images are data
 * URIs with explicit width/height.
 */
import type { ReactNode } from "react";
import {
  PAPER_BG,
  INK,
  INK_SOFT,
  INK_MUTE,
  HAIRLINE,
  clip,
} from "@/lib/og/theme";

const FONT = "Georgia";

// ── Primitives ──────────────────────────────────────────────────────────────

function FeynmanMark({ color, size }: { color: string; size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 21 L12 9 L21 21" />
      <path d="M12 9 C 13.4 5.6, 10.6 4.4, 12 2" />
      <circle cx="12" cy="9" r="1.7" fill={color} stroke="none" />
    </svg>
  );
}

function Wordmark() {
  return (
    <div style={{ display: "flex", alignItems: "center" }}>
      <FeynmanMark color={INK} size={22} />
      <div style={{ display: "flex", fontSize: 21, color: INK, marginLeft: 10, fontFamily: FONT }}>
        feynman.wiki
      </div>
    </div>
  );
}

function FooterSimple({ left }: { left: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `1px solid ${HAIRLINE}`, paddingTop: 24, marginTop: 28 }}>
      <div style={{ display: "flex", fontSize: 20, color: INK_MUTE, fontFamily: FONT, fontStyle: "italic" }}>
        {clip(left, 64)}
      </div>
      <Wordmark />
    </div>
  );
}

function FooterIdentity({ glyph, name, label }: { glyph: ReactNode; name: string; label: string }) {
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", borderTop: `1px solid ${HAIRLINE}`, paddingTop: 22, marginTop: 26 }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        {glyph}
        <div style={{ display: "flex", flexDirection: "column", marginLeft: 16 }}>
          <div style={{ display: "flex", fontSize: 23, fontWeight: 700, color: INK, fontFamily: FONT }}>
            {clip(name, 40)}
          </div>
          <div style={{ display: "flex", fontSize: 15, color: INK_MUTE, marginTop: 3, fontFamily: FONT }}>
            {clip(label, 52)}
          </div>
        </div>
      </div>
      <Wordmark />
    </div>
  );
}

function Avatar({ src, initials, accent, size }: { src: string | null; initials: string; accent: string; size: number }) {
  if (src) {
    return (
      <div style={{ display: "flex", width: size, height: size, borderRadius: size, overflow: "hidden", border: `1px solid ${HAIRLINE}` }}>
        <img src={src} width={size} height={size} style={{ width: size, height: size, objectFit: "cover" }} alt="" />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: size, height: size, borderRadius: size, background: accent, color: "#fff", fontSize: Math.round(size * 0.4), fontWeight: 700, fontFamily: FONT }}>
      {initials}
    </div>
  );
}

function BookCover({ src, title, author, bg, w = 198, h = 290 }: { src: string | null; title: string; author?: string; bg: string; w?: number; h?: number }) {
  if (src) {
    return (
      <div style={{ display: "flex", width: w, height: h, borderRadius: 10, overflow: "hidden", boxShadow: "0 10px 30px rgba(0,0,0,0.22)" }}>
        <img src={src} width={w} height={h} style={{ width: w, height: h, objectFit: "cover" }} alt="" />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", width: w, height: h, borderRadius: 10, background: bg, padding: "26px 22px", borderLeft: "5px solid rgba(255,255,255,0.22)", boxShadow: "0 10px 30px rgba(0,0,0,0.22)" }}>
      <div style={{ display: "flex", fontSize: title.length > 38 ? 23 : 28, fontWeight: 700, color: "#fff", lineHeight: 1.16, fontFamily: FONT }}>
        {clip(title, 64)}
      </div>
      <div style={{ display: "flex", fontSize: 16, color: "rgba(255,255,255,0.86)", fontFamily: FONT }}>
        {clip(author || "", 40)}
      </div>
    </div>
  );
}

function MiniCover({ src, bg, initials, w = 46, h = 64 }: { src?: string | null; bg: string; initials: string; w?: number; h?: number }) {
  if (src) {
    return (
      <div style={{ display: "flex", width: w, height: h, borderRadius: 6, overflow: "hidden", boxShadow: "0 3px 10px rgba(0,0,0,0.18)" }}>
        <img src={src} width={w} height={h} style={{ width: w, height: h, objectFit: "cover" }} alt="" />
      </div>
    );
  }
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", width: w, height: h, borderRadius: 6, background: bg, color: "#fff", fontSize: 15, fontWeight: 700, borderLeft: "3px solid rgba(255,255,255,0.22)", fontFamily: FONT }}>
      {initials}
    </div>
  );
}

function Frame({ body, footer }: { body: ReactNode; footer: ReactNode }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", width: "100%", height: "100%", background: PAPER_BG, padding: "60px 70px", fontFamily: FONT, color: INK }}>
      <div style={{ display: "flex", flexDirection: "column", flexGrow: 1 }}>{body}</div>
      {footer}
    </div>
  );
}

// ── Cards ───────────────────────────────────────────────────────────────────

export interface MindCardData {
  name: string;
  era?: string;
  domain?: string;
  voice?: string;
  bio?: string;
}
export function MindCard({ data, portrait, accent, initials }: { data: MindCardData; portrait: string | null; accent: string; initials: string }) {
  const meta = [data.era, data.domain].filter(Boolean).join("  ·  ");
  const voice = clip(data.voice || data.bio || "", 172);
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", alignItems: "center", marginBottom: voice ? 42 : 0 }}>
            <Avatar src={portrait} initials={initials} accent={accent} size={150} />
            <div style={{ display: "flex", flexDirection: "column", marginLeft: 36, flexGrow: 1 }}>
              <div style={{ display: "flex", fontSize: 60, fontWeight: 700, color: INK, lineHeight: 1.04 }}>
                {clip(data.name, 36)}
              </div>
              {meta ? (
                <div style={{ display: "flex", fontSize: 25, color: INK_MUTE, marginTop: 14 }}>
                  {clip(meta, 58)}
                </div>
              ) : null}
            </div>
          </div>
          {voice ? (
            <div style={{ display: "flex", fontSize: 34, color: INK_SOFT, lineHeight: 1.42 }}>
              {`“${voice}”`}
            </div>
          ) : null}
        </div>
      }
      footer={<FooterSimple left="Great Minds — chat with them in their own voice" />}
    />
  );
}

export function BookCard({ title, author, description, cover, bg }: { title: string; author?: string; description?: string; cover: string | null; bg: string }) {
  return (
    <Frame
      body={
        <div style={{ display: "flex", alignItems: "center", flexGrow: 1 }}>
          <BookCover src={cover} title={title} author={author} bg={bg} />
          <div style={{ display: "flex", flexDirection: "column", marginLeft: 50, flexGrow: 1 }}>
            <div style={{ display: "flex", fontSize: 54, fontWeight: 700, color: INK, lineHeight: 1.08 }}>
              {clip(title, 68)}
            </div>
            {author ? (
              <div style={{ display: "flex", fontSize: 27, color: INK_MUTE, marginTop: 16, fontStyle: "italic" }}>
                {clip(author, 48)}
              </div>
            ) : null}
            {description ? (
              <div style={{ display: "flex", fontSize: 25, color: INK_SOFT, marginTop: 26, lineHeight: 1.46 }}>
                {clip(description, 156)}
              </div>
            ) : null}
          </div>
        </div>
      }
      footer={<FooterSimple left="Chat with this book — grounded in its actual text" />}
    />
  );
}

export function AnswerCard({ question, answer, who, attrSrc, attrInitials, attrAccent, attrLabel }: { question?: string; answer: string; who: string; attrSrc: string | null; attrInitials: string; attrAccent: string; attrLabel: string }) {
  const q = clip(question || "", 118);
  const a = clip(answer || "", q ? 232 : 300);
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          {q ? (
            <div style={{ display: "flex", fontSize: 41, fontWeight: 700, color: INK, lineHeight: 1.2, marginBottom: 28 }}>
              {q}
            </div>
          ) : null}
          <div style={{ display: "flex", fontSize: q ? 29 : 37, color: INK_SOFT, lineHeight: 1.5, borderLeft: `3px solid ${attrAccent}`, paddingLeft: 28 }}>
            {`“${a}”`}
          </div>
        </div>
      }
      footer={
        <FooterIdentity
          glyph={<Avatar src={attrSrc} initials={attrInitials} accent={attrAccent} size={58} />}
          name={who}
          label={attrLabel}
        />
      }
    />
  );
}

export function QaCard({ question, snippet, bookTitle, author, cover, bg, initials }: { question: string; snippet: string; bookTitle: string; author?: string; cover: string | null; bg: string; initials: string }) {
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: 17, letterSpacing: 2, color: INK_MUTE, marginBottom: 18, fontFamily: FONT }}>
            ASKED OF THE BOOK
          </div>
          <div style={{ display: "flex", fontSize: 42, fontWeight: 700, color: INK, lineHeight: 1.18, marginBottom: 26 }}>
            {clip(question, 116)}
          </div>
          <div style={{ display: "flex", fontSize: 26, color: INK_SOFT, lineHeight: 1.48, borderLeft: `3px solid ${typeof bg === "string" && bg.startsWith("#") ? bg : "#888"}`, paddingLeft: 26 }}>
            {`“${clip(snippet, 188)}”`}
          </div>
        </div>
      }
      footer={
        <FooterIdentity
          glyph={<MiniCover src={cover} bg={bg} initials={initials} />}
          name={bookTitle}
          label={author ? `${clip(author, 40)} · grounded answer` : "Grounded in the book"}
        />
      }
    />
  );
}

export function EssayCard({ mindName, topic, snippet, portrait, accent, initials }: { mindName: string; topic: string; snippet: string; portrait: string | null; accent: string; initials: string }) {
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: 26, color: INK_MUTE, marginBottom: 8, fontFamily: FONT }}>
            {clip(mindName, 36)} on
          </div>
          <div style={{ display: "flex", fontSize: 60, fontWeight: 700, color: INK, lineHeight: 1.06, marginBottom: 30 }}>
            {clip(topic, 46)}
          </div>
          {snippet ? (
            <div style={{ display: "flex", fontSize: 28, color: INK_SOFT, lineHeight: 1.46 }}>
              {`“${clip(snippet, 184)}”`}
            </div>
          ) : null}
        </div>
      }
      footer={
        <FooterIdentity
          glyph={<Avatar src={portrait} initials={initials} accent={accent} size={56} />}
          name={mindName}
          label="An imagined essay · Great Minds"
        />
      }
    />
  );
}

export interface ShelfItem {
  bg: string;
  initials: string;
}
export function TopicCard({ topic, bookCount, mindCount, books, minds }: { topic: string; bookCount: number; mindCount: number; books: ShelfItem[]; minds: { accent: string; initials: string }[] }) {
  const metaBits: string[] = [];
  if (bookCount) metaBits.push(`${bookCount} ${bookCount === 1 ? "book" : "books"}`);
  if (mindCount) metaBits.push(`${mindCount} great ${mindCount === 1 ? "mind" : "minds"}`);
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: 76, fontWeight: 700, color: INK, lineHeight: 1.04 }}>
            {clip(topic, 30)}
          </div>
          {metaBits.length ? (
            <div style={{ display: "flex", fontSize: 26, color: INK_MUTE, marginTop: 18 }}>
              {metaBits.join("  ·  ")} on Feynman
            </div>
          ) : null}
          <div style={{ display: "flex", alignItems: "flex-end", marginTop: 44 }}>
            {books.slice(0, 4).map((b, i) => (
              <div key={`b${i}`} style={{ display: "flex", marginRight: 14 }}>
                <MiniCover bg={b.bg} initials={b.initials} w={58} h={82} />
              </div>
            ))}
            {minds.slice(0, 3).map((m, i) => (
              <div key={`m${i}`} style={{ display: "flex", marginRight: 12 }}>
                <Avatar src={null} initials={m.initials} accent={m.accent} size={64} />
              </div>
            ))}
          </div>
        </div>
      }
      footer={<FooterSimple left="A curated shelf — read the canon, chat with the thinkers" />}
    />
  );
}

export function DiscussionCard({ withWho, userMsg, answerMsg, turns, accent, initials, portrait }: { withWho: string; userMsg: string; answerMsg: string; turns: number; accent: string; initials: string; portrait: string | null }) {
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          {userMsg ? (
            <div style={{ display: "flex", flexDirection: "column", marginBottom: 30 }}>
              <div style={{ display: "flex", fontSize: 16, letterSpacing: 2, color: INK_MUTE }}>YOU ASKED</div>
              <div style={{ display: "flex", fontSize: 33, fontWeight: 700, color: INK, lineHeight: 1.22, marginTop: 8 }}>
                {clip(userMsg, 96)}
              </div>
            </div>
          ) : null}
          <div style={{ display: "flex", flexDirection: "column" }}>
            <div style={{ display: "flex", fontSize: 16, letterSpacing: 2, color: INK_MUTE }}>
              {clip(withWho.toUpperCase(), 40)}
            </div>
            <div style={{ display: "flex", fontSize: 28, color: INK_SOFT, lineHeight: 1.46, marginTop: 8, borderLeft: `3px solid ${accent}`, paddingLeft: 24 }}>
              {`“${clip(answerMsg, 168)}”`}
            </div>
          </div>
        </div>
      }
      footer={
        <FooterIdentity
          glyph={<Avatar src={portrait} initials={initials} accent={accent} size={56} />}
          name={`A conversation with ${withWho}`}
          label={turns ? `${turns} turns · read the thread` : "Read the thread"}
        />
      }
    />
  );
}

export function AggCard({ title, sub, glyph, name, label }: { title: string; sub?: string; glyph: ReactNode; name: string; label: string }) {
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: 56, fontWeight: 700, color: INK, lineHeight: 1.1 }}>
            {clip(title, 64)}
          </div>
          {sub ? (
            <div style={{ display: "flex", fontSize: 26, color: INK_MUTE, marginTop: 22, lineHeight: 1.45 }}>
              {clip(sub, 150)}
            </div>
          ) : null}
        </div>
      }
      footer={<FooterIdentity glyph={glyph} name={name} label={label} />}
    />
  );
}

export function HomeCard() {
  return (
    <Frame
      body={
        <div style={{ display: "flex", flexDirection: "column", flexGrow: 1, justifyContent: "center" }}>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 700, color: INK, lineHeight: 1.08 }}>
            Chat with books.
          </div>
          <div style={{ display: "flex", fontSize: 72, fontWeight: 700, color: INK, lineHeight: 1.08 }}>
            Great minds join in.
          </div>
          <div style={{ display: "flex", fontSize: 28, color: INK_MUTE, marginTop: 28, lineHeight: 1.45, maxWidth: 880 }}>
            An interactive knowledge network built on the world&rsquo;s most important books and great minds.
          </div>
        </div>
      }
      footer={<FooterSimple left="Ask any book anything · discuss with the thinkers who shaped the field" />}
    />
  );
}

/**
 * Last-resort card for the route's catch block. Deliberately sets NO
 * fontFamily so it renders even when the Georgia fetch failed and the font set
 * is empty (next/og's built-in font takes over) — the only render path that
 * must never itself throw.
 */
export function FallbackCard() {
  return (
    <div style={{ display: "flex", width: "100%", height: "100%", alignItems: "center", justifyContent: "center", background: "#f4f2ec", color: INK }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <FeynmanMark color={INK} size={48} />
        <div style={{ display: "flex", fontSize: 56, fontWeight: 700, marginLeft: 18 }}>feynman.wiki</div>
      </div>
    </div>
  );
}

export { Avatar as OgAvatar, MiniCover as OgMiniCover };
