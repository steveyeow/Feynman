import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import { ExploreFooter } from "@/components/seo/mind/MindSections";
import {
  SITE_URL,
  abs,
  bookAuthor,
  breadcrumbJsonLd,
  collectionJsonLd,
  fetchAgents,
  fetchMinds,
  fetchTopics,
  filterBooksByTopic,
  filterMindsByTopic,
  metaDescription,
  resolveTopicSlug,
  topicSlug,
} from "@/lib/seo-mind";

export const revalidate = 86400;
export const dynamicParams = true;

function introText(topic: string, bookCount: number, mindCount: number): string {
  const parts: string[] = [];
  if (bookCount > 0) parts.push(`${bookCount} ${bookCount === 1 ? "book" : "books"}`);
  if (mindCount > 0)
    parts.push(`${mindCount} great ${mindCount === 1 ? "mind" : "minds"}`);
  if (!parts.length) {
    return `Explore ${topic} on Feynman — chat with the best books and great thinkers shaping this field.`;
  }
  return `${parts.join(" and ")} on ${topic} curated for chat and exploration on Feynman — read the canon, ask the questions you actually have, and discuss with the thinkers who shaped the field.`;
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const topic = await resolveTopicSlug(params.slug);
  if (!topic) return { title: "Topic not found — Feynman" };
  const canonical = abs(`/topic/${params.slug}`);
  const title = `${topic} on Feynman`;
  const desc = metaDescription(
    `Chat with the best ${topic} books and great minds on Feynman. Read the canon and discuss ideas with the thinkers who shaped the field.`,
  );
  return {
    title,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "website",
      title,
      description: desc,
      url: canonical,
      siteName: "Feynman",
    },
    twitter: { card: "summary", site: "@steve_yeow", title, description: desc },
  };
}

export default async function TopicPage({
  params,
}: {
  params: { slug: string };
}) {
  const topic = await resolveTopicSlug(params.slug);
  if (!topic) notFound();

  const [agents, minds, topics] = await Promise.all([
    fetchAgents(),
    fetchMinds(),
    fetchTopics(),
  ]);

  const books = filterBooksByTopic(agents, topic, 30);
  const topicMinds = filterMindsByTopic(minds, topic, 12);

  const canonical = abs(`/topic/${params.slug}`);

  // CollectionPage → ItemList: books first, then minds.
  const items: Array<{ name: string; url: string }> = [];
  for (const b of books) {
    if (b.id && b.name) items.push({ name: b.name, url: abs(`/book/${b.id}`) });
  }
  for (const m of topicMinds) {
    if (m.id && m.name) items.push({ name: m.name, url: abs(`/mind/${m.id}`) });
  }

  const desc = `Chat with the best ${topic} books and great minds on Feynman. ${books.length} curated ${books.length === 1 ? "book" : "books"}, ${topicMinds.length} ${topicMinds.length === 1 ? "thinker" : "thinkers"}.`;

  const collectionLd = collectionJsonLd({
    name: `${topic} on Feynman`,
    description: metaDescription(desc),
    url: canonical,
    items,
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Topics", `${SITE_URL}/#/library`],
    [topic, canonical],
  ]);

  // Explore footer: sibling topic hubs (skip self), up to 4.
  const siblings = topics.filter((t) => t !== topic).slice(0, 4);
  const exploreItems = siblings.map((t) => ({
    label: t,
    href: `/topic/${topicSlug(t)}`,
  }));

  return (
    <SeoColumn>
      <JsonLd data={collectionLd} />
      <JsonLd data={breadcrumbLd} />

      <h1>{topic}</h1>
      <p className="topic-intro">{introText(topic, books.length, topicMinds.length)}</p>

      {books.length ? (
        <section className="seo-section">
          <h2>Books in this topic</h2>
          <ul className="topic-books">
            {books.map((b) => {
              const author = bookAuthor(b);
              return (
                <li key={b.id}>
                  <Link href={`/book/${b.id}`}>{b.name}</Link>
                  {author ? ` — ${author}` : ""}
                </li>
              );
            })}
          </ul>
        </section>
      ) : null}

      {topicMinds.length ? (
        <section className="seo-section">
          <h2>Great minds on this topic</h2>
          <ul className="topic-minds">
            {topicMinds.map((m) => (
              <li key={m.id}>
                <Link href={`/mind/${m.id}`}>{m.name}</Link>
                {m.era ? ` — ${m.era}` : ""}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      {!books.length && !topicMinds.length ? (
        <section className="seo-section">
          <p>
            We&rsquo;re still curating {topic} on Feynman. Open the library to
            discover books in this field — if a title isn&rsquo;t here yet,
            Feynman finds and adds it in real time.
          </p>
        </section>
      ) : null}

      <p className="seo-cta-row">
        <a className="primary" href={`${SITE_URL}/#/library`}>
          Explore the full Feynman library →
        </a>
      </p>

      <ExploreFooter items={exploreItems} label="Other topics" />
    </SeoColumn>
  );
}
