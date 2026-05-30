import type { Metadata } from "next";
import Link from "next/link";
import SeoColumn from "@/components/seo/SeoColumn";
import JsonLd from "@/components/seo/JsonLd";
import { SITE_URL, abs, breadcrumbJsonLd } from "@/lib/seo-mind";

// NOTE — missing endpoint:
// The legacy /discussions/{id} page rendered a single approved, PII-scrubbed
// public chat session (db.get_chat_session_with_public_status +
// list_messages_for_public_session) behind the ENABLE_PUBLIC_DISCUSSIONS flag
// (default OFF). Both the per-session read AND its messages are exposed ONLY
// through `response_class=HTMLResponse` SSR routes — there is NO JSON API, and
// the feature is disabled by default. So this Next.js route cannot fetch the
// session and renders a graceful "not available" page (NOT a 404 — the URL is
// a shareable permalink, so we keep a stable, friendly page).
//
// To light this up, add a JSON read endpoint, e.g.
//   GET /api/public-discussions/{id}
//     → { id, public_title, public_handle, approved_at, session_type,
//         entity_id, messages: [{ role, content }] }   (PII-scrubbed,
//         gated on public_status='approved'), then render the post + a
//         DiscussionForumPosting JSON-LD here.

export const revalidate = 600;
export const dynamicParams = true;

const TITLE = "Discussion on Feynman";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const canonical = abs(`/discussions/${params.id}`);
  const desc = "A shared discussion on Feynman.";
  return {
    title: `${TITLE} — Feynman`,
    description: desc,
    // Until the feature/endpoint is live, keep this URL out of the index.
    robots: { index: false, follow: true },
    alternates: { canonical },
    openGraph: {
      type: "article",
      title: TITLE,
      description: desc,
      url: canonical,
      siteName: "Feynman",
    },
    twitter: { card: "summary", site: "@steve_yeow", title: TITLE, description: desc },
  };
}

export default function PublicDiscussionPage({
  params,
}: {
  params: { id: string };
}) {
  const canonical = abs(`/discussions/${params.id}`);
  const breadcrumbLd = breadcrumbJsonLd([
    ["Feynman", SITE_URL],
    ["Discussions", SITE_URL],
    [TITLE, canonical],
  ]);

  return (
    <SeoColumn>
      <JsonLd data={breadcrumbLd} />

      <h1>{TITLE}</h1>
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
