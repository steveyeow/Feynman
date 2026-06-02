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
  fetchMindOnTopic,
  metaDescription,
  mindEssayJsonLd,
  resolveTopicSlug,
} from "@/lib/seo-mind";

// The imagined essay comes from GET /api/minds/{id}/on/{slug} (mirrors the
// legacy qa.generate_mind_on_topic_essay). When that endpoint returns an
// essay we render it; when it 404s (relevance gate) or returns nothing
// (ENABLE_MIND_ESSAY off / generation failed), we fall back to the framed
// view below so the page is always substantive and never crashes.

export const revalidate = 86400;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: { id: string; slug: string };
}): Promise<Metadata> {
  const [mind, topic] = await Promise.all([
    fetchMind(params.id),
    resolveTopicSlug(params.slug),
  ]);
  if (!mind || !topic) {
    return { title: "Not found — Feynman" };
  }
  const canonical = abs(`/mind/${params.id}/on/${params.slug}`);
  const title = `How ${mind.name} might approach ${topic}`;
  const desc = metaDescription(
    `An imagined perspective on ${topic}, grounded in ${mind.name}'s recorded ideas and methods. Explore it in conversation on Feynman.`,
  );
  return {
    title: `${title} — Feynman`,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [abs(`/mind/${params.id}/og.png`)],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title,
      description: desc,
      images: [abs(`/mind/${params.id}/og.png`)],
    },
  };
}

export default async function MindOnTopicPage({
  params,
}: {
  params: { id: string; slug: string };
}) {
  const [mind, topic] = await Promise.all([
    fetchMind(params.id),
    resolveTopicSlug(params.slug),
  ]);
  if (!mind) notFound();
  if (!topic) notFound();
  // Relevance is decided by the backend essay endpoint (same Python
  // is_mind_topic_relevant the sitemap uses), NOT re-checked here. The old JS
  // port of the stemmer diverged ("economics" → "economic" vs Python "econom"),
  // so it 404'd pairs the sitemap advertised (e.g. Karl Marx × Economics) —
  // self-inflicted 404s on URLs we tell Google to crawl. We now fetch the essay
  // and fall back to a framed view when it's absent, so every sitemap /on/ URL
  // resolves 200.

  const canonical = abs(`/mind/${params.id}/on/${params.slug}`);
  const mindUrl = abs(`/mind/${params.id}`);
  const readerUrl = `/mind/${params.id}/chat`;
  const desc = `An imagined perspective on ${topic}, grounded in ${mind.name}'s recorded ideas and methods.`;

  // Generated essay (may be null when the feature is off / generation fails →
  // we fall back to the framed view).
  const onTopic = await fetchMindOnTopic(params.id, params.slug);
  const essayParagraphs = onTopic?.essay
    ? onTopic.essay.split(/\n\n+/).map((p) => p.trim()).filter(Boolean)
    : [];

  const articleLd = mindEssayJsonLd({
    mindName: mind.name,
    topic,
    description: metaDescription(desc),
    url: canonical,
    mindUrl,
    image: abs(`/mind/${params.id}/og.png`),
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/minds`],
    [mind.name, mindUrl],
    [topic, canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />

      <nav className="seo-meta">
        <Link href={`/mind/${params.id}`}>← {mind.name}</Link>
      </nav>

      <h1>
        How {mind.name} might approach {topic}
      </h1>

      <section className="seo-section">
        {essayParagraphs.length ? (
          <>
            {essayParagraphs.map((p, i) => (
              <p key={i}>{p}</p>
            ))}
          </>
        ) : (
          <>
            <p>
              This is a framed view of how {mind.name}
              {mind.era ? ` (${mind.era})` : ""} might reason about {topic},
              drawing on the methods, values, and concerns their work exhibits.
              {mind.domain ? ` ${mind.name} is best known in ${mind.domain}.` : ""}
            </p>
            {mind.bio_summary ? <p>{mind.bio_summary}</p> : null}
            <p>
              The fullest version of this perspective is interactive — put a
              question to {mind.name} directly and follow the reasoning where it
              leads.
            </p>
          </>
        )}
        <p>
          <small>
            Imagined perspective — an AI synthesis grounded in {mind.name}&rsquo;s
            recorded ideas and methods, not a quotation or a statement they
            actually made.
          </small>
        </p>
      </section>

      <p className="seo-cta-row">
        <a className="primary" href={readerUrl}>
          Chat with {mind.name} →
        </a>
        <Link className="secondary" href={`/topic/${params.slug}`}>
          {topic} on Feynman
        </Link>
      </p>

      <footer className="seo-explore-footer">
        <small>
          Read more: <Link href={`/mind/${params.id}`}>About {mind.name}</Link>
          {" · "}
          <Link href={`/topic/${params.slug}`}>{topic} on Feynman</Link>
        </small>
      </footer>
    </SeoColumn>
  );
}
