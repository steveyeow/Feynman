/**
 * Insight cards for /book/{id}/insights, plus the empty state. Ports of
 * seo.py render_insight_cards and render_insights_empty_state. Each card is
 * labelled as AI synthesis (the collective attribution line) to be
 * transparent about authorship; user questions are never published.
 */
import { truncateWords, type InsightCard } from "@/lib/seo-book";

export function InsightCards({
  insights,
  maxChars = 900,
}: {
  insights: InsightCard[];
  maxChars?: number;
}) {
  const cards = insights
    .map((c) => truncateWords(c.text, maxChars))
    .filter(Boolean)
    .map((text) => text.split(/\n\n+/).map((p) => p.trim()).filter(Boolean));
  if (!cards.length) return null;
  return (
    <section className="seo-section insights">
      {cards.map((paras, i) => (
        <article key={i} className="insight-card">
          {paras.map((p, j) => (
            <p key={j}>{p}</p>
          ))}
        </article>
      ))}
      <p>
        <small>
          Synthesized from AI agent responses across reader conversations. AI
          output only; user questions are never published.
        </small>
      </p>
    </section>
  );
}

export function InsightsEmptyState({ entityName }: { entityName: string }) {
  return (
    <section className="seo-section insights-empty">
      <p>
        No AI insights have accumulated yet for {entityName}. Start a chat
        below and your conversation will help shape this <em>insights</em>{" "}
        page — the AI&apos;s responses get aggregated here (your questions stay
        private).
      </p>
    </section>
  );
}
