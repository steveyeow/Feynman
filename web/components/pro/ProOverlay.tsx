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
import { useIsProUser } from "@/lib/pro";
import { track } from "@/lib/analytics";
import { useAuth } from "@/lib/auth";
import PlanCards from "@/components/subscription/PlanCards";
import styles from "./ProOverlay.module.css";

interface ProOverlayContextValue {
  showProOverlay: (source?: string) => void;
  hideProOverlay: () => void;
}

const ProOverlayContext = createContext<ProOverlayContextValue | null>(null);

export function ProOverlayProvider({ children }: { children: React.ReactNode }) {
  const { isPro } = useAuth();
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false); // drives the fade-in transition

  const showProOverlay = useCallback(() => {
    track("upgrade_prompt_shown", { tier: isPro ? "pro" : "free" });
    setOpen(true);
  }, [isPro]);

  const hideProOverlay = useCallback(() => setOpen(false), []);

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

  const requirePro = useCallback(
    (action?: () => void): boolean => {
      if (isProUser) {
        action?.();
        return true;
      }
      showProOverlay();
      return false;
    },
    [isProUser, showProOverlay],
  );

  return { isProUser, requirePro, showProOverlay };
}
