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
  // Distinct participants in first-appearance order — the group-chat header row
  // (and the footer chat funnel). One entry per mind even though they speak twice.
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

      <p className="seo-meta">{d.topic ? `${d.topic} · Symposium` : "Symposium"}</p>
      <h1>{d.question}</h1>

      {/* Participants — the SAME join-notice treatment as the live chat ("X, Y
          and Z joined the discussion"), so the symposium reads as a chat room. */}
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

      {/* The conversation — each turn is the SAME mind-message row as the live
          chat UI (32px avatar + name + content), reused verbatim for consistency. */}
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
              <div className="mind-msg-name">{t.mind_name}</div>
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

      {/* Footer funnel: continue with any voice in the room (no single pick). */}
      <p className="symposium-footer seo-meta">
        Continue the conversation —{" "}
        {participants.map((t, i) => (
          <span key={t.mind_id}>
            {i > 0 ? " · " : ""}
            <Link href={`/mind/${encodeURIComponent(ref(t.mind_id))}/chat`}>
              chat with {t.mind_name}
            </Link>
          </span>
        ))}
      </p>
    </SeoColumn>
  );
}
