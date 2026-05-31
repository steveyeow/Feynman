"use client";

/**
 * Subscription / Stripe management page. Port of renderSubscriptionPage
 * (app.js ~496-575): the Free + Pro plan cards, plus a footer with the
 * signed-in email + Sign Out (or a Sign-in CTA when signed out).
 *
 * Gating:
 *   - The whole page is only meaningful when auth is enabled. On the
 *     open-source self-host build (authEnabled=false) every feature is already
 *     included, so we show a simple note instead of plans/checkout.
 *   - The checkout/portal buttons (inside PlanCards) further gate on
 *     config.stripe_enabled, alerting "Payments are not configured on this
 *     server." when off — matching the legacy.
 *
 * Reuses the legacy .sub-* classes from styles/app.css.
 */

import Link from "next/link";
import { useAuth } from "@/lib/auth";
import PlanCards from "./PlanCards";

export default function Subscription() {
  const { ready, authEnabled, user, signOut } = useAuth();

  // Wait for config/session so we don't flash the wrong gate.
  if (!ready) {
    return (
      <div className="sub-page">
        <div className="sub-loading">
          <span className="loading-dot">Loading...</span>
        </div>
      </div>
    );
  }

  // Open-source / self-hosted: no tiers, everything is included.
  if (!authEnabled) {
    return (
      <div className="sub-page">
        <div className="sub-header">
          <h1 className="sub-title">Plans</h1>
          <p className="sub-subtitle">
            This is a self-hosted Feynman — every feature is included, with no
            account or subscription required.
          </p>
        </div>
        <div className="sub-footer">
          <Link className="sub-btn sub-btn-signin" href="/">
            Back to Feynman
          </Link>
        </div>
      </div>
    );
  }

  return (
    <>
      <PlanCards source="subscription_page" />
      <div className="sub-page" style={{ paddingTop: 0 }}>
        <div className="sub-footer">
          {user ? (
            <>
              <p className="sub-email">{user.email || ""}</p>
              <button
                type="button"
                className="sub-signout-btn"
                onClick={() => {
                  void signOut();
                }}
              >
                Sign Out
              </button>
            </>
          ) : (
            <Link className="sub-btn sub-btn-signin" href="/login">
              Sign in to manage your account
            </Link>
          )}
        </div>
      </div>
    </>
  );
}
