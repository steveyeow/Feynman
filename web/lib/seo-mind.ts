/**
 * SEO/GEO helpers for the MIND / TOPIC / DISCUSSIONS landing pages.
 *
 * Faithful TypeScript port of the structured-data + slug primitives that
 * used to live in `app/core/seo.py` (person_jsonld, collection_jsonld,
 * mind_essay_jsonld, breadcrumb_jsonld, slugify, FAMOUS_MIND_SAMEAS /
 * lookup_same_as) plus the fetch helpers each route needs.
 *
 * Design rules (mirroring the Python module):
 *   - Builders take already-loaded data and return JSON-serializable dicts.
 *     React's <JsonLd> handles serialization; we drop empty leaves here so
 *     schema validators don't choke on `sameAs: []` etc.
 *   - Every fetch helper try/catches and degrades gracefully — the API may
 *     be down or empty in dev, and SSR must never crash the route.
 *   - No HTML escaping here: JSX escapes text nodes automatically, unlike
 *     the Python SSR which hand-escaped every string.
 */

import { get } from "@/lib/api";

export const SITE_URL =
  process.env.NEXT_PUBLIC_SITE_URL || "https://feynman.wiki";

// ─── Domain types (the JSON API strips `persona` from mind payloads) ────

export interface MindDetail {
  id: string;
  name: string;
  slug?: string;
  era?: string;
  domain?: string;
  bio_summary?: string;
  /** Generated first-person self-intro (imagined). Drives the first-person About. */
  voice?: string;
  thinking_style?: string;
  typical_phrases?: string[];
  /** Full persona is stripped by /api/minds and /api/minds/{id} (system-prompt
   *  text, kept private). `persona_excerpt` is the bounded ~900-char public
   *  snippet the single-mind endpoint exposes for the "Core approach" section. */
  persona?: string;
  persona_excerpt?: string;
  works?: string[];
  /** Wikidata/Wikipedia identity URLs — stored per-mind by expand_minds from
   *  the matched Wikidata candidate. Merged into the Person JSON-LD `sameAs`
   *  alongside the curated FAMOUS_MIND_SAMEAS table (see mindSameAs). */
  wikidata_url?: string;
  wikipedia_url?: string;
  created_at?: string;
  [k: string]: unknown;
}

export interface AgentRowLite {
  id: string;
  name: string;
  slug?: string;
  type?: string;
  status?: string;
  source?: string;
  meta?: {
    author?: string;
    category?: string;
    description?: string;
    [k: string]: unknown;
  };
  [k: string]: unknown;
}

export interface SimilarityLink {
  source: string;
  target: string;
  strength?: number;
}

// ─── Slug generation (deterministic, ASCII-only — matches seo.py) ───────

const SLUG_NON_ALNUM = /[^a-z0-9]+/g;
const SLUG_TRIM = /^-+|-+$/g;

/**
 * Convert a title or name into a URL-safe kebab-case slug. Deterministic
 * and ASCII-only — non-Latin scripts collapse to dashes. Mirrors the
 * Python `slugify` exactly so slugs round-trip across the two stacks.
 */
export function slugify(text: string, maxLen = 80): string {
  if (!text) return "untitled";
  let s = text.toLowerCase().trim();
  // Drop non-ASCII the same way the Python canonical does
  // (`s.encode("ascii", "ignore")`): accented/ligature chars are removed
  // entirely rather than folded, so slugs are byte-for-byte identical to the
  // backend's sitemap/canonical URLs for the same entity. All TOPIC_TAGS are
  // plain ASCII, so topic-slug round-tripping is unaffected either way.
  // eslint-disable-next-line no-control-regex
  s = s.replace(/[^\x00-\x7f]/g, "");
  s = s.replace(SLUG_NON_ALNUM, "-");
  s = s.replace(SLUG_TRIM, "");
  if (!s) return "untitled";
  if (s.length > maxLen) {
    const cut = s.slice(0, maxLen);
    const lastDash = cut.lastIndexOf("-");
    s = lastDash > 0 ? cut.slice(0, lastDash) : cut;
  }
  return s;
}

/** Slug for a given topic name (alias kept for parity with seo.py). */
export const topicSlug = (topic: string): string => slugify(topic);

