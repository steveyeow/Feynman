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
  metaDescription,
} from "@/lib/seo-mind";

// NOTE — missing endpoint:
// The legacy /mind/{id}/dialogues page rendered aggregated, PII-sanitized
// assistant messages from real chats (db.list_assistant_messages_for_mind +
// insights.select_publishable, behind the ENABLE_LIVE_INSIGHTS flag). There
// is NO public JSON API exposing that aggregation, so this route renders the
// empty-state (a chat invitation) plus the page chrome and Article JSON-LD.
// When a `GET /api/minds/{id}/dialogues` (publishable assistant cards) lands,
// map each card to an <article class="insight-card"> and add a dateModified
// to the Article schema.

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

  const dialogues = await fetchMindDialogues(params.id, 10);

  const articleLd = dialoguesArticleJsonLd({
    headline: `AI dialogues with ${mind.name}`,
    description: `AI dialogues with ${mind.name} on Feynman. Start a chat to seed the public dialogues page.`,
    url: canonical,
    aboutUrl: entityCanonical,
    aboutName: mind.name,
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Great Minds", `${SITE_URL}/#/minds`],
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
    </EntityLayout>
  );
}
