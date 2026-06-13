"use client";

/**
 * /symposiums discovery feed. A SINGLE-COLUMN question stream (the question is
 * the hook → click → read → chat), with top topic chips to filter by interest.
 * NOT topic-grouped (grouping breaks the "scan questions" flow) and NOT a dense
 * grid (a grid makes you skim a block instead of reading each question).
 *
 * Rendered by a server page that passes all debates in, so the full list is in
 * the SSR HTML (SEO); the chip filter is the only client concern.
 */
import { useState } from "react";
import Link from "next/link";
import type { DebateListItem } from "@/lib/seo-mind";
import { mindColor, mindInitials } from "@/lib/minds";

export default function SymposiumsFeed({ debates }: { debates: DebateListItem[] }) {
  // Topic chips in first-seen order, "All" first.
  const topics: string[] = ["All"];
  for (const d of debates) {
    const t = d.topic || "Other";
    if (!topics.includes(t)) topics.push(t);
  }
  const [active, setActive] = useState("All");
  const shown =
    active === "All" ? debates : debates.filter((d) => (d.topic || "Other") === active);

  return (
    <>
      {topics.length > 2 ? (
        <div className="symposium-filters" role="tablist" aria-label="Filter by topic">
          {topics.map((t) => (
            <button
              key={t}
              type="button"
              className={`symposium-filter${active === t ? " active" : ""}`}
              aria-selected={active === t}
              onClick={() => setActive(t)}
            >
              {t}
            </button>
          ))}
        </div>
      ) : null}

      <div className="symposium-feed">
        {shown.map((d) => (
          <Link key={d.slug} href={`/symposium/${d.slug}`} className="symposium-row">
            <div className="symposium-row-q">{d.question}</div>
            <div className="symposium-row-meta">
              {d.participants && d.participants.length ? (
                <>
                  <span className="symposium-row-avatars">
                    {d.participants.slice(0, 5).map((name, i) => (
                      <span
                        key={i}
                        className="symposium-row-avatar"
                        style={{ background: mindColor(name) }}
                      >
                        {mindInitials(name)}
                      </span>
                    ))}
                  </span>
                  <span className="symposium-row-names">{d.participants.join(", ")}</span>
                </>
              ) : null}
              {d.topic ? <span className="symposium-row-topic">{d.topic}</span> : null}
            </div>
          </Link>
        ))}
      </div>
    </>
  );
}
