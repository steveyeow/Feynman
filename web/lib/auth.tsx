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
  const [config, setConfig] = useState<ProConfig | null>(null);
  const clientRef = useRef<SupabaseClient | null>(null);

  useEffect(() => {
    let unsub: (() => void) | undefined;

    const applySession = (session: Session | null) => {
      setUser(session?.user ?? null);
      setAuthToken(session?.access_token ?? null);
      if (session?.user) {
        // Best-effort tier lookup; ignore failures (endpoint requires auth).
        get<{ tier?: string }>("/api/pro/subscription")
          .then((s) => setIsPro((s?.tier || "free") === "pro"))
          .catch(() => setIsPro(false));
      } else {
        setIsPro(false);
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
    setAuthToken(null);
  }, []);

  return (
    <AuthContext.Provider
      value={{ ready, authEnabled, user, isPro, config, signInWithPassword, signUp, signInWithOAuth, signOut }}
    >
      {children}
    </AuthContext.Provider>
  );
}