/** Absolute URL helper. */
export function abs(path: string): string {
  if (/^https?:\/\//.test(path)) return path;
  return SITE_URL.replace(/\/$/, "") + (path.startsWith("/") ? path : `/${path}`);
}

// ─── sameAs: curated Wikipedia/Wikidata identity links (from seo.py) ────

export const FAMOUS_MIND_SAMEAS: Record<string, string[]> = {
  "karl marx": [
    "https://en.wikipedia.org/wiki/Karl_Marx",
    "https://www.wikidata.org/wiki/Q9061",
  ],
  "friedrich engels": [
    "https://en.wikipedia.org/wiki/Friedrich_Engels",
    "https://www.wikidata.org/wiki/Q34787",
  ],
  "adam smith": [
    "https://en.wikipedia.org/wiki/Adam_Smith",
    "https://www.wikidata.org/wiki/Q9381",
  ],
  "john maynard keynes": [
    "https://en.wikipedia.org/wiki/John_Maynard_Keynes",
    "https://www.wikidata.org/wiki/Q9317",
  ],
  "richard feynman": [
    "https://en.wikipedia.org/wiki/Richard_Feynman",
    "https://www.wikidata.org/wiki/Q39246",
  ],
  "albert einstein": [
    "https://en.wikipedia.org/wiki/Albert_Einstein",
    "https://www.wikidata.org/wiki/Q937",
  ],
  "isaac newton": [
    "https://en.wikipedia.org/wiki/Isaac_Newton",
    "https://www.wikidata.org/wiki/Q935",
  ],
  "charles darwin": [
    "https://en.wikipedia.org/wiki/Charles_Darwin",
    "https://www.wikidata.org/wiki/Q1035",
  ],
  "sigmund freud": [
    "https://en.wikipedia.org/wiki/Sigmund_Freud",
    "https://www.wikidata.org/wiki/Q9215",
  ],
  "carl jung": [
    "https://en.wikipedia.org/wiki/Carl_Jung",
    "https://www.wikidata.org/wiki/Q41532",
  ],
  "friedrich nietzsche": [
    "https://en.wikipedia.org/wiki/Friedrich_Nietzsche",
    "https://www.wikidata.org/wiki/Q1141",
  ],
  aristotle: [
    "https://en.wikipedia.org/wiki/Aristotle",
    "https://www.wikidata.org/wiki/Q868",
  ],
  plato: [
    "https://en.wikipedia.org/wiki/Plato",
    "https://www.wikidata.org/wiki/Q859",
  ],
  socrates: [
    "https://en.wikipedia.org/wiki/Socrates",
    "https://www.wikidata.org/wiki/Q913",
  ],
  confucius: [
    "https://en.wikipedia.org/wiki/Confucius",
    "https://www.wikidata.org/wiki/Q4604",
  ],
  "immanuel kant": [
    "https://en.wikipedia.org/wiki/Immanuel_Kant",
    "https://www.wikidata.org/wiki/Q9312",
  ],
  "g.w.f. hegel": [
    "https://en.wikipedia.org/wiki/Georg_Wilhelm_Friedrich_Hegel",
    "https://www.wikidata.org/wiki/Q9235",
  ],
  "warren buffett": [
    "https://en.wikipedia.org/wiki/Warren_Buffett",
    "https://www.wikidata.org/wiki/Q47213",
  ],
  "charlie munger": [
    "https://en.wikipedia.org/wiki/Charlie_Munger",
    "https://www.wikidata.org/wiki/Q1066368",
  ],
  "peter drucker": [
    "https://en.wikipedia.org/wiki/Peter_Drucker",
    "https://www.wikidata.org/wiki/Q57139",
  ],
  "carl sagan": [
    "https://en.wikipedia.org/wiki/Carl_Sagan",
    "https://www.wikidata.org/wiki/Q34943",
  ],
  "stephen hawking": [
    "https://en.wikipedia.org/wiki/Stephen_Hawking",
    "https://www.wikidata.org/wiki/Q17714",
  ],
  "marie curie": [
    "https://en.wikipedia.org/wiki/Marie_Curie",
    "https://www.wikidata.org/wiki/Q7186",
  ],
  "nikola tesla": [
    "https://en.wikipedia.org/wiki/Nikola_Tesla",
    "https://www.wikidata.org/wiki/Q9036",
  ],
};

/** Return curated authoritative URLs for a famous mind, or undefined. */
export function lookupSameAs(mindName: string): string[] | undefined {
  if (!mindName) return undefined;
  return FAMOUS_MIND_SAMEAS[mindName.trim().toLowerCase()];
}

/**
 * Full `sameAs` set for a mind's Person JSON-LD. The Wikidata/Wikipedia URLs
 * stored on the row (resolved + verified from Wikidata's action API by
 * expand_minds / backfill_mind_sameas — P31=Q5 + enwiki-gated) are
 * AUTHORITATIVE and SUPERSEDE the curated FAMOUS_MIND_SAMEAS table: same two
 * URL kinds, but correct by construction. The hand-curated table doesn't scale
 * to 1000 minds and had at least one copy-paste error (Engels pointed at
 * Russell's QID), so for any mind we've actually resolved we don't risk
 * re-introducing a curated mistake. The table is the fallback ONLY for minds
 * without stored links (the few Wikidata can't resolve by name). Deduped;
 * undefined when empty so dropNulls strips the key rather than emit `sameAs: []`.
 */
export function mindSameAs(
  mind: Pick<MindDetail, "name" | "wikidata_url" | "wikipedia_url">,
): string[] | undefined {
  const stored = [mind.wikipedia_url || "", mind.wikidata_url || ""]
    .map((u) => (u || "").trim())
    .filter(Boolean);
  if (stored.length) return [...new Set(stored)];
  const curated = (lookupSameAs(mind.name) || [])
    .map((u) => (u || "").trim())
    .filter(Boolean);
  return curated.length ? [...new Set(curated)] : undefined;
}

// ─── JSON-LD builders (drop empty leaves, matching jsonld_script) ───────

type Json = Record<string, unknown>;

/** Recursively drop null/""/[] leaves so validators don't choke. */
export function dropNulls<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map((x) => dropNulls(x)) as unknown as T;
  }
  if (obj && typeof obj === "object") {
    const out: Json = {};
    for (const [k, v] of Object.entries(obj as Json)) {
      if (v === null || v === undefined || v === "") continue;
      if (Array.isArray(v) && v.length === 0) continue;
      out[k] = dropNulls(v);
    }
    return out as unknown as T;
  }
  return obj;
}

