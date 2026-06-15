import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import SymposiumsFeed from "@/components/seo/SymposiumsFeed";
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
      images: [abs("/og?type=symposiums")],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: "Symposiums — great minds on today's questions",
      description:
        "2-4 great thinkers take up one question, each in their own voice. Read the symposium, then chat with any of them.",
      images: [abs("/og?type=symposiums")],
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

      {/* Create affordance. Most visitors never discover that a symposium is
          just a chat with 2+ minds invited — this panel teaches the mechanic and
          routes into the SAME home debate composer (?debate=1) the "Start a
          debate" pill uses, so convening one is identical to that flow and
          inherits its sign-in → Pro gate. Shown even with zero debates so the
          first symposium can be convened. */}
      <Link href="/?debate=1" prefetch={false} className="symposium-create">
        <span className="symposium-create-text">
          <span className="symposium-create-title">Convene your own symposium</span>
          <span className="symposium-create-sub">
            Pick 2-4 great minds, pose a question, and watch them debate it — each
            in their own voice.
          </span>
        </span>
        <span className="symposium-create-cta">
          Start a symposium
          <svg
            width="15"
            height="15"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M5 12h14M13 6l6 6-6 6" />
          </svg>
        </span>
      </Link>

      {debates.length ? (
        <SymposiumsFeed debates={debates} />
      ) : (
        <section className="seo-section">
          <p>No symposiums yet — check back soon.</p>
        </section>
      )}
    </SeoColumn>
  );
}
