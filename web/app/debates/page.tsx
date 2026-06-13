import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import { SITE_URL, abs, breadcrumbJsonLd, fetchDebatesList } from "@/lib/seo-mind";

// The debates index — the discovery surface for Type-4 multi-mind symposia
// (the philosophie.ai-style feed). Question-led entries: a sharp question pulls
// far harder than an entity name.

export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
  const canonical = abs("/debates");
  return {
    title: "Debates — history's great minds argue today's questions | Feynman",
    description:
      "Multi-mind debates on Feynman: 2-4 great thinkers argue one question, each in their own voice, engaging the others. Read the symposium, then join the conversation.",
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: "Debates — great minds argue today's questions",
      description:
        "2-4 great thinkers argue one question, each in their own voice. Read the symposium, then chat with any of them.",
      url: canonical,
      siteName: "Feynman",
    },
  };
}

export default async function DebatesIndexPage() {
  const debates = await fetchDebatesList();
  const canonical = abs("/debates");

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Debates on Feynman",
    url: canonical,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: debates.length,
      itemListElement: debates.map((d, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: abs(`/debate/${d.slug}`),
        name: d.question,
      })),
    },
  };
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Debates", canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={itemListLd} />
      <JsonLd data={breadcrumbLd} />

      <h1>Debates</h1>
      <p className="seo-meta">
        History&apos;s great minds argue today&apos;s questions — 2-4 thinkers
        per question, each in their own voice, engaging the others. Read the
        symposium, then join the conversation.
      </p>

      {debates.length ? (
        <section className="seo-section">
          <ul>
            {debates.map((d) => (
              <li key={d.slug}>
                <Link href={`/debate/${d.slug}`}>{d.question}</Link>
                {d.topic ? <span className="seo-meta"> · {d.topic}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="seo-section">
          <p>No debates yet — check back soon.</p>
        </section>
      )}
    </SeoColumn>
  );
}
