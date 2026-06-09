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

    // A 401 here is usually recoverable, so try a one-time session refresh + retry
    // BEFORE surfacing anything — and crucially before bouncing to /login:
    //  - token_expired / invalid_token: the short-lived Supabase access token aged
    //    out mid-session.
    //  - auth_required: a request raced ahead of the token being applied (e.g. at
    //    startup, or right after the access token expired) so it went out with no
    //    Authorization header and the auth middleware returned auth_required.
    // In ALL of these, if a valid Supabase session still exists the refresh handler
    // mints a fresh token and we retry once. Only a genuinely signed-out user
    // (refresh yields no token, or the retry is STILL auth_required) is bounced to
    // /login — so a logged-in user never gets kicked to the login page over a
    // transient token gap. Browser-only; at most one retry (port + hardening of
    // app.js api() 1754-1765).
    const recoverable401 =
      !isServer &&
      res.status === 401 &&
      opts.auth !== false &&
      (err.code === "token_expired" ||
        err.code === "invalid_token" ||
        err.code === "auth_required");
    if (recoverable401 && _onTokenRefresh) {
      let newToken: string | null = null;
      try {
        newToken = await _onTokenRefresh();
      } catch {
        /* refresh failed — fall through to the signed-out handling below */
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
      // Refresh couldn't establish a session (or the retry is still auth_required)
      // → this really is a signed-out state, so surface the login bounce now.
      if (err.code === "auth_required") {
        _onAuthRequired?.();
      }
    }

    // Browser-only interceptor (ports app.js api() 429 handling): a daily-limit
    // 429 opens the upgrade overlay. The 401 auth_required → /login bounce is
    // handled above (only AFTER a session refresh fails), so a transient token
    // gap no longer kicks a logged-in user to the login page.
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
  /** Descriptive URL slug. Share URLs MUST use this (not the uuid): /book/{uuid}
   *  301-redirects to /book/{slug}, and X's card crawler doesn't follow 301s. */
  slug?: string | null;
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
// Minds list cache (near-static). ChatView + the composer mind picker import
// listMinds from here, so cache it (TTL + de-dupe) to avoid re-fetching the cold
// Python origin on every mount. auth:false → the list is identity-independent, so
// the first load can hit Vercel's shared edge cache too. (lib/minds.ts has its
// own cache for the graph's richer Mind type.)
let _mindsListCache: Mind[] | null = null;
let _mindsListAt = 0;
let _mindsListInflight: Promise<Mind[]> | null = null;
export const listMinds = (): Promise<Mind[]> => {
  if (_mindsListCache && Date.now() - _mindsListAt < 300_000) {
    return Promise.resolve(_mindsListCache);
  }
  if (_mindsListInflight) return _mindsListInflight;
  _mindsListInflight = apiFetch<Mind[]>("/api/minds", { method: "GET", auth: false })
    .then((m) => {
      _mindsListCache = Array.isArray(m) ? m : [];
      _mindsListAt = Date.now();
      return _mindsListCache;
    })
    .catch((e) => {
      if (_mindsListCache) return _mindsListCache; // serve stale on a transient failure
      throw e;
    })
    .finally(() => {
      _mindsListInflight = null;
    });
  return _mindsListInflight;
};
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
