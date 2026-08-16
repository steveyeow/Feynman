import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import EntityLayout from "@/components/seo/EntityLayout";
import EntityActions, { type EntityAction } from "@/components/seo/EntityActions";
import JsonLd from "@/components/seo/JsonLd";
import { getBookData, SITE_URL } from "@/lib/seo-book";
import { abs, breadcrumbJsonLd, fetchEntityDiscussions } from "@/lib/seo-mind";

// Aggregation page: approved public chat sessions ABOUT a book. Mirrors the
// production /book/{id}/discussions. Indexable list that showcases real reader
// conversations (UGC) + funnels into chat. ISR-cached.
export const revalidate = 600;
export const dynamicParams = true;

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const book = await getBookData(params.id);
  // Pre-stream 404 (the parent loading.tsx flushes a 200 shell before the page
  // body's notFound() can run — Soft 404 otherwise). See /book/[id].
  if (!book) notFound();
  const canonical = abs(`/book/${params.id}/discussions`);
  const name = book.title || "this book";
  const desc = `Public conversations readers have shared about ${name} on Feynman.`;
  const ogImage = abs(`/og?type=book-agg&id=${encodeURIComponent(params.id)}&kind=discussions`);
  return {
    title: `Discussions about ${name} — Feynman`,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: `Discussions about ${name}`,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [{ url: ogImage, width: 1200, height: 630, alt: `Discussions about ${name}` }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: `Discussions about ${name}`,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function BookDiscussionsPage({
  params,
}: {
  params: { id: string };
}) {
  const book = await getBookData(params.id);
  if (!book) notFound();
  const { discussions } = await fetchEntityDiscussions("agents", params.id);

  const canonical = abs(`/book/${params.id}/discussions`);
  const chatHref = `/?book=${encodeURIComponent(params.id)}`;
  const actions: EntityAction[] = [
    { label: `Chat with this book`, href: chatHref, variant: "primary" },
    { label: `About ${book.title}`, href: `/book/${params.id}`, variant: "secondary" },
  ];

  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    [book.title, abs(`/book/${params.id}`)],
    ["Discussions", canonical],
  ]);

  const hero = (
    <>
      <Link href={`/book/${params.id}`} className="seo-backlink">
        ← {book.title}
      </Link>
      <p className="seo-meta">Public discussions</p>
      <h1>Discussions about {book.title}</h1>
      <EntityActions actions={actions} shareUrl={canonical} shareTitle={`Discussions about ${book.title}`} />
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
            No public discussions about {book.title} yet. Start a conversation and
            share it — your discussion could be the first to appear here (your
            questions stay private until you choose to share).
          </p>
        </section>
      )}
    </EntityLayout>
  );
}
