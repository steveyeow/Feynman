import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchPublicDiscussion,
  metaDescription,
} from "@/lib/seo-mind";
import MessageList from "@/components/chat/MessageList";
import ContinueDiscussionButton from "@/components/chat/ContinueDiscussionButton";
import type { Message } from "@/lib/chat";

// A single approved, PII-scrubbed public discussion. Data comes from
// GET /api/public-discussions/{id} (mirrors the legacy public_session_page:
// gated on ENABLE_PUBLIC_DISCUSSIONS + public_status='approved'). When the
// feature is off or the session isn't approved the endpoint 404s and we keep
// a stable, friendly "not available" page (the URL is a shareable permalink,
// so we avoid a hard 404) and noindex it.

export const revalidate = 600;
export const dynamicParams = true;

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
  const title = disc.title || "Discussion on Feynman";
  const desc = metaDescription(
    `A public discussion shared by ${disc.handle} on Feynman.`,
  );
  // Thin-content guard: now that any answered chat (≥2 messages) is shareable,
  // don't index very short discussions — still renders + is shareable, just not
  // crawled (protects the GSC index from thin pages).
  const totalChars = disc.messages.reduce((n, m) => n + (m.content || "").length, 0);
  const thin = totalChars < 400;
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
    },
    twitter: { card: "summary", site: "@steve_yeow", title, description: desc },
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

  const title = disc.title || "Discussion on Feynman";
  // Cross-link back to the entity (book or mind) this discussion is about.
  const entityRef = disc.entity_slug || disc.entity_id; // prefer slug, uuid fallback
  const entityHref =
    entityRef && disc.session_type === "book"
      ? `/book/${entityRef}`
      : entityRef
        ? `/mind/${entityRef}`
        : null;
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
  // avatars, names, markdown) — read-only (no composer, no per-message share).
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
      </div>

      <div className="shared-transcript">
        <MessageList messages={transcript} knownMindNames={knownMindNames} />
      </div>

      <div className="shared-cta">
        <ContinueDiscussionButton id={params.id} />
        <p className="shared-cta-hint">
          Continuing creates a private copy in your account — only your replies
          are visible to you.
        </p>
        <Link
          className="shared-cta-alt"
          href={entityHref || "/library"}
        >
          {entityHref
            ? `More from this ${disc.session_type === "book" ? "book" : "mind"}`
            : "Browse the library"}
        </Link>
      </div>
    </SeoColumn>
  );
}
