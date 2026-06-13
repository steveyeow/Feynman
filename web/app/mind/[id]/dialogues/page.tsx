import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  dialoguesArticleJsonLd,
  fetchMind,
  fetchMindDialogues,
  fetchMindDebates,
  metaDescription,
} from "@/lib/seo-mind";

// Type-4 auto-fill surface: renders aggregated, PII-sanitized assistant
// messages from real chats via GET /api/minds/{id}/dialogues (the public
// mirror of insights.select_publishable). The page renders cards when the
// corpus exists and an empty-state chat invitation when it doesn't — so it
// fills automatically as chat volume grows, no code change needed. The
// sitemap gates this URL at ≥3 publishable messages, so empty pages aren't
// advertised; dateModified below tracks the latest message so Google re-crawls
// when fresh dialogue lands.

export const revalidate = 86400;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const mind = await fetchMind(params.id);
  if (!mind) return { title: "Mind not found — Feynman" };
  const canonical = abs(`/mind/${params.id}/dialogues`);
  const title = `AI dialogues with ${mind.name} — Feynman`;
  const desc = metaDescription(
    `AI agent responses from real chat sessions with ${mind.name} on Feynman, aggregated and refreshed as new conversations happen. AI output only; user questions stay private.`,
  );
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
      images: [abs(`/og?type=mind-agg&id=${encodeURIComponent(params.id)}&kind=dialogues`)],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title,
      description: desc,
      images: [abs(`/og?type=mind-agg&id=${encodeURIComponent(params.id)}&kind=dialogues`)],
    },
  };
}

export default async function MindDialoguesPage({
  params,
}: {
  params: { id: string };
}) {
  const mind = await fetchMind(params.id);
  if (!mind) notFound();

  const canonical = abs(`/mind/${params.id}/dialogues`);
  const entityCanonical = abs(`/mind/${params.id}`);
  // Chat with a single mind → the DEDICATED 1:1 chat page (not the reader,
  // not the multi-mind home composer), so a cold visitor can start talking.
  const chatHref = `/mind/${encodeURIComponent(params.id)}/chat`;

  const [dialogues, debates] = await Promise.all([
    fetchMindDialogues(params.id, 10),
    fetchMindDebates(params.id),
  ]);

  const articleLd = dialoguesArticleJsonLd({
    headline: `AI dialogues with ${mind.name}`,
    description: `AI dialogues with ${mind.name} on Feynman. Start a chat to seed the public dialogues page.`,
    url: canonical,
    aboutUrl: entityCanonical,
    aboutName: mind.name,
    // Freshness signal: latest contributing dialogue → Google re-crawls as the
    // corpus grows (the Type-4 auto-fill loop).
    dateModified: dialogues[0]?.created_at || "",
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/minds`],
    [mind.name, entityCanonical],
    ["Dialogues", canonical],
  ]);

  const actions: EntityAction[] = [
    { label: `Chat with ${mind.name}`, href: chatHref, variant: "primary" },
  ];

  const hero = (
    <>
      <Link href={`/mind/${params.id}`} className="seo-backlink">
        ← {mind.name}
      </Link>
      <p className="seo-meta">Live AI dialogues</p>
      <h1>AI dialogues with {mind.name}</h1>
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={`AI dialogues with ${mind.name}`} />
    </>
  );

  const rail = (
    <div className="seo-rail-card">
      <h3>About this mind</h3>
      <ul>
        <li>
          <Link href={`/mind/${params.id}`}>{mind.name}</Link>
        </li>
        <li>
          <Link href={`/mind/${params.id}/discussions`}>
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
        These are AI agent responses from real chat sessions with {mind.name} on
        Feynman, aggregated and refreshed as new conversations happen. The
        agent&apos;s responses are published; reader questions stay private.
      </p>

      {dialogues.length ? (
        <section className="seo-section insights">
          {dialogues.map((d, i) => (
            <article key={i} className="insight-card">
              <span className="insight-card-who">{mind.name}</span>
              <p>{d.text}</p>
            </article>
          ))}
          <p>
            <small>
              Synthesized from AI agent responses across reader conversations.
              AI output only; user questions are never published.
            </small>
          </p>
        </section>
      ) : (
        <section className="seo-section insights-empty">
          <p>
            No AI dialogues have accumulated yet for {mind.name}. Start a chat
            and the agent&apos;s responses get aggregated here (your questions
            stay private).
          </p>
        </section>
      )}

      {debates.length ? (
        <section className="seo-section">
          <h2>Debates {mind.name} joined</h2>
          <ul>
            {debates.map((d) => (
              <li key={d.slug}>
                <Link href={`/debate/${d.slug}`}>{d.question}</Link>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </EntityLayout>
  );
}
