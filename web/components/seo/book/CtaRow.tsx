/**
 * Capability-aware CTA row. Port of seo.py render_cta_matrix, adapted to
 * the new app's real /read/{id} route (the legacy used /#/read/{id}).
 *
 * Both Read and Chat resolve to the same /read/{id} route (the reader
 * carries the chat sidebar), but distinct anchor text doubles internal-link
 * signal diversity for SEO and clarifies user intent. Uses the .seo-cta-row
 * classes with a.primary / a.secondary.
 */
import Link from "next/link";
import { readerUrl as buildReaderUrl, type Capabilities } from "@/lib/seo-book";

export default function CtaRow({
  caps,
  bookId,
  title,
}: {
  caps: Capabilities;
  bookId: string;
  title: string;
}) {
  if (!caps.read && !caps.preview && !caps.chat) return null;
  // readerUrl yields an absolute URL; use a path for next/link internal nav.
  const href = `/read/${encodeURIComponent(bookId)}`;
  const name = title || "this book";

  const primaryLabel = caps.read
    ? `Read ${name}`
    : caps.preview
      ? `Preview ${name}`
      : null;

  return (
    <div className="seo-cta-row">
      {primaryLabel ? (
        <Link className="primary" href={href}>
          {primaryLabel}
        </Link>
      ) : null}
      {caps.chat ? (
        <Link
          className={primaryLabel ? "secondary" : "primary"}
          href={href}
          // ensure the absolute reader URL is available to crawlers that
          // don't resolve relative hrefs (mirrors the Python absolute link)
          data-abs={buildReaderUrl(bookId)}
        >
          Chat about {name}
        </Link>
      ) : null}
    </div>
  );
}