export function personJsonLd(opts: {
  name: string;
  description?: string;
  domain?: string;
  url: string;
  image?: string;
  sameAs?: string[] | null;
  dateModified?: string;
}): Json {
  const out: Json = {
    "@context": "https://schema.org",
    "@type": "Person",
    name: opts.name,
    description: opts.description || "",
    url: opts.url,
    image: opts.image || "",
  };
  const domain = (opts.domain || "").trim();
  if (domain) {
    const knows = domain
      .split(",")
      .map((d) => d.trim())
      .filter(Boolean);
    out.knowsAbout = knows.length ? knows : domain;
  }
  if (opts.sameAs && opts.sameAs.length) out.sameAs = opts.sameAs;
  if (opts.dateModified) out.dateModified = opts.dateModified;
  return dropNulls(out);
}

export function breadcrumbJsonLd(items: Array<[string, string]>): Json {
  return {
    "@context": "https://schema.org",
    "@type": "BreadcrumbList",
    itemListElement: items.map(([name, url], i) => ({
      "@type": "ListItem",
      position: i + 1,
      name,
      item: url,
    })),
  };
}

export function collectionJsonLd(opts: {
  name: string;
  description?: string;
  url: string;
  items: Array<{ name: string; url: string }>;
  siteUrl?: string;
}): Json {
  const siteUrl = opts.siteUrl || SITE_URL;
  return dropNulls({
    "@context": "https://schema.org",
    "@type": "CollectionPage",
    name: opts.name,
    description: opts.description || "",
    url: opts.url,
    isPartOf: { "@type": "WebSite", name: "Feynman", url: siteUrl },
    mainEntity: {
      "@type": "ItemList",
      numberOfItems: opts.items.length,
      itemListElement: opts.items.map((item, i) => ({
        "@type": "ListItem",
        position: i + 1,
        url: item.url,
        name: item.name,
      })),
    },
  });
}

/**
 * Schema.org/Article for the imagined mind-on-topic essay. Author is
 * Feynman (Organization) — the essay is our synthesis, not the mind's own
 * writing. `about` ties it to the mind for topical clarity.
 */
export function mindEssayJsonLd(opts: {
  mindName: string;
  topic: string;
  description?: string;
  url: string;
  mindUrl: string;
  image?: string;
  siteUrl?: string;
}): Json {
  const siteUrl = opts.siteUrl || SITE_URL;
  return dropNulls({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: `How ${opts.mindName} might approach ${opts.topic}`,
    description: opts.description || "",
    url: opts.url,
    author: { "@type": "Organization", name: "Feynman", url: siteUrl },
    about: { "@type": "Person", name: opts.mindName, url: opts.mindUrl },
    publisher: { "@type": "Organization", name: "Feynman", url: siteUrl },
    image: opts.image || "",
  });
}

