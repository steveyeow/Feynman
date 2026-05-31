import AppShell from "@/components/shell/AppShell";

/**
 * Shared layout for SEO entity pages (book / mind / topic / q / insights /
 * dialogues / discussions). Information architecture, per product direction:
 *
 *   ┌─────────────────────────────────────────────┐
 *   │ HERO: title + subtitle + ACTION BAR (top)     │  ← actions are prominent,
 *   ├──────────────────────────────┬────────────────┤    above the fold, never
 *   │ MAIN: SEO reading content     │ RIGHT RAIL:     │    buried in content.
 *   │ (passages / Q&A / insights /  │ meta + related  │
 *   │  essay / dialogue thread)     │ + secondary     │  Right rail is desktop-
 *   │                               │ links (share…)  │  only; on mobile it
 *   └──────────────────────────────┴────────────────┘  stacks under the main.
 *
 * Why this shape: these pages are a NEW content type — they must read as
 * substantive, indexable documents (SEO/GEO) AND offer the product's actions
 * (chat / read / share) up top so a visitor from Google/an LLM citation can
 * act immediately, while feeling continuous with the app (same shell, same
 * tokens). The whole thing scrolls as one document (fixes the prior nested-
 * scroll trap); only the app shell is fixed.
 */
export default function EntityLayout({
  hero,
  rail,
  children,
}: {
  hero: React.ReactNode;
  rail?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <AppShell>
      <div className="seo-scroll">
        <div className="seo-entity">
          <header className="seo-hero">{hero}</header>
          <div className={`seo-grid${rail ? " has-rail" : ""}`}>
            <article className="seo-content">{children}</article>
            {rail ? <aside className="seo-rail">{rail}</aside> : null}
          </div>
        </div>
      </div>
    </AppShell>
  );
}
