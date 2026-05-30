/**
 * "Popular questions readers ask" — each question links to its own
 * /book/{id}/q/{slug} compound page (the long-tail SEO play). Port of
 * seo.py render_popular_questions (book_id + site_url branch). Uses
 * next/link with real paths (no hash). Companion FAQPage JSON-LD is
 * emitted by the page, not here.
 */
import Link from "next/link";
import { slugify } from "@/lib/seo-book";

export default function PopularQuestions({
  questions,
  bookId,
}: {
  questions: string[];
  bookId: string;
}) {
  const items = questions.filter(Boolean);
  if (!items.length) return null;
  return (
    <section className="seo-section">
      <h2>Popular questions readers ask</h2>
      <ul>
        {items.map((q, i) => (
          <li key={i}>
            <Link href={`/book/${encodeURIComponent(bookId)}/q/${slugify(q)}`}>
              {q}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