/**
 * Schema.org/Article for the aggregated dialogues page. Author/publisher is
 * Feynman; `about` is the mind. Ports `insights_article_jsonld` (Person
 * variant) from seo.py.
 */
export function dialoguesArticleJsonLd(opts: {
  headline: string;
  description?: string;
  url: string;
  aboutUrl: string;
  aboutName: string;
  dateModified?: string;
  siteUrl?: string;
}): Json {
  const siteUrl = opts.siteUrl || SITE_URL;
  return dropNulls({
    "@context": "https://schema.org",
    "@type": "Article",
    headline: opts.headline,
    description: opts.description || "",
    url: opts.url,
    author: { "@type": "Organization", name: "Feynman", url: siteUrl },
    publisher: { "@type": "Organization", name: "Feynman", url: siteUrl },
    about: { "@type": "Person", name: opts.aboutName, url: opts.aboutUrl },
    dateModified: opts.dateModified || "",
  });
}

// ─── Multi-mind debates (Type 4) ───

export interface DebateTurn {
  mind_id: string;
  mind_name: string;
  turn_index: number;
  content: string;
}

export interface Debate {
  id: string;
  slug: string;
  question: string;
  topic?: string;
  created_at?: string;
  turns: DebateTurn[];
  mind_slugs?: Record<string, string>;
}

export interface MindDebateItem {
  slug: string;
  question: string;
  created_at?: string;
}

export interface DebateListItem {
  slug: string;
  question: string;
  topic?: string;
  created_at?: string;
  participants?: string[];
}

/** A debate + its ordered turns (GET /api/debates/{slug}); null if absent. */
export async function fetchDebate(slug: string): Promise<Debate | null> {
  try {
    const res = await get<Debate>(`/api/debates/${encodeURIComponent(slug)}`, {
      next: { revalidate: 600 },
    });
    if (!res || !Array.isArray(res.turns) || res.turns.length === 0) return null;
    return res;
  } catch {
    return null;
  }
}

/** All published debates — the /debates index feed. */
export async function fetchDebatesList(): Promise<DebateListItem[]> {
  try {
    const res = await get<{ debates?: DebateListItem[] }>(`/api/debates`, {
      next: { revalidate: 600 },
    });
    return Array.isArray(res?.debates) ? res.debates : [];
  } catch {
    return [];
  }
}

/** Debates a mind argued in — the 'Recent debates' rail on /mind/{id}. */
export async function fetchMindDebates(id: string): Promise<MindDebateItem[]> {
  try {
    const res = await get<{ debates?: MindDebateItem[] }>(
      `/api/minds/${encodeURIComponent(id)}/debates`,
      { next: { revalidate: 600 } },
    );
    return Array.isArray(res?.debates) ? res.debates : [];
  } catch {
    return [];
  }
}

/**
 * Debate page schema. DiscussionForumPosting with each mind's turn as a
 * Comment authored by that thinker (Person) — the multi-author structure
 * Google understands for a symposium, and the citation hook for LLMs.
 */
export function debateJsonLd(opts: {
  question: string;
  url: string;
  created?: string;
  turns: Array<{ name: string; text: string; url: string }>;
}): Json {
  return dropNulls({
    "@context": "https://schema.org",
    "@type": "DiscussionForumPosting",
    headline: opts.question,
    url: opts.url,
    datePublished: opts.created || "",
    author: { "@type": "Organization", name: "Feynman", url: SITE_URL },
    comment: opts.turns.map((t) => ({
      "@type": "Comment",
      text: t.text,
      author: { "@type": "Person", name: t.name, url: t.url },
    })),
  });
}

/** Truncate to ~N chars on a word boundary with an ellipsis (matches seo.py). */
export function truncate(text: string, maxChars: number): string {
  const t = (text || "").trim();
  if (t.length <= maxChars) return t;
  const cut = t.slice(0, maxChars);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 0 ? cut.slice(0, lastSpace) : cut) + "…";
}

/** Build a meta description, clamped to 200 chars on a word boundary. */
export function metaDescription(text: string): string {
  const t = (text || "").replace(/\s+/g, " ").trim();
  if (t.length <= 200) return t;
  return t.slice(0, 197).replace(/\s+\S*$/, "") + "...";
}

