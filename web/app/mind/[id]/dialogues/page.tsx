import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  dialoguesArticleJsonLd,
  fetchMind,
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
  const readerUrl = `${SITE_URL}/#/mind/${params.id}`;

  // No JSON source for publishable dialogues — always the empty state for now.
  const dialogues: Array<{ text: string }> = [];

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

  return (
    <SeoColumn>
      <JsonLd data={articleLd} />
      <JsonLd data={breadcrumbLd} />

      <nav className="seo-meta">
        <Link href={`/mind/${params.id}`}>← {mind.name}</Link>
      </nav>

      <h1>AI dialogues with {mind.name}</h1>
      <p>
        Accumulated AI agent responses from real chat sessions with {mind.name}.
        Updated as more conversations happen. The agent&rsquo;s responses are
        published; user questions remain private.
      </p>

      {dialogues.length ? (
        <div className="insights">
          {dialogues.map((d, i) => (
            <article key={i} className="insight-card">
              <p>{d.text}</p>
            </article>
          ))}
        </div>
      ) : (
        <section className="seo-section insights-empty">
          <p>
            No AI dialogues have accumulated yet for {mind.name}. Start a chat
            below and the agent&rsquo;s responses get aggregated here (your
            questions stay private).
          </p>
        </section>
      )}

      <p className="seo-cta-row">
        <a className="primary" href={readerUrl}>
          Chat with {mind.name} →
        </a>
      </p>
    </SeoColumn>
  );
}
