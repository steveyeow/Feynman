import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import MindsGraph from "@/components/minds/MindsGraph";

export const metadata: Metadata = {
  title: "Great Minds — Feynman",
  description:
    "The network of great minds. Explore how history's thinkers connect by what they thought about — then chat with any of them.",
};

/**
 * MINDS NETWORK page — server component wrapper. Renders the app shell, the
 * tagline, and mounts the interactive <MindsGraph/> client island (which owns
 * the glass toolbar, the d3 canvas, and the hover tooltip — all of which need
 * the browser).
 */
export default function MindsPage() {
  return (
    <AppShell>
      <div className="page-view minds-page">
        <MindsGraph />
        <p className="minds-tagline">Expand the scale and scope of collective enlightenment.</p>
      </div>
    </AppShell>
  );
}
