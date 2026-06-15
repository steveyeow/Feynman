import type { Metadata } from "next";
import HomeOrLanding from "@/components/landing/HomeOrLanding";

type SP = { [key: string]: string | string[] | undefined };

/**
 * Route entry for `/`. Stays a server component; the client gate decides
 * whether an anonymous first-time visitor sees the marketing LANDING or the
 * app HOME (the previous contents of this file, now in components/home/HomePage).
 */
export async function generateMetadata(
  { searchParams }: { searchParams: SP },
): Promise<Metadata> {
  // `/` renders the SAME app shell for every query-param variant — ?book / ?q /
  // ?mind / ?debate are utility deep-links into the composer (a preselected
  // entity + prefilled question), NOT distinct content. Google had indexed ~2K
  // thin `/?mind=X&q=Y` quote-CTA URLs that earn ZERO impressions while the real
  // entity pages they point at sit "discovered, not indexed". So canonicalize
  // each param page to the REAL entity it's a chat-entry for — consolidating the
  // signal onto the page that actually ranks (and nudging Google to index it),
  // not generic home. Paramless `/`, a bare `?q=`, or `?debate=1` → home.
  // The entity detail pages set their own canonicals; the root layout sets none.
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) || "";
  // Slug/uuid only — reject anything with a slash, dot or space so a stray param
  // can never point the canonical outside the entity namespace.
  const safe = (s: string) => (/^[a-zA-Z0-9-]+$/.test(s) ? s : "");
  const mind = safe(one(searchParams.mind));
  const book = safe(one(searchParams.book));
  const canonical = mind ? `/mind/${mind}` : book ? `/book/${book}` : "/";
  return { alternates: { canonical } };
}

export default function Page() {
  return <HomeOrLanding />;
}