// ─── Topic-relevance matcher (port of qa.is_mind_topic_relevant) ────────
//
// Used to surface topic-hub links on a mind page and to gate which minds
// appear on a topic page. Morphologically loose; false positives are fine.

const MIND_ESSAY_MIN_DOMAIN_OVERLAP_CHARS = 3;
const STEM_SKIP = new Set(["and", "the", "of", "in", "on", "for", "to", "&"]);

/**
 * Light morphological stem — a FAITHFUL port of qa._morphological_stem so the
 * Next pages and the Python sitemap agree on which (mind, topic) pairs are
 * related. The previous port diverged: its suffix list/order stripped only
 * "s" from "economics" → "economic" (vs Python's "ics" → "econom"), so
 * isMindTopicRelevant returned false for pairs the sitemap lists as true —
 * which 404'd /mind/{id}/on/economics AND dropped mind↔topic internal links
 * (e.g. Karl Marx never linked to /topic/economics). Same suffix tuple, same
 * order, same length guard (len(w) > len(suffix) + 3) as the Python original.
 */
function morphologicalStem(word: string): string {
  const w = word.toLowerCase();
  for (const suf of ["ical", "ics", "ing", "ed", "al", "ly", "es", "s", "y"]) {
    if (w.length > suf.length + 3 && w.endsWith(suf)) {
      return w.slice(0, w.length - suf.length);
    }
  }
  return w;
}

export function isMindTopicRelevant(
  mind: Pick<MindDetail, "domain">,
  topic: string,
): boolean {
  if (!mind || !topic) return false;
  const domain = (mind.domain || "").toLowerCase();
  if (!domain) return false;
  const domainStems = domain
    .split(/[,\s]+/)
    .filter(Boolean)
    .map(morphologicalStem);
  const domainBlob = domainStems.join(" ");

  const topicLower = topic.toLowerCase();
  if (domain.includes(topicLower)) return true;

  for (const rawToken of topicLower.split(/[,\s&]+/)) {
    if (
      rawToken.length < MIND_ESSAY_MIN_DOMAIN_OVERLAP_CHARS ||
      STEM_SKIP.has(rawToken)
    )
      continue;
    const stem = morphologicalStem(rawToken);
    if (stem.length < MIND_ESSAY_MIN_DOMAIN_OVERLAP_CHARS) continue;
    if (domainBlob.includes(stem)) return true;
  }
  return false;
}

// ─── Fetch helpers (graceful degradation; never throw) ──────────────────

