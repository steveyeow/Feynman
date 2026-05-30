/**
 * Top-of-page metadata block for a book landing page: author line + stats
 * (words / read-time / chapters). Uses the established .seo-author and
 * .seo-meta typography classes (defined in liquid.css). Renders nothing
 * for the bits it has no data for.
 */
import { statsLine } from "@/lib/seo-book";

export default function BookMeta({
  author,
  totalWords,
  chapterCount,
}: {
  author: string;
  totalWords: number;
  chapterCount: number;
}) {
  const stats = statsLine(totalWords, chapterCount);
  return (
    <>
      {author ? <p className="seo-author">by {author}</p> : null}
      {stats ? <p className="seo-meta">{stats}</p> : null}
    </>
  );
}
