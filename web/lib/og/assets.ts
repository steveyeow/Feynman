/**
 * Real visual assets for the share cards — the highest-impact lever for
 * conveying "this is a real great mind / a real book":
 *   - mind portraits  →  Wikidata P18 image → Wikimedia Commons file
 *   - book covers     →  Open Library covers API, keyed on ISBN
 *
 * Both fetch server-side inside the `/api/og` render, return a base64 data URI
 * (Satori embeds it directly — most reliable vs a remote <img> URL), and
 * degrade to `null` on ANY failure/timeout/missing-asset so the card falls back
 * to a generated glyph / typographic cover. Bounded by a short timeout; the
 * rendered PNG is edge-cached, so this only runs on a cache miss.
 *
 * NOTE on rights: Wikimedia portraits are predominantly public-domain or
 * CC-BY/BY-SA; we render them without an on-card credit (standard for OG
 * thumbnails). If strict attribution is ever required, switch to glyph-only.
 */

import { lookupSameAs } from "@/lib/seo-mind";

const TIMEOUT_MS = 2500;
const UA = "FeynmanOG/1.0 (+https://feynman.wiki)";

async function timed(url: string): Promise<Response | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await fetch(url, {
      signal: ctrl.signal,
      headers: { "User-Agent": UA },
      // Asset endpoints are immutable per key; let the platform cache.
      cache: "force-cache",
    });
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

async function toDataUri(res: Response): Promise<string | null> {
  try {
    const buf = Buffer.from(await res.arrayBuffer());
    // Open Library returns a 1×1 GIF placeholder for missing covers even with
    // ?default=false on some edges; a real cover/portrait is always >2KB.
    if (buf.length < 2048) return null;
    const ct = res.headers.get("content-type") || "image/jpeg";
    if (!ct.startsWith("image/")) return null;
    return `data:${ct};base64,${buf.toString("base64")}`;
  } catch {
    return null;
  }
}

/** Open Library cover (Large) by ISBN, or null when there's no real cover. */
export async function bookCoverDataUri(isbn?: string | null): Promise<string | null> {
  const clean = (isbn || "").replace(/[^0-9Xx]/g, "");
  if (clean.length !== 10 && clean.length !== 13) return null;
  const res = await timed(
    `https://covers.openlibrary.org/b/isbn/${clean}-L.jpg?default=false`,
  );
  if (!res || !res.ok) return null;
  return toDataUri(res);
}

/** Extract a Wikidata QID (Q123…) from a wikidata.org URL. */
function qidFrom(url?: string): string | null {
  const m = (url || "").match(/\/(Q\d+)(?:[#?/].*)?$/i);
  return m ? m[1].toUpperCase() : null;
}

/**
 * Mind portrait as a data URI: resolve the Wikidata QID (from the stored
 * wikidata_url, falling back to the curated FAMOUS_MIND_SAMEAS table by name),
 * read its P18 image filename, then fetch a width-bounded render from Commons.
 * null on any miss → caller renders the initials glyph.
 */
export async function mindPortraitDataUri(opts: {
  name: string;
  wikidata_url?: string;
}): Promise<string | null> {
  let qid = qidFrom(opts.wikidata_url);
  if (!qid) {
    for (const u of lookupSameAs(opts.name) || []) {
      const q = qidFrom(u);
      if (q) {
        qid = q;
        break;
      }
    }
  }
  if (!qid) return null;

  const meta = await timed(
    `https://www.wikidata.org/wiki/Special:EntityData/${qid}.json`,
  );
  if (!meta || !meta.ok) return null;

  let filename = "";
  try {
    const json = (await meta.json()) as {
      entities?: Record<
        string,
        { claims?: { P18?: Array<{ mainsnak?: { datavalue?: { value?: unknown } } }> } }
      >;
    };
    const v = json?.entities?.[qid]?.claims?.P18?.[0]?.mainsnak?.datavalue?.value;
    if (typeof v === "string") filename = v;
  } catch {
    return null;
  }
  if (!filename) return null;

  // Special:FilePath redirects to the actual bytes; ?width caps the render.
  const img = await timed(
    `https://commons.wikimedia.org/wiki/Special:FilePath/${encodeURIComponent(
      filename.replace(/ /g, "_"),
    )}?width=480`,
  );
  if (!img || !img.ok) return null;
  return toDataUri(img);
}
