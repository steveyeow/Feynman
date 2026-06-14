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
  const { ready, authEnabled, user, isPro, tierKnown } = useAuth();
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

  // Production shows the user's NAME + tier (Free/Pro) in the collapsed profile,
  // NOT the email (email lives only in the expanded menu header). Derive name
  // like app.js: full_name → email prefix → "Account".
  const meta = (user?.user_metadata ?? {}) as {
    full_name?: string;
    name?: string;
    avatar_url?: string;
    picture?: string;
  };
  const email = user?.email ?? "";
  const name =
    meta.full_name || meta.name || (email ? email.split("@")[0] : "") || "Account";
  const avatarUrl = meta.avatar_url || meta.picture || "";
  const tier = isPro ? "Pro" : "Free";
  const initial = (user ? name[0] : "")?.toUpperCase() ?? "";
  // Until auth is resolved (`ready`), show the neutral "Account" — NEVER flash
  // "Guest" (which implies signed-out) while the config/session are still
  // loading. "Guest" is only correct on the open-source build (ready + auth off).
  const guestLabel = authEnabled || !ready ? "Account" : "Guest";

  return (
    <div className="sidebar-user-wrap" ref={wrapRef}>
      <div
        className="sidebar-profile"
        title={user ? name : "Account"}
        role="button"
        tabIndex={0}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={(e) => e.key === "Enter" && setOpen((o) => !o)}
      >
        <div className="profile-avatar">
          {avatarUrl ? (
            // eslint-disable-next-line @next/next/no-img-element
            <img
              src={avatarUrl}
              referrerPolicy="no-referrer"
              alt=""
              style={{ width: 28, height: 28, borderRadius: "50%" }}
            />
          ) : initial ? (
            initial
          ) : (
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          )}
        </div>
        {user ? (
          <div className="sidebar-label profile-info">
            <span className="profile-name">{name}</span>
            {tierKnown && <span className="profile-tier">{tier}</span>}
          </div>
        ) : (
          <span className="sidebar-label profile-name">{guestLabel}</span>
        )}
        <svg className="sidebar-label profile-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="6 9 12 15 18 9" />
        </svg>
      </div>

      {/* Production structure: .sidebar-user-menu (.open) with header + divider
          + .user-menu-item rows. Positioned above the profile, bottom-left. */}
      <div className={`sidebar-user-menu${open ? " open" : ""}`} style={{ left: 12, bottom: 60, right: 12 }}>
        <div className="user-menu-header">
          <span className="user-menu-name">{user ? name : guestLabel}</span>
          {email && <span className="user-menu-email">{email}</span>}
        </div>
        <div className="user-menu-divider" />
        {/* A row that *contains* the ThemeToggle <button>, so it must NOT be a
            <button> itself (button-in-button = invalid HTML → hydration error).
            A div with stopPropagation keeps the menu open on in-row clicks. */}
        <div className="user-menu-item" onClick={(e) => e.stopPropagation()}>
          <span>Theme</span>
          <span style={{ marginLeft: "auto" }}><ThemeToggle /></span>
        </div>
        {/* Join Community (Discord) — legacy app.js had it in both the signed-in
            and signed-out menus; the Next rewrite dropped it. Plain text (no icon)
            to match the icon-less Theme / Sign in rows — a lone Discord glyph left
            the label misaligned. Same URL as the landing page + layout.tsx. */}
        <a
          className="user-menu-item"
          href="https://discord.gg/bCShwbFnCd"
          target="_blank"
          rel="noopener noreferrer"
          onClick={() => setOpen(false)}
        >
          Join Community
        </a>
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
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      className="user-menu-item user-menu-signout"
      disabled={busy}
      // Keep the menu open showing "Signing out…" until signOut resolves (it
      // usually redirects); close it afterward (or on failure) via onDone.
      onClick={async () => {
        if (busy) return;
        setBusy(true);
        try {
          await signOut();
        } finally {
          onDone();
        }
      }}
    >
      {busy ? "Signing out…" : "Sign out"}
    </button>
  );
}
