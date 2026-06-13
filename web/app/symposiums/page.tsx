import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import { SITE_URL, abs, breadcrumbJsonLd, fetchDebatesList } from "@/lib/seo-mind";

// The symposiums index — the discovery surface for Type-4 multi-mind symposia
// (the philosophie.ai-style feed). Question-led entries: a sharp question pulls
// far harder than an entity name. (Internal data/fns keep the "debate" name.)

export const revalidate = 3600;

export async function generateMetadata(): Promise<Metadata> {
  const canonical = abs("/symposiums");
  return {
    title: "Symposiums — history's great minds on today's questions | Feynman",
    description:
      "Symposiums on Feynman: 2-4 great thinkers take up one question, each in their own voice, engaging the others. Read the symposium, then join the conversation.",
    alternates: { canonical },
    openGraph: {
      type: "website",
      title: "Symposiums — great minds on today's questions",
      description:
        "2-4 great thinkers take up one question, each in their own voice. Read the symposium, then chat with any of them.",
      url: canonical,
      siteName: "Feynman",
    },
  };
}

export default async function SymposiumsIndexPage() {
  const debates = await fetchDebatesList();
  const canonical = abs("/symposiums");

  const itemListLd = {
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: "Symposiums on Feynman",
    url: canonical,
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: debates.length,
      itemListElement: debates.map((d, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: abs(`/symposium/${d.slug}`),
        name: d.question,
      })),
    },
  };
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Symposiums", canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={itemListLd} />
      <JsonLd data={breadcrumbLd} />

      <h1>Symposiums</h1>
      <p className="seo-meta">
        History&apos;s great minds on today&apos;s questions — 2-4 thinkers per
        question, each in their own voice, engaging the others. Read the
        symposium, then join the conversation.
      </p>

      {debates.length ? (
        <section className="seo-section">
          <ul>
            {debates.map((d) => (
              <li key={d.slug}>
                <Link href={`/symposium/${d.slug}`}>{d.question}</Link>
                {d.topic ? <span className="seo-meta"> · {d.topic}</span> : null}
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <section className="seo-section">
          <p>No symposiums yet — check back soon.</p>
        </section>
      )}
    </SeoColumn>
  );
}
