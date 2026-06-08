import EntityLayout from "@/components/seo/EntityLayout";
import SeoColumn from "@/components/seo/SeoColumn";

/**
 * Instant loading skeleton for the SEO entity routes (/book/[id], /mind/[id]).
 *
 * These pages are Server Components that await 5–7 enrichment fetches before
 * the first byte. With no `loading.tsx` the browser sat on the PREVIOUS page
 * for the whole round-trip — the "click Profile / Details and nothing happens
 * for a few seconds" bug. Rendering this through the SAME EntityLayout (hero +
 * grid + rail inside the app shell) means the shell stays put and only the
 * content cross-fades from shimmer → real, so navigation feels immediate.
 */
function Bar({ w, h = 14, r = 6, mt = 0 }: { w: number | string; h?: number; r?: number; mt?: number }) {
  return (
    <span
      className="skeleton-block"
      style={{ display: "block", width: w, height: h, borderRadius: r, marginTop: mt }}
      aria-hidden="true"
    />
  );
}

export default function EntitySkeleton({ variant }: { variant: "book" | "mind" | "topic" }) {
  const heroBody = (
    <div className="seo-hero-body">
      <Bar w={64} h={12} />
      <Bar w="68%" h={30} r={8} mt={12} />
      <Bar w={150} h={14} mt={12} />
      <div style={{ display: "flex", gap: 8, marginTop: 18 }}>
        <Bar w={150} h={38} r={999} />
        <Bar w={130} h={38} r={999} />
      </div>
    </div>
  );

  const hero =
    variant === "book" ? (
      <div className="seo-hero-with-cover">
        <span className="seo-hero-cover skeleton-block" aria-hidden="true" />
        {heroBody}
      </div>
    ) : (
      heroBody
    );

  const rail = (
    <>
      {[0, 1].map((i) => (
        <div className="seo-rail-card" key={i}>
          <Bar w={140} h={16} />
          <Bar w="90%" h={12} mt={14} />
          <Bar w="80%" h={12} mt={10} />
          <Bar w="85%" h={12} mt={10} />
        </div>
      ))}
    </>
  );

  return (
    <EntityLayout hero={hero} rail={rail}>
      <div className="seo-section" aria-busy="true" aria-label="Loading">
        <Bar w="100%" h={14} />
        <Bar w="96%" h={14} mt={12} />
        <Bar w="98%" h={14} mt={12} />
        <Bar w="60%" h={14} mt={12} />
        <Bar w={180} h={20} r={6} mt={32} />
        <Bar w="100%" h={14} mt={18} />
        <Bar w="92%" h={14} mt={12} />
        <Bar w="70%" h={14} mt={12} />
      </div>
    </EntityLayout>
  );
}

/**
 * Single-column loading skeleton for the SeoColumn-shelled share/permalink
 * pages (/discussions/[id], /a/[id]) — same instant-feedback rationale as
 * EntitySkeleton, shaped as a title + a short thread of content blocks.
 */
export function SeoColumnSkeleton() {
  return (
    <SeoColumn>
      <div className="seo-section" aria-busy="true" aria-label="Loading">
        <Bar w="55%" h={26} r={8} />
        <Bar w={160} h={13} mt={12} />
        <Bar w="100%" h={14} mt={28} />
        <Bar w="94%" h={14} mt={12} />
        <Bar w="88%" h={14} mt={12} />
        <Bar w="64%" h={14} mt={12} />
        <Bar w="100%" h={72} r={14} mt={28} />
        <Bar w="90%" h={14} mt={20} />
        <Bar w="80%" h={14} mt={12} />
      </div>
    </SeoColumn>
  );
}
