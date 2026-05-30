/**
 * "From the book" — the first few real passages rendered verbatim as
 * blockquotes. Port of seo.py render_sample_passages (default 3 passages,
 * ~800 chars each). This is the bulk of the unique on-page text for SEO.
 */
import { truncateWords, type SamplePassage } from "@/lib/seo-book";

export default function SamplePassages({
  passages,
  maxChars = 800,
}: {
  passages: SamplePassage[];
  maxChars?: number;
}) {
  const items = passages
    .map((p) => truncateWords(p.text, maxChars))
    .filter(Boolean);
  if (!items.length) return null;
  return (
    <section className="seo-section">
      <h2>From the book</h2>
      {items.map((text, i) => (
        <blockquote key={i}>{text}</blockquote>
      ))}
    </section>
  );
}
