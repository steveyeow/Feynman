"use client";

/**
 * The Free + Pro plan cards. Shared verbatim between the full Subscription page
 * and the ProOverlay modal (legacy renderSubscriptionPage / showProOverlay both
 * rendered the same card markup). Feature bullets are copied VERBATIM from
 * app.js lines 476-493.
 *
 * Reuses the legacy .sub-* classes (already present in styles/app.css), so this
 * component adds no styling — only behavior + state.
 */

import { useEffect, useState } from "react";
import { get, post } from "@/lib/api";
import { useAuth } from "@/lib/auth";
import { track } from "@/lib/analytics";

export const FREE_FEATURES = [
  "Chat with any book in your library",
  "Answers rooted in the book — and beyond, with broader relevant context",
  "Great minds join your first chats",
  "Discover books & topics (3/day)",
  "Upload up to 3 books (PDF / EPUB / TXT / MD)",
];

export const PRO_FEATURES = [
  "Everything in Free",
  "Upload more books",
  "Discover more books in chat & library",
  "Write the book you need — on-demand, on any topic",
  "Great minds continuously join chats",
  "Invite great minds into your chats",
  "Upload your own minds or from any source",
  "Discover & expand the minds network",
  "Higher daily usage limits",
  "Priority access",
];

interface SubscriptionState {
  tier: string;
  email?: string;
  subscription: {
    status?: string;
    current_period_end?: number;
    cancel_at_period_end?: boolean;
  } | null;
}

function FeatureRow({ text, pro }: { text: string; pro?: boolean }) {
  return (
    <div className="sub-feature-row">
      <span className={`sub-feature-check${pro ? " pro-check" : ""}`}>✓</span>
      <span className="sub-feature-label">{text}</span>
    </div>
  );
}

/**
 * @param source analytics tag for upgrade_clicked ("subscription_page" | "overlay")
 * @param onAfterCheckout optional callback fired right before the checkout
 *        redirect (the overlay uses it to close itself first).
 */
export default function PlanCards({
  source,
  onAfterCheckout,
}: {
  source: "subscription_page" | "overlay";
  onAfterCheckout?: () => void;
}) {
  const { user, config } = useAuth();
  const [sub, setSub] = useState<SubscriptionState | null>(null);
  const [loading, setLoading] = useState(true);
  const [redirecting, setRedirecting] = useState(false);

  useEffect(() => {
    let alive = true;
    get<SubscriptionState>("/api/pro/subscription")
      .then((s) => {
        if (alive) setSub(s);
      })
      .catch(() => {
        if (alive) setSub({ tier: "free", subscription: null });
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  if (loading) {
    return (
      <div className="sub-page">
        <div className="sub-loading">
          <span className="loading-dot">Loading...</span>
        </div>
      </div>
    );
  }

  const isPro = sub?.tier === "pro";
  const cancels = !!sub?.subscription?.cancel_at_period_end;

  const onUpgrade = async () => {
    // Anonymous users can't checkout — bounce to login (the overlay path also
    // closes itself first via onAfterCheckout).
    if (!user) {
      onAfterCheckout?.();
      window.location.href = "/login";
      return;
    }
    if (!config?.stripe_enabled) {
      alert("Payments are not configured on this server.");
      return;
    }
    track("upgrade_clicked", { source });
    setRedirecting(true);
    try {
      const data = await post<{ url?: string }>("/api/pro/create-checkout-session");
      if (data.url) {
        onAfterCheckout?.();
        window.location.href = data.url;
      } else {
        setRedirecting(false);
      }
    } catch (err) {
      alert("Checkout failed: " + (err instanceof Error ? err.message : "Unknown error"));
      setRedirecting(false);
    }
  };

  const onManage = async () => {
    setRedirecting(true);
    try {
      const data = await post<{ url?: string }>("/api/pro/create-portal-session");
      if (data.url) {
        onAfterCheckout?.();
        window.location.href = data.url;
      } else {
        setRedirecting(false);
      }
    } catch (err) {
      alert("Portal failed: " + (err instanceof Error ? err.message : "Unknown error"));
      setRedirecting(false);
    }
  };

  return (
    <div className="sub-page">
      <div className="sub-header">
        <h1 className="sub-title">Plans</h1>
        <p className="sub-subtitle">
          Read smarter. Think deeper.
          <br />
          Learn with the greatest minds in history and today&apos;s world.
        </p>
      </div>
      <div className="sub-cards">
        {/* Free */}
        <div className={`sub-card${!isPro ? " sub-card-active" : ""}`}>
          <div className="sub-card-head">
            <div className="sub-plan-name">
              <span>Free</span>
              {!isPro && <span className="sub-badge">Current</span>}
            </div>
            <div className="sub-price">
              $0<span>/mo</span>
            </div>
            <p className="sub-price-note">Get started, no credit card needed</p>
          </div>
          <div className="sub-card-body">
            {FREE_FEATURES.map((f) => (
              <FeatureRow key={f} text={f} />
            ))}
          </div>
          {!isPro && (
            <div className="sub-card-foot">
              <button className="sub-btn sub-btn-secondary" disabled>
                Current Plan
              </button>
            </div>
          )}
        </div>

        {/* Pro */}
        <div className={`sub-card sub-card-pro${isPro ? " sub-card-active" : ""}`}>
          <div className="sub-card-head">
            <div className="sub-plan-name">
              <span>Pro</span>
              {isPro && <span className="sub-badge sub-badge-pro">Current</span>}
            </div>
            <div className="sub-price">
              $9.90<span>/mo</span>
            </div>
            <p className="sub-price-note">For power users who read and learn every day</p>
          </div>
          <div className="sub-card-body">
            {PRO_FEATURES.map((f) => (
              <FeatureRow key={f} text={f} pro />
            ))}
          </div>
          <div className="sub-card-foot">
            {isPro ? (
              <>
                <button
                  className="sub-btn sub-btn-manage"
                  onClick={onManage}
                  disabled={redirecting}
                >
                  {redirecting ? "Redirecting..." : "Manage Subscription"}
                </button>
                {cancels && (
                  <p className="sub-cancel-note">Cancels at end of billing period</p>
                )}
              </>
            ) : (
              <button
                className="sub-btn sub-btn-primary"
                onClick={onUpgrade}
                disabled={redirecting}
              >
                {redirecting ? "Redirecting..." : "Upgrade to Pro"}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
