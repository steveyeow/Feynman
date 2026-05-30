/**
 * Surfaces the book's /insights live-content page from the landing page.
 * Port of seo.py render_live_content_link (kind="insights"). Always
 * rendered so the page is discoverable; an optional count badge advertises
 * real activity when > 0.
 */
import Link from "next/link";

export default function LiveContentLink({
  entityName,
  bookId,
  count = 0,
}: {
  entityName: string;
  bookId: string;
  count?: number;
}) {
  return (
    <section className="seo-section live-content-link">
      <h2>
        <Link href={`/book/${encodeURIComponent(bookId)}/insights`}>
          AI insights about {entityName} →
        </Link>
        {count > 0 ? <span className="count-badge"> {count}</span> : null}
      </h2>
      <p>
        Accumulated AI commentary on this book, drawn from real reader chat
        sessions and updated as more readers engage.
      </p>
    </section>
  );
}
