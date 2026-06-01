"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";
import styles from "./LoginForm.module.css";

export default function LoginForm() {
  const { ready, authEnabled, signInWithPassword, signUp, signInWithOAuth } = useAuth();
  const router = useRouter();
  const [mode, setMode] = useState<"signin" | "signup">("signin");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // Required Terms/Privacy consent on the email sign-up path (port of app.js
  // 385-388/451-453). Shown only in signup mode.
  const [agreed, setAgreed] = useState(false);

  if (ready && !authEnabled) {
    return (
      <div className={`${styles.card} lg-glass-thick`}>
        <h1 className={styles.title}>Sign in</h1>
        <p className={styles.note}>
          Accounts aren&apos;t enabled in this environment — you can use Feynman anonymously.
        </p>
      </div>
    );
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    // Block sign-up without consent (port of app.js 451-453).
    if (mode === "signup" && !agreed) {
      setError("Please agree to the Terms of Service and Privacy Policy.");
      return;
    }
    setBusy(true);
    const fn = mode === "signin" ? signInWithPassword : signUp;
    const { error } = await fn(email.trim(), password);
    setBusy(false);
    if (error) {
      setError(error);
      return;
    }
    if (mode === "signup") {
      setError("Account created — check your email to confirm, then sign in.");
      setMode("signin");
      return;
    }
    router.push("/");
  }

  return (
    <div className={`${styles.card} lg-glass-thick`}>
      <h1 className={styles.title}>
        Welcome to <span className={styles.brand}>Feynman</span>
      </h1>
      <p className={styles.sub}>Chat with books. Great minds join in.</p>
      <form onSubmit={submit} className={styles.form}>
        <input
          type="email"
          required
          placeholder="Email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          className={styles.input}
          autoComplete="email"
        />
        <input
          type="password"
          required
          minLength={6}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className={styles.input}
          autoComplete={mode === "signin" ? "current-password" : "new-password"}
        />
        {mode === "signup" && (
          <label
            style={{
              display: "flex",
              gap: 8,
              alignItems: "flex-start",
              fontSize: 12,
              lineHeight: 1.4,
              color: "var(--text-secondary)",
              textAlign: "left",
              cursor: "pointer",
            }}
          >
            <input
              type="checkbox"
              checked={agreed}
              onChange={(e) => setAgreed(e.target.checked)}
              style={{ marginTop: 2, flexShrink: 0 }}
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
              .
            </span>
          </label>
        )}
        {error && <p className={styles.error}>{error}</p>}
        <button type="submit" className={styles.primary} disabled={busy}>
          {busy ? "…" : mode === "signin" ? "Sign in" : "Create account"}
        </button>
      </form>
      <button type="button" className={styles.oauth} onClick={() => signInWithOAuth("google")}>
        Continue with Google
      </button>
      <p className={styles.switch}>
        {mode === "signin" ? "New here? " : "Have an account? "}
        <button
          type="button"
          className={styles.link}
          onClick={() => {
            setMode(mode === "signin" ? "signup" : "signin");
            setError(null);
            setAgreed(false);
          }}
        >
          {mode === "signin" ? "Create an account" : "Sign in"}
        </button>
      </p>
    </div>
  );
}
