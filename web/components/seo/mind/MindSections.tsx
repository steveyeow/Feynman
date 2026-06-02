/**
 * Presentational sections for the mind landing page. Server components —
 * each renders inside the clean `.seo-content` reading column and returns
 * null when its input is empty (so the page degrades gracefully when the
 * JSON API omits a field, e.g. `persona` which the API strips).
 *
 * Ports the per-section renderers from app/core/seo.py
 * (render_mind_bio, render_mind_thinking_style, render_mind_phrases,
 * render_mind_persona_excerpt, render_mind_works, render_related_minds,
 * render_topic_links_for_mind, render_live_content_link, render_explore_footer).
 */
import Link from "next/link";
import {
  type AgentRowLite,
  type MindDetail,
  buildWorkLinkIndex,
  matchWorkToBook,
  slugify,
  truncate,
} from "@/lib/seo-mind";

export function Section({
  heading,
  children,
}: {
  heading: string;
  children: React.ReactNode;
}) {
  return (
    <section className="seo-section">
      {/* Skip the heading when empty — DialoguesLink renders its own <h2>, and an
          empty <h2></h2> is an a11y/SEO nit that would repeat on every page. */}
      {heading ? <h2>{heading}</h2> : null}
      {children}
    </section>
  );
}

export function MindBio({ bio }: { bio?: string }) {
  if (!bio) return null;
  return (
    <Section heading="About">
      <p>{bio}</p>
    </Section>
  );
}

export function MindThinkingStyle({ style }: { style?: string }) {
  if (!style) return null;
  return (
    <Section heading="How they think">
      <p>{style}</p>
    </Section>
  );
}

export function MindPhrases({
  phrases,
  limit = 6,
}: {
  phrases?: string[];
  limit?: number;
}) {
  const list = (phrases || []).filter(Boolean).slice(0, limit);
  if (!list.length) return null;
  return (
    <Section heading="Characteristic phrases">
      <ul className="characteristic-phrases">
        {list.map((p, i) => (
          <li key={i}>
            <q>{p}</q>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/**
 * Core-approach excerpt from the persona. The JSON API strips `persona`, so
 * this almost always renders nothing in the Next.js stack — kept for the
 * day the API exposes it (and so the section structure matches the legacy
 * SSR exactly). ~900 chars ≈ 150 words.
 */
export function MindPersonaExcerpt({
  persona,
  maxChars = 900,
}: {
  persona?: string;
  maxChars?: number;
}) {
  const p = (persona || "").trim();
  if (!p) return null;
  return (
    <Section heading="Core approach">
      <p>{truncate(p, maxChars)}</p>
    </Section>
  );
}

export function MindWorks({
  works,
  agents,
}: {
  works?: string[];
  agents: AgentRowLite[];
}) {
  const list = (works || []).filter(Boolean).slice(0, 20);
  if (!list.length) return null;
  const idx = buildWorkLinkIndex(agents);
  return (
    <Section heading="Notable works">
      <ul className="works">
        {list.map((w, i) => {
          const bookId = matchWorkToBook(w, idx);
          return (
            <li key={i}>
              {bookId ? <Link href={`/book/${bookId}`}>{w}</Link> : w}
            </li>
          );
        })}
      </ul>
    </Section>
  );
}

export function RelatedMinds({ minds }: { minds: MindDetail[] }) {
  const list = minds.filter((m) => m.id && m.name);
  if (!list.length) return null;
  return (
    <Section heading="Related minds">
      <ul className="related-minds">
        {list.map((m) => (
          <li key={m.id}>
            <Link href={`/mind/${m.id}`}>{m.name}</Link>
            {m.era ? ` — ${m.era}` : ""}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function TopicLinksForMind({ topics }: { topics: string[] }) {
  const list = topics.filter(Boolean).slice(0, 5);
  if (!list.length) return null;
  return (
    <p className="topic-links">
      Explore the topics this mind discusses:{" "}
      {list.map((t, i) => (
        <span key={t}>
          {i > 0 ? " · " : ""}
          <Link href={`/topic/${slugify(t)}`}>{t}</Link>
        </span>
      ))}
    </p>
  );
}

/**
 * Link to the mind's live dialogues page. Rendered regardless of count so
 * the page is always discoverable (mirrors render_live_content_link).
 */
export function DialoguesLink({
  mindId,
  name,
}: {
  mindId: string;
  name: string;
}) {
  return (
    <Section heading="">
      <h2 style={{ marginTop: 0 }}>
        <Link href={`/mind/${mindId}/dialogues`}>
          Recent dialogues with {name} →
        </Link>
      </h2>
      <p>
        AI responses from real chat sessions with this mind agent, aggregated
        and refreshed as new conversations happen.
      </p>
    </Section>
  );
}

/**
 * Bottom-of-page neighborhood links. Each item is {label, href}; bare paths
 * are rendered with next/link, full URLs as plain anchors. Mirrors
 * render_explore_footer.
 */
export function ExploreFooter({
  items,
  label = "Explore further",
}: {
  items: Array<{ label: string; href: string }>;
  label?: string;
}) {
  const clean = items
    .map((it) => ({ label: (it.label || "").trim(), href: (it.href || "").trim() }))
    .filter((it) => it.label && it.href)
    .slice(0, 5);
  if (!clean.length) return null;
  return (
    <footer className="seo-explore-footer">
      <small>
        {label}:{" "}
        {clean.map((it, i) => (
          <span key={`${it.href}-${i}`}>
            {i > 0 ? " · " : ""}
            {/^https?:\/\//.test(it.href) ? (
              <a href={it.href}>{it.label}</a>
            ) : (
              <Link href={it.href}>{it.label}</Link>
            )}
          </span>
        ))}
      </small>
    </footer>
  );
}
