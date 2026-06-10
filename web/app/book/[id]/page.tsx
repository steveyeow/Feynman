import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";
import { coverStyleFromTitle, coverInitials } from "@/lib/books";

import SamplePassages from "@/components/seo/book/SamplePassages";
import TableOfContents from "@/components/seo/book/TableOfContents";
import PopularQuestions from "@/components/seo/book/PopularQuestions";

import {
  SITE_URL,
  getBookData,
  getBookReadMeta,
  getQuestions,
  getSamplePassages,
  getRelatedForBook,
  getBookOverview,
  detectCapabilities,
  clampDescription,
  slugify,
  canonicalTopicForCategory,
  isCleanCategory,
  bookJsonld,
  breadcrumbJsonld,
} from "@/lib/seo-book";
import { fetchTopics } from "@/lib/seo-mind";

// ISR. The EMPTY generateStaticParams() is load-bearing: it opts this dynamic
// route into the static/ISR path — prerender NONE at build (there are thousands
// of books) but render each on-demand on first hit, then CACHE it. Without it,
// Next 14 renders the route dynamically on EVERY request (Cache-Control:
// no-store), so every crawl re-hit Supabase — the egress that dominated usage.
export const revalidate = 86400;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

interface PageProps {
  params: { id: string };
}

/** Shared description logic for both generateMetadata and the page body. */
function bookDescription(
  subtitle: string,
  author: string,
): string {
  const by = author ? ` by ${author}` : "";
  // Hybrid intent: searchers reach book pages with "summary"/"key ideas"/
  // "{title} wiki" qualifiers (GSC) — answer that intent first, then
  // differentiate with the Type-0 value (the book itself answers, grounded in
  // its text — what no static summary site has).
  const lead = `Summary and key ideas of this book${by} — then ask the book itself anything and get answers grounded in its actual text.`;
  return clampDescription(subtitle ? `${lead} ${subtitle}` : lead);
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const data = await getBookData(params.id);
  if (!data) {
    return { title: "Book not found — Feynman" };
  }
  // A bare catalog stub — no sample passages, no chapters, no questions — is a
  // low-unique-value page we can't ground. Keep it out of the index to
  // concentrate crawl budget on real books (it's already excluded from the
  // sitemap; this stops indexing via internal links too). It still renders for
  // users; `follow` keeps its cross-links live. These two fetches are shared
  // with the body (Next dedupes within the request), so no extra round trips.
  const [stubQuestions, stubPassages] = await Promise.all([
    getQuestions(params.id),
    getSamplePassages(params.id, 3),
  ]);
  const isStub =
    stubPassages.length === 0 && data.chapters.length === 0 && stubQuestions.length === 0;

  const canonical = `${SITE_URL}/book/${encodeURIComponent(params.id)}`;
  const ogImage = `${SITE_URL}/og?type=book&id=${encodeURIComponent(params.id)}`;
  const desc = bookDescription(data.subtitle, data.author);
  return {
    // "& Chat" read like every static summary site; "Ask the Book" is the
    // capability nobody else can claim — concrete, three words, query-relevant
    // neighbors (Summary, Key Ideas) intact.
    title: `${data.title} — Summary, Key Ideas & Ask the Book | Feynman`,
    description: desc,
    alternates: { canonical },
    ...(isStub ? { robots: { index: false, follow: true } } : {}),
    openGraph: {
      type: "book",
      title: data.title,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [{ url: ogImage, width: 1200, height: 630, alt: data.title }],
    },
    twitter: {
      card: "summary_large_image",
      title: data.title,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function BookLandingPage({ params }: PageProps) {
  const { id } = params;
  const data = await getBookData(id);
  if (!data) notFound();

  // Enrichment — all independent, all degrade to empty on failure.
  const [questions, passages, related, overview, topics, readMeta] = await Promise.all([
    getQuestions(id),
    getSamplePassages(id, 3),
    getRelatedForBook(id),
    getBookOverview(id),
    fetchTopics(),
    getBookReadMeta(id),
  ]);
  // Author + subtitle for AI books live in the ai_books row (the /read endpoint),
  // NOT the agent meta_json — so they must come from readMeta to match what the
  // reader cover shows ("{creator} · AI" + the real subtitle), falling back to
  // the agent-derived values for catalog books.
  const displayAuthor = readMeta.author || data.author;
  const displaySubtitle = readMeta.subtitle || data.subtitle;

  // Map the book's free-form category to a canonical topic hub (or null) so the
  // "Topic" rail links to a real /topic/{slug} instead of 404'ing on ad-hoc
  // categories like "Business" (→ "Business & Strategy") or junk values.
  const canonicalTopic = canonicalTopicForCategory(data.category, topics);
  // Only surface the category in display chrome when it's a real category, not
  // a leaked chat query stored as the category by topic-discovery.
  const cleanCategory = isCleanCategory(data.category) ? data.category : "";

  const caps = detectCapabilities(data.agent);
  const chapterCount = data.chapters.length;

  // Stub detection: catalog book with no passages, no chapters, no questions.
  const isStub =
    passages.length === 0 && chapterCount === 0 && questions.length === 0;

  const canonical = `${SITE_URL}/book/${encodeURIComponent(id)}`;
  const desc = bookDescription(data.subtitle, data.author);
  const ogImage = `${SITE_URL}/og?type=book&id=${encodeURIComponent(id)}`;
  const createdAt = data.agent.created_at || "";

  // ── JSON-LD ──────────────────────────────────────────────────────────
  const bookLd = bookJsonld({
    title: data.title,
    description: data.subtitle || desc,
    author: data.author,
    url: canonical,
    image: ogImage,
    wordCount: data.totalWords || null,
    chapters: data.chapters.length ? data.chapters : null,
    siteUrl: SITE_URL,
    datePublished: createdAt,
    dateModified: createdAt,
  });
  const breadcrumbLd = breadcrumbJsonld([
    { name: "Feynman", url: SITE_URL },
    { name: "Books", url: `${SITE_URL}/library` },
    { name: data.title, url: canonical },
  ]);
  // ── Top actions (per product direction) ───────────────────────────────
  // Chat ALWAYS available → routes to the conversational surface (home composer
  // preselects the book), NOT the reader — so catalog stubs with no readable
  // text still start a chat (fixes the dead-end). Read/Preview appear only when
  // the book actually has content, and go to the reader.
  // Chat is ALWAYS the primary action and listed FIRST — chatting with the book
  // is the core product moment; Read/Preview are secondary even when available.
  const chatHref = `/?book=${encodeURIComponent(id)}`;
  const actions: EntityAction[] = [
    { label: `Chat with this book`, href: chatHref, variant: "primary" },
  ];
  if (caps.read) {
    actions.push({ label: `Read`, href: `/read/${encodeURIComponent(id)}`, variant: "secondary" });
  } else if (caps.preview) {
    actions.push({ label: `Preview`, href: `/read/${encodeURIComponent(id)}`, variant: "secondary" });
  }

  const metaBits: string[] = [];
  if (data.totalWords) metaBits.push(`${data.totalWords.toLocaleString()} words`);
  if (chapterCount) metaBits.push(`${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`);

  // Chips only on indexed books — gate on meta.chunk_count >= 5, the SAME
  // threshold that defines the de-templated/indexable set (the 57 books that get
  // /q URLs and book-specific questions). Thin catalog stubs (chunk_count < 5)
  // have only meta-referential questions ("Given the title…", "With 15M copies
  // sold…") that no regex reliably catches, so gate on depth, not phrasing. NOT
  // passages: getSamplePassages reads the legacy `vector` column and returns 0
  // for pgvector-migrated books (Franklin has 146 chunks but 0 sample passages).
  // The regex below stays as a secondary cleanup for the odd meta question.
  const hasRealContent = Number(data.meta.chunk_count || 0) >= 5;
  const chipQs = hasRealContent
    ? questions
        .filter((q) => {
          // Drop meta-referential openers…
          if (
            /^\s*(given|considering|imagine|if you were|drawing on|reflecting on|the (description|book|text|author)\b)/i.test(q)
          )
            return false;
          // …and questions ABOUT the book's packaging rather than its ideas
          // ("What does the title's emphasis…", "the description calls it…").
          if (/\bthe (title|description)\b|\bthe book['’]s (title|premise|promise|status)\b/i.test(q))
            return false;
          return true;
        })
        .slice(0, 3)
    : [];
  const isAI = data.agent.type === "ai_book";
  const hero = (
    <div className="seo-hero-with-cover">
      <div
        className="seo-hero-cover"
        style={{ background: coverStyleFromTitle(data.title, isAI) }}
        aria-hidden="true"
      >
        <span>{coverInitials(data.title)}</span>
      </div>
      <div className="seo-hero-body">
        <p className="seo-meta">Book{cleanCategory ? ` · ${cleanCategory}` : ""}</p>
        <h1>{data.title}</h1>
        {displaySubtitle ? <p className="seo-subtitle">{displaySubtitle}</p> : null}
        {displayAuthor ? <p className="seo-author">by {displayAuthor}</p> : null}
        {metaBits.length ? <p className="seo-meta">{metaBits.join(" · ")}</p> : null}
        <EntityActions actions={actions} shareUrl={canonical} shareTitle={data.title} />
        {chipQs.length ? (
          <div className="mind-starters">
            <span className="mind-starters-label">Ask this book:</span>
            {chipQs.map((q) => (
              <Link
                key={q}
                href={`/?book=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`}
                className="mind-starter-chip"
              >
                {q.length > 40 ? q.slice(0, 38).replace(/\s+\S*$/, "") + "…" : q}
              </Link>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );

  const rail = (
    <>
      {related.minds.length ? (
        <div className="seo-rail-card">
          <h3>Great minds on this book</h3>
          <ul>
            {related.minds.map((m) => (
              <li key={m.id}>
                <Link href={`/mind/${m.slug || m.id}`}>{m.name}</Link>
                {m.activity && m.activity.count > 0 ? (
                  <span className="activity-badge" title="Active in real reader conversations about this book">
                    {" "}● {m.activity.count} {m.activity.count === 1 ? "chat" : "chats"}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {isStub ? null : (
        <div className="seo-rail-card">
          <h3>AI insights</h3>
          <ul>
            <li>
              <Link href={`/book/${encodeURIComponent(id)}/insights`}>
                AI insights about {data.title}
              </Link>
            </li>
          </ul>
          <p>Accumulated AI commentary, drawn from real reader chat sessions.</p>
        </div>
      )}
      {related.books.length ? (
        <div className="seo-rail-card">
          <h3>Related books</h3>
          <ul>
            {related.books.map((b) => (
              <li key={b.id}>
                <Link href={`/book/${b.slug || b.id}`}>{b.name}</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      {canonicalTopic ? (
        <div className="seo-rail-card">
          <h3>Topic</h3>
          <ul>
            <li>
              <Link href={`/topic/${slugify(canonicalTopic)}`}>More on {canonicalTopic}</Link>
            </li>
          </ul>
        </div>
      ) : null}
    </>
  );

  // A substantive opening line that's always present (even for catalog stubs):
  // prefer the real subtitle, else synthesize from author/topic so the page
  // never opens empty.
  const aboutLine =
    data.subtitle?.trim() ||
    [
      data.author ? `${data.title} by ${data.author}` : data.title,
      cleanCategory ? `a work on ${cleanCategory}` : "",
    ]
      .filter(Boolean)
      .join(" — ") +
      ". Chat with it on Feynman to explore its ideas, ask questions, and discuss with the great minds connected to it.";

  return (
    <EntityLayout hero={hero} rail={rail}>
      <JsonLd data={bookLd} />
      <JsonLd data={breadcrumbLd} />

      <section className="seo-section">
        {overview ? (
          <>
            {/* "Summary" is the literal query word searchers use (GSC:
                "daodejing summary" etc.) — the heading matches the intent. */}
            <h2>Summary</h2>
            {overview.overview
              .split(/\n\n+/)
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p, i) => (
                <p key={i} className="book-about">
                  {p}
                </p>
              ))}
          </>
        ) : (
          <p className="book-about">{aboutLine}</p>
        )}
        {isStub ? (
          <p className="seo-availability">
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10" />
              <line x1="12" y1="8" x2="12" y2="12" />
              <line x1="12" y1="16" x2="12.01" y2="16" />
            </svg>
            Full text isn&apos;t indexed yet — this overview draws on general
            knowledge of the book and its metadata, and chat works the same way.
          </p>
        ) : null}
      </section>

      {overview && overview.concepts.length ? (
        <section className="seo-section">
          <h2>Key concepts</h2>
          <ul className="key-concepts">
            {overview.concepts.map((c, i) => (
              <li key={i}>
                <strong>{c.term}</strong> — {c.note}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <SamplePassages passages={passages} />
      <TableOfContents chapters={data.chapters} />
      <PopularQuestions questions={questions} bookId={id} />
    </EntityLayout>
  );
}
