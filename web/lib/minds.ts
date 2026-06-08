/**
 * Minds-network data layer. Faithful port of the legacy app.js graph data flow
 * (`_fetchGraphData`, `_buildGraphData`, `mindColor`, `mindInitials`,
 * `_domainTokens`, `_matchStrength`, `_makeEmbeddingForce` inputs).
 *
 * Shapes match the FastAPI backend (app/core/minds.py):
 *   GET /api/minds                → Mind[]
 *   GET /api/minds/similarities   → { links: GraphLink[], layout: LayoutPos[] }
 *
 * NOTE: the backend `compute_mind_layout()` returns an ARRAY of {id, rx, ry}
 * (fractional canvas coords in ~[0.08, 0.92]), NOT a {[id]:[x,y]} map. We type
 * and consume the real array shape so the embedding force lines up with the
 * server's PCA projection.
 */

// Types are defined locally here (not in lib/api.ts, which is out of scope).
// lib/api.ts exports its own minimal `Mind`; we re-declare a superset with the
// extra fields the graph reads (chat_count, created_at) so we don't depend on
// editing that file.
export interface Mind {
  id: string;
  name: string;
  /** Descriptive URL slug. Link to /mind/{slug} to skip the uuid→slug 301 hop
   *  (the slug-resolution middleware fetches the cold origin on every uuid). */
  slug?: string | null;
  era?: string;
  domain?: string;
  bio_summary?: string;
  chat_count?: number;
  created_at?: string;
}

/** A pairwise similarity edge. `strength` is cosine similarity (~0.45–1.0). */
export interface GraphLink {
  source: string;
  target: string;
  strength: number;
}

/** One mind's 2D PCA position, fractional (rx, ry both ~[0.08, 0.92]). */
export interface LayoutPos {
  id: string;
  rx: number;
  ry: number;
}

export interface GraphData {
  links: GraphLink[];
  layout: LayoutPos[];
}

// ── d3 node/link working shapes (mutated by the simulation) ─────────────
export interface GraphNode {
  id: string;
  /** Descriptive slug for navigation (falls back to id when un-backfilled). */
  slug: string | null;
  name: string;
  era: string;
  domain: string;
  bio: string;
  color: string;
  initials: string;
  tokens: string[];
  /** Fractional PCA target {rx, ry} for the embedding force, or null. */
  layoutPos: { rx: number; ry: number } | null;
  // d3.forceSimulation mutates these in place:
  x?: number;
  y?: number;
  vx?: number;
  vy?: number;
  fx?: number | null;
  fy?: number | null;
}

export interface SimLink {
  source: GraphNode | string;
  target: GraphNode | string;
  strength: number;
}

// ── Helpers (ported verbatim from app.js) ───────────────────────────────

const MIND_COLORS = [
  "#6d597a", "#355070", "#264653", "#2a9d8f", "#e76f51",
  "#b56576", "#0077b6", "#588157", "#9b2226", "#457b9d",
];

/** Deterministic per-name color (legacy `mindColor`). */
export function mindColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return MIND_COLORS[Math.abs(h) % MIND_COLORS.length];
}

/** Up-to-two-letter initials (legacy `mindInitials`). */
export function mindInitials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => (w[0] ? w[0].toUpperCase() : ""))
    .join("");
}

