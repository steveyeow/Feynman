import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import ShareButton from "@/components/share/ShareButton";
import {
  SITE_URL,
  abs,
  breadcrumbJsonLd,
  fetchPublicAnswer,
  metaDescription,
  truncate,
  dropNulls,
  type PublicAnswer,
} from "@/lib/seo-mind";
import { renderMarkdown } from "@/components/chat/markdown";

// Render the (already PII-scrubbed) answer as markdown. renderMarkdown
// HTML-escapes all text; PII scrub strips http(s) URLs, so we also neutralize
// any remaining non-http href so a crafted markdown link can't XSS this page.
function renderSafe(md: string): string {
  return renderMarkdown(md).replace(/href="(?!https?:\/\/)[^"]*"/gi, 'href="#"');
}

// A single approved, PII-scrubbed shared answer (share redesign Phase 2).
// Data comes from GET /api/public-answers/{id} (gated on
// ENABLE_PUBLIC_DISCUSSIONS + public_status='approved'). When the feature is
// off / the answer is withdrawn / pending, the endpoint 404s and we keep a
// stable, friendly "not available" page (the URL is a shareable permalink) and
// noindex it. The unit carries mind/book attribution + a "Chat with {mind}"
// funnel so a single shared answer still conveys the product (per the spec).

export const revalidate = 600;
export const dynamicParams = true;

// Empty static params → ISR rather than fully-dynamic. In Next 14 `revalidate`
// alone leaves an [id] route dynamic (every crawl hits the API); an empty
// generateStaticParams opts it into the Data/Full-Route cache. See
// project_seo_isr_caching (the egress fix, #58).
export function generateStaticParams() {
  return [];
}

// UGC quality floor: don't index 1-liner answers (still rendered as permalinks).
const MIN_INDEXABLE_ANSWER = 120;

