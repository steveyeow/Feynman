/**
 * Supporting RAG passages for a Q&A page, with passage attribution. Port of
 * seo.py render_qa_passages (default 600 chars). Even when LLM synthesis is
 * unavailable, this section alone gives the page real, original book text.
 */
import { truncateWords } from "@/lib/seo-book";

export interface QaPassage {
  text: string;
  chunk_index?: number | null;
}

export default function QaPassages({
  passages,
  maxChars = 600,
}: {
  passages: QaPassage[];
  maxChars?: number;
}) {
  const items = passages
    .map((p) => ({
      text: truncateWords(p.text, maxChars),
      idx: p.chunk_index,
    }))
    .filter((p) => p.text);
  if (!items.length) return null;
  return (
    <section className="seo-section qa-passages">
      <h2>From the book</h2>
      {items.map((p, i) => (
        <blockquote key={i}>
          {p.text}
          {p.idx !== null && p.idx !== undefined ? (
            <footer>
              <small>Passage [{Number(p.idx) + 1}]</small>
            </footer>
          ) : null}
        </blockquote>
      ))}
    </section>
  );
}
