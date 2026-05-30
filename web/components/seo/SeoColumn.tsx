import AppShell from "@/components/shell/AppShell";

/**
 * Clean reading column for SEO/content entity pages. Renders inside the SAME
 * glass AppShell as the app (unified chrome → one product), but the content
 * itself stays clean and legible — NO glass behind reading text. Use the
 * `.seo-content` typography classes (defined in liquid.css).
 */
export default function SeoColumn({ children }: { children: React.ReactNode }) {
  return (
    <AppShell>
      <div className="seo-page">
        <article className="seo-content">{children}</article>
      </div>
    </AppShell>
  );
}