/** Split a mind's domain string into normalized tokens (legacy `_domainTokens`). */
export function domainTokens(m: Mind): string[] {
  return (m.domain || "")
    .toLowerCase()
    .split(/[,;/&]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

export function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

// ── API ──────────────────────────────────────────────────────────────────
import { apiFetch } from "@/lib/api";

// Near-static minds list — cache it (TTL) + de-dupe so the Great Minds graph,
// the composer mind picker, and ChatView don't re-fetch the cold origin on every
// mount. Fetched auth:false (the endpoint is identity-independent) so the first
// load can hit the shared edge cache too.
const MINDS_TTL = 5 * 60 * 1000;
let _mindsCache: Mind[] | null = null;
let _mindsAt = 0;
let _mindsInflight: Promise<Mind[]> | null = null;

/** GET /api/minds — full mind list, cached. Returns [] on failure (never throws). */
export async function listMinds(): Promise<Mind[]> {
  if (_mindsCache && Date.now() - _mindsAt < MINDS_TTL) return _mindsCache;
  if (_mindsInflight) return _mindsInflight;
  _mindsInflight = apiFetch<Mind[]>("/api/minds", { method: "GET", auth: false })
    .then((minds) => {
      _mindsCache = Array.isArray(minds) ? minds : [];
      _mindsAt = Date.now();
      return _mindsCache;
    })
    .catch((err) => {
      console.warn("[minds] listMinds failed:", err);
      return _mindsCache || []; // stale-or-empty; preserve the never-throws contract
    })
    .finally(() => {
      _mindsInflight = null;
    });
  return _mindsInflight;
}

/**
 * GET /api/minds/similarities — embedding links + PCA layout. Returns empty
 * arrays on failure (the graph falls back to a charge-only layout). Tolerates
 * the legacy/alternate `layout` map shape just in case, normalizing to LayoutPos[].
 */
let _simCache: GraphData | null = null;
let _simAt = 0;
let _simInflight: Promise<GraphData> | null = null;

export async function getSimilarities(): Promise<GraphData> {
  if (_simCache && Date.now() - _simAt < MINDS_TTL) return _simCache;
  if (_simInflight) return _simInflight;
  // 176 KB graph, fetched on every Great Minds mount — cache it (TTL) like the
  // minds list. auth:false: it's the global embedding graph (identity-independent).
  _simInflight = apiFetch<{ links?: GraphLink[]; layout?: unknown }>(
    "/api/minds/similarities",
    { method: "GET", auth: false },
  )
    .then((resp) => {
      _simCache = {
        links: Array.isArray(resp?.links) ? resp.links : [],
        layout: normalizeLayout(resp?.layout),
      };
      _simAt = Date.now();
      return _simCache;
    })
    .catch((err) => {
      console.warn("[minds] getSimilarities failed:", err);
      return _simCache || { links: [], layout: [] };
    })
    .finally(() => {
      _simInflight = null;
    });
  return _simInflight;
}

/** Accept either the real array shape or a {[id]:[x,y]|{rx,ry}} map. */
function normalizeLayout(raw: unknown): LayoutPos[] {
  if (Array.isArray(raw)) {
    return raw
      .filter((p): p is LayoutPos => !!p && typeof p.id === "string")
      .map((p) => ({ id: p.id, rx: Number(p.rx) || 0.5, ry: Number(p.ry) || 0.5 }));
  }
  if (raw && typeof raw === "object") {
    const out: LayoutPos[] = [];
    for (const [id, v] of Object.entries(raw as Record<string, unknown>)) {
      if (Array.isArray(v) && v.length >= 2) {
        out.push({ id, rx: Number(v[0]) || 0.5, ry: Number(v[1]) || 0.5 });
      } else if (v && typeof v === "object") {
        const o = v as { rx?: number; ry?: number };
        out.push({ id, rx: Number(o.rx) || 0.5, ry: Number(o.ry) || 0.5 });
      }
    }
    return out;
  }
  return [];
}

/**
 * Build d3 nodes + links from minds + similarity data. Mirrors the essential
 * parts of legacy `_buildGraphData`:
 *  - one node per mind (color/initials/tokens/layoutPos derived)
 *  - links from vector similarities (rescaled to ~[0.3, …] like the legacy)
 *  - fallback to shared-token links when no vector links are present
 *  - connect any orphan node to its best token match
 * (We drop the legacy localStorage custom-links + new-mind fly-in staggering,
 * which were session-state extras, not core to the visualization.)
 */
export function buildGraphData(
  minds: Mind[],
  links: GraphLink[],
  layout: LayoutPos[],
): { nodes: GraphNode[]; links: SimLink[] } {
  const layoutMap = new Map(layout.map((p) => [p.id, { rx: p.rx, ry: p.ry }]));

  const nodes: GraphNode[] = minds.map((m) => ({
    id: m.id,
    slug: m.slug ?? null,
    name: m.name,
    era: m.era || "",
    domain: m.domain || "",
    bio: m.bio_summary || "",
    color: mindColor(m.name),
    initials: mindInitials(m.name),
    tokens: domainTokens(m),
    layoutPos: layoutMap.get(m.id) || null,
  }));

  const nodeIds = new Set(nodes.map((n) => n.id));
  const out: SimLink[] = [];
  let usedVectorLinks = false;

  if (links && links.length > 0) {
    for (const vl of links) {
      if (!nodeIds.has(vl.source) || !nodeIds.has(vl.target)) continue;
      // legacy rescale: spread the 0.45–1.0 cosine band into a wider strength range
      out.push({
        source: vl.source,
        target: vl.target,
        strength: Math.max(0.3, (vl.strength - 0.4) * 2.5),
      });
    }
    if (out.length > 0) usedVectorLinks = true;
  }

  if (!usedVectorLinks) {
    // Fallback: link minds that share domain tokens.
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const shared = nodes[i].tokens.filter((t) =>
          nodes[j].tokens.some((u) => t === u || t.includes(u) || u.includes(t)),
        );
        if (shared.length > 0) {
          out.push({ source: nodes[i].id, target: nodes[j].id, strength: shared.length });
        }
      }
    }
  }

  // Ensure no orphans: connect each unlinked node to its best token match
  // (or, for a single-node-dominated graph, chain everything off node 0).
  if (out.length === 0 && nodes.length > 1) {
    for (let i = 1; i < nodes.length; i++) {
      out.push({ source: nodes[0].id, target: nodes[i].id, strength: 0.3 });
    }
  } else if (nodes.length > 1) {
    const linked = new Set<string>();
    for (const l of out) {
      linked.add(typeof l.source === "object" ? l.source.id : l.source);
      linked.add(typeof l.target === "object" ? l.target.id : l.target);
    }
    for (const orphan of nodes) {
      if (linked.has(orphan.id)) continue;
      let best: GraphNode | null = null;
      let bestStr = 0;
      for (const other of nodes) {
        if (other === orphan) continue;
        const s = matchStrength(orphan.tokens, other.tokens);
        if (s > bestStr) {
          bestStr = s;
          best = other;
        }
      }
      if (best) out.push({ source: orphan.id, target: best.id, strength: Math.min(bestStr, 2) });
    }
  }

  return { nodes, links: out };
}

