import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchEntityDiscussions,
  fetchMind,
} from "@/lib/seo-mind";

// Aggregation page: approved public chat sessions WITH a mind. Mirrors the
// production /mind/{id}/discussions. ISR-cached.
export const revalidate = 600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const mind = await fetchMind(params.id);
  // Pre-stream 404 (the parent loading.tsx flushes a 200 shell before the page
  // body's notFound() can run — Soft 404 otherwise). See /book/[id].
  if (!mind) notFound();
  const canonical = abs(`/mind/${params.id}/discussions`);
  const name = mind.name || "this mind";
  const desc = `Public conversations readers have shared with ${name} on Feynman.`;
  const ogImage = abs(`/og?type=mind-agg&id=${encodeURIComponent(params.id)}&kind=discussions`);
  return {
    title: `Discussions with ${name} — Feynman`,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: `Discussions with ${name}`,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [{ url: ogImage, width: 1200, height: 630, alt: `Discussions with ${name}` }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: `Discussions with ${name}`,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function MindDiscussionsPage({
  params,
}: {
  params: { id: string };
}) {
  const mind = await fetchMind(params.id);
  if (!mind) notFound();
  const { discussions } = await fetchEntityDiscussions("minds", params.id);

  const canonical = abs(`/mind/${params.id}/discussions`);
  // Dedicated 1:1 chat page (not the multi-mind home composer).
  const chatHref = `/mind/${encodeURIComponent(params.id)}/chat`;
  const actions: EntityAction[] = [
    { label: `Chat with ${mind.name}`, href: chatHref, variant: "primary" },
    { label: `About ${mind.name}`, href: `/mind/${params.id}`, variant: "secondary" },
  ];

  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    [mind.name, abs(`/mind/${params.id}`)],
    ["Discussions", canonical],
  ]);

  const hero = (
    <>
      <Link href={`/mind/${params.id}`} className="seo-backlink">
        ← {mind.name}
      </Link>
      <p className="seo-meta">Public discussions</p>
      <h1>Discussions with {mind.name}</h1>
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={`Discussions with ${mind.name}`} />
    </>
  );

  return (
    <EntityLayout hero={hero}>
      <JsonLd data={breadcrumbLd} />
      {discussions.length ? (
        <section className="seo-section">
          <ul className="discussion-list">
            {discussions.map((d) => (
              <li key={d.id}>
                <Link href={`/discussions/${d.id}`} className="discussion-list-item">
                  <span className="discussion-list-title">{d.title}</span>
                  <span className="discussion-list-by">shared by {d.handle}</span>
                </Link>
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="seo-section">
          <p>
            No public discussions with {mind.name} yet. Start a conversation and
            share it — your discussion could be the first to appear here (your
            questions stay private until you choose to share).
          </p>
        </section>
      )}
    </EntityLayout>
  );
}
