/**
 * Table of Contents — ordered list of chapter titles from meta.outline.
 * Port of seo.py render_toc. Renders nothing when no titled chapters exist.
 */
import type { Chapter } from "@/lib/seo-book";

export default function TableOfContents({ chapters }: { chapters: Chapter[] }) {
  const titles = chapters.map((c) => c.title?.trim()).filter(Boolean) as string[];
  if (!titles.length) return null;
  return (
    <section className="seo-section">
      <h2>Table of Contents</h2>
      <ol>
        {titles.map((t, i) => (
          <li key={i}>{t}</li>
        ))}
      </ol>
    </section>
  );
}
