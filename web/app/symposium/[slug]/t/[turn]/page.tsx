import type { Metadata } from "next";
import { notFound } from "next/navigation";
import TurnRedirect from "@/components/symposium/TurnRedirect";
import { abs, fetchDebate, metaDescription } from "@/lib/seo-mind";

// Per-turn share permalink. Purpose: a social scrape (X/Twitter) of one mind's
// remark resolves to THAT turn's OG card (an in-page `#turn-{i}` fragment is
// invisible to crawlers). A human who clicks through is redirected to the full
// symposium, anchored to that turn — so there's exactly ONE symposium content
// page (the detail page), never a confusing near-duplicate. The route still
// serves 200 + the turn OG in <head> for the crawler; canonical → the full
// symposium; noindex. ISR by params — doesn't touch the /symposium/[slug] cache.

export const revalidate = 86400;
export const dynamicParams = true;
export function generateStaticParams() {
  return [];
}

function turnOf(
  d: { turns: { mind_id: string; mind_name: string; content: string }[] },
  turnStr: string,
) {
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
    // Canonical = the full symposium (this is a share entry, not a separate page).
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
  // Send the human to the full symposium, scrolled to this turn.
  return (
    <TurnRedirect
      href={`/symposium/${d.slug}#turn-${i}`}
      label={`Open “${d.question}”`}
    />
  );
}
