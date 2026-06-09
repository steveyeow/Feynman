import { get } from "@/lib/api";

/** Public frontend config from FastAPI (safe to expose). Mirrors /api/pro/config. */
export interface ProConfig {
  auth_enabled: boolean;
  supabase_url: string;
  supabase_key: string;
  stripe_enabled: boolean;
  posthog_key: string;
}

const EMPTY: ProConfig = {
  auth_enabled: false,
  supabase_url: "",
  supabase_key: "",
  stripe_enabled: false,
  posthog_key: "",
};

// Persist the LAST KNOWN-GOOD (auth-enabled) config. This config is static per
// deployment and GATES auth detection: if a transient /api/pro/config failure is
// treated as "auth off", a signed-in user silently renders as "Guest" and their
// authed chats load nothing (the bug this guards against). The supabase url/key
// are the public anon values the client already ships, so caching them is safe.
const LS_KEY = "feynman:pro-config";

function isUsable(c: Partial<ProConfig> | null | undefined): c is ProConfig {
  return !!(c && c.auth_enabled && c.supabase_url && c.supabase_key);
}

function readGoodConfig(): ProConfig | null {
  if (typeof localStorage === "undefined") return null;
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Partial<ProConfig>;
    return isUsable(c) ? { ...EMPTY, ...c } : null;
  } catch {
    return null;
  }
}

function saveGoodConfig(c: ProConfig): void {
  if (typeof localStorage === "undefined" || !isUsable(c)) return;
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(c));
  } catch {
    /* storage blocked/full — non-fatal */
  }
}

let _cfg: ProConfig | null = null;
let _inflight: Promise<ProConfig> | null = null;

/** One network fetch. Memoizes + persists on success; returns null on failure. */
async function fetchFresh(): Promise<ProConfig | null> {
  try {
    const c = await get<ProConfig>("/api/pro/config");
    const merged = { ...EMPTY, ...c };
    saveGoodConfig(merged);
    _cfg = merged;
    return merged;
  } catch {
    return null;
  }
}

/**
 * Public frontend config, resolved robustly so a transient failure can never
 * silently disable auth (which strands a signed-in user as "Guest").
 *
 * - Cache-first: a previously-confirmed (auth-enabled) config makes `authEnabled`
 *   correct on the FIRST paint even if the network is slow/down, and revalidates
 *   in the background.
 * - No cache (first load / open-source auth-off): fetch with one retry; on total
 *   failure return EMPTY but do NOT memoize it, so the next call/load retries
 *   instead of being stuck signed-out.
 */
export async function getProConfig(): Promise<ProConfig> {
  if (_cfg) return _cfg;

  const cached = readGoodConfig();
  if (cached) {
    _cfg = cached;
    void fetchFresh(); // background revalidate (best-effort; never rejects)
    return _cfg;
  }

  if (!_inflight) {
    _inflight = (async () => {
      for (let attempt = 0; attempt < 2; attempt++) {
        const fresh = await fetchFresh();
        if (fresh) return fresh;
        if (attempt === 0) await new Promise((r) => setTimeout(r, 400));
      }
      _inflight = null; // don't memoize an auth-off failure → allow a retry
      return EMPTY;
    })();
  }
  return _inflight;
}
