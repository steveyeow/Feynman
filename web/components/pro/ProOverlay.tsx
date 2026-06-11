"use client";

/**
 * Pro paywall overlay + the gate hook used everywhere a pro feature is invoked.
 *
 * Port of showProOverlay (app.js ~577-661): a glass modal showing the same plan
 * cards as the Subscription page, with "Upgrade to Pro" (→ checkout) and a close
 * affordance ("Maybe later"). Mounted once via ProOverlayProvider in
 * ClientProviders so any component can call showProOverlay().
 *
 * useProGate() returns { isProUser, requirePro, showProOverlay }:
 *   - isProUser    — the open-source/hosted gate result (see lib/pro.ts).
 *   - requirePro(action?) — if isProUser, runs action and returns true; else
 *                   shows the overlay and returns false. This is the faithful
 *                   port of the legacy `if (!isProUser()) { showProOverlay(); return; }`
 *                   pattern: anonymous (auth-on) users see the overlay, whose
 *                   Upgrade button bounces them to /login. Call sites that need
 *                   a *different* anonymous path (save pending intent → login,
 *                   e.g. the Reader) handle the !user branch themselves before
 *                   calling requirePro.
 *
 * Open-source build (authEnabled=false): isProUser is always true, so requirePro
 * always runs the action and the overlay never appears.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { useRouter } from "next/navigation";
import { useIsProUser } from "@/lib/pro";
import { track } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import { setQuotaHandler, setAuthRequiredHandler } from "@/lib/api";
import PlanCards from "@/components/subscription/PlanCards";
import styles from "./ProOverlay.module.css";

interface ProOverlayContextValue {
  showProOverlay: (source?: string) => void;
  hideProOverlay: () => void;
}

const ProOverlayContext = createContext<ProOverlayContextValue | null>(null);

export function ProOverlayProvider({ children }: { children: React.ReactNode }) {
  const { isPro } = useAuth();
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false); // drives the fade-in transition

  const showProOverlay = useCallback(() => {
    track("upgrade_prompt_shown", { tier: isPro ? "pro" : "free" });
    setOpen(true);
  }, [isPro]);

  const hideProOverlay = useCallback(() => setOpen(false), []);

  // Wire the non-React api.ts interceptors (ports app.js api() 429/401):
  //   429 quota_exceeded/upload_limit_reached → quota_hit analytics + upgrade
  //   overlay (except generate_mind, which production excludes); 401
  //   auth_required → bounce to /login.
  useEffect(() => {
    setQuotaHandler(({ action, limit, used, tier }) => {
      // Match production's quota_hit schema exactly (action/limit/used/tier) so
      // PostHog paywall funnels keyed on those keep working (M17, app.js 1747).
      track("quota_hit", { action, limit, used, tier });
      if (action !== "generate_mind") {
        track("upgrade_prompt_shown", { tier: isPro ? "pro" : "free" });
        setOpen(true);
      }
    });
    setAuthRequiredHandler(() => {
      router.push("/login");
    });
    return () => {
      setQuotaHandler(null);
      setAuthRequiredHandler(null);
    };
  }, [isPro, router]);

  // Fade in on next frame after mount (mirrors the legacy rAF → .visible).
  useEffect(() => {
    if (!open) {
      setVisible(false);
      return;
    }
    const raf = requestAnimationFrame(() => setVisible(true));
    return () => cancelAnimationFrame(raf);
  }, [open]);

  // Close on Escape.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

  return (
    <ProOverlayContext.Provider value={{ showProOverlay, hideProOverlay }}>
      {children}
      {open && (
        <div
          className={`pro-overlay${visible ? " visible" : ""} ${styles.overlay}`}
          onClick={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <div className="pro-overlay-inner">
            <button
              type="button"
              className="pro-overlay-close"
              title="Maybe later"
              aria-label="Close"
              onClick={() => setOpen(false)}
            >
              ×
            </button>
            <PlanCards source="overlay" onAfterCheckout={() => setOpen(false)} />
          </div>
        </div>
      )}
    </ProOverlayContext.Provider>
  );
}

function useProOverlay(): ProOverlayContextValue {
  const ctx = useContext(ProOverlayContext);
  if (!ctx) throw new Error("useProOverlay must be used within <ProOverlayProvider>");
  return ctx;
}

export interface ProGate {
  /** True when the user has pro features (open-source → always true). */
  isProUser: boolean;
  /**
   * Gate a pro action. If the user is pro (or auth is off), runs `action` (if
   * given) and returns true. Otherwise shows the upgrade overlay and returns
   * false — the caller should bail out of the gated action.
   */
  requirePro: (action?: () => void) => boolean;
  /** Imperatively open the upgrade overlay. */
  showProOverlay: (source?: string) => void;
}

export function useProGate(): ProGate {
  const isProUser = useIsProUser();
  const { showProOverlay } = useProOverlay();
  const { authEnabled, user } = useAuth();
  const router = useRouter();

  const requirePro = useCallback(
    (action?: () => void): boolean => {
      if (isProUser) {
        action?.();
        return true;
      }
      // Gate ORDER: an anonymous visitor must be sent to sign-in, never shown
      // the paywall — a plans modal means nothing without an account, and
      // closing it stranded people on /login anyway (the reported bug). Only
      // a signed-in free user sees the upgrade overlay.
      if (authEnabled && !user) {
        const next =
          typeof window !== "undefined"
            ? window.location.pathname + window.location.search
            : "/";
        router.push(`/login?next=${encodeURIComponent(next)}`);
        return false;
      }
      showProOverlay();
      return false;
    },
    [isProUser, authEnabled, user, router, showProOverlay],
  );

  return { isProUser, requirePro, showProOverlay };
}
