/**
 * "Full text isn't indexed yet" notice for catalog-stub books. Port of
 * seo.py render_book_empty_state. Gives the page a meaningful body when a
 * title sits in the catalog with no fetched primary text; the page's
 * bottom CTA row carries the actual Chat affordance, so no CTA here.
 */
export default function BookEmptyState({
  title,
  author,
}: {
  title: string;
  author: string;
}) {
  return (
    <section className="seo-section empty-state">
      <p className="empty-state-headline">
        Full text isn&apos;t indexed yet for <em>{title}</em>
        {author ? <> by {author}</> : null}.
      </p>
      <p>
        This title sits in our catalog but its primary text wasn&apos;t
        available from public-domain sources (Project Gutenberg, OpenLibrary,
        etc.) and no reader has uploaded a copy. You can still chat with
        Feynman about it — the AI draws on general knowledge and the
        book&apos;s metadata even when the book passages aren&apos;t available
        for retrieval.
      </p>
    </section>
  );
}
