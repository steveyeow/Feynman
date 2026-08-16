import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";

import QaAnswer from "@/components/seo/book/QaAnswer";
import QaPassages from "@/components/seo/book/QaPassages";
import SiblingQuestions from "@/components/seo/book/SiblingQuestions";

import {
  SITE_URL,
  getBookData,
  getQuestions,
  getSamplePassages,
  getBookQa,
  findQuestionBySlug,
  isGenericFallbackQuestion,
  clampDescription,
  qaPageJsonld,
  breadcrumbJsonld,
} from "@/lib/seo-book";

// Empty generateStaticParams() opts this dynamic route into ISR caching (render
// on-demand on first hit, then CACHE) instead of dynamic-render-every-request
// (no-store), which re-hit Supabase on every crawl.
export const revalidate = 86400;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

interface PageProps {
  params: { id: string; slug: string };
}

/**
 * Mirrors the legacy book_question_page: the grounded answer + cited passages
 * come from GET /api/agents/{id}/qa (qa_module.generate_grounded_answer). When
 * QA generation is disabled/fails the answer is empty and we fall back to the
 * book's leading sample passages; the QAPage schema then carries the
 * chat-deflection answer (non-empty, satisfying Google's spec).
 */
async function resolveQuestion(
  id: string,
  slug: string,
): Promise<{ question: string; questions: string[] } | null> {
  const questions = await getQuestions(id);
  const question = findQuestionBySlug(questions, slug);
  if (!question) return null;
  return { question, questions };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const data = await getBookData(params.id);
  // Pre-stream 404 (the parent loading.tsx flushes a 200 shell before the page
  // body's notFound() can run — Soft 404 otherwise). See /book/[id].
  if (!data) notFound();
  const resolved = await resolveQuestion(params.id, params.slug);
  if (!resolved) notFound();

  // Grounded-content presence drives BOTH the snippet and indexability. Cached
  // server-side, so this is not an extra LLM call vs the body's fetch.
  const qa = await getBookQa(params.id, resolved.question);
  const answer = (qa?.answer || "").trim();
  const hasGrounded = Boolean(answer || qa?.passages?.length);
  // A generic fallback question (one of the 5 the backend inserts when
  // book-specific generation failed) is byte-identical across ~400 books, so its
  // /q page is a duplicate even WITH a grounded answer — never index it.
  const generic = isGenericFallbackQuestion(resolved.question);

  const canonical = `${SITE_URL}/book/${encodeURIComponent(params.id)}/q/${params.slug}`;
  const ogImage = `${SITE_URL}/og?type=qa&id=${encodeURIComponent(params.id)}&slug=${encodeURIComponent(params.slug)}`;
  let pageTitle = `${resolved.question} — ${data.title}`;
  if (pageTitle.length > 120) {
    pageTitle = pageTitle.slice(0, 117).replace(/\s+\S*$/, "") + "...";
  }
  // The synthesized answer is the strongest, least-duplicative snippet; fall
  // back to boilerplate only when there's no answer yet.
  const desc = clampDescription(
    answer || `Discuss "${resolved.question}" with the book "${data.title}" on Feynman.`,
  );
  return {
    title: pageTitle,
    description: desc,
    alternates: { canonical },
    // Keep this question page OUT of the index when EITHER:
    //  (a) no grounded answer/passage yet — its only content would be generic
    //      fallback passages, not an answer to THIS question (it indexes later
    //      once the answer is generated + cached on a crawl), OR
    //  (b) it's one of the 5 generic fallback questions — byte-identical across
    //      ~400 books, so a duplicate even WITH a grounded answer ("Duplicate
    //      without user-selected canonical" in GSC).
    // `follow` keeps link equity flowing to the book either way.
    ...(hasGrounded && !generic ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      type: "article",
      title: resolved.question,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [{ url: ogImage, width: 1200, height: 630, alt: data.title }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: resolved.question,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function BookQuestionPage({ params }: PageProps) {
  const { id, slug } = params;
  const data = await getBookData(id);
  if (!data) notFound();

  const resolved = await resolveQuestion(id, slug);
  if (!resolved) notFound();
  const { question, questions } = resolved;

  // Grounded answer + cited passages from the RAG endpoint. Falls back to the
  // book's leading sample passages (and an empty answer) when QA generation is
  // disabled or fails.
  const qa = await getBookQa(id, question);
  const answer = qa?.answer || "";
  const passages =
    qa && qa.passages.length
      ? qa.passages.map((p, i) => ({ index: p.chunk_index ?? i, text: p.text }))
      : await getSamplePassages(id, 5);

  const bookUrl = `${SITE_URL}/book/${encodeURIComponent(id)}`;
  const canonical = `${bookUrl}/q/${slug}`;
  // Chat ALWAYS routes to the conversational composer (preselects the book),
  // never the reader — catalog stubs have no readable text, so /read would be
  // a dead end here.
  const chatHref = `/?book=${encodeURIComponent(id)}`;
  const createdAt = data.agent.created_at || "";

  const qaLd = qaPageJsonld({
    question,
    answer, // real synthesized answer when available; schema deflects if empty
    url: canonical,
    bookTitle: data.title,
    bookUrl,
    siteUrl: SITE_URL,
    dateCreated: createdAt,
  });
  const breadcrumbLd = breadcrumbJsonld([
    { name: "Feynman", url: SITE_URL },
    { name: "Books", url: `${SITE_URL}/library` },
    { name: data.title, url: bookUrl },
    { name: "Q&A", url: canonical },
  ]);

  const actions: EntityAction[] = [
    { label: `Chat with this book`, href: chatHref, variant: "primary" },
  ];

  const hero = (
    <>
      <Link href={`/book/${encodeURIComponent(id)}`} className="seo-backlink">
        ← {data.title}
      </Link>
      <p className="seo-meta">Question</p>
      <h1>{question}</h1>
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={question} />
    </>
  );

  const rail = (
    <div className="seo-rail-card">
      <h3>About this book</h3>
      <ul>
        <li>
          <Link href={`/book/${encodeURIComponent(id)}`}>{data.title}</Link>
        </li>
        {data.author ? <li className="seo-meta">by {data.author}</li> : null}
      </ul>
    </div>
  );

  return (
    <EntityLayout hero={hero} rail={rail}>
      <JsonLd data={qaLd} />
      <JsonLd data={breadcrumbLd} />

      {/* Real grounded answer when available; QaAnswer renders nothing for an
          empty answer, in which case the passages below carry the content. */}
      <QaAnswer answer={answer} />
      <QaPassages
        passages={passages.map((p) => ({ text: p.text, chunk_index: p.index }))}
      />

      <SiblingQuestions
        siblings={questions}
        bookId={id}
        currentQuestion={question}
      />
    </EntityLayout>
  );
}
