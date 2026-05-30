/**
 * Top-of-page 1-2 sentence summary. Port of seo.py render_book_about — the
 * subtitle (from the outline) is the best signal of what the book is about
 * in the author's own framing. Renders nothing when there's no subtitle.
 */
export default function AboutBook({ subtitle }: { subtitle: string }) {
  const text = (subtitle || "").trim();
  if (!text) return null;
  return <p className="book-about">{text}</p>;
}
