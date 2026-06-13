import type { Metadata } from "next";
import { notFound } from "next/navigation";
import Link from "next/link";
import EntityLayout from "@/components/seo/EntityLayout";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  debateJsonLd,
  fetchDebate,
  fetchDebatesList,
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

export default async function SymposiumPage({
  params,
}: {
  params: { slug: string };
}) {
  const d = await fetchDebate(params.slug);
  if (!d) notFound();

  const canonical = abs(`/symposium/${d.slug}`);
  const ref = (mindId: string) => d.mind_slugs?.[mindId] || mindId;
  // Distinct participants in first-appearance order — the header strip + the
  // rail's chat funnel. One entry per mind even though they speak twice.
  const participants: typeof d.turns = [];
  const seenP = new Set<string>();
  for (const t of d.turns) {
    if (!seenP.has(t.mind_id)) {
      seenP.add(t.mind_id);
      participants.push(t);
    }
  }
  // "X, Y and Z" — same phrasing as the chat JoinNotice.
  const pNames = participants.map((t) => t.mind_name);
  const joinLabel =
    pNames.length <= 1
      ? pNames[0] || ""
      : pNames.slice(0, -1).join(", ") + " and " + pNames[pNames.length - 1];

  // Right-rail discovery: other symposiums (internal links + fills the column).
  const more = (await fetchDebatesList())
    .filter((x) => x.slug !== d.slug)
    .slice(0, 6);

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

  const hero = (
    <>
      <p className="seo-meta">{d.topic ? `${d.topic} · Symposium` : "Symposium"}</p>
      <h1>{d.question}</h1>
      {/* Participant strip — the chat's join-notice treatment, so it reads as
          a room of minds in conversation. */}
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
      {/* Lede — tells a cold visitor exactly what this page is + why it's unique. */}
      <p className="symposium-lede">
        A <strong>symposium</strong>: {participants.length} great minds take up one
        question — each argues in their own voice and answers the others. It&apos;s
        a living exchange you won&apos;t find anywhere else — read it, then chat with
        any of them yourself.
      </p>
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
      <JsonLd data={ld} />
      <JsonLd data={breadcrumbLd} />

      {/* The conversation — each turn is the SAME mind-message row as the live
          chat UI (32px avatar + name + content), with a per-turn chat entry on
          the name line (right) instead of a footer link list. */}
      <div className="symposium-thread">
        {d.turns.map((t, i) => (
          <div key={i} className="chat-message mind-message">
            <div
              className="mind-msg-avatar"
              style={{ background: mindColor(t.mind_name) }}
            >
              {mindInitials(t.mind_name)}
            </div>
            <div className="mind-msg-body">
              <div className="mind-msg-name symposium-turn-head">
                <span>{t.mind_name}</span>
                <Link
                  href={`/mind/${encodeURIComponent(ref(t.mind_id))}/chat`}
                  className="symposium-chat-link"
                >
                  Chat →
                </Link>
              </div>
              <div className="mind-msg-content">
                {t.content
                  .split(/\n\n+/)
                  .map((p) => p.trim())
                  .filter(Boolean)
                  .map((p, j) => (
                    <p key={j}>{p}</p>
                  ))}
              </div>
            </div>
          </div>
        ))}
      </div>
    </EntityLayout>
  );
}
