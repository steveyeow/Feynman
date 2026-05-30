import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";

import BookMeta from "@/components/seo/book/BookMeta";
import BookEmptyState from "@/components/seo/book/BookEmptyState";
import AboutBook from "@/components/seo/book/AboutBook";
import SamplePassages from "@/components/seo/book/SamplePassages";
import TableOfContents from "@/components/seo/book/TableOfContents";
import PopularQuestions from "@/components/seo/book/PopularQuestions";
import CtaRow from "@/components/seo/book/CtaRow";
import LiveContentLink from "@/components/seo/book/LiveContentLink";
import ExploreFooter, {
  type ExploreItem,
} from "@/components/seo/book/ExploreFooter";

import {
  SITE_URL,
  getBookData,
  getQuestions,
  getSamplePassages,
  detectCapabilities,
  clampDescription,
  slugify,
  bookJsonld,
  breadcrumbJsonld,
  faqJsonld,
} from "@/lib/seo-book";

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
    },
    twitter: {
      card: "summary_large_image",
      title: data.title,
      description: desc,
    },
  };
}

export default async function BookLandingPage({ params }: PageProps) {
  const { id } = params;
  const data = await getBookData(id);
  if (!data) notFound();

  // Enrichment — all independent, all degrade to empty on failure.
  const [questions, passages] = await Promise.all([
    getQuestions(id),
    getSamplePassages(id, 3),
  ]);

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
  const reader = `${SITE_URL}/read/${encodeURIComponent(id)}`;
  const deflect = `Open Feynman to chat with this book and explore the answer in depth: ${reader}`;
  const faqLd = questions.length
    ? faqJsonld(questions.filter(Boolean).map((q) => ({ question: q, answer: deflect })))
    : null;

  // ── Explore footer: topic hub + first 2 questions as neighborhood ──────
  // Related books/minds for a book have no JSON endpoint (see report), so we
  // build the neighborhood from the data we do have: the topic hub.
  const exploreItems: ExploreItem[] = [];
  if (data.category) {
    exploreItems.push({
      label: `More on ${data.category}`,
      href: `/topic/${slugify(data.category)}`,
    });
  }

  return (
    <SeoColumn>
      <JsonLd data={bookLd} />
      <JsonLd data={breadcrumbLd} />
      {faqLd ? <JsonLd data={faqLd} /> : null}

      <h1>{data.title}</h1>
      <BookMeta
        author={data.author}
        totalWords={data.totalWords}
        chapterCount={chapterCount}
      />

      {isStub ? (
        <BookEmptyState title={data.title} author={data.author} />
      ) : (
        <AboutBook subtitle={data.subtitle} />
      )}

      <SamplePassages passages={passages} />
      <TableOfContents chapters={data.chapters} />
      <PopularQuestions questions={questions} bookId={id} />

      <CtaRow caps={caps} bookId={id} title={data.title} />

      <LiveContentLink entityName={data.title} bookId={id} />

      {data.category ? (
        <p className="topic-link-back">
          More on{" "}
          <Link href={`/topic/${slugify(data.category)}`}>{data.category}</Link>
        </p>
      ) : null}

      <ExploreFooter items={exploreItems} />
    </SeoColumn>
  );
}
