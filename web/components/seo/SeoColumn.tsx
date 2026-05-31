import AppShell from "@/components/shell/AppShell";

/**
 * Single-column SEO page wrapper (q / insights / dialogues / on / topic /
 * discussions). Shares the SAME scroll container + horizontal padding as the
 * two-column EntityLayout (.seo-scroll + .seo-entity), so these pages get the
 * proper page margins (not flush against the sidebar) and scroll as one
 * document. Content stays clean (no glass) and left-aligned via .seo-content.
 */
export default function SeoColumn({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="seo-scroll">
        <div className="seo-entity">
          <article className="seo-content">{children}</article>
        </div>
      </div>
    </AppShell>
  );
}
