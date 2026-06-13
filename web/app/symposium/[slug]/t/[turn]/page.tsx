import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import ShareButton from "@/components/share/ShareButton";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchDebate,
  metaDescription,
} from "@/lib/seo-mind";
import { mindColor, mindInitials } from "@/lib/minds";

// Per-turn share permalink: one mind's remark within a symposium. Exists ONLY so
// a social scrape resolves to THAT turn's OG card (the in-page per-turn Share
// used a `#turn-{i}` fragment, which a crawler never sees — it'd fetch the whole
// /symposium page and get the whole-symposium card). The canonical still points
// to the full symposium and the page is noindex'd — it's a share entry, not a
// separate indexable surface. ISR by params (slug + turn), so it does NOT touch
// the /symposium/[slug] cache.

export const revalidate = 86400;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

function turnOf(d: { turns: { mind_id: string; mind_name: string; content: string }[] }, turnStr: string) {
  const i = parseInt(turnStr, 10);
  const turn = Number.isInteger(i) && i >= 0 ? d.turns[i] : undefined;
  return { i, turn };
}

export async function generateMetadata({
  params,
}: {
  params: { slug: string; turn: string };
}): Promise<Metadata> {
  const d = await fetchDebate(params.slug);
  if (!d) return { title: "Symposium not found — Feynman" };
  const { i, turn } = turnOf(d, params.turn);
  if (!turn) return { title: "Symposium not found — Feynman" };
  const base = abs(`/symposium/${d.slug}`);
  const permalink = abs(`/symposium/${d.slug}/t/${i}`);
  const title = `${turn.mind_name} on “${d.question}” | Feynman`;
  const desc = metaDescription(
    `${turn.mind_name} in a symposium on "${d.question}": ${turn.content}`,
  );
  const ogImage = abs(
    `/og?type=symposium-turn&slug=${encodeURIComponent(d.slug)}&kind=${i}`,
  );
  return {
    title,
    description: desc,
    // Canonical = the full symposium; this turn permalink is a share entry, not a
    // separate indexable page (noindex so it doesn't compete with the symposium).
    alternates: { canonical: base },
    robots: { index: false, follow: true },
    openGraph: {
      type: "article",
      title: `${turn.mind_name} on “${d.question}”`,
      description: desc,
      url: permalink,
      siteName: "Feynman",
      images: [ogImage],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title: `${turn.mind_name} on “${d.question}”`,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function SymposiumTurnPage({
  params,
}: {
  params: { slug: string; turn: string };
}) {
  const d = await fetchDebate(params.slug);
  if (!d) notFound();
  const { i, turn } = turnOf(d, params.turn);
  if (!turn) notFound();
  const base = `/symposium/${d.slug}`;
  const ref = (mindId: string) => d.mind_slugs?.[mindId] || mindId;
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Symposiums", abs("/symposiums")],
    [d.question, abs(base)],
    [turn.mind_name, abs(`${base}/t/${i}`)],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={breadcrumbLd} />
      <p className="seo-meta">In a symposium on</p>
      <h1 className="discussion-symposium-h1">
        <Link href={base}>{d.question}</Link>
      </h1>
      {/* The shared remark — the SAME mind-message row as the live chat. */}
      <div className="symposium-thread" style={{ marginTop: 18 }}>
        <div className="chat-message mind-message">
          <div className="mind-msg-avatar" style={{ background: mindColor(turn.mind_name) }}>
            {mindInitials(turn.mind_name)}
          </div>
          <div className="mind-msg-body">
            <div className="mind-msg-name">{turn.mind_name}</div>
            <div className="mind-msg-content">
              {turn.content
                .split(/\n\n+/)
                .map((p) => p.trim())
                .filter(Boolean)
                .map((p, j) => (
                  <p key={j}>{p}</p>
                ))}
            </div>
          </div>
        </div>
      </div>
      <div className="symposium-hero-actions" style={{ marginTop: 22 }}>
        <Link
          className="symposium-join-cta"
          href={`/mind/${encodeURIComponent(ref(turn.mind_id))}/chat`}
        >
          Chat with {turn.mind_name}
        </Link>
        <ShareButton
          url={abs(`${base}/t/${i}`)}
          title={`${turn.mind_name} on “${d.question}”`}
          subject="From a symposium"
          previewImage={ogImageFor(d.slug, i)}
          label="Share"
          variant="secondary"
        />
      </div>
      <p className="shared-cta-foot" style={{ marginTop: 20 }}>
        <Link className="shared-cta-alt" href={base}>
          ← Read the full symposium
        </Link>
      </p>
    </SeoColumn>
  );
}

function ogImageFor(slug: string, i: number) {
  return abs(`/og?type=symposium-turn&slug=${encodeURIComponent(slug)}&kind=${i}`);
}
