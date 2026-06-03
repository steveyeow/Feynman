import { revalidatePath, revalidateTag } from "next/cache";
import { type NextRequest, NextResponse } from "next/server";

/**
 * On-demand cache busting. Every public SSR read is tagged "ssr" (see
 * web/lib/api.ts), so POST /revalidate?token=…&tag=ssr invalidates them all and
 * each SEO page re-fetches fresh data on its next request — content changes
 * (generated voices, regenerated questions, new minds) go live in seconds
 * instead of waiting out the 1-day revalidate window. No constant egress cost:
 * the cache still only refreshes when we explicitly invalidate it.
 *
 * Lives at /revalidate (NOT /api/*, which vercel.json rewrites to the FastAPI
 * backend). Token-gated; a leak's worst case is a one-time cache refresh.
 */
export const dynamic = "force-dynamic";

const TOKEN = "fey_rv_9f3a7c2e8b1d4056b7e21ad4c8";

function handle(req: NextRequest): NextResponse {
  const token =
    req.nextUrl.searchParams.get("token") || req.headers.get("x-revalidate-token");
  if (token !== TOKEN) {
    return NextResponse.json({ ok: false, error: "unauthorized" }, { status: 401 });
  }
  // revalidateTag("ssr") only busts entries CREATED after the tag shipped; to
  // refresh pages cached before then, revalidatePath purges a route's Data +
  // Route cache outright. type=page is REQUIRED to bust a dynamic-route PATTERN
  // like /mind/[id] (all instances) — without it Next treats the brackets as a
  // literal path and matches nothing.
  const path = req.nextUrl.searchParams.get("path");
  const tag = req.nextUrl.searchParams.get("tag");
  const done: string[] = [];
  if (path) {
    const type = req.nextUrl.searchParams.get("type");
    revalidatePath(path, type === "page" || type === "layout" ? type : undefined);
    done.push(`path:${path}${type ? `:${type}` : ""}`);
  }
  if (tag) {
    revalidateTag(tag);
    done.push(`tag:${tag}`);
  }
  if (!path && !tag) {
    revalidateTag("ssr");
    done.push("tag:ssr");
  }
  return NextResponse.json({ ok: true, revalidated: done, at: Date.now() });
}

export const POST = handle;
export const GET = handle;
