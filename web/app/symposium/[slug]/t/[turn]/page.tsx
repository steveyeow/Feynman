import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import EntityLayout from "@/components/seo/EntityLayout";
import JsonLd from "@/components/seo/JsonLd";
import ShareButton from "@/components/share/ShareButton";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchDebate,
  fetchDebatesList,
  metaDescription,
} from "@/lib/seo-mind";
import { mindColor, mindInitials } from "@/lib/minds";

// Per-turn share permalink: a visitor arrives from a tweet of ONE turn. The page
// renders the WHOLE symposium (identical to /symposium/[slug] — EntityLayout +
// hero + rail + thread) with the shared turn highlighted, so it's instantly a
// full multi-mind debate, not an orphan quote. Exists so a social scrape resolves
// to THAT turn's OG card (the in-page `#turn-{i}` fragment a crawler never sees).
// canonical → the full symposium, noindex (a share entry, not a separate page).
// ISR by params (slug + turn) — does NOT touch the /symposium/[slug] cache.

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

function ogImageFor(slug: string, i: number) {
  return abs(`/og?type=symposium-turn&slug=${encodeURIComponent(slug)}&kind=${i}`);
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
  const ogImage = ogImageFor(d.slug, i);
  return {
    title,
    description: desc,
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
  const canonical = abs(base);
  const ref = (mindId: string) => d.mind_slugs?.[mindId] || mindId;

  // Distinct participants (roster strip + rail) in first-appearance order.
  const participants: typeof d.turns = [];
  const seenP = new Set<string>();
  for (const t of d.turns) {
    if (!seenP.has(t.mind_id)) {
      seenP.add(t.mind_id);
      participants.push(t);
    }
  }
  const pNames = participants.map((t) => t.mind_name);
  const joinLabel =
    pNames.length <= 1
      ? pNames[0] || ""
      : pNames.slice(0, -1).join(", ") + " and " + pNames[pNames.length - 1];

  const more = (await fetchDebatesList()).filter((x) => x.slug !== d.slug).slice(0, 6);

  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Symposiums", abs("/symposiums")],
    [d.question, canonical],
    [turn.mind_name, abs(`${base}/t/${i}`)],
  ]);

  const hero = (
    <>
      <p className="seo-meta">{d.topic ? `${d.topic} · Symposium` : "Symposium"}</p>
      <h1>{d.question}</h1>
      <div className="chat-system-notice mind-join-notice symposium-join">
        <div className="join-notice-inner">
          {participants.map((t) => (
            <span
              key={t.mind_id}
              className="join-avatar"
              style={{ background: mindColor(t.mind_name) }}
            >
              {mindInitials(t.mind_name)}
            </span>
          ))}
          <span>{joinLabel} in conversation</span>
        </div>
      </div>
      <p className="symposium-lede">
        You followed <strong>{turn.mind_name}</strong>&apos;s point — here&apos;s the
        full {participants.length}-mind symposium it belongs to, their turn
        highlighted below.
      </p>
      <div className="symposium-hero-actions">
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
    </>
  );

  const rail = (
    <>
      <div className="seo-rail-card">
        <h3>Chat with a participant</h3>
        <ul>
          {participants.map((t) => (
            <li key={t.mind_id}>
              <Link href={`/mind/${encodeURIComponent(ref(t.mind_id))}/chat`}>
                {t.mind_name}
              </Link>
            </li>
          ))}
        </ul>
      </div>
      {more.length ? (
        <div className="seo-rail-card">
          <h3>More symposiums</h3>
          <ul>
            {more.map((x) => (
              <li key={x.slug}>
                <Link href={`/symposium/${x.slug}`}>{x.question}</Link>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </>
  );

  return (
    <EntityLayout hero={hero} rail={rail}>
      <JsonLd data={breadcrumbLd} />
      {/* Full thread — same mind-message rows as the live chat; the shared turn
          is highlighted + tagged so it's obvious which moment was linked. */}
      <div className="symposium-thread">
        {d.turns.map((t, j) => (
          <div
            key={j}
            id={j === i ? "shared-turn" : undefined}
            className={`chat-message mind-message${j === i ? " symposium-turn-shared" : ""}`}
          >
            <div className="mind-msg-avatar" style={{ background: mindColor(t.mind_name) }}>
              {mindInitials(t.mind_name)}
            </div>
            <div className="mind-msg-body">
              <div className="mind-msg-name symposium-turn-head">
                <span>{t.mind_name}</span>
                {j === i ? <span className="symposium-shared-tag">Shared</span> : null}
              </div>
              <div className="mind-msg-content">
                {t.content
                  .split(/\n\n+/)
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((p, k) => (
                    <p key={k}>{p}</p>
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </EntityLayout>
  );
}
