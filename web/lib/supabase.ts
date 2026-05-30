import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Lazily create the Supabase browser client from runtime config (the anon key
 * comes from /api/pro/config, not the bundle). Returns null when auth is not
 * configured (e.g. local dev with ENABLE_AUTH unset) → app runs anonymous.
 */
let _client: SupabaseClient | null = null;

export function initSupabase(url: string, key: string): SupabaseClient | null {
  if (_client) return _client;
  if (!url || !key) return null;
  _client = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
  });
  return _client;
}

export function getSupabaseClient(): SupabaseClient | null {
  return _client;
}
