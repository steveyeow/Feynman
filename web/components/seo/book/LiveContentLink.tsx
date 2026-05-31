/**
 * Surfaces the book's /insights live-content page from the landing page.
 * Port of seo.py render_live_content_link (kind="insights"). Rendered as a
 * "promo card" (NOT an <h2><a>, which inherited the content-link underline +
 * heading size and looked like a struck-through title).
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
    <Link
      href={`/book/${encodeURIComponent(bookId)}/insights`}
      className="seo-promo-card"
    >
      <span className="seo-promo-title">
        AI insights about {entityName}
        {count > 0 ? <span className="seo-promo-badge">{count}</span> : null}
        <span className="seo-promo-arrow"> →</span>
      </span>
      <span className="seo-promo-sub">
        Accumulated AI commentary on this book, drawn from real reader chat
        sessions and updated as more readers engage.
      </span>
    </Link>
  );
}