/** Mind chat funnel ref: slug preferred, uuid fallback (301s to the slug). */
function mindRef(mind: NonNullable<PublicAnswer["mind"]>): string {
  return mind.slug || mind.id || "";
}
function bookRef(book: NonNullable<PublicAnswer["book"]>): string {
  return book.slug || book.agent_id || "";
}

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const canonical = abs(`/a/${params.id}`);
  const ans = await fetchPublicAnswer(params.id);
  if (!ans) {
    return {
      title: "Shared answer on Feynman",
      description: "A shared answer on Feynman.",
      robots: { index: false, follow: true },
      alternates: { canonical },
    };
  }
  const who = ans.mind?.name || "Feynman";
  const title = ans.question ? truncate(ans.question, 70) : `An answer from ${who}`;
  const desc = metaDescription(ans.answer || `A shared answer from ${who} on Feynman.`);
  const indexable = (ans.answer || "").trim().length >= MIN_INDEXABLE_ANSWER;
  const ogImage = abs(`/og?type=answer&id=${encodeURIComponent(params.id)}`);
  return {
    title: `${title} — Feynman`,
    description: desc,
    alternates: { canonical },
    robots: indexable ? undefined : { index: false, follow: true },
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

export default async function SharedAnswerPage({
  params,
}: {
  params: { id: string };
}) {
  const canonical = abs(`/a/${params.id}`);
  const ans = await fetchPublicAnswer(params.id);

  // Not available (feature off / withdrawn / pending) — friendly stable page.
  if (!ans) {
    const breadcrumbLd = breadcrumbJsonLd([
      ["Feynman", SITE_URL],
      ["Shared answer", canonical],
    ]);
    return (
      <SeoColumn>
        <JsonLd data={breadcrumbLd} />
        <h1>Shared answer on Feynman</h1>
        <section className="seo-section">
          <p>
            This shared answer isn&rsquo;t available to view right now. Shared
            answers are user-published with consent and PII-scrubbed before they
            appear — this one may be private, withdrawn, or pending review.
          </p>
          <p>
            You can still start your own conversation: chat with any book or great
            mind on Feynman and share an answer from the message menu.
          </p>
        </section>
        <p className="seo-cta-row">
          <a className="primary" href={`${SITE_URL}/`}>
            Open Feynman →
          </a>
          <Link className="secondary" href="/minds">
            Meet the minds
          </Link>
        </p>
      </SeoColumn>
    );
  }

  const who = ans.mind?.name || "Feynman";
  const initial = (who.trim().charAt(0) || "F").toUpperCase();
  const isMind = ans.answer_role === "mind" && !!ans.mind;
  const mRef = ans.mind ? mindRef(ans.mind) : "";
  const bRef = ans.book ? bookRef(ans.book) : "";

  // Funnel CTAs. A mind answer → chat with that mind; a Feynman answer → chat
  // about the cited book, else open Feynman. Secondary → the mind / book page.
  const chatHref =
    isMind && mRef
      ? `/mind/${encodeURIComponent(mRef)}/chat`
      : bRef
        ? `/?book=${encodeURIComponent(bRef)}`
        : `/`;
  const chatLabel = isMind
    ? `Chat with ${who} →`
    : bRef
      ? "Chat about this book →"
      : "Start your own conversation →";
  const moreHref =
    isMind && mRef
      ? `/mind/${encodeURIComponent(mRef)}`
      : bRef
        ? `/book/${encodeURIComponent(bRef)}`
        : null;
  const moreLabel = isMind ? `More from ${who}` : bRef ? "View the book" : null;

  const headline = ans.question ? truncate(ans.question, 110) : `An answer from ${who}`;

  // QAPage when there's a real question; Article otherwise. Author is the mind
  // (Person) or Feynman (Organization). Text is already PII-scrubbed server-side.
  const authorLd = isMind
    ? { "@type": "Person", name: who, url: mRef ? abs(`/mind/${mRef}`) : SITE_URL }
    : { "@type": "Organization", name: "Feynman", url: SITE_URL };
  const schemaLd = dropNulls(
    ans.question
      ? {
          "@context": "https://schema.org",
          "@type": "QAPage",
          url: canonical,
          mainEntity: {
            "@type": "Question",
            name: truncate(ans.question, 200),
            text: ans.question,
            answerCount: 1,
            acceptedAnswer: {
              "@type": "Answer",
              text: ans.answer,
              url: canonical,
              dateCreated: ans.approved_at || "",
              author: authorLd,
            },
          },
        }
      : {
          "@context": "https://schema.org",
          "@type": "Article",
          headline,
          url: canonical,
          articleBody: ans.answer,
          datePublished: ans.approved_at || "",
          author: authorLd,
          publisher: { "@type": "Organization", name: "Feynman", url: SITE_URL },
        },
  );
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Shared answer", canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={schemaLd} />
      <JsonLd data={breadcrumbLd} />

      <h1 className="answer-question">{headline}</h1>
      <p className="seo-meta">
        Answered by {who}
        {ans.book ? <> · based on {ans.book.name}</> : null}
        {ans.handle && ans.handle !== "Anonymous" ? <> · shared by {ans.handle}</> : null}
      </p>

      <section className="seo-section answer-card">
        <div className="answer-byline">
          <span className="answer-avatar" aria-hidden="true">
            {initial}
          </span>
          <span className="answer-author">
            {isMind && mRef ? (
              <Link href={`/mind/${encodeURIComponent(mRef)}`}>{who}</Link>
            ) : (
              who
            )}
          </span>
        </div>
        <div
          className="discussion-md"
          dangerouslySetInnerHTML={{ __html: renderSafe(ans.answer || "") }}
        />
      </section>

      {isMind && ans.mind?.voice ? (
        <p className="answer-voice">“{truncate(ans.mind.voice, 200)}”</p>
      ) : null}

      <p className="seo-cta-row">
        <a className="primary" href={chatHref}>
          {chatLabel}
        </a>
        {moreHref ? (
          <Link className="secondary" href={moreHref}>
            {moreLabel}
          </Link>
        ) : (
          <Link className="secondary" href="/minds">
            Meet the minds
          </Link>
        )}
      </p>
      <div className="seo-actions" style={{ marginTop: 18 }}>
        <ShareButton
          url={canonical}
          subject={isMind ? `Answer from ${who}` : "Shared answer"}
          title={headline}
          defaultText={
            isMind && who
              ? `${who}: “${truncate(ans.answer.replace(/\s+/g, " ").trim(), 180)}”`
              : `“${truncate(ans.answer.replace(/\s+/g, " ").trim(), 200)}”`
          }
          variant="secondary"
        />
      </div>
    </SeoColumn>
  );
}
