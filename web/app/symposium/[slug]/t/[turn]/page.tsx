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
  // Distinct participants (roster strip) in first-appearance order.
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
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Symposiums", abs("/symposiums")],
    [d.question, abs(base)],
    [turn.mind_name, abs(`${base}/t/${i}`)],
  ]);

  // Share-landing view: the visitor arrives from a tweet of ONE turn, but we
  // render the WHOLE symposium with that turn highlighted — so it's instantly
  // clear this is one moment in a multi-mind debate, and the full thing is right
  // here (no easy-to-miss "read more" link needed).
  return (
    <SeoColumn>
      <JsonLd data={breadcrumbLd} />
      <p className="seo-meta">{d.topic ? `${d.topic} · Symposium` : "Symposium"}</p>
      <h1 className="discussion-symposium-h1">
        <Link href={base}>{d.question}</Link>
      </h1>
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

      {/* Full thread — same mind-message rows as the live chat; the shared turn
          is highlighted + tagged so it's obvious which moment was linked. */}
      <div className="symposium-thread" style={{ marginTop: 18 }}>
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
    </SeoColumn>
  );
}

function ogImageFor(slug: string, i: number) {
  return abs(`/og?type=symposium-turn&slug=${encodeURIComponent(slug)}&kind=${i}`);
}
