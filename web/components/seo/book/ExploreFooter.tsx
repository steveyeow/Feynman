/**
 * Bottom-of-page neighborhood link cluster (3-5 cross-links). Port of
 * seo.py render_explore_footer. Uses the .seo-explore-footer class.
 * Internal links use next/link; we cap at 5 like the original.
 */
import Link from "next/link";

export interface ExploreItem {
  label: string;
  href: string; // a real Next path, e.g. /topic/x, /mind/x, /book/x
}

export default function ExploreFooter({
  items,
  label = "Explore further",
}: {
  items: ExploreItem[];
  label?: string;
}) {
  const links = items
    .filter((it) => it.href && it.label)
    .slice(0, 5);
  if (!links.length) return null;
  return (
    <footer className="seo-explore-footer">
      <small>
        {label}:{" "}
        {links.map((it, i) => (
          <span key={i}>
            {i > 0 ? " · " : null}
            <Link href={it.href}>{it.label}</Link>
          </span>
        ))}
      </small>
    </footer>
  );
}
