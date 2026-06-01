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
import LiveContentLink from "@/components/seo/book/LiveContentLink";

import {
  SITE_URL,
  getBookData,
  getQuestions,
  getSamplePassages,
  getRelatedForBook,
  getBookOverview,
  detectCapabilities,
  clampDescription,
  slugify,
  canonicalTopicForCategory,
  bookJsonld,
  breadcrumbJsonld,
} from "@/lib/seo-book";
import { fetchTopics } from "@/lib/seo-mind";

// ISR — on-demand revalidation, no generateStaticParams (thousands of books).
export const revalidate = 86400;

interface PageProps {
  params: { id: string };
}

/** Shared description logic for both generateMetadata and the page body. */
function bookDescription(
  subtitle: string,
  author: string,
): string {
  let raw: string;
  if (subtitle) raw = subtitle;
  else if (author) raw = `by ${author} — Read and chat with this book on Feynman`;
  else raw = "Read and chat with this book on Feynman";
  return clampDescription(raw);
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const data = await getBookData(params.id);
  if (!data) {
    return { title: "Book not found — Feynman" };
  }
  const canonical = `${SITE_URL}/book/${encodeURIComponent(params.id)}`;
  const ogImage = `${SITE_URL}/book/${encodeURIComponent(params.id)}/og.png`;
  const desc = bookDescription(data.subtitle, data.author);
  return {
    title: `${data.title} — Feynman`,
    description: desc,
    alternates: { canonical },
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
  const [questions, passages, related, overview, topics] = await Promise.all([
    getQuestions(id),
    getSamplePassages(id, 3),
    getRelatedForBook(id),
    getBookOverview(id),
    fetchTopics(),
  ]);

  // Map the book's free-form category to a canonical topic hub (or null) so the
  // "Topic" rail links to a real /topic/{slug} instead of 404'ing on ad-hoc
  // categories like "Business" (→ "Business & Strategy") or junk values.
  const canonicalTopic = canonicalTopicForCategory(data.category, topics);

  const caps = detectCapabilities(data.agent);
  const chapterCount = data.chapters.length;

  // Stub detection: catalog book with no passages, no chapters, no questions.
  const isStub =
    passages.length === 0 && chapterCount === 0 && questions.length === 0;

  const canonical = `${SITE_URL}/book/${encodeURIComponent(id)}`;
  const desc = bookDescription(data.subtitle, data.author);
  const ogImage = `${SITE_URL}/book/${encodeURIComponent(id)}/og.png`;
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
  // Chat ALWAYS available → routes to the conversational surface (home
  // composer preselects the book), NOT the reader — so catalog stubs with no
  // readable text still start a chat (fixes the dead-end). Read/Preview appear
  // only when the book actually has content, and go to the reader.
  const chatHref = `/?book=${encodeURIComponent(id)}`;
  const actions: EntityAction[] = [];
  if (caps.read) {
    actions.push({ label: `Read`, href: `/read/${encodeURIComponent(id)}`, variant: "primary" });
    actions.push({ label: `Chat about this book`, href: chatHref, variant: "secondary" });
  } else if (caps.preview) {
    actions.push({ label: `Preview`, href: `/read/${encodeURIComponent(id)}`, variant: "primary" });
    actions.push({ label: `Chat about this book`, href: chatHref, variant: "secondary" });
  } else {
    actions.push({ label: `Chat about this book`, href: chatHref, variant: "primary" });
  }

  const metaBits: string[] = [];
  if (data.totalWords) metaBits.push(`${data.totalWords.toLocaleString()} words`);
  if (chapterCount) metaBits.push(`${chapterCount} chapter${chapterCount === 1 ? "" : "s"}`);

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
        <p className="seo-meta">Book{data.category ? ` · ${data.category}` : ""}</p>
        <h1>{data.title}</h1>
        {data.author ? <p className="seo-author">by {data.author}</p> : null}
        {metaBits.length ? <p className="seo-meta">{metaBits.join(" · ")}</p> : null}
        <EntityActions actions={actions} shareUrl={canonical} shareTitle={data.title} />
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
                <Link href={`/mind/${m.id}`}>{m.name}</Link>
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
      {related.books.length ? (
        <div className="seo-rail-card">
          <h3>Related books</h3>
          <ul>
            {related.books.map((b) => (
              <li key={b.id}>
                <Link href={`/book/${b.id}`}>{b.name}</Link>
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
      data.category ? `a work on ${data.category}` : "",
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
          overview.overview
            .split(/\n\n+/)
            .map((p) => p.trim())
            .filter(Boolean)
            .map((p, i) => (
              <p key={i} className="book-about">
                {p}
              </p>
            ))
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
            Full text isn&apos;t indexed yet — chat still works, drawing on general
            knowledge and the book&apos;s metadata.
          </p>
        ) : null}
      </section>

      {overview && overview.concepts.length ? (
        <section className="seo-section">
          <h2>Key concepts in {data.title}</h2>
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
      <LiveContentLink entityName={data.title} bookId={id} />
    </EntityLayout>
  );
}
