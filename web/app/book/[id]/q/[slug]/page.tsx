import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";

import BackLink from "@/components/seo/book/BackLink";
import QaAnswer from "@/components/seo/book/QaAnswer";
import QaPassages from "@/components/seo/book/QaPassages";
import SiblingQuestions from "@/components/seo/book/SiblingQuestions";

import {
  SITE_URL,
  getBookData,
  getQuestions,
  getSamplePassages,
  findQuestionBySlug,
  clampDescription,
  qaPageJsonld,
  breadcrumbJsonld,
} from "@/lib/seo-book";

export const revalidate = 86400;

interface PageProps {
  params: { id: string; slug: string };
}

/**
 * The legacy book_question_page calls qa_module.generate_grounded_answer
 * (RAG + LLM) for a per-question synthesized answer + cited passages. That
 * pipeline has no JSON endpoint (see report). Here we degrade gracefully:
 * the page resolves the question, renders the book's leading passages as
 * supporting context, and the QAPage schema carries the chat-deflection
 * answer (which is non-empty, satisfying Google's spec). No synthesized
 * answer text is shown — only real book passages — until a grounded-answer
 * endpoint exists.
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
  if (!data) return { title: "Not found — Feynman" };
  const resolved = await resolveQuestion(params.id, params.slug);
  if (!resolved) return { title: "Question not found — Feynman" };

  const canonical = `${SITE_URL}/book/${encodeURIComponent(params.id)}/q/${params.slug}`;
  let pageTitle = `${resolved.question} — ${data.title}`;
  if (pageTitle.length > 120) {
    pageTitle = pageTitle.slice(0, 117).replace(/\s+\S*$/, "") + "...";
  }
  const desc = clampDescription(
    `Discuss "${resolved.question}" with the book "${data.title}" on Feynman.`,
  );
  return {
    title: pageTitle,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: resolved.question,
      description: desc,
      url: canonical,
      siteName: "Feynman",
    },
    twitter: {
      card: "summary_large_image",
      title: resolved.question,
      description: desc,
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

  // Supporting passages — the book's leading passages, the best grounding
  // we can surface without a per-question RAG endpoint.
  const passages = await getSamplePassages(id, 5);

  const bookUrl = `${SITE_URL}/book/${encodeURIComponent(id)}`;
  const canonical = `${bookUrl}/q/${slug}`;
  const reader = `${SITE_URL}/read/${encodeURIComponent(id)}`;
  const createdAt = data.agent.created_at || "";

  const qaLd = qaPageJsonld({
    question,
    answer: "", // no synthesized answer available → schema uses deflection
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

  return (
    <SeoColumn>
      <JsonLd data={qaLd} />
      <JsonLd data={breadcrumbLd} />

      <BackLink href={`/book/${encodeURIComponent(id)}`} label={data.title} />
      <h1>{question}</h1>

      {/* No synthesized answer endpoint yet — QaAnswer renders nothing for an
          empty answer, and the passages below carry the page's content. */}
      <QaAnswer answer="" />
      <QaPassages
        passages={passages.map((p) => ({ text: p.text, chunk_index: p.index }))}
      />
      <SiblingQuestions
        siblings={questions}
        bookId={id}
        currentQuestion={question}
      />

      <p className="cta">
        <Link href={`/read/${encodeURIComponent(id)}`} data-abs={reader}>
          Chat about this question →
        </Link>
      </p>
    </SeoColumn>
  );
}
