import { NextResponse, type NextRequest } from "next/server";

/**
 * UUID→slug 301 redirects (final stage of the descriptive-URL migration).
 *
 * Old links and already-indexed pages use `/book/{uuid}` and `/mind/{uuid}`.
 * We 301 them to the canonical `/book/{slug}` / `/mind/{slug}` so search engines
 * consolidate ranking signals onto the descriptive URL. Pages requested with a
 * slug (the new normal) pass straight through with no work — only UUID segments
 * trigger a resolution fetch. Resolution failures fall through (the page still
 * renders via the UUID), so this can never take the catalog down.
 *
 * og.png is left alone — it's rewritten to the API at the edge (vercel.json) and
 * the API resolves the slug itself, so a redirect here would just add a hop.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "https://api.feynman.wiki";

export const config = {
  matcher: ["/book/:path*", "/mind/:path*"],
};

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (pathname.endsWith("/og.png")) return NextResponse.next();

  const m = pathname.match(/^\/(book|mind)\/([^/]+)(\/.*)?$/);
  if (!m) return NextResponse.next();
  const kind = m[1];
  const seg = m[2];
  const rest = m[3] || "";
  if (!UUID.test(seg)) return NextResponse.next(); // already a slug → no work

  try {
    const api = kind === "book" ? "agents" : "minds";
    const res = await fetch(`${API_BASE}/api/${api}/${seg}`, {
      headers: { accept: "application/json" },
      next: { revalidate: 86400 }, // cache the uuid→slug resolution for a day
    });
    if (res.ok) {
      const data = (await res.json()) as { slug?: string };
      if (data?.slug && data.slug !== seg) {
        const url = req.nextUrl.clone();
        url.pathname = `/${kind}/${data.slug}${rest}`;
        return NextResponse.redirect(url, 301);
      }
    }
  } catch {
    /* resolution failed — fall through; the page still renders via the UUID */
  }
  return NextResponse.next();
}
