import Link from "next/link";
import { mindColor, mindInitials } from "@/lib/minds";
import type { DebateListItem } from "@/lib/seo-mind";

/**
 * Compact symposium list for embedding in other entity pages (topic hub, book
 * detail). Each row: the question + a few participant avatars. Server component
 * (pure render) — the host page fetches + filters the debates by topic.
 */
export default function SymposiumLinks({
  debates,
  limit = 6,
}: {
  debates: DebateListItem[];
  limit?: number;
}) {
  const items = debates.slice(0, limit);
  if (!items.length) return null;
  return (
    <ul className="symposium-links">
      {items.map((d) => (
        <li key={d.slug}>
          <Link href={`/symposium/${d.slug}`} className="symposium-link">
            <span className="symposium-link-q">{d.question}</span>
            {d.participants && d.participants.length ? (
              <span className="symposium-link-avatars">
                {d.participants.slice(0, 4).map((n, i) => (
                  <span
                    key={i}
                    className="symposium-link-avatar"
                    style={{ background: mindColor(n) }}
                  >
                    {mindInitials(n)}
                  </span>
                ))}
              </span>
            ) : null}
          </Link>
        </li>
      ))}
    </ul>
  );
}
