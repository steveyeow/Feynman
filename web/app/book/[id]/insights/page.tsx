import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";

import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";

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
  // Chat ALWAYS routes to the conversational composer (preselects the book),
  // never the reader — catalog stubs have no readable text, so /read would be
  // a dead end here.
  const chatHref = `/?book=${encodeURIComponent(id)}`;
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

  const actions: EntityAction[] = [
    { label: `Chat with this book`, href: chatHref, variant: "primary" },
  ];

  const hero = (
    <>
      <Link
        href={`/book/${encodeURIComponent(id)}`}
        className="seo-backlink"
      >
        ← {data.title}
      </Link>
      <p className="seo-meta">Live AI insights</p>
      <h1>AI insights about {data.title}</h1>
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={`AI insights about ${data.title}`} />
    </>
  );

  const rail = (
    <div className="seo-rail-card">
      <h3>About this book</h3>
      <ul>
        <li>
          <Link href={`/book/${encodeURIComponent(id)}`}>{data.title}</Link>
        </li>
        <li>
          <Link href={`/book/${encodeURIComponent(id)}/discussions`}>
            Reader discussions
          </Link>
        </li>
      </ul>
    </div>
  );

  return (
    <EntityLayout hero={hero} rail={rail}>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />

      <p className="seo-meta">
        These are AI-synthesized insights about {data.title}, drawn from real
        reader chat sessions on Feynman and refreshed as more readers engage.
        The AI&apos;s responses are published; reader questions stay private.
      </p>

      {insights.length ? (
        <InsightCards insights={insights} />
      ) : (
        <InsightsEmptyState entityName={data.title} />
      )}
    </EntityLayout>
  );
}