const STOP_WORDS = new Set([
  "and", "the", "of", "in", "a", "an", "to", "for", "on", "with", "its", "or",
  "as", "by", "at", "is", "was", "are", "be", "has", "had", "that", "this",
  "from", "but", "not", "it", "he", "she", "they", "his", "her", "their",
  "our", "my", "all", "no", "so", "if", "do", "did", "will", "can", "may",
]);

function tokenWords(tokens: string[]): Set<string> {
  const words = new Set<string>();
  for (const t of tokens) {
    for (const w of t.split(/\s+/)) {
      const clean = w.replace(/[^a-z0-9]/g, "");
      if (clean.length > 2 && !STOP_WORDS.has(clean)) words.add(clean);
    }
  }
  return words;
}

/** Token overlap score between two minds (legacy `_matchStrength`). */
export function matchStrength(tokensA: string[], tokensB: string[]): number {
  let strength = 0;
  for (const t of tokensA) {
    for (const u of tokensB) {
      if (t === u) strength += 3;
      else if (t.includes(u) || u.includes(t)) strength += 2;
    }
  }
  if (strength === 0) {
    const wordsA = tokenWords(tokensA);
    const wordsB = tokenWords(tokensB);
    let wordHits = 0;
    for (const w of wordsA) if (wordsB.has(w)) wordHits++;
    if (wordHits >= 2) strength = wordHits;
  }
  return strength;
}
