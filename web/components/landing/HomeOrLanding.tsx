"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import HomePage from "@/components/home/HomePage";
import { LandingPage } from "./LandingPage";

const LANDED_KEY = "feynman-landed";

/**
 * Decides between the marketing LANDING and the app HOME at `/`.
 *
 * Ported from the legacy SPA getRoute() (app.js lines 679-684):
 *   if (!currentUser && window.FEYNMAN_PRO) -> landing
 *   else if (!window.FEYNMAN_PRO && !localStorage['feynman-landed']) -> landing
 *   else -> home
 *
 * Here `authEnabled` is the React mirror of window.FEYNMAN_PRO (auth/Pro is
 * configured). So:
 *   - authEnabled && !user && !landed  -> LANDING
 *   - otherwise                        -> HOME
 *
 * When auth is disabled the product is anonymous (no gate) -> always HOME. We
 * wait for auth to resolve (`ready`) before deciding so a signed-in or
 * returning visitor never flashes the landing on first paint.
 */
export default function HomeOrLanding() {
  const { ready, authEnabled, user, isPro } = useAuth();
  const router = useRouter();

  // Tracks the localStorage flag. `null` = not yet read (SSR / first paint).
  const [landed, setLanded] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setLanded(window.localStorage.getItem(LANDED_KEY) === "1");
    } catch {
      setLanded(true); // storage blocked -> behave as "already landed" (show home)
    }
  }, []);

  const markLandedAndShowHome = useCallback(() => {
    try {
      window.localStorage.setItem(LANDED_KEY, "1");
    } catch {
      /* private mode — re-render still flips to home for this session */
    }
    setLanded(true);
  }, []);

  // CTA handler — ports the legacy _lpCtaHandler branch logic (app.js 938-951).
  const handleCta = useCallback(() => {
    if (isPro) {
      // Pro build: signed in -> home; signed out -> login.
      if (user) markLandedAndShowHome();
      else router.push("/login");
    } else {
      // Non-Pro: remember the visit and drop into the home.
      markLandedAndShowHome();
    }
  }, [isPro, user, router, markLandedAndShowHome]);

  // Before auth/localStorage resolve, render HOME (the default app surface).
  // Keeps the common case intact and avoids flashing the landing.
  if (!ready || landed === null) {
    return <HomePage />;
  }

  const showLanding = authEnabled && !user && !landed;
  if (showLanding) {
    // CTA copy mirrors the legacy ternary on window.FEYNMAN_PRO.
    const ctaLabel = isPro ? "Get Started Free" : "Start Exploring";
    return <LandingPage ctaLabel={ctaLabel} onCta={handleCta} />;
  }

  return <HomePage />;
}
