"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

/**
 * Faithful restore of the pre-rewrite production login/sign-up card: pixel-art
 * brand mark, Google-first OAuth, a collapsible "or sign in with email" section,
 * a secondary submit, and a "← Back" link. Reuses the legacy `.login-*` classes
 * (present verbatim in app.css) so the layout matches production 1:1; liquid.css
 * re-skins the card itself as frosted Liquid Glass.
 */
export default function LoginForm() {
  const { ready, authEnabled, signInWithPassword, signUp, signInWithOAuth } = useAuth();
  const router = useRouter();
  const [isSignUp, setIsSignUp] = useState(false);
  const [emailOpen, setEmailOpen] = useState(true);
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [agreed, setAgreed] = useState(false);
  const [error, setError] = useState("");
  const [success, setSuccess] = useState("");
  const [busy, setBusy] = useState(false);
  const [googleBusy, setGoogleBusy] = useState(false);

  function toggleMode() {
    setIsSignUp((v) => !v);
    setEmailOpen(true);
    setAgreed(false);
    setError("");
    setSuccess("");
  }

  async function onGoogle() {
    setError("");
    if (ready && !authEnabled) {
      setError("Authentication is not configured.");
      return;
    }
    // OAuth redirects away on success, so only clear busy on error — the button
    // stays "Connecting…" until the navigation happens.
    setGoogleBusy(true);
    try {
      await signInWithOAuth("google");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
      setGoogleBusy(false);
    }
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const mail = email.trim();
    if (!mail || !password) return;
    if (ready && !authEnabled) {
      setError("Authentication is not configured.");
      return;
    }
    if (isSignUp && !agreed) {
      setError("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }
    setError("");
    setSuccess("");
    setBusy(true);
    const fn = isSignUp ? signUp : signInWithPassword;
    const { error } = await fn(mail, password);
    setBusy(false);
    if (error) {
      setError(error);
      return;
    }
    if (isSignUp) {
      setSuccess("Check your email to confirm your account, then sign in.");
      setIsSignUp(false);
      setAgreed(false);
      return;
    }
    // Honor a same-site ?next= return path (e.g. "Continue this conversation"
    // bounces here when signed out). Guard against open redirects.
    const next =
      typeof window !== "undefined"
        ? new URLSearchParams(window.location.search).get("next")
        : null;
    router.push(next && next.startsWith("/") && !next.startsWith("//") ? next : "/");
  }

  return (
    <div className="login-container">
      <div className="login-card">
        <div className="login-brand">
          <div className="greeting-logo-wrap" style={{ width: 40, height: 40 }}>
            <svg
              className="greeting-logo"
              width="40"
              height="40"
              viewBox="0 0 56 56"
              xmlns="http://www.w3.org/2000/svg"
              shapeRendering="crispEdges"
            >
              <rect x="24" y="0" width="8" height="4" fill="#FDCB6E" />
              <rect x="26" y="4" width="4" height="4" fill="#B8B8B8" />
              <rect x="8" y="8" width="40" height="28" fill="#DA7756" />
              <rect x="12" y="12" width="32" height="20" fill="#FFF1E0" />
              <rect x="16" y="16" width="8" height="8" fill="#2D3436" />
              <rect x="32" y="16" width="8" height="8" fill="#2D3436" />
              <rect x="18" y="18" width="4" height="4" fill="#fff" />
              <rect x="34" y="18" width="4" height="4" fill="#fff" />
              <rect x="22" y="28" width="12" height="2" fill="#C45E3E" />
              <rect x="18" y="38" width="4" height="8" fill="#B8B8B8" />
              <rect x="34" y="38" width="4" height="8" fill="#B8B8B8" />
            </svg>
            <svg
              className="greeting-feynman-logo"
              width="40"
              height="40"
              viewBox="0 0 64 64"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="32" cy="30" r="3.5" fill="currentColor" />
              <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </div>
        </div>

        <h1 className="login-welcome">
          Welcome to <span className="login-welcome-brand">Feynman</span>
        </h1>
        <p className="login-subtitle">
          An interactive knowledge network of books, minds, and ideas.
        </p>

        <button type="button" className="login-google" onClick={onGoogle} disabled={googleBusy}>
          <svg width="20" height="20" viewBox="0 0 24 24">
            <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92a5.06 5.06 0 0 1-2.2 3.32v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.1z" fill="#4285F4" />
            <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
            <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18A10.96 10.96 0 0 0 1 12c0 1.77.42 3.45 1.18 4.93l3.66-2.84z" fill="#FBBC05" />
            <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
          </svg>
          {googleBusy ? "Connecting…" : "Continue with Google"}
        </button>
        <p className="login-oauth-terms">
          By continuing, you agree to our{" "}
          <a href="/terms" target="_blank" rel="noopener noreferrer">
            Terms
          </a>{" "}
          and{" "}
          <a href="/privacy" target="_blank" rel="noopener noreferrer">
            Privacy&nbsp;Policy
          </a>
          .
        </p>

        {error && <div className="auth-error">{error}</div>}
        {success && <div className="auth-success">{success}</div>}

        <div
          className="login-divider"
          style={{ cursor: "pointer" }}
          onClick={() => setEmailOpen((v) => !v)}
        >
          <span>or sign in with email</span>
        </div>

        <div className={`login-email-section${emailOpen ? "" : " login-email-collapsed"}`}>
          <form className="login-form" onSubmit={onSubmit}>
            <div className="login-field">
              <input
                className="login-input"
                type="email"
                placeholder="Email address"
                required
                autoComplete="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </div>
            <div className="login-field">
              <input
                className="login-input"
                type="password"
                placeholder="Password"
                required
                minLength={6}
                autoComplete={isSignUp ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
            {isSignUp && (
              <label className="login-terms">
                <input
                  type="checkbox"
                  checked={agreed}
                  onChange={(e) => setAgreed(e.target.checked)}
                />
                <span>
                  I agree to the{" "}
                  <a href="/terms" target="_blank" rel="noopener noreferrer">
                    Terms of Service
                  </a>{" "}
                  and{" "}
                  <a href="/privacy" target="_blank" rel="noopener noreferrer">
                    Privacy Policy
                  </a>
                </span>
              </label>
            )}
            <button
              type="submit"
              className="login-submit login-submit-secondary"
              disabled={busy}
            >
              {busy
                ? isSignUp
                  ? "Creating account..."
                  : "Signing in..."
                : isSignUp
                  ? "Create account"
                  : "Sign in"}
            </button>
          </form>
          <p className="login-toggle">
            <span>{isSignUp ? "Already have an account?" : "Don't have an account?"}</span>{" "}
            <a role="button" tabIndex={0} style={{ cursor: "pointer" }} onClick={toggleMode}>
              {isSignUp ? "Sign in" : "Sign up"}
            </a>
          </p>
        </div>
      </div>

      <a href="/" className="login-back">
        &larr; Back
      </a>
    </div>
  );
}
