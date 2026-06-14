import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import EntityLayout from "@/components/seo/EntityLayout";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchPublicDiscussion,
  fetchDebatesList,
  metaDescription,
  type PublicDiscussion,
} from "@/lib/seo-mind";
import MessageList from "@/components/chat/MessageList";
import ContinueComposer from "@/components/chat/ContinueComposer";
import ShareButton from "@/components/share/ShareButton";
import JoinDiscussionButton from "@/components/symposium/JoinDiscussionButton";
import type { Message } from "@/lib/chat";
import { mindColor, mindInitials } from "@/lib/minds";

// A single approved, PII-scrubbed public discussion. Data comes from
// GET /api/public-discussions/{id} (gated on ENABLE_PUBLIC_DISCUSSIONS +
// public_status='approved'). When the feature is off or the session isn't
// approved the endpoint 404s and we keep a stable, friendly "not available"
// page (the URL is a shareable permalink, so we avoid a hard 404) + noindex.
//
// A MULTI-MIND discussion (>=2 minds spoke) renders as a FULL symposium —
// identical experience to a curated /symposium (Join this discussion +
// participant chat rail + More symposiums), so the two kinds the /symposiums
// feed mixes together behave the same (Steve, 2026-06-14). A single-mind / book
// chat keeps the plain read-only "shared conversation" page.

export const revalidate = 600;
export const dynamicParams = true;

/** Display title: a session shared without a title comes through as "New chat";
 *  fall back to the first user question (the actual topic), else a generic label. */
function pickTitle(disc: PublicDiscussion): string {
  const t = (disc.title || "").trim();
  if (t && t.toLowerCase() !== "new chat") return t;
  const firstQ = (disc.messages.find((m) => m.role === "user")?.content || "").trim();
  return firstQ.slice(0, 90) || "Symposium";
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const canonical = abs(`/discussions/${params.id}`);
  const disc = await fetchPublicDiscussion(params.id);
  if (!disc) {
    return {
      title: "Discussion on Feynman",
      description: "A shared discussion on Feynman.",
      robots: { index: false, follow: true },
      alternates: { canonical },
    };
  }
  const title = pickTitle(disc);
  const desc = metaDescription(
    `A public discussion shared by ${disc.handle} on Feynman.`,
  );
  // Thin-content guard: now that any answered chat (≥2 messages) is shareable,
  // don't index very short discussions — still renders + is shareable, just not
  // crawled (protects the GSC index from thin pages).
  const totalChars = disc.messages.reduce((n, m) => n + (m.content || "").length, 0);
  const thin = totalChars < 400;
  const ogImage = abs(`/og?type=discussion&id=${encodeURIComponent(params.id)}`);
  return {
    title: `${title} — Feynman`,
    description: desc,
    alternates: { canonical },
    robots: thin ? { index: false, follow: true } : undefined,
    openGraph: {
      type: "article",
      title,
      description: desc,
      url: canonical,
      siteName: "Feynman",
      images: [{ url: ogImage, width: 1200, height: 630, alt: title }],
    },
    twitter: {
      card: "summary_large_image",
      site: "@steve_yeow",
      title,
      description: desc,
      images: [ogImage],
    },
  };
}

