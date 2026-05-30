"use client";

import { AuthProvider } from "@/lib/auth";

/**
 * Single client-side provider tree, mounted once by the (server) root layout.
 * Keeps auth/session state app-wide so any client component can useAuth().
 */
export default function ClientProviders({ children }: { children: React.ReactNode }) {
  return <AuthProvider>{children}</AuthProvider>;
}
