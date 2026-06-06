"use client";

import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { Session, SupabaseClient, User } from "@supabase/supabase-js";
import { getProConfig, type ProConfig } from "@/lib/config";
import { initSupabase } from "@/lib/supabase";
import { get, setAuthToken, setTokenRefreshHandler } from "@/lib/api";

interface AuthContextValue {
  ready: boolean;
  /** Auth system is configured (legacy window.FEYNMAN_PRO). */
  authEnabled: boolean;
  user: User | null;
  /** Subscription tier is pro. */
  isPro: boolean;
  /** A definitive tier answer has resolved (lets the UI avoid a "Free" flash). */
  tierKnown: boolean;
  config: ProConfig | null;
  signInWithPassword: (email: string, password: string) => Promise<{ error: string | null }>;
  signUp: (email: string, password: string) => Promise<{ error: string | null }>;
  signInWithOAuth: (provider: "google") => Promise<void>;
  signOut: () => Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within <AuthProvider>");
  return ctx;
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);
  const [authEnabled, setAuthEnabled] = useState(false);
  const [user, setUser] = useState<User | null>(null);
  const [isPro, setIsPro] = useState(false);
  // Whether we have a DEFINITIVE tier answer yet (a successful subscription
  // fetch, or a signed-out user). The UI hides the Free/Pro badge until this is
  // true, so a Pro user never flashes "Free" before the tier resolves.
  const [tierKnown, setTierKnown] = useState(false);
  const [config, setConfig] = useState<ProConfig | null>(null);
  const clientRef = useRef<SupabaseClient | null>(null);
  // The signed-in identity we last fetched the tier for. onAuthStateChange fires
  // applySession on every TOKEN_REFRESHED; without this guard each fire re-ran an
  // authed GET that, if it raced the token, hard-reset a Pro user to Free.
  const lastTierUserRef = useRef<string | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    const applySession = (session: Session | null) => {
      const u = session?.user ?? null;
      setUser(u);
      setAuthToken(session?.access_token ?? null);
      if (u) {
        // Fetch the tier only when the identity actually changes — not on every
        // token refresh.
        if (lastTierUserRef.current !== u.id) {
          lastTierUserRef.current = u.id;
          setTierKnown(false);
          get<{ tier?: string }>("/api/pro/subscription")
            .then((s) => {
              setIsPro((s?.tier || "free") === "pro");
              setTierKnown(true);
            })
            .catch(() => {
              // Transient failure (e.g. a token that raced the request): do NOT
              // downgrade a Pro user to Free. Leave the tier unresolved so the
              // badge stays hidden rather than showing a wrong "Free" — api.ts's
              // refresh+retry makes this path rare, and a later auth event re-runs
              // the fetch.
              lastTierUserRef.current = null;
            });
        }
      } else {
        lastTierUserRef.current = null;
        setIsPro(false);
        setTierKnown(true);
      }
    };

    (async () => {
      const cfg = await getProConfig();
      setConfig(cfg);
      if (cfg.auth_enabled && cfg.supabase_url && cfg.supabase_key) {
        setAuthEnabled(true);
        const client = initSupabase(cfg.supabase_url, cfg.supabase_key);
        clientRef.current = client;
        if (client) {
          const {
            data: { session },
          } = await client.auth.getSession();
          applySession(session);
          const { data: sub } = client.auth.onAuthStateChange((_event, s) => applySession(s));
          unsub = () => sub.subscription.unsubscribe();
          // Let api.ts refresh + retry a raced 401 (token_expired/invalid_token):
          // refresh the Supabase session, apply it, and return the new token.
          setTokenRefreshHandler(async () => {
            const c = clientRef.current;
            if (!c) return null;
            try {
              const {
                data: { session: refreshed },
              } = await c.auth.refreshSession();
              if (refreshed) {
                applySession(refreshed);
                return refreshed.access_token;
              }
            } catch {
              /* refresh failed */
            }
            return null;
          });
        }
      }
      setReady(true);
    })();

    return () => {
      unsub?.();
      setTokenRefreshHandler(null);
    };
  }, []);

  const signInWithPassword = useCallback(async (email: string, password: string) => {
    const client = clientRef.current;
    if (!client) return { error: "Auth is not configured." };
    const { error } = await client.auth.signInWithPassword({ email, password });
    return { error: error?.message ?? null };
  }, []);

  const signUp = useCallback(async (email: string, password: string) => {
    const client = clientRef.current;
    if (!client) return { error: "Auth is not configured." };
    const { data, error } = await client.auth.signUp({
      email,
      password,
      options: { emailRedirectTo: window.location.origin + "/" },
    });
    if (error) return { error: error.message };
    // Supabase returns no error for an already-registered email, but with an
    // empty identities array — surface it instead of a phantom "check your
    // email" (port of app.js signUpWithEmail 315-317).
    if (data?.user?.identities?.length === 0) {
      return { error: "This email is already registered. Please sign in instead." };
    }
    return { error: null };
  }, []);

  const signInWithOAuth = useCallback(async (provider: "google") => {
    const client = clientRef.current;
    if (!client) return;
    await client.auth.signInWithOAuth({
      provider,
      options: { redirectTo: window.location.origin },
    });
  }, []);

  const signOut = useCallback(async () => {
    const client = clientRef.current;
    if (client) await client.auth.signOut();
    setUser(null);
    setIsPro(false);
    setTierKnown(true);
    lastTierUserRef.current = null;
    setAuthToken(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ ready, authEnabled, user, isPro, tierKnown, config, signInWithPassword, signUp, signInWithOAuth, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}
