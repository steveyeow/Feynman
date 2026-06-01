"use client";

import { Suspense } from "react";
import { AuthProvider } from "@/lib/auth";
import { ProOverlayProvider } from "@/components/pro/ProOverlay";
import AnalyticsBridge from "./AnalyticsBridge";
import GreetingLogoSwap from "./GreetingLogoSwap";

/**
 * Single client-side provider tree, mounted once by the (server) root layout.
 * Keeps auth/session state app-wide so any client component can useAuth(), and
 * mounts the pro-paywall overlay so any component can useProGate().
 *
 * AnalyticsBridge initializes PostHog (only when a key is configured) and fires
 * page-view + identify events; it uses useSearchParams, so it sits behind a
 * Suspense boundary per the App Router contract.
 */
export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return (
    <AuthProvider>
      <ProOverlayProvider>
        <Suspense fallback={null}>
          <AnalyticsBridge />
        </Suspense>
        <GreetingLogoSwap />
        {children}
      </ProOverlayProvider>
    </AuthProvider>
  );
}
