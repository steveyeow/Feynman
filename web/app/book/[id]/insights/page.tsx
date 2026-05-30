import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";

import BackLink from "@/components/seo/book/BackLink";
import {
  InsightCards,
  InsightsEmptyState,
} from "@/components/seo/book/InsightCards";

import {
  SITE_URL,
  getBookData,
  getInsights,
  clampDescription,
  insightsArticleJsonld,
  breadcrumbJsonld,
} from "@/lib/seo-book";

export const revalidate = 86400;

interface PageProps {
  params: { id: string };
}

export async function generateMetadata({
  params,
}: PageProps): Promise<Metadata> {
  const data = await getBookData(params.id);
  if (!data) return { title: "Not found — Feynman" };

  const canonical = `${SITE_URL}/book/${encodeURIComponent(params.id)}/insights`;
  const desc = clampDescription(
    `AI insights about ${data.title} on Feynman, drawn from real reader chat sessions. AI agent output only; user questions are never published.`,
  );
  const title = `AI insights about ${data.title} — Feynman`;
  return {
    title,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title,
      description: desc,
      url: canonical,
      siteName: "Feynman",
    },
    twitter: { card: "summary_large_image", title, description: desc },
  };
}

export default async function BookInsightsPage({ params }: PageProps) {
  const { id } = params;
  const data = await getBookData(id);
  if (!data) notFound();

  const insights = await getInsights(id, 10);

  const bookUrl = `${SITE_URL}/book/${encodeURIComponent(id)}`;
  const canonical = `${bookUrl}/insights`;
  const reader = `${SITE_URL}/read/${encodeURIComponent(id)}`;
  const latest = insights[0]?.created_at || "";

  const descRaw = insights.length
    ? `${insights.length} AI-synthesized insights about ${data.title} drawn from real reader chat sessions on Feynman. AI agent output only; user questions are never published.`
    : `AI insights about ${data.title} on Feynman. Start a chat to seed the public insights page.`;

  const articleLd = insightsArticleJsonld({
    headline: `AI insights about ${data.title}`,
    description: descRaw,
    url: canonical,
    aboutUrl: bookUrl,
    aboutType: "Book",
    aboutName: data.title,
    siteUrl: SITE_URL,
    dateModified: latest,
    insightCount: insights.length,
  });
  const breadcrumbLd = breadcrumbJsonld([
    { name: "Feynman", url: SITE_URL },
    { name: "Books", url: `${SITE_URL}/library` },
    { name: data.title, url: bookUrl },
    { name: "Insights", url: canonical },
  ]);

  return (
    <SeoColumn>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />

      <BackLink href={`/book/${encodeURIComponent(id)}`} label={data.title} />
      <h1>AI insights about {data.title}</h1>
      <p className="insights-intro">
        Accumulated AI-synthesized commentary drawn from real reader chat
        sessions with this book. Updated as more readers explore the text. The
        AI&apos;s responses are published; user questions remain private.
      </p>

      {insights.length ? (
        <InsightCards insights={insights} />
      ) : (
        <InsightsEmptyState entityName={data.title} />
      )}

      <p className="cta">
        <Link href={`/read/${encodeURIComponent(id)}`} data-abs={reader}>
          Chat with {data.title} →
        </Link>
      </p>
    </SeoColumn>
  );
}
