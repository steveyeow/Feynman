import type { Metadata } from "next";
import { notFound } from "next/navigation";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import {
  DialoguesLink,
  ExploreFooter,
  MindBio,
  MindPersonaExcerpt,
  MindPhrases,
  MindThinkingStyle,
  MindWorks,
  RelatedMinds,
  TopicLinksForMind,
} from "@/components/seo/mind/MindSections";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchAgents,
  fetchMind,
  fetchRelatedMinds,
  fetchTopics,
  isMindTopicRelevant,
  lookupSameAs,
  metaDescription,
  personJsonLd,
  topicSlug,
  type MindDetail,
} from "@/lib/seo-mind";

// Daily ISR; no generateStaticParams — minds are minted continuously and the
// set is large, so we render on-demand and cache.
export const revalidate = 86400;
export const dynamicParams = true;

function descFor(mind: MindDetail): string {
  const base =
    mind.bio_summary ||
    `${mind.name} — ${mind.domain || ""} thinker on Feynman`.trim();
  return metaDescription(base);
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const mind = await fetchMind(params.id);
  if (!mind) {
    return { title: "Mind not found — Feynman" };
  }
  const canonical = abs(`/mind/${params.id}`);
  const ogImage = abs(`/mind/${params.id}/og.png`);
  const desc = descFor(mind);
  return {
    title: `${mind.name} — Feynman Great Minds`,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "profile",
      title: mind.name,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [{ url: ogImage, width: 1200, height: 630, alt: `Portrait of ${mind.name} on Feynman` }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      creator: "@steve_yeow",
      title: mind.name,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function MindPage({
  params,
}: {
  params: { id: string };
}) {
  const mind = await fetchMind(params.id);
  if (!mind) notFound();

  // Enrichment in parallel; each degrades to empty on failure.
  const [agents, related, topics] = await Promise.all([
    fetchAgents(),
    fetchRelatedMinds(mind),
    fetchTopics(),
  ]);

  const matchingTopics = topics.filter((t) => isMindTopicRelevant(mind, t));

  const canonical = abs(`/mind/${params.id}`);
  const ogImage = abs(`/mind/${params.id}/og.png`);
  const readerUrl = `${SITE_URL}/#/mind/${params.id}`;

  // Explore footer: first matching topic + top related minds + first works' book.
  const exploreItems: Array<{ label: string; href: string }> = [];
  if (matchingTopics.length) {
    exploreItems.push({
      label: `More on ${matchingTopics[0]}`,
      href: `/topic/${topicSlug(matchingTopics[0])}`,
    });
  }
  for (const rm of related.slice(0, 2)) {
    if (rm.id && rm.name) exploreItems.push({ label: rm.name, href: `/mind/${rm.id}` });
  }

  const eraDomain = [mind.era, mind.domain].filter(Boolean).join(" · ");

  const personLd = personJsonLd({
    name: mind.name,
    description: mind.bio_summary || "",
    domain: mind.domain || "",
    url: canonical,
    image: ogImage,
    sameAs: lookupSameAs(mind.name),
    dateModified: mind.created_at || "",
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/#/minds`],
    [mind.name, canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={personLd} />
      <JsonLd data={breadcrumbLd} />

      <h1>{mind.name}</h1>
      {eraDomain ? <p className="seo-meta">{eraDomain}</p> : null}

      <MindBio bio={mind.bio_summary} />
      <MindThinkingStyle style={mind.thinking_style} />
      <MindPhrases phrases={mind.typical_phrases} />
      {/* persona is stripped by the JSON API — renders only if ever present */}
      <MindPersonaExcerpt persona={mind.persona} />
      <MindWorks works={mind.works} agents={agents} />
      <RelatedMinds minds={related} />
      <TopicLinksForMind topics={matchingTopics} />
      <DialoguesLink mindId={params.id} name={mind.name} />

      <p className="seo-cta-row">
        <a className="primary" href={readerUrl}>
          Chat with {mind.name} on Feynman →
        </a>
      </p>

      <ExploreFooter items={exploreItems} />
    </SeoColumn>
  );
}
