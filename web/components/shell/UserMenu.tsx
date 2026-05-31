"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useAuth } from "@/lib/auth";
import ThemeToggle from "@/components/theme/ThemeToggle";

/**
 * Sidebar account area. Shows the signed-in user + a menu (theme, sign out)
 * when auth is configured; a "Sign in" link when configured but signed out;
 * and just the theme toggle in anonymous mode (auth off, e.g. local dev).
 */
export default function UserMenu() {
  const { authEnabled, user } = useAuth();
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const email = user?.email ?? "";
  const initial = email ? email[0]!.toUpperCase() : "";
  const label = email || (authEnabled ? "Account" : "Guest");

  return (
    <div className="sidebar-user-wrap" ref={wrapRef}>
      <div
        className="sidebar-profile"
        title="Account"
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
      >
        <div className="profile-avatar">
          {initial || (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          )}
        </div>
        <span className="sidebar-label profile-email">{label}</span>
        <svg className="sidebar-label profile-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Production structure: .sidebar-user-menu (.open) with header + divider
          + .user-menu-item rows. Positioned above the profile, bottom-left. */}
      <div className={`sidebar-user-menu${open ? " open" : ""}`} style={{ left: 12, bottom: 60, right: 12 }}>
        <div className="user-menu-header">
          <span className="user-menu-name">{authEnabled && user ? "Signed in" : "Guest"}</span>
          {email && <span className="user-menu-email">{email}</span>}
        </div>
        <div className="user-menu-divider" />
        <button type="button" className="user-menu-item" onClick={(e) => e.stopPropagation()}>
          <span>Theme</span>
          <span style={{ marginLeft: "auto" }}><ThemeToggle /></span>
        </button>
        {authEnabled && user && (
          <Link className="user-menu-item" href="/subscription" onClick={() => setOpen(false)}>
            Subscription
          </Link>
        )}
        {authEnabled && user && <SignOutItem onDone={() => setOpen(false)} />}
        {authEnabled && !user && (
          <Link className="user-menu-item" href="/login" onClick={() => setOpen(false)}>
            Sign in
          </Link>
        )}
      </div>
    </div>
  );
}

function SignOutItem({ onDone }: { onDone: () => void }) {
  const { signOut } = useAuth();
  return (
    <button
      type="button"
      className="user-menu-item user-menu-signout"
      onClick={async () => {
        onDone();
        await signOut();
      }}
    >
      Sign out
    </button>
  );
}
