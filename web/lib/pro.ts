"use client";

/**
 * Open-source vs hosted pro-gating — the single source of truth.
 *
 * Replicates the legacy isProUser() EXACTLY:
 *
 *   function isProUser() { if (!window.FEYNMAN_PRO) return true; return userTier === 'pro'; }
 *
 * i.e. when auth is OFF (open-source self-host), EVERYONE is "pro" — every
 * feature is ungated. When auth is ON (hosted release), only tier === 'pro'
 * users get pro features.
 *
 * `authEnabled` mirrors window.FEYNMAN_PRO; `isPro` mirrors userTier === 'pro'.
 *
 * The overlay-aware gate (useProGate, requirePro) lives in
 * components/pro/ProOverlay.tsx because it depends on the overlay context.
 */

import { useAuth } from "@/lib/auth";

/** Pure helper — usable outside React (and trivially testable). */
export function computeIsProUser(authEnabled: boolean, isPro: boolean): boolean {
  return !authEnabled ? true : isPro;
}

/**
 * Hook form. Returns true when the user should have pro features:
 *  - open-source build (authEnabled=false) → always true
 *  - hosted build → only when the user's tier is pro
 */
export function useIsProUser(): boolean {
  const { authEnabled, isPro } = useAuth();
  return computeIsProUser(authEnabled, isPro);
}
