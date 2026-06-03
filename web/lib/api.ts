/**
 * Thin client for the FastAPI JSON API.
 *
 * Same-origin in the browser (Next rewrites /api/* → FastAPI), or absolute via
 * NEXT_PUBLIC_API_BASE when called from a Server Component during SSR (where
 * there is no same-origin to resolve against).
 *
 * Auth: the legacy app sends the Supabase access token as a Bearer header.
 * `setAuthToken` lets the auth layer (added in a later phase) inject it; SSR
 * calls for public SEO pages run unauthenticated.
 */

// Server-side fetch needs an absolute base. Resolution order:
//  1. NEXT_PUBLIC_API_BASE — explicit (e.g. two-project setup: Next + separate API)
//  2. VERCEL_URL — same-origin on Vercel (single project; /api/* rewrites to the
//     Python function), so SSR talks to the same deployment over https
//  3. localhost — local dev (matches the feynman-backend launch config on :8001)
const SSR_BASE =
  process.env.NEXT_PUBLIC_API_BASE ||
  (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://127.0.0.1:8001");
const isServer = typeof window === "undefined";

// Revalidation window for PUBLIC server-side reads (the SEO pages). Without an
// explicit cache directive, an SSR `fetch` here defaults to uncached, which
// forces the whole page into dynamic rendering (`Cache-Control: no-store`,
// `x-vercel-cache: MISS`) — so every crawl re-renders + re-hits Supabase, which
// was the dominant egress. Caching these reads makes the pages CDN-cacheable
// (repeat crawls serve from the edge, not the DB). 1 day balances egress vs
// content freshness; new content still appears within the window, and brand-new
// pages (e.g. a freshly-minted mind) render on first crawl regardless.
const SSR_REVALIDATE = 86400;

let _authToken: string | null = null;
export function setAuthToken(token: string | null) {
  _authToken = token;
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  /** Server-provided human message (from {detail:{message}}), when present. */
  detailMessage?: string;
  /** Server error code, e.g. quota_exceeded / upload_limit_reached / auth_required. */
  code?: string;
  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.status = status;
    this.body = body;
    const detail = (body as { detail?: unknown } | null)?.detail;
    if (detail && typeof detail === "object") {
      this.code = (detail as { code?: string }).code;
      this.detailMessage = (detail as { message?: string }).message;
    }
    // The auth middleware returns the code at the TOP level with a STRING detail
    // (e.g. {detail:"Authentication required", code:"auth_required"} and the
    // token_expired / invalid_token 401s). Without reading it here the 401
    // interceptor + token-refresh path never fire.
    if (!this.code) this.code = (body as { code?: string } | null)?.code;
  }
}

