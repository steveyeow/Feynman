import type { Metadata } from "next";
import HomeOrLanding from "@/components/landing/HomeOrLanding";

/**
 * Route entry for `/`. Stays a server component; the client gate decides
 * whether an anonymous first-time visitor sees the marketing LANDING or the
 * app HOME (the previous contents of this file, now in components/home/HomePage).
 */
export const metadata: Metadata = {
  // Self-canonicalize the `/` route. It renders the SAME app shell for every
  // query-param variant — ?book / ?q / ?mind / ?debate are utility deep-links
  // into the composer, not distinct content — so without this each variant is a
  // canonical-less duplicate of home ("Duplicate without user-selected
  // canonical"). The unique content lives at /book/{slug}, /mind/{slug}, etc.,
  // which set their own canonicals; the root layout deliberately sets none (a
  // layout-level canonical would force EVERY page to claim "/"). Relative — Next
  // resolves it against metadataBase → https://feynman.wiki/.
  alternates: { canonical: "/" },
};

export default function Page() {
  return <HomeOrLanding />;
}
