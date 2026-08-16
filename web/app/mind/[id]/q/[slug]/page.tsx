import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchMind,
  fetchMindQA,
  fetchMindQuestions,
  metaDescription,
} from "@/lib/seo-mind";

// Per-mind Q&A pages — the mind-side mirror of /book/{id}/q/{slug}, built from
// verified search demand for person-specific questions (GSC: "was rousseau a
// romantic", "bf skinner educational background", …). Answers are PRE-stored
// by the mind-qa cron (persona-grounded, first person), so a render costs zero
// LLM calls; pages 404 until the answer exists, and only answered questions
// are advertised in the sitemap — no thin shells.

export const revalidate = 86400;
export const dynamicParams = true;
// Empty generateStaticParams() opts this dynamic route into ISR caching.
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: { id: string; slug: string };
}): Promise<Metadata> {
  const [mind, qa] = await Promise.all([
    fetchMind(params.id),
    fetchMindQA(params.id, params.slug),
  ]);
  // Pre-stream 404 (the parent loading.tsx flushes a 200 shell before the page
  // body's notFound() can run — Soft 404 otherwise). See /book/[id].
  if (!mind || !qa) notFound();
  const canonical = abs(`/mind/${params.id}/q/${qa.slug}`);
  const ogImage = abs(`/og?type=mind&id=${encodeURIComponent(params.id)}`);
  // The question IS the search query — title leads with it verbatim.
  const title = `${qa.question} | ${mind.name} — Feynman`;
  const desc = metaDescription(
    `${qa.answer} — answered in ${mind.name}'s own voice on Feynman, where you can ask the follow-up yourself.`,
  );
  return {
    title,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: qa.question,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: qa.question,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function MindQuestionPage({
  params,
}: {
  params: { id: string; slug: string };
}) {
  const [mind, qa] = await Promise.all([
    fetchMind(params.id),
    fetchMindQA(params.id, params.slug),
  ]);
  if (!mind || !qa) notFound();

  const canonical = abs(`/mind/${params.id}/q/${qa.slug}`);
  const mindUrl = abs(`/mind/${params.id}`);
  const chatHref = `/mind/${encodeURIComponent(params.id)}/chat`;
  const related = (await fetchMindQuestions(params.id))
    .filter((q) => q.slug !== qa.slug)
    .slice(0, 4);

  // QAPage with the Google-required fields; the Answer is authored by the
  // mind-as-Person (the living-entry differentiator carried into the schema).
  const qaLd = {
    "@context": "https://schema.org",
    "@type": "QAPage",
    mainEntity: {
      "@type": "Question",
      name: qa.question,
      text: qa.question,
      answerCount: 1,
      upvoteCount: 0,
      url: canonical,
      author: { "@type": "Organization", name: "Feynman", url: SITE_URL },
      ...(qa.created_at ? { dateCreated: qa.created_at } : {}),
      acceptedAnswer: {
        "@type": "Answer",
        text: qa.answer,
        upvoteCount: 0,
        url: canonical,
        author: { "@type": "Person", name: mind.name, url: mindUrl },
        ...(qa.created_at ? { dateCreated: qa.created_at } : {}),
      },
    },
  };
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/minds`],
    [mind.name, mindUrl],
    [qa.question, canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={qaLd} />
      <JsonLd data={breadcrumbLd} />

      <nav className="seo-meta">
        <Link href={`/mind/${params.id}`}>← {mind.name}</Link>
      </nav>

      <h1>{qa.question}</h1>
      <p className="seo-meta">
        Answered in {mind.name}&apos;s voice — an AI synthesis grounded in their
        documented work, not a quotation.
      </p>

      <section className="seo-section">
        {qa.answer
          .split(/\n\n+/)
          .map((p) => p.trim())
          .filter(Boolean)
          .map((p, i) => (
            <p key={i}>{p}</p>
          ))}
      </section>

      <p className="seo-cta-row">
        <a className="primary" href={chatHref}>
          Ask {mind.name} the follow-up →
        </a>
      </p>

      {related.length ? (
        <section className="seo-section">
          <h2>More questions about {mind.name}</h2>
          <ul>
            {related.map((r) => (
              <li key={r.slug}>
                <Link href={`/mind/${params.id}/q/${r.slug}`}>{r.question}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </SeoColumn>
  );
}
