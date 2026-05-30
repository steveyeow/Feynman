/**
 * Cross-links to the book's other Q&A pages. Port of seo.py
 * render_sibling_questions — skips the current question (self-link).
 * Uses next/link with real /book/{id}/q/{slug} paths.
 */
import Link from "next/link";
import { slugify } from "@/lib/seo-book";

export default function SiblingQuestions({
  siblings,
  bookId,
  currentQuestion = "",
}: {
  siblings: string[];
  bookId: string;
  currentQuestion?: string;
}) {
  const currentSlug = currentQuestion ? slugify(currentQuestion) : "";
  const items = siblings
    .filter(Boolean)
    .map((q) => ({ q, slug: slugify(q) }))
    .filter((it) => it.slug !== currentSlug);
  if (!items.length) return null;
  return (
    <section className="seo-section">
      <h2>More questions about this book</h2>
      <ul>
        {items.map((it, i) => (
          <li key={i}>
            <Link href={`/book/${encodeURIComponent(bookId)}/q/${it.slug}`}>
              {it.q}
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
