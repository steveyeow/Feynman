import { ImageResponse } from "next/og";
import { fetchPublicAnswer, truncate } from "@/lib/seo-mind";

// Dynamic social card for a shared answer (share redesign Phase 2). Next
// auto-wires this as the page's og:image + twitter:image. Generated on demand
// (ISR-cached with the route) — mind name + answer snippet + brand, so a shared
// answer looks good when pasted into X / Slack / iMessage.
//
// Note: relies on @vercel/og's default font (no custom font fetch → no extra
// network failure mode). If the data fetch 404s (feature off / withdrawn) we
// still emit a branded fallback card rather than erroring.

export const alt = "A shared answer on Feynman";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function Image({ params }: { params: { id: string } }) {
  const ans = await fetchPublicAnswer(params.id);
  const who = ans?.mind?.name || "Feynman";
  const snippet = truncate(
    (ans?.answer || ans?.question || "A shared answer on Feynman").replace(/\s+/g, " "),
    220,
  );

  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          padding: "72px 80px",
          background:
            "linear-gradient(135deg, #0b1020 0%, #11162a 60%, #0b1020 100%)",
          color: "#f5f5f7",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            fontSize: 34,
            fontWeight: 700,
            letterSpacing: -0.5,
            color: "#6aa8ff",
          }}
        >
          Feynman
        </div>

        <div
          style={{
            display: "flex",
            fontSize: 52,
            lineHeight: 1.25,
            fontWeight: 600,
            letterSpacing: -1,
            maxWidth: 1040,
          }}
        >
          {snippet}
        </div>

        <div
          style={{
            display: "flex",
            justifyContent: "space-between",
            alignItems: "center",
            fontSize: 30,
            color: "#9aa4b8",
          }}
        >
          <span style={{ display: "flex" }}>— {who}</span>
          <span style={{ display: "flex" }}>feynman.wiki</span>
        </div>
      </div>
    ),
    { ...size },
  );
}
