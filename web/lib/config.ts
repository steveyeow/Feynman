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

let _cfg: ProConfig | null = null;
let _inflight: Promise<ProConfig> | null = null;

/** Fetch once, memoized. Falls back to auth-off config if the API is down. */
export async function getProConfig(): Promise<ProConfig> {
  if (_cfg) return _cfg;
  if (!_inflight) {
    _inflight = get<ProConfig>("/api/pro/config")
      .then((c) => (_cfg = { ...EMPTY, ...c }))
      .catch(() => (_cfg = EMPTY));
  }
  return _inflight;
}
