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
  }
}

// ── Quota / auth interceptors ───────────────────────────────────────────
// api.ts is not a React module, so the overlay trigger, analytics, and login
// redirect are injected by the app shell (ProOverlay provider) at mount. This
// ports app.js's api() 429/401 handling: a daily-limit 429 opens the upgrade
// overlay (the ONLY way the paywall surfaces on the hosted build); a 401
// auth_required bounces to login.
type QuotaHandler = (info: { action: string; code: string; message?: string }) => void;
let _onQuota: QuotaHandler | null = null;
let _onAuthRequired: (() => void) | null = null;
export function setQuotaHandler(fn: QuotaHandler | null) {
  _onQuota = fn;
}
export function setAuthRequiredHandler(fn: (() => void) | null) {
  _onAuthRequired = fn;
}

export async function apiFetch<T = unknown>(
  path: string,
  opts: RequestInit & { auth?: boolean } = {},
): Promise<T> {
  const base = isServer ? SSR_BASE : "";
  const headers = new Headers(opts.headers || {});
  if (!headers.has("Content-Type") && opts.body && typeof opts.body === "string") {
    headers.set("Content-Type", "application/json");
  }
  if (opts.auth !== false && _authToken) {
    headers.set("Authorization", `Bearer ${_authToken}`);
  }
  const res = await fetch(`${base}${path}`, { ...opts, headers });
  if (!res.ok) {
    let body: unknown = null;
    try {
      body = await res.json();
    } catch {
      /* non-JSON error body */
    }
    const err = new ApiError(res.status, `API ${res.status} on ${path}`, body);
    // Browser-only interceptors (ports app.js api() 429/401 handling).
    if (!isServer) {
      if (res.status === 429 && (err.code === "quota_exceeded" || err.code === "upload_limit_reached")) {
        const action = (body as { detail?: { action?: string } } | null)?.detail?.action || "";
        _onQuota?.({ action, code: err.code, message: err.detailMessage });
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
export const listMinds = () => get<Mind[]>("/api/minds");
export const getMind = (id: string) => get<Mind>(`/api/minds/${encodeURIComponent(id)}`);
export const listTopics = () =>
  get<{ topics?: string[] } | string[]>("/api/topics").then((r) =>
    Array.isArray(r) ? r : r.topics || [],
  );
