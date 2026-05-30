/**
 * Synthesized LLM answer block for a Q&A compound page. Port of seo.py
 * render_qa_answer — labelled explicitly because the answer is AI-generated
 * grounded synthesis (transparency required by Google's helpful-content
 * guidance). Preserves the LLM's paragraph breaks. Renders nothing when
 * there is no answer (the passages section then carries the content).
 */
export default function QaAnswer({ answer }: { answer: string }) {
  const paragraphs = (answer || "")
    .split(/\n\n+/)
    .map((p) => p.trim())
    .filter(Boolean);
  if (!paragraphs.length) return null;
  return (
    <section className="seo-section qa-answer">
      <h2>Synthesized answer</h2>
      {paragraphs.map((p, i) => (
        <p key={i}>{p}</p>
      ))}
      <p>
        <small>
          Synthesized from the book passages below. Chat with the book on
          Feynman for follow-up.
        </small>
      </p>
    </section>
  );
}
