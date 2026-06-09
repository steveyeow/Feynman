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
  fetchMinds,
  fetchTopics,
  filterMindsByTopic,
  isMindTopicRelevant,
  metaDescription,
  mindEssayJsonLd,
  resolveTopicSlug,
  topicSlug,
} from "@/lib/seo-mind";

// The imagined essay comes from GET /api/minds/{id}/on/{slug} (mirrors the
// legacy qa.generate_mind_on_topic_essay). When that endpoint returns an
// essay we render it; when it 404s (relevance gate) or returns nothing
// (ENABLE_MIND_ESSAY off / generation failed), we fall back to the framed
// view below so the page is always substantive and never crashes.

export const revalidate = 86400;
export const dynamicParams = true;
// Empty generateStaticParams() opts this dynamic route into ISR caching (render
// on-demand, then CACHE) instead of dynamic-render-every-request (no-store).
export function generateStaticParams() {
  return [];
}

export async function generateMetadata({
  params,
}: {
  params: { id: string; slug: string };
}): Promise<Metadata> {
  const [mind, topic, onTopic] = await Promise.all([
    fetchMind(params.id),
    resolveTopicSlug(params.slug),
    fetchMindOnTopic(params.id, params.slug),
  ]);
  if (!mind || !topic) {
    return { title: "Not found — Feynman" };
  }
  // Canonical = the one true lowercase slug, regardless of how the URL was
  // typed (resolveTopicSlug matches case-insensitively).
  const canonical = abs(`/mind/${params.id}/on/${topicSlug(topic)}`);
  const title = `How ${mind.name} might approach ${topic}`;
  const desc = metaDescription(
    `An imagined perspective on ${topic}, grounded in ${mind.name}'s recorded ideas and methods. Explore it in conversation on Feynman.`,
  );
  // No generated essay yet → keep this URL out of the index. Without an essay
  // the page is one of ~1000×15 near-identical framed shells (same three
  // sentences, only the name/topic swapped) — exactly the thin programmatic
  // combinations behind the GSC "Discovered – not indexed" problem. `follow`
  // still passes link equity, and once the essay generates + caches on a later
  // crawl the page becomes indexable.
  const hasEssay = Boolean(onTopic?.essay && onTopic.essay.trim());
  return {
    title: `${title} — Feynman`,
    description: desc,
    alternates: { canonical },
    ...(hasEssay ? {} : { robots: { index: false, follow: true } }),
    openGraph: {
      type: "article",
      title,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [abs(`/og?type=essay&id=${encodeURIComponent(params.id)}&slug=${encodeURIComponent(params.slug)}`)],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title,
      description: desc,
      images: [abs(`/og?type=essay&id=${encodeURIComponent(params.id)}&slug=${encodeURIComponent(params.slug)}`)],
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

  const canonicalSlug = topicSlug(topic);
  const canonical = abs(`/mind/${params.id}/on/${canonicalSlug}`);
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
    image: abs(`/og?type=essay&id=${encodeURIComponent(params.id)}&slug=${encodeURIComponent(params.slug)}`),
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/minds`],
    [mind.name, mindUrl],
    [topic, canonical],
  ]);

  const eraDomain = [mind.era, mind.domain].filter(Boolean).join(" · ");
  // Exploration data — turn the page from a dead-end essay into a hub: the mind's
  // OTHER perspectives, plus how OTHER minds approach the same topic. Both are
  // cached lite-list fetches and the page is ISR (renders ~once/day per URL).
  const [allTopics, allMinds] = await Promise.all([fetchTopics(), fetchMinds()]);
  const otherTopics = allTopics
    .filter((t) => isMindTopicRelevant(mind, t) && topicSlug(t) !== canonicalSlug)
    .slice(0, 6);
  const otherMinds = filterMindsByTopic(allMinds, topic, 8)
    .filter((m) => m.id !== mind.id)
    .slice(0, 6);

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
      {eraDomain ? <p className="seo-meta perspective-byline">{eraDomain}</p> : null}

      <section className="seo-section">
        {essayParagraphs.length ? (
          essayParagraphs.map((p, i) => <p key={i}>{p}</p>)
        ) : (
          <>
            <p>
              This is a framed view of how {mind.name}
              {mind.era ? ` (${mind.era})` : ""} might reason about {topic}, drawing
              on the methods, values, and concerns their work exhibits.
              {mind.domain ? ` ${mind.name} is best known in ${mind.domain}.` : ""}
            </p>
            {mind.bio_summary ? <p>{mind.bio_summary}</p> : null}
            <p>
              The fullest version of this perspective is interactive — put a question
              to {mind.name} directly and follow the reasoning where it leads.
            </p>
          </>
        )}
        <p className="perspective-disclaimer">
          Imagined perspective — an AI synthesis grounded in {mind.name}&rsquo;s
          recorded ideas and methods, not a quotation or a statement they actually
          made.
        </p>
      </section>

      <div className="seo-cta-row perspective-cta">
        <a className="primary" href={readerUrl}>
          Chat with {mind.name} →
        </a>
        <span className="perspective-cta-hint">
          Ask {mind.name} directly — the perspective comes alive in conversation.
        </span>
      </div>

      {otherTopics.length ? (
        <section className="seo-section">
          <h2>More perspectives from {mind.name}</h2>
          <div className="mind-topic-cards">
            {otherTopics.map((t) => (
              <Link
                key={t}
                href={`/mind/${params.id}/on/${topicSlug(t)}`}
                className="mind-topic-card"
              >
                <span className="mind-topic-card-eyebrow">How {mind.name} approaches</span>
                <span className="mind-topic-card-title">{t}</span>
                <span className="mind-topic-card-cta">Read the perspective →</span>
              </Link>
            ))}
          </div>
        </section>
      ) : null}

      {otherMinds.length ? (
        <section className="seo-section">
          <h2>How other minds approach {topic}</h2>
          <ul className="perspective-minds">
            {otherMinds.map((m) => (
              <li key={m.id}>
                <Link href={`/mind/${m.slug || m.id}/on/${canonicalSlug}`}>
                  <span className="perspective-minds-name">{m.name}</span>
                  {m.era ? <span className="perspective-minds-era">{m.era}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <p className="perspective-explore">
        <Link href={`/topic/${canonicalSlug}`}>Explore all of {topic} on Feynman →</Link>
      </p>
    </SeoColumn>
  );
}
