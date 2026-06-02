import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";
import {
  DialoguesLink,
  MindBio,
  MindPersonaExcerpt,
  MindPhrases,
  MindThinkingStyle,
  MindWorks,
} from "@/components/seo/mind/MindSections";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchAgents,
  fetchMind,
  fetchRelatedMinds,
  fetchTopics,
  fetchMindLibrary,
  fetchMindThemes,
  isMindTopicRelevant,
  mindSameAs,
  metaDescription,
  personJsonLd,
  topicSlug,
  type MindDetail,
} from "@/lib/seo-mind";

// Daily ISR. The EMPTY generateStaticParams() is load-bearing: it opts this
// dynamic route into the static/ISR path — prerender NONE (minds are minted
// continuously and the set is large) but render on-demand on first hit, then
// CACHE. Without it, Next 14 renders dynamically on every request (no-store),
// so every crawl re-hit Supabase.
export const revalidate = 86400;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

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
  const [agents, related, topics, library, themes] = await Promise.all([
    fetchAgents(),
    fetchRelatedMinds(mind),
    fetchTopics(),
    fetchMindLibrary(params.id),
    fetchMindThemes(params.id),
  ]);

  const matchingTopics = topics.filter((t) => isMindTopicRelevant(mind, t));

  // "Books in this mind's library" = linked books NOT already in Notable Works
  // (dedupe by case-insensitive title), per render_books_for_mind.
  const workTitles = new Set((mind.works || []).map((w) => w.toLowerCase().trim()));
  const libraryExtra = library.filter((b) => !workTitles.has((b.name || "").toLowerCase().trim()));

  const canonical = abs(`/mind/${params.id}`);
  const ogImage = abs(`/mind/${params.id}/og.png`);
  // Chat with a single mind → the DEDICATED 1:1 chat page (not the multi-mind
  // home composer, which would treat the mind as an invited participant). The
  // Chat action lives at the TOP.
  const chatHref = `/mind/${encodeURIComponent(params.id)}/chat`;

  const eraDomain = [mind.era, mind.domain].filter(Boolean).join(" · ");

  const personLd = personJsonLd({
    name: mind.name,
    description: mind.bio_summary || "",
    domain: mind.domain || "",
    url: canonical,
    image: ogImage,
    sameAs: mindSameAs(mind),
    dateModified: mind.created_at || "",
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/minds`],
    [mind.name, canonical],
  ]);

  const actions: EntityAction[] = [
    { label: `Chat with ${mind.name}`, href: chatHref, variant: "primary" },
  ];

  const hero = (
    <>
      <p className="seo-meta">Great mind</p>
      <h1>{mind.name}</h1>
      {eraDomain ? <p className="seo-meta">{eraDomain}</p> : null}
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={mind.name} />
    </>
  );

  // Rail = genuinely complementary "Related minds" only. The topic list lives in
  // the body ("How {mind} approaches key topics"); a rail "Topics" card repeated
  // the same labels on-screen (the bug the /topic review removed), so the
  // body section now carries BOTH the essay link and the topic-hub link instead.
  const rail = related.length ? (
    <div className="seo-rail-card">
      <h3>Related minds</h3>
      <ul>
        {related.slice(0, 8).map((rm) => (
          <li key={rm.id}>
            <Link href={`/mind/${rm.id}`}>{rm.name}</Link>
          </li>
        ))}
      </ul>
    </div>
  ) : null;

  return (
    <EntityLayout hero={hero} rail={rail}>
      <JsonLd data={personLd} />
      <JsonLd data={breadcrumbLd} />

      <MindBio bio={mind.bio_summary} />
      <MindThinkingStyle style={mind.thinking_style} />
      <MindPhrases phrases={mind.typical_phrases} />
      {/* Full persona stays private; the API exposes a bounded excerpt. */}
      <MindPersonaExcerpt persona={mind.persona_excerpt || mind.persona} />
      <MindWorks works={mind.works} agents={agents} />

      {matchingTopics.length ? (
        <section className="seo-section">
          <h2>How {mind.name} approaches key topics</h2>
          <p className="seo-meta">
            Imagined, persona-grounded perspectives — read how {mind.name} would
            reason about each field, then take the question further in conversation.
          </p>
          <ul className="mind-on-topics">
            {matchingTopics.slice(0, 8).map((t) => (
              <li key={t}>
                <Link href={`/mind/${params.id}/on/${topicSlug(t)}`}>
                  How {mind.name} approaches {t}
                </Link>
                {" · "}
                <Link href={`/topic/${topicSlug(t)}`} className="seo-inline-link">
                  {t} hub
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {libraryExtra.length ? (
        <section className="seo-section">
          <h2>Books in {mind.name}&apos;s library</h2>
          <ul className="related-books">
            {libraryExtra.map((b) => (
              <li key={b.id}>
                <Link href={`/book/${b.id}`}>{b.name}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {themes.length ? (
        <section className="seo-section">
          <h2>Recent themes in conversations</h2>
          <p className="seo-meta">
            Topics readers have actually been discussing with {mind.name} on
            Feynman, aggregated across sessions. Updates as new conversations happen.
          </p>
          <ul className="theme-list">
            {themes.map((t) => (
              <li key={t.topic} className="theme-chip">
                {t.topic}
                {t.count > 1 ? <span className="theme-count"> ×{t.count}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <DialoguesLink mindId={params.id} name={mind.name} />
    </EntityLayout>
  );
}