// ── Quota / auth interceptors ───────────────────────────────────────────
// api.ts is not a React module, so the overlay trigger, analytics, and login
// redirect are injected by the app shell (ProOverlay provider) at mount. This
// ports app.js's api() 429/401 handling: a daily-limit 429 opens the upgrade
// overlay (the ONLY way the paywall surfaces on the hosted build); a 401
// auth_required bounces to login.
// quota_hit reports the same props production sends to PostHog (limit/used/tier),
// NOT code/message — preserves analytics funnels keyed on those (M17).
type QuotaHandler = (info: {
  action: string;
  limit?: number;
  used?: number;
  tier?: string;
}) => void;
let _onQuota: QuotaHandler | null = null;
let _onAuthRequired: (() => void) | null = null;
// Token-refresh handler: returns a fresh access token (or null). Injected by the
// auth layer so api.ts can refresh + retry a 401 token_expired/invalid_token
// before giving up (port of app.js api() refreshSession-and-retry, 1754-1765).
let _onTokenRefresh: (() => Promise<string | null>) | null = null;
export function setQuotaHandler(fn: QuotaHandler | null) {
  _onQuota = fn;
}
export function setAuthRequiredHandler(fn: (() => void) | null) {
  _onAuthRequired = fn;
}
export function setTokenRefreshHandler(fn: (() => Promise<string | null>) | null) {
  _onTokenRefresh = fn;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const base = isServer ? SSR_BASE : "";
  const buildHeaders = () => {
    const h = new Headers(opts.headers || {});
    if (!h.has("Content-Type") && opts.body && typeof opts.body === "string") {
      h.set("Content-Type", "application/json");
    }
    if (opts.auth !== false && _authToken) {
      h.set("Authorization", `Bearer ${_authToken}`);
    }
    return h;
  };

  // Cache public SSR reads (server-side GET, no auth token) so the SEO pages
  // become CDN-cacheable — repeat crawls hit the edge, not Supabase. Never
  // caches authenticated/user fetches (a token present); a caller can opt out
  // explicitly via opts.cache or opts.next.
  const isGet = !opts.method || opts.method.toUpperCase() === "GET";
  // The "ssr" tag lets POST /api/revalidate bust every cached SSR read at once
  // (after a content batch), so data changes go live in seconds instead of
  // waiting out the 1-day revalidate window — without shortening it (no constant
  // egress cost; the cache only refreshes when we explicitly invalidate it).
  const cacheInit: { next?: { revalidate: number; tags?: string[] } } =
    isServer && isGet && !_authToken && !("cache" in opts) && !("next" in opts)
      ? { next: { revalidate: SSR_REVALIDATE, tags: ["ssr"] } }
      : {};

  let res = await fetch(`${base}${path}`, { ...opts, ...cacheInit, headers: buildHeaders() });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    let err = new ApiError(res.status, `API ${res.status} on ${path}`, body);

    // Token expired/invalid mid-flight (hosted): refresh the session once and
    // retry the original request before surfacing the error (port of app.js
    // api() 1754-1765). Browser-only; retries AT MOST once (no infinite loop).
    if (
      !isServer &&
      res.status === 401 &&
      (err.code === "token_expired" || err.code === "invalid_token") &&
      opts.auth !== false &&
      _onTokenRefresh
    ) {
      let newToken: string | null = null;
      try {
        newToken = await _onTokenRefresh();
      } catch {
        /* refresh failed — fall through to normal error handling */
      }
      if (newToken) {
        _authToken = newToken;
        res = await fetch(`${base}${path}`, { ...opts, ...cacheInit, headers: buildHeaders() });
        if (res.ok) {
          if (res.status === 204) return undefined as T;
          return (await res.json()) as T;
        }
        // Retry also failed — re-parse its body so the thrown error reflects it.
        body = null;
        try {
          body = await res.json();
        } catch {
          /* non-JSON */
        }
        err = new ApiError(res.status, `API ${res.status} on ${path}`, body);
      }
    }

    // Browser-only interceptors (ports app.js api() 429/401 handling).
    if (!isServer) {
      if (res.status === 429 && (err.code === "quota_exceeded" || err.code === "upload_limit_reached")) {
        const detail = (body as {
          detail?: { action?: string; limit?: number; used?: number; tier?: string };
        } | null)?.detail;
        _onQuota?.({
          action: detail?.action || "",
          limit: detail?.limit,
          used: detail?.used,
          tier: detail?.tier,
        });
      } else if (res.status === 401 && err.code === "auth_required") {
        _onAuthRequired?.();
      }
    }
    throw err;
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

export const get = <T = unknown>(path: string, init?: RequestInit) =>
  apiFetch<T>(path, { ...init, method: "GET" });

export const post = <T = unknown>(path: string, data?: unknown, init?: RequestInit) =>
  apiFetch<T>(path, {
    ...init,
    method: "POST",
    body: data === undefined ? undefined : JSON.stringify(data),
  });

export const del = <T = unknown>(path: string, init?: RequestInit) =>
  apiFetch<T>(path, { ...init, method: "DELETE" });

// ── Typed helpers for the first surfaces (extended per-phase) ──────────
export interface Agent {
  id: string;
  name: string;
  author?: string;
  status?: string;
  type?: string;
  meta?: Record<string, unknown>;
  cover_url?: string;
}
export interface Mind {
  id: string;
  name: string;
  era?: string;
  domain?: string;
  bio_summary?: string;
}

export const listAgents = () => get<Agent[]>("/api/agents");
export const getAgent = (id: string) => get<Agent>(`/api/agents/${encodeURIComponent(id)}`);
export const deleteAgent = (id: string) =>
  del<void>(`/api/agents/${encodeURIComponent(id)}`);
export const listMinds = () => get<Mind[]>("/api/minds");
export const getMind = (id: string) => get<Mind>(`/api/minds/${encodeURIComponent(id)}`);

/**
 * POST /api/votes {title} — upvote a book by title (port of handleUpvote). The
 * server returns the new vote record incl. the updated count.
 */
export const upvote = (title: string) =>
  post<{ id?: string; title?: string; count?: number }>("/api/votes", { title });

/** GET /api/votes → vote records ({title, count, …}); merged into Book.upvotes. */
export const listVotes = () =>
  get<{ id: string; title: string; count: number }[]>("/api/votes");
export const listTopics = () =>
  get<{ topics?: string[] } | string[]>("/api/topics").then((r) =>
    Array.isArray(r) ? r : r.topics || [],
  );
