"use client";

import { useEffect, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import HomePage from "@/components/home/HomePage";
import { LandingPage } from "./LandingPage";

const LANDED_KEY = "feynman-landed";

// Cookie mirror of "this visitor is app-bound" (signed in, or dismissed the
// landing). Unlike localStorage it IS visible to the server, which uses it in
// app/page.tsx to decide whether `/` server-renders the full landing HTML
// (crawlers + first-time visitors) or nothing (returning users — avoids a
// landing flash before this gate picks HOME).
const HOME_COOKIE = "feynman-home";

function setHomeCookie() {
  try {
    document.cookie = `${HOME_COOKIE}=1; path=/; max-age=31536000; samesite=lax`;
  } catch {
    /* cookies blocked — the server keeps SSR-ing the landing; this gate
       still swaps to HOME after hydration, same as pre-SSR behavior */
  }
}

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
export default function HomeOrLanding({
  ssrLanding = false,
}: {
  /** Server verdict from app/page.tsx: no chat-intent params and no
   *  `feynman-home` cookie → the initial HTML should be the full landing. */
  ssrLanding?: boolean;
}) {
  const { ready, authEnabled, user } = useAuth();
  const router = useRouter();

  // Tracks the localStorage flag. `null` = not yet read (SSR / first paint).
  const [landed, setLanded] = useState<boolean | null>(null);
  // A cross-surface chat link — /?book, /?q, /?mind or /?debate — means the
  // visitor came to chat about something specific (the SEO, Reader and library
  // "Chat" CTAs route through book/q/mind; the /symposiums "Convene a symposium"
  // CTA routes through ?debate). Such a visitor must drop into the composer,
  // NEVER the marketing landing page — otherwise an anonymous arrival from
  // Google/an SEO page silently loses the intent they came for. `null` = not yet
  // read (SSR / first paint).
  const [hasChatIntent, setHasChatIntent] = useState<boolean | null>(null);

  useEffect(() => {
    try {
      setLanded(window.localStorage.getItem(LANDED_KEY) === "1");
    } catch {
      setLanded(true); // storage blocked -> behave as "already landed" (show home)
    }
    try {
      const sp = new URLSearchParams(window.location.search);
      setHasChatIntent(
        sp.has("book") || sp.has("q") || sp.has("mind") || sp.has("debate"),
      );
    } catch {
      setHasChatIntent(false);
    }
  }, []);

  // Keep the server's cookie mirror in sync: any app-bound visitor (signed in
  // or already landed) gets the cookie so their NEXT `/` load skips the SSR
  // landing. A signed-in visitor who doesn't have it yet (first visit after
  // this shipped, cleared cookies) sees the landing for one paint before the
  // gate swaps to HOME — once, then the cookie prevents it.
  useEffect(() => {
    if (ready && (user || landed)) setHomeCookie();
  }, [ready, user, landed]);

  const markLandedAndShowHome = useCallback(() => {
    try {
      window.localStorage.setItem(LANDED_KEY, "1");
    } catch {
      /* private mode — re-render still flips to home for this session */
    }
    setHomeCookie();
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

  // CTA copy mirrors the legacy ternary on window.FEYNMAN_PRO (authEnabled).
  const ctaLabel = authEnabled ? "Get Started Free" : "Start Exploring";

  // Before auth/localStorage resolve, the render depends on the SERVER's
  // verdict. When the server saw no `feynman-home` cookie and no chat-intent
  // params (ssrLanding), render the landing — this is what puts real content
  // and entity links in the initial HTML for crawlers, and it's also the
  // correct first paint for a first-time anonymous visitor (no flash: the
  // resolved gate below reaches the same answer). Otherwise render nothing
  // (a neutral blank) rather than committing to HOME — a returning visitor
  // must never see a backwards home→landing (or landing→home) flash.
  if (!ready || landed === null || hasChatIntent === null) {
    return ssrLanding ? <LandingPage ctaLabel={ctaLabel} onCta={handleCta} /> : null;
  }

  // Legacy getRoute() (app.js 679-684):
  //   authEnabled  -> landing whenever there's no signed-in user
  //   !authEnabled -> landing once, until the visitor dismisses it (feynman-landed)
  // A cross-surface chat link overrides both: honor the book/question intent and
  // open the composer regardless of auth (HomeComposer gates anonymous SEND to
  // login from there, so the intent survives sign-up instead of being lost here).
  const showLanding = !hasChatIntent && (authEnabled ? !user : !landed);
  if (showLanding) {
    return <LandingPage ctaLabel={ctaLabel} onCta={handleCta} />;
  }

  return <HomePage />;
}