/** All minds (persona stripped). Empty array on any failure. */
export async function fetchMinds(): Promise<MindDetail[]> {
  try {
    const data = await get<MindDetail[]>("/api/minds", {
      next: { revalidate: 86400 },
    } as RequestInit);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/** Single mind by id (persona stripped by the API). null on failure/404. */
export async function fetchMind(id: string): Promise<MindDetail | null> {
  try {
    const data = await get<MindDetail>(`/api/minds/${encodeURIComponent(id)}`, {
      next: { revalidate: 86400 },
    } as RequestInit);
    return data && data.id ? data : null;
  } catch {
    return null;
  }
}

/** All agents (books). Empty array on failure. */
export async function fetchAgents(): Promise<AgentRowLite[]> {
  try {
    const data = await get<AgentRowLite[]>("/api/agents", {
      next: { revalidate: 86400 },
    } as RequestInit);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

/**
 * Topic list. The API returns `{topics: string[]}`; older callers expected a
 * bare array. Handle both shapes. Empty array on failure.
 */
export async function fetchTopics(): Promise<string[]> {
  try {
    const data = await get<string[] | { topics?: string[] }>("/api/topics", {
      next: { revalidate: 86400 },
    } as RequestInit);
    if (Array.isArray(data)) return data;
    if (data && Array.isArray(data.topics)) return data.topics;
    return [];
  } catch {
    return [];
  }
}

/**
 * Similarity links between minds, used to derive "related minds" on a mind
 * page (there is no direct related-minds JSON endpoint). Empty on failure.
 */
export async function fetchSimilarityLinks(): Promise<SimilarityLink[]> {
  try {
    const data = await get<{ links?: SimilarityLink[] }>(
      "/api/minds/similarities",
      { next: { revalidate: 86400 } } as RequestInit,
    );
    return data && Array.isArray(data.links) ? data.links : [];
  } catch {
    return [];
  }
}

/**
 * Generated 2-paragraph intro for a topic hub (GET /api/topics/{slug}/overview).
 * On-demand generated + cached server-side; empty string degrades to the
 * page's existing one-line intro. The Bucket-B density floor for Type-3 hubs.
 */
export async function fetchTopicOverview(slug: string): Promise<string> {
  try {
    const res = await get<{ overview?: string }>(
      `/api/topics/${encodeURIComponent(slug)}/overview`,
      { next: { revalidate: 86400 } } as RequestInit,
    );
    return (res?.overview || "").trim();
  } catch {
    return "";
  }
}

/** Resolve a topic slug to its canonical topic name via the topic list. */
export async function resolveTopicSlug(slug: string): Promise<string | null> {
  const topics = await fetchTopics();
  const target = slug.trim().toLowerCase();
  for (const t of topics) {
    if (slugify(t) === target) return t;
  }
  return null;
}

/**
 * Derive related minds for a given mind from the similarity graph, falling
 * back to same-domain minds when the graph has no entry (e.g. embeddings
 * not yet computed). Returns at most `limit` minds, excluding self.
 */
export async function fetchRelatedMinds(
  mind: MindDetail,
  limit = 6,
): Promise<MindDetail[]> {
  const [allMinds, links] = await Promise.all([
    fetchMinds(),
    fetchSimilarityLinks(),
  ]);
  if (!allMinds.length) return [];
  const byId = new Map(allMinds.map((m) => [m.id, m]));

  // 1) Similarity-graph neighbors, strongest first.
  const neighbors: Array<{ id: string; strength: number }> = [];
  for (const l of links) {
    if (l.source === mind.id && l.target)
      neighbors.push({ id: l.target, strength: l.strength || 0 });
    else if (l.target === mind.id && l.source)
      neighbors.push({ id: l.source, strength: l.strength || 0 });
  }
  neighbors.sort((a, b) => b.strength - a.strength);

  const seen = new Set<string>([mind.id]);
  const out: MindDetail[] = [];
  for (const n of neighbors) {
    const m = byId.get(n.id);
    if (m && !seen.has(m.id)) {
      seen.add(m.id);
      out.push(m);
      if (out.length >= limit) return out;
    }
  }

  // 2) Fallback: same primary domain token.
  const domainKey = (mind.domain || "").split(",")[0]?.trim().toLowerCase();
  if (domainKey) {
    for (const m of allMinds) {
      if (seen.has(m.id)) continue;
      const md = (m.domain || "").toLowerCase();
      if (md && md.includes(domainKey)) {
        seen.add(m.id);
        out.push(m);
        if (out.length >= limit) break;
      }
    }
  }
  return out;
}

/**
 * Match a mind's notable-works titles against the book catalog so each work
 * can deep-link to /book/{id} when we host it. Case-insensitive, with a
 * substring fallback (handles subtitle / edition drift) — mirrors
 * render_mind_works in seo.py. Returns a map of lowercased title → book id.
 */
export function buildWorkLinkIndex(
  agents: AgentRowLite[],
): Map<string, string> {
  const idx = new Map<string, string>();
  for (const a of agents) {
    // Store the slug (uuid fallback) so work→book links skip the 301 hop.
    if (a.id && a.name) idx.set(a.name.toLowerCase(), a.slug || a.id);
  }
  return idx;
}

/** Find a book id for a work title using exact then substring matching. */
export function matchWorkToBook(
  work: string,
  idx: Map<string, string>,
): string | null {
  const wl = work.toLowerCase();
  const exact = idx.get(wl);
  if (exact) return exact;
  for (const [name, id] of idx) {
    if (name && (name.includes(wl) || wl.includes(name))) return id;
  }
  return null;
}

/** Books whose meta.category matches a topic name (case-insensitive). */
export function filterBooksByTopic(
  agents: AgentRowLite[],
  topic: string,
  limit = 30,
): AgentRowLite[] {
  const t = topic.toLowerCase();
  // Dedupe by normalized title: the catalog holds the SAME book as both a
  // full-title `catalog` stub and a short-title `ready` record ("Competitive
  // Strategy: Techniques…" vs "Competitive Strategy"; "Good to Great" even has
  // two stubs differing only in punctuation). Normalize = strip the subtitle
  // after a colon/dash + punctuation, lowercase, collapse whitespace. On a
  // collision, prefer the real (ready/indexing) book so the short correct title
  // wins over the stub — which also makes the page's "N books" count honest.
  const norm = (a: AgentRowLite) =>
    (a.name || "")
      .toLowerCase()
      .split(/[:—]|\s-\s/)[0]
      .replace(/[.,;:!?'"()]/g, "")
      .replace(/\s+/g, " ")
      .trim();
  const rank = (a: AgentRowLite) =>
    a.status === "ready" || a.status === "indexing" ? 2 : a.status === "writing" ? 1 : 0;

  const best = new Map<string, AgentRowLite>();
  const order: string[] = [];
  for (const a of agents) {
    if (a.status === "error" && a.type !== "ai_book") continue;
    const cat = (a.meta?.category || "").toLowerCase();
    if (!(cat && (cat === t || cat.includes(t) || t.includes(cat)))) continue;
    const k = norm(a) || a.id; // fall back to id if the title normalizes empty
    const cur = best.get(k);
    if (!cur) {
      best.set(k, a);
      order.push(k);
    } else if (rank(a) > rank(cur)) {
      best.set(k, a);
    }
  }
  return order.map((k) => best.get(k)!).slice(0, limit);
}

/** Minds whose domain is relevant to a topic (uses isMindTopicRelevant). */
export function filterMindsByTopic(
  minds: MindDetail[],
  topic: string,
  limit = 12,
): MindDetail[] {
  const out: MindDetail[] = [];
  for (const m of minds) {
    if (isMindTopicRelevant(m, topic)) {
      out.push(m);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/** Author / display name for a book agent (mirrors books.ts mapping). */
export function bookAuthor(a: AgentRowLite): string {
  return a.meta?.author || a.source || "";
}

// ─── JSON endpoints added for parity (mirror the SSR mind surfaces) ─────

export interface DialogueCard {
  text: string;
  created_at: string;
}

/**
 * Public, server-sanitized AI dialogue cards for /mind/{id}/dialogues
 * (GET /api/minds/{id}/dialogues). 404 when the insights flag is off →
 * treated as empty so the page shows its empty state.
 */
export async function fetchMindDialogues(id: string, limit = 10): Promise<DialogueCard[]> {
  try {
    const res = await get<{ dialogues?: DialogueCard[] }>(
      `/api/minds/${encodeURIComponent(id)}/dialogues`,
      // ISR, not no-store: no-store would opt the whole /mind/[id]/dialogues
      // route into per-request dynamic rendering, defeating `revalidate` and
      // letting crawlers drive uncapped function invocations + backend egress.
      { next: { revalidate: 600 } },
    );
    const cards = Array.isArray(res?.dialogues) ? res.dialogues : [];
    return cards.slice(0, limit);
  } catch {
    return [];
  }
}

export interface MindOnTopic {
  mind_name: string;
  topic: string;
  essay: string;
}

/**
 * The imagined mind-on-topic essay for /mind/{id}/on/{slug}
 * (GET /api/minds/{id}/on/{slug}). The endpoint applies the same relevance
 * gate as the SSR page and 404s irrelevant pairs / disabled feature — we
 * return null so the page can notFound() or render its minimal fallback.
 */
export async function fetchMindOnTopic(id: string, slug: string): Promise<MindOnTopic | null> {
  try {
    const res = await get<MindOnTopic>(
      `/api/minds/${encodeURIComponent(id)}/on/${encodeURIComponent(slug)}`,
    );
    if (!res || !res.essay) return null;
    return res;
  } catch {
    return null;
  }
}

export interface MindQuestionItem {
  slug: string;
  question: string;
}

export interface MindQA {
  slug: string;
  question: string;
  answer: string;
  created_at?: string;
}

/** Stored Q&A list for a mind (slug + question) — detail-page section + related list. */
export async function fetchMindQuestions(id: string): Promise<MindQuestionItem[]> {
  try {
    const res = await get<{ questions?: MindQuestionItem[] }>(
      `/api/minds/${encodeURIComponent(id)}/questions`,
      { next: { revalidate: 600 } },
    );
    return Array.isArray(res?.questions) ? res.questions : [];
  } catch {
    return [];
  }
}

/** One pre-answered mind question (zero LLM at request time — stored by the mind-qa cron). */
export async function fetchMindQA(id: string, slug: string): Promise<MindQA | null> {
  try {
    const res = await get<MindQA>(
      `/api/minds/${encodeURIComponent(id)}/q/${encodeURIComponent(slug)}`,
      { next: { revalidate: 86400 } },
    );
    return res && res.question ? res : null;
  } catch {
    return null;
  }
}

export interface PublicDiscussion {
  id: string;
  title: string;
  handle: string;
  session_type: string;
  entity_id: string;
  /** Descriptive slug of the linked book/mind (uuid fallback). Avoids the 301. */
  entity_slug?: string;
  approved_at: string;
  /** speaker: a mind answer's name (mind turns), "Feynman" (assistant), or "" (user). */
  messages: Array<{ role: string; content: string; speaker?: string }>;
}

/**
 * One approved, PII-scrubbed public discussion for /discussions/{id}
 * (GET /api/public-discussions/{id}). 404 unless the feature flag is on AND
 * the session is approved — returns null so the page can notFound().
 */
export async function fetchPublicDiscussion(id: string): Promise<PublicDiscussion | null> {
  try {
    const res = await get<PublicDiscussion>(
      `/api/public-discussions/${encodeURIComponent(id)}`,
      // ISR (see fetchMindDialogues): keep /discussions/[id] cacheable so
      // shareable permalinks don't render per-request on every crawl.
      { next: { revalidate: 600 } },
    );
    if (!res || !res.id) return null;
    return res;
  } catch {
    return null;
  }
}

export interface PublicAnswer {
  id: string;
  /** Preceding user turn (PII-scrubbed). May be empty. */
  question: string;
  /** The shared answer (PII-scrubbed). */
  answer: string;
  /** "assistant" (Feynman) | "mind". */
  answer_role: string;
  /** Sharer's display name; "Anonymous" when none. */
  handle: string;
  /** The mind that authored a 'mind' answer; null for a Feynman answer. */
  mind: {
    name: string;
    id?: string;
    slug?: string;
    avatar_seed?: string;
    voice?: string;
  } | null;
  /** The cited book, when the answer drew on one; otherwise null. */
  book: { name: string; agent_id?: string; slug?: string } | null;
  approved_at: string;
}

/**
 * One approved, PII-scrubbed shared single answer for /a/{id}
 * (GET /api/public-answers/{id}). 404 unless the feature flag is on AND the
 * answer is approved — returns null so the page can render its stable
 * "not available" permalink state.
 */
export async function fetchPublicAnswer(id: string): Promise<PublicAnswer | null> {
  try {
    const res = await get<PublicAnswer>(
      `/api/public-answers/${encodeURIComponent(id)}`,
      // ISR (see fetchPublicDiscussion): keep /a/[id] cacheable so shareable
      // permalinks don't render per-request on every crawl.
      { next: { revalidate: 600 } },
    );
    if (!res || !res.id) return null;
    return res;
  } catch {
    return null;
  }
}

// ─── Content-density sections: mind library / themes / discussions list ───

export interface LibraryBook {
  id: string;
  name: string;
  slug?: string;
  type?: string;
  author?: string;
}

/** Books in this mind's library (GET /api/minds/{id}/library) — cross-links
 *  distinct from persona "notable works". Empty array on failure. */
export async function fetchMindLibrary(id: string): Promise<LibraryBook[]> {
  try {
    const res = await get<{ books?: LibraryBook[] }>(
      `/api/minds/${encodeURIComponent(id)}/library`,
      { next: { revalidate: 86400 } },
    );
    return Array.isArray(res?.books) ? res.books : [];
  } catch {
    return [];
  }
}

export interface MindTheme {
  topic: string;
  count: number;
  last_seen?: string;
}

/** Community-emergent recent themes (GET /api/minds/{id}/themes) — what
 *  readers actually discuss with this mind. Empty array on failure. */
export async function fetchMindThemes(id: string): Promise<MindTheme[]> {
  try {
    const res = await get<{ themes?: MindTheme[] }>(
      `/api/minds/${encodeURIComponent(id)}/themes`,
      { next: { revalidate: 1800 } },
    );
    return Array.isArray(res?.themes) ? res.themes : [];
  } catch {
    return [];
  }
}

export interface DiscussionCard {
  id: string;
  title: string;
  handle: string;
  approved_at: string;
}

/** Approved public discussions for an entity (book or mind). Returns the list
 *  + the entity name. Empty list when UGC disabled / none approved. */
export async function fetchEntityDiscussions(
  kind: "agents" | "minds",
  id: string,
): Promise<{ discussions: DiscussionCard[]; entityName: string }> {
  try {
    const res = await get<{ discussions?: DiscussionCard[]; entity_name?: string }>(
      `/api/${kind}/${encodeURIComponent(id)}/discussions`,
      { next: { revalidate: 600 } },
    );
    return {
      discussions: Array.isArray(res?.discussions) ? res.discussions : [],
      entityName: res?.entity_name || "",
    };
  } catch {
    return { discussions: [], entityName: "" };
  }
}
