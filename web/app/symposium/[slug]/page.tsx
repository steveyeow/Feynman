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
import { mindColor, mindInitials } from "@/lib/minds";

// Symposium (Type-4): 2-4 great minds argue ONE question, each engaging the
// prior speakers by name. The emergent cross-referencing transcript is the
// unique citable artifact — it exists nowhere else (Wikipedia is dead bio,
// Wikiquote is isolated quotes). Curated + generated, so it's advertised in the
// sitemap (unlike the frozen /q /on editorial layer). User-facing name is
// "symposium"; internal API/table/fn names stay "debate(s)" as implementation.

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
  if (!d) return { title: "Symposium not found — Feynman" };
  const names = uniqueNames(d.turns);
  const canonical = abs(`/symposium/${d.slug}`);
  const title = `${d.question} — a symposium with ${names.slice(0, 3).join(", ")} | Feynman`;
  const desc = metaDescription(
    `${names.join(", ")} in symposium on "${d.question}" — each argues in their own voice, engaging the others, then you can join the conversation. A living symposium, not a static page.`,
  );
  const ogImage = abs(`/og?type=symposium&slug=${encodeURIComponent(d.slug)}`);
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

  const canonical = abs(`/symposium/${d.slug}`);
  const names = uniqueNames(d.turns);
  const ref = (mindId: string) => d.mind_slugs?.[mindId] || mindId;
  // Where the deeper round begins = the first time a speaker takes a second
  // turn. Used to drop a "the discussion deepens" divider between movements.
  const secondRoundAt = (() => {
    const seen = new Set<string>();
    for (let i = 0; i < d.turns.length; i++) {
      if (seen.has(d.turns[i].mind_id)) return i;
      seen.add(d.turns[i].mind_id);
    }
    return -1;
  })();

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
    ["Symposiums", abs("/symposiums")],
    [d.question, canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={ld} />
      <JsonLd data={breadcrumbLd} />

      {d.topic ? <p className="seo-meta">{d.topic} · Symposium</p> : <p className="seo-meta">Symposium</p>}
      <h1>{d.question}</h1>
      <p className="seo-meta">
        {names.length} great minds in conversation — each argues in their own
        voice, grounded in their documented ideas, engaging the others by name.
        An AI-mediated symposium you can join.
      </p>

      <div className="symposium-thread">
        {d.turns.map((t, i) => {
          const href = `/mind/${encodeURIComponent(ref(t.mind_id))}`;
          return (
            <div key={i}>
              {i === secondRoundAt ? (
                <div className="symposium-round-break">The discussion deepens</div>
              ) : null}
              <article className="symposium-turn">
                <Link
                  href={href}
                  className="symposium-avatar"
                  style={{ background: mindColor(t.mind_name) }}
                  aria-hidden="true"
                  tabIndex={-1}
                >
                  {mindInitials(t.mind_name)}
                </Link>
                <div className="symposium-turn-body">
                  <Link href={href} className="symposium-turn-author">
                    {t.mind_name}
                  </Link>
                  {t.content
                    .split(/\n\n+/)
                    .map((p) => p.trim())
                    .filter(Boolean)
                    .map((p, j) => (
                      <p key={j}>{p}</p>
                    ))}
                </div>
              </article>
            </div>
          );
        })}
      </div>

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
