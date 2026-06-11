import { Suspense } from "react";
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
  fetchMindDialogues,
  fetchMindQuestions,
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
  // Hybrid intent: GSC shows searchers qualify with wiki/biography/who-is/
  // occupation — so the snippet opens by ANSWERING that intent ("Who is X?
  // {occupation}") — then differentiates with the Type-0 value (a living entry
  // you can question) instead of reading like another static bio.
  const who = [mind.era, mind.domain].filter(Boolean).join(" · ");
  const lead = `Who is ${mind.name}?${who ? ` ${who}.` : ""} Biography and key ideas — then chat with ${mind.name} directly and get answers in their own voice. A living entry, not a static page.`;
  return metaDescription(mind.bio_summary ? `${lead} ${mind.bio_summary}` : lead);
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
  const ogImage = abs(`/og?type=mind&id=${encodeURIComponent(params.id)}`);
  const desc = descFor(mind);
  return {
    // Type-0 title rule (seo-geo-master-plan §3.5): the title states the
    // unique artifact plainly — here, the chattable thinker — like every other
    // type does (Type 1 = the question, Type 2 = "How X might approach Y").
    // "Chat with {Name}" LEADS (the capability no static site has, and the
    // exact on-page CTA), intent words (biography/ideas per GSC) follow.
    // FROZEN until GSC CTR data says otherwise — do not wordsmith further.
    title: `Chat with ${mind.name} — Biography & Key Ideas | Feynman`,
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
  const id = params.id;
  // FAST PATH — only the primary mind row + the (small) topic list the hero's
  // starter chips need. Everything heavier (full catalog for works, related-mind
  // similarity, library/themes/dialogues/questions) is fetched inside Suspense
  // boundaries below, so the hero + the mind's own content (voice, perspectives,
  // phrases, bio) paint in ~one round-trip instead of waiting on all ~7 fetches.
  const [mind, topics] = await Promise.all([fetchMind(id), fetchTopics()]);
  if (!mind) notFound();

  const matchingTopics = topics.filter((t) => isMindTopicRelevant(mind, t));

  const canonical = abs(`/mind/${id}`);
  const ogImage = abs(`/og?type=mind&id=${encodeURIComponent(id)}`);
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
    { label: `Chat with ${mind.name}`, href: `/mind/${encodeURIComponent(id)}/chat`, variant: "primary" },
  ];

  // First-person hook — the mind's own signature line (a real quote, no
  // generation). Turns the page from "an article about X" into "X's voice".
  const signatureQuote = (mind.typical_phrases || []).find(
    (p) => p && p.trim().length > 12,
  );
  // Starter prompts deep-link into the chat funnel (/?mind=&q=), preselecting the
  // mind AND prefilling the question — interaction entries, not a dead-end button.
  const starters = [
    ...matchingTopics.slice(0, 3).map((t) => ({
      label: t,
      q: `How would you approach ${t}?`,
    })),
    { label: "Where might you be wrong?", q: `Where might your own ideas be wrong or incomplete?` },
  ];

  const hero = (
    <>
      <p className="seo-meta">Great mind</p>
      <h1>{mind.name}</h1>
      {eraDomain ? <p className="seo-meta">{eraDomain}</p> : null}
      {signatureQuote ? (
        <blockquote className="mind-signature">{`“${signatureQuote}”`}</blockquote>
      ) : null}
      <div className="mind-starters">
        <span className="mind-starters-label">Think with {mind.name}:</span>
        {starters.map((s) => (
          <Link
            key={s.q}
            href={`/?mind=${encodeURIComponent(id)}&q=${encodeURIComponent(s.q)}`}
            className="mind-starter-chip"
          >
            <svg
              className="mind-starter-chip-icon"
              width="13"
              height="13"
              viewBox="0 0 24 24"
              fill="none"
              aria-hidden="true"
            >
              <path
                d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            {s.label}
          </Link>
        ))}
      </div>
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={mind.name} />
    </>
  );

  // Rail (Notable works + Related minds) needs the full catalog + similarity —
  // stream it so it never blocks the hero.
  const rail = (
    <Suspense fallback={null}>
      <MindRail id={id} mind={mind} />
    </Suspense>
  );

  return (
    <EntityLayout hero={hero} rail={rail}>
      <JsonLd data={personLd} />
      <JsonLd data={breadcrumbLd} />

      {/* First-person About — the mind in their own (imagined) voice, up top.
          Turns "an article about X" into "X, talking to you". */}
      {mind.voice ? (
        <section className="seo-section mind-voice-section">
          <p className="mind-voice-label">In {mind.name}&apos;s own words · imagined</p>
          <p className="mind-voice-text">{mind.voice}</p>
        </section>
      ) : null}

      {/* ① The distinctive supply, up front: imagined, persona-grounded
          perspectives (Type 2) Wikipedia structurally can't have — as clickable
          cards, not a buried list. */}
      {matchingTopics.length ? (
        <section className="seo-section">
          <h2>Think with {mind.name}</h2>
          <p className="seo-meta">
            Imagined, persona-grounded perspectives — how {mind.name} would reason
            about each field. Read one, then take the question further in conversation.
          </p>
          <div className="mind-topic-cards">
            {matchingTopics.slice(0, 8).map((t) => (
              <Link
                key={t}
                href={`/mind/${id}/on/${topicSlug(t)}`}
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

      {/* ② A LIVING mind: what people discuss + recent dialogues (Type 4).
          Deferred — community aggregates, not core to the first paint. */}
      <Suspense fallback={null}>
        <MindLivingSections id={id} name={mind.name} />
      </Suspense>

      {/* ③ In their voice — signature phrases + core approach (first-person feel). */}
      <MindPhrases phrases={mind.typical_phrases} name={mind.name} mindId={id} />

      {/* Pre-answered Q&A pages (the person-question search demand). Deferred. */}
      <Suspense fallback={null}>
        <MindQuestionsSection id={id} name={mind.name} />
      </Suspense>

      {/* Full persona stays private; the API exposes a bounded excerpt. */}
      <MindPersonaExcerpt persona={mind.persona_excerpt || mind.persona} />

      {/* ④ Encyclopedic context — demoted below the distinctive content. */}
      <MindBio bio={mind.bio_summary} name={mind.name} />
      <MindThinkingStyle style={mind.thinking_style} />

      {/* Books in the mind's library (minus Notable works) — deferred. */}
      <Suspense fallback={null}>
        <MindLibrarySection id={id} name={mind.name} works={mind.works} />
      </Suspense>
    </EntityLayout>
  );
}

// ── Deferred (streamed) sections ─────────────────────────────────────────
// Each fetches its own data and degrades to nothing on failure, so a slow or
// failing enrichment fetch never blocks (or breaks) the hero + core content.

async function MindRail({ id, mind }: { id: string; mind: MindDetail }) {
  try {
    const [agents, related] = await Promise.all([fetchAgents(), fetchRelatedMinds(mind)]);
    const hasWorks = (mind.works || []).filter(Boolean).length > 0;
    if (!hasWorks && !related.length) return null;
    return (
      <>
        <MindWorks works={mind.works} agents={agents} variant="rail" />
        {related.length ? (
          <div className="seo-rail-card">
            <h3>Related minds</h3>
            <ul>
              {related.slice(0, 8).map((rm) => (
                <li key={rm.id}>
                  <Link href={`/mind/${rm.slug || rm.id}`}>{rm.name}</Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );
  } catch {
    return null;
  }
}

async function MindLivingSections({ id, name }: { id: string; name: string }) {
  try {
    const [themes, dialogues] = await Promise.all([
      fetchMindThemes(id),
      fetchMindDialogues(id, 3),
    ]);
    return (
      <>
        {themes.length ? (
          <section className="seo-section">
            <h2>What people explore with {name}</h2>
            <p className="seo-meta">
              Topics readers have actually been discussing with {name} on Feynman.
              Updates as new conversations happen.
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
        {dialogues.length >= 3 ? <DialoguesLink mindId={id} name={name} /> : null}
      </>
    );
  } catch {
    return null;
  }
}

async function MindQuestionsSection({ id, name }: { id: string; name: string }) {
  try {
    const mindQuestions = await fetchMindQuestions(id);
    if (!mindQuestions.length) return null;
    return (
      <section className="seo-section">
        <h2>Questions about {name}</h2>
        <ul>
          {mindQuestions.map((q) => (
            <li key={q.slug}>
              <Link href={`/mind/${id}/q/${q.slug}`}>{q.question}</Link>
            </li>
          ))}
        </ul>
      </section>
    );
  } catch {
    return null;
  }
}

async function MindLibrarySection({
  id,
  name,
  works,
}: {
  id: string;
  name: string;
  works?: string[];
}) {
  try {
    const library = await fetchMindLibrary(id);
    // "Books in this mind's library" = linked books NOT already in Notable Works
    // (dedupe by case-insensitive title).
    const workTitles = new Set((works || []).map((w) => w.toLowerCase().trim()));
    const libraryExtra = library.filter(
      (b) => !workTitles.has((b.name || "").toLowerCase().trim()),
    );
    if (!libraryExtra.length) return null;
    return (
      <section className="seo-section">
        <h2>Books in {name}&apos;s library</h2>
        <ul className="related-books">
          {libraryExtra.map((b) => (
            <li key={b.id}>
              <Link href={`/book/${b.slug || b.id}`}>{b.name}</Link>
            </li>
          ))}
        </ul>
      </section>
    );
  } catch {
    return null;
  }
}
