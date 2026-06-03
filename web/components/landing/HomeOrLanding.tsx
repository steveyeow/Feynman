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
  const { ready, authEnabled, user } = useAuth();
  const router = useRouter();

  // Tracks the localStorage flag. `null` = not yet read (SSR / first paint).
  const [landed, setLanded] = useState<boolean | null>(null);
  // A cross-surface chat intent (/?book= /?q= /?mind=) must BYPASS the marketing
  // landing gate for signed-out visitors. Otherwise a search visitor who clicks
  // "Chat with this book" lands on the marketing page and the book is silently
  // dropped — they then see an empty New Chat. With the override they drop
  // straight into the composer with the entity preselected (anonymous chat).
  const [chatIntent, setChatIntent] = useState(false);

  useEffect(() => {
    try {
      setLanded(window.localStorage.getItem(LANDED_KEY) === "1");
    } catch {
      setLanded(true); // storage blocked -> behave as "already landed" (show home)
    }
    try {
      const sp = new URLSearchParams(window.location.search);
      setChatIntent(sp.has("book") || sp.has("q") || sp.has("mind"));
    } catch {
      /* no/blocked search params -> not a chat intent */
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
  // Keyed on authEnabled (the FEYNMAN_PRO mirror), NOT isPro: on the hosted
  // build a signed-out visitor must go to /login; on the open-source build we
  // just remember the visit and drop into the app.
  const handleCta = useCallback(() => {
    if (authEnabled) {
      if (user) markLandedAndShowHome();
      else router.push("/login");
    } else {
      markLandedAndShowHome();
    }
  }, [authEnabled, user, router, markLandedAndShowHome]);

  // Before auth/localStorage resolve, render nothing (a neutral blank) rather
  // than committing to HOME — otherwise a first-time anonymous visitor on the
  // hosted build briefly sees the app home, then it swaps to the landing
  // (a backwards flash). Rendering null until `ready` avoids that while still
  // never flashing the landing to returning/auth'd users.
  if (!ready || landed === null) {
    return null;
  }

  // Legacy getRoute() (app.js 679-684):
  //   authEnabled  -> landing whenever there's no signed-in user
  //   !authEnabled -> landing once, until the visitor dismisses it (feynman-landed)
  const showLanding = (authEnabled ? !user : !landed) && !chatIntent;
  if (showLanding) {
    // CTA copy mirrors the legacy ternary on window.FEYNMAN_PRO (authEnabled).
    const ctaLabel = authEnabled ? "Get Started Free" : "Start Exploring";
    return <LandingPage ctaLabel={ctaLabel} onCta={handleCta} />;
  }

  return <HomePage />;
}
