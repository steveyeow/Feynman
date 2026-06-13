import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  debateJsonLd,
  fetchDebate,
  metaDescription,
} from "@/lib/seo-mind";

// Type-4 multi-mind debate: 2-4 great minds argue ONE question, each engaging
// the prior speakers by name. The emergent cross-referencing transcript is the
// unique citable artifact — it exists nowhere else (Wikipedia is dead bio,
// Wikiquote is isolated quotes). Curated + generated, so it's advertised in the
// sitemap (unlike the frozen /q /on editorial layer).

export const revalidate = 86400;
export const dynamicParams = true;
// Empty generateStaticParams() opts this dynamic route into ISR caching.
export function generateStaticParams() {
  return [];
}

function uniqueNames(turns: { mind_name: string }[]): string[] {
  return Array.from(new Set(turns.map((t) => t.mind_name)));
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string };
}): Promise<Metadata> {
  const d = await fetchDebate(params.slug);
  if (!d) return { title: "Debate not found — Feynman" };
  const names = uniqueNames(d.turns);
  const canonical = abs(`/debate/${d.slug}`);
  const title = `${d.question} — ${names.slice(0, 3).join(", ")} debate | Feynman`;
  const desc = metaDescription(
    `${names.join(", ")} debate the question "${d.question}" — each argues in their own voice, engaging the others, then you can join the conversation. A living symposium, not a static page.`,
  );
  const ogImage = abs(`/og?type=debate&slug=${encodeURIComponent(d.slug)}`);
  return {
    title,
    description: desc,
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: d.question,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: d.question,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function DebatePage({
  params,
}: {
  params: { slug: string };
}) {
  const d = await fetchDebate(params.slug);
  if (!d) notFound();

  const canonical = abs(`/debate/${d.slug}`);
  const names = uniqueNames(d.turns);
  const ref = (mindId: string) => d.mind_slugs?.[mindId] || mindId;

  const ld = debateJsonLd({
    question: d.question,
    url: canonical,
    created: d.created_at,
    turns: d.turns.map((t) => ({
      name: t.mind_name,
      text: t.content,
      url: abs(`/mind/${ref(t.mind_id)}`),
    })),
  });
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Debates", abs("/debates")],
    [d.question, canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={ld} />
      <JsonLd data={breadcrumbLd} />

      {d.topic ? <p className="seo-meta">{d.topic} · Debate</p> : <p className="seo-meta">Debate</p>}
      <h1>{d.question}</h1>
      <p className="seo-meta">
        {names.length} great minds in conversation — each argues in their own
        voice, grounded in their documented ideas, engaging the others by name.
        An AI-mediated symposium you can join.
      </p>

      <section className="seo-section insights">
        {d.turns.map((t, i) => (
          <article key={i} className="insight-card">
            <Link
              href={`/mind/${encodeURIComponent(ref(t.mind_id))}`}
              className="insight-card-who"
            >
              {t.mind_name}
            </Link>
            {t.content
              .split(/\n\n+/)
              .map((p) => p.trim())
              .filter(Boolean)
              .map((p, j) => (
                <p key={j}>{p}</p>
              ))}
          </article>
        ))}
      </section>

      <p className="seo-cta-row">
        <a
          className="primary"
          href={`/mind/${encodeURIComponent(ref(d.turns[0].mind_id))}/chat`}
        >
          Chat with {d.turns[0].mind_name} →
        </a>
      </p>

      <section className="seo-section">
        <h2>Chat with any of them</h2>
        <ul>
          {d.turns.map((t, i) => (
            <li key={i}>
              <Link href={`/mind/${encodeURIComponent(ref(t.mind_id))}`}>
                {t.mind_name}
              </Link>
            </li>
          ))}
        </ul>
      </section>
    </SeoColumn>
  );
}
