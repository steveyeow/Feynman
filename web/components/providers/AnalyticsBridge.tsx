"use client";

/**
 * Wires PostHog into the app lifecycle. Mounted once inside AuthProvider so it
 * can read config (the posthog_key) + the current user.
 *
 *  - Initializes PostHog after config loads, ONLY if a key is present (the
 *    open-source build has none → analytics stays completely off, bundle never
 *    loaded). See lib/analytics.ts.
 *  - identify(user) + track('signed_up') when a user authenticates this session
 *    (port of the SIGNED_IN handler in app.js ~212-214). Fires once per
 *    null→user transition.
 *  - $pageview on every route change (capture_pageview is off in init, matching
 *    the legacy which fired $pageview manually in its router — app.js 1704).
 *
 * The `ready` state flips true once the async init resolves, so the identify +
 * initial-pageview effects re-run after PostHog actually loads (rather than
 * silently no-op'ing on first paint while the bundle is still fetching).
 *
 * Renders nothing.
 */

import { useEffect, useRef, useState } from "react";
import { usePathname, useSearchParams } from "next/navigation";
import { useAuth } from "@/lib/auth";
import { initAnalytics, identify, track } from "@/lib/analytics";

export default function AnalyticsBridge() {
  const { config, user, isPro } = useAuth();
  const pathname = usePathname();
  const search = useSearchParams();
  const prevUserId = useRef<string | null>(null);
  const [ready, setReady] = useState(false);

  // ── Init once config (and thus the key) is available ──
  useEffect(() => {
    let alive = true;
    if (config?.posthog_key) {
      void initAnalytics(config.posthog_key).then(() => {
        if (alive) setReady(true);
      });
    }
    return () => {
      alive = false;
    };
  }, [config?.posthog_key]);

  // ── Identify + signed_up on first authentication of the session ──
  useEffect(() => {
    if (!ready) return;
    const id = user?.id ?? null;
    if (id && id !== prevUserId.current) {
      identify(id, { email: user?.email, tier: isPro ? "pro" : "free" });
      // The new auth layer doesn't surface the raw SIGNED_IN event; firing on
      // the null→user transition captures fresh sign-up/sign-in this session.
      if (prevUserId.current === null) {
        const provider =
          (user?.app_metadata?.provider as string | undefined) || "email";
        track("signed_up", { method: provider });
      }
    }
    prevUserId.current = id;
  }, [ready, user, isPro]);

  // ── $pageview on route change (and once on init) ──
  // Depend on the serialized query string (not the URLSearchParams object,
  // whose identity can change every render) so we fire exactly once per URL.
  const qs = search?.toString() ?? "";
  useEffect(() => {
    if (!ready) return;
    track("$pageview", { path: qs ? `${pathname}?${qs}` : pathname });
  }, [ready, pathname, qs]);

  return null;
}
