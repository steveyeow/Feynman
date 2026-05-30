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
  isMindTopicRelevant,
  metaDescription,
  mindEssayJsonLd,
  resolveTopicSlug,
} from "@/lib/seo-mind";

// NOTE — missing endpoint:
// The legacy /mind/{id}/on/{slug} page rendered an LLM-generated imagined
// essay (qa.generate_mind_on_topic_essay). There is NO JSON API for that
// generation, so this Next.js route renders a MINIMAL page: the framed title,
// an explicit "imagined perspective" disclaimer, and links back to the mind
// and topic hubs. When an essay endpoint exists (e.g. GET
// /api/minds/{id}/on/{slug}), drop the generated paragraphs in below and
// extend the Article JSON-LD description with an excerpt.

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
  if (!mind || !topic || !isMindTopicRelevant(mind, topic)) {
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
  // Relevance gate — mirrors the legacy 404 for implausible (mind, topic)
  // pairs so we don't expose programmatic combinations.
  if (!isMindTopicRelevant(mind, topic)) notFound();

  const canonical = abs(`/mind/${params.id}/on/${params.slug}`);
  const mindUrl = abs(`/mind/${params.id}`);
  const readerUrl = `${SITE_URL}/#/mind/${params.id}`;
  const desc = `An imagined perspective on ${topic}, grounded in ${mind.name}'s recorded ideas and methods.`;

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
    ["Great Minds", `${SITE_URL}/#/minds`],
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
