/**
 * PostHog analytics — lazy, opt-in.
 *
 * Port of phInit / phTrack / phIdentify in app.js (~7385-7435). PostHog is only
 * loaded when the server hands us a key (config.posthog_key); on the open-source
 * self-host build there is no key, so this module is a complete no-op and the
 * posthog-js bundle is never fetched.
 *
 * init options match the legacy verbatim:
 *   api_host: 'https://us.i.posthog.com'
 *   person_profiles: 'identified_only'
 *   capture_pageview: false   (we fire $pageview manually on route change)
 *   autocapture: false
 *
 * track()/identify() are safe to call before init resolves (and forever, if no
 * key) — they no-op until the client is ready.
 */

import type { PostHog } from "posthog-js";

let _ph: PostHog | null = null;
let _initStarted = false;

/**
 * Lazy-load + init PostHog. Idempotent: safe to call repeatedly; only the first
 * call with a non-empty key does anything. No-ops (and never imports the bundle)
 * when key is falsy — preserving the open-source build's zero-analytics default.
 */
export async function initAnalytics(key: string | undefined | null): Promise<void> {
  if (!key || _initStarted || typeof window === "undefined") return;
  _initStarted = true;
  try {
    const mod = await import("posthog-js");
    const posthog = mod.default;
    posthog.init(key, {
      api_host: "https://us.i.posthog.com",
      person_profiles: "identified_only",
      capture_pageview: false,
      autocapture: false,
    });
    _ph = posthog;
  } catch (e) {
    // Network/bundle failure must never break the app — analytics stays off.
    console.warn("[analytics] PostHog init failed:", e);
    _initStarted = false;
  }
}

/** Capture an event. No-op until PostHog is initialized. */
export function track(event: string, props?: Record<string, unknown>): void {
  if (_ph) _ph.capture(event, props);
}

/** Associate the current session with a user. No-op until initialized. */
export function identify(userId: string, traits?: Record<string, unknown>): void {
  if (_ph) _ph.identify(userId, traits);
}