export default async function PublicDiscussionPage({
  params,
}: {
  params: { id: string };
}) {
  const canonical = abs(`/discussions/${params.id}`);
  const disc = await fetchPublicDiscussion(params.id);

  // Not available (feature off / withdrawn / pending) — friendly stable page.
  if (!disc) {
    const breadcrumbLd = breadcrumbJsonLd([
      ["Feynman", SITE_URL],
      ["Discussions", SITE_URL],
      ["Discussion on Feynman", canonical],
    ]);
    return (
      <SeoColumn>
        <JsonLd data={breadcrumbLd} />
        <h1>Discussion on Feynman</h1>
        <section className="seo-section">
          <p>
            This shared discussion isn&rsquo;t available to view right now. Public
            discussions are user-shared with consent and PII-scrubbed before they
            appear — this one may be private, withdrawn, or pending review.
          </p>
          <p>
            You can still start your own conversation: chat with any book or great
            mind on Feynman and share the result from your session menu.
          </p>
        </section>
        <p className="seo-cta-row">
          <a className="primary" href={`${SITE_URL}/`}>
            Open Feynman →
          </a>
          <Link className="secondary" href="/library">
            Browse the library
          </Link>
        </p>
      </SeoColumn>
    );
  }

  const title = pickTitle(disc);
  const forumLd = {
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: title,
    url: canonical,
    datePublished: disc.approved_at || "",
    author: { "@type": "Person", name: disc.handle || "Anonymous" },
    publisher: { "@type": "Organization", name: "Feynman", url: SITE_URL },
  };
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Discussions", SITE_URL],
    [title, canonical],
  ]);

  // Render the shared transcript with the SAME component the live chat uses, so
  // a shared conversation looks exactly like it does in-app (Feynman + mind
  // avatars, names, markdown), read-only.
  const transcript: Message[] = disc.messages.map((m): Message =>
    m.role === "mind"
      ? { role: "mind", content: m.content, mindName: m.speaker || "A great mind" }
      : m.role === "assistant"
        ? { role: "assistant", content: m.content }
        : { role: "user", content: m.content },
  );
  const knownMindNames = [
    ...new Set(
      disc.messages.filter((m) => m.role === "mind").map((m) => m.speaker || ""),
    ),
  ].filter(Boolean) as string[];
  const isSymposium = knownMindNames.length >= 2;

  // ── Multi-mind discussion → a FULL symposium, identical to a curated
  //    /symposium: Join this discussion (→ live multi-mind chat) + participant
  //    chat rail + More symposiums. Unifies the experience the /symposiums feed
  //    mixes together (Steve, 2026-06-14). ──
  if (isSymposium) {
    const participants = (disc.participants || []).filter((p) => p.mind_name);
    // The minds' remarks replayed into the live chat on Join (same handoff as a
    // curated symposium): each mind turn → {mind_id, mind_name, content}.
    const turns = disc.messages
      .filter((m) => m.role === "mind")
      .map((m) => ({
        mind_id: m.mind_id || "",
        mind_name: m.speaker || "A great mind",
        content: m.content,
      }));
    const pNames = participants.map((p) => p.mind_name);
    const roster =
      pNames.length <= 1
        ? pNames[0] || ""
        : pNames.slice(0, -1).join(", ") + " and " + pNames[pNames.length - 1];
    const more = (await fetchDebatesList()).filter((x) => x.slug !== disc.id).slice(0, 6);

    const hero = (
      <>
        <p className="seo-meta">Symposium · shared by {disc.handle || "Anonymous"}</p>
        <h1>{title}</h1>
        <div className="chat-system-notice mind-join-notice symposium-join">
          <div className="join-notice-inner">
            {participants.map((p) => (
              <span
                key={p.mind_id || p.mind_name}
                className="join-avatar"
                style={{ background: mindColor(p.mind_name) }}
              >
                {mindInitials(p.mind_name)}
              </span>
            ))}
            <span>{roster} in conversation</span>
          </div>
        </div>
        <p className="symposium-lede">
          {participants.length} great minds took up one question — each in their own
          voice, answering the others. Read the exchange, then join the conversation
          yourself.
        </p>
        <div className="symposium-hero-actions">
          <JoinDiscussionButton question={title} participants={participants} turns={turns} />
          <ShareButton
            url={canonical}
            title={title}
            subject="Symposium"
            label="Share this symposium"
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
            {participants.map((p) => {
              const ref = p.mind_slug || p.mind_id;
              return (
                <li key={p.mind_id || p.mind_name}>
                  {ref ? (
                    <Link href={`/mind/${encodeURIComponent(ref)}/chat`}>{p.mind_name}</Link>
                  ) : (
                    <span>{p.mind_name}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
        {more.length ? (
          <div className="seo-rail-card">
            <h3>More symposiums</h3>
            <ul>
              {more.map((x) => (
                <li key={x.slug}>
                  <Link
                    href={
                      x.source === "community"
                        ? `/discussions/${x.slug}`
                        : `/symposium/${x.slug}`
                    }
                  >
                    {x.question}
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </>
    );

    return (
      <EntityLayout hero={hero} rail={rail}>
        <JsonLd data={forumLd} />
        <JsonLd data={breadcrumbLd} />
        <div className="shared-transcript">
          <MessageList messages={transcript} knownMindNames={knownMindNames} />
        </div>
      </EntityLayout>
    );
  }

  // ── Single-mind / book chat → the plain read-only shared-conversation page
  //    (banner + transcript + continue). Not a symposium. ──
  return (
    <SeoColumn>
      <JsonLd data={forumLd} />
      <JsonLd data={breadcrumbLd} />
      {/* h1 kept for SEO but visually hidden — the chat itself has no big title;
          the question is the first turn of the transcript below. */}
      <h1 className="sr-only">{title}</h1>
      <div className="shared-banner">
        <span className="shared-banner-label">Shared conversation on Feynman</span>
        <span className="shared-banner-by">Shared by {disc.handle || "Anonymous"}</span>
        <ShareButton url={canonical} subject="Shared conversation" title={title} variant="ghost" />
      </div>
      <div className="shared-transcript">
        <MessageList messages={transcript} knownMindNames={knownMindNames} />
      </div>
      <ContinueComposer id={params.id} />
    </SeoColumn>
  );
}
