"use client";

/**
 * The app chrome — left sidebar. Ported from index.html's #app-sidebar so the
 * existing styles.css rules apply 1:1. The decisive change vs. the legacy app:
 * nav uses real paths via next/link (no `#/` hash routing), and active state
 * comes from the real pathname. This is the single shared chrome used by BOTH
 * the app surfaces and the SEO entity pages.
 */

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useState } from "react";
import ChatHistory from "@/components/chat/ChatHistory";
import UserMenu from "./UserMenu";

function BrandMark() {
  return (
    <svg
      className="sidebar-logo-icon"
      width="19"
      height="19"
      viewBox="0 0 64 64"
      fill="none"
      aria-hidden="true"
    >
      <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="32" cy="30" r="3.5" fill="currentColor" />
      <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

const NAV = [
  {
    href: "/chats",
    label: "Chats",
    cls: "sidebar-chats-link",
    icon: (
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    ),
  },
  {
    href: "/library",
    label: "Library",
    cls: "sidebar-library-link",
    icon: (
      <>
        <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
        <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
      </>
    ),
  },
  {
    href: "/minds",
    label: "Great Minds",
    cls: "sidebar-minds-link",
    icon: (
      <>
        <circle cx="6" cy="6" r="2.5" />
        <circle cx="18" cy="8" r="2.5" />
        <circle cx="8" cy="18" r="2.5" />
        <circle cx="18" cy="18" r="2" />
        <line x1="8.2" y1="7.2" x2="15.8" y2="7.2" />
        <line x1="7" y1="8.3" x2="7.5" y2="15.5" />
        <line x1="10.2" y1="17.2" x2="16" y2="17.8" />
        <line x1="16.5" y1="10.3" x2="17.5" y2="16" />
      </>
    ),
  },
];

export default function Sidebar() {
  const pathname = usePathname() || "/";
  const [collapsed, setCollapsed] = useState(false);

  // Small screens start collapsed: ≤900px the sidebar becomes a fixed overlay
  // (app.css), so the desktop expanded-by-default covered the page content on
  // every mobile visit. Keyed on pathname so navigating FROM the open overlay
  // also dismisses it (it would otherwise sit over the destination page).
  // Layout effect rather than a state initializer — the SSR markup is
  // "expanded", and flipping before first paint avoids both the hydration
  // mismatch and a visible flash.
  useLayoutEffect(() => {
    try {
      if (window.matchMedia("(max-width: 900px)").matches) setCollapsed(true);
    } catch {
      /* matchMedia unavailable → keep the desktop default */
    }
  }, [pathname]);

  // The collapse styling lives on `.app-layout.sidebar-collapsed` (styles.css),
  // but this aside can't set a class on its parent in JSX — so sync it
  // imperatively. The migration toggled `data-collapsed` on the aside instead,
  // which no CSS rule matched, so the toggle button did nothing.
  useEffect(() => {
    document
      .getElementById("app-layout")
      ?.classList.toggle("sidebar-collapsed", collapsed);
  }, [collapsed]);

  return (
    <>
    <aside className="app-sidebar" id="app-sidebar" data-collapsed={collapsed}>
      <div className="sidebar-header">
        <Link
          href="/"
          className="sidebar-logo"
          title={collapsed ? "Open sidebar" : "Feynman"}
          onClick={(e) => {
            // When collapsed, the brand glyph IS the expand control —
            // expand in place instead of navigating home.
            if (collapsed) {
              e.preventDefault();
              setCollapsed(false);
            }
          }}
        >
          <BrandMark />
          <svg
            className="sidebar-logo-expand"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
          Feynman
        </Link>
        <button
          id="sidebar-toggle-btn"
          className="sidebar-icon-btn"
          title="Collapse sidebar"
          onClick={() => setCollapsed((c) => !c)}
          aria-label="Collapse sidebar"
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      </div>

      <Link href="/?new=1" className="new-chat-action" title="New Chat">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span className="sidebar-label">New Chat</span>
      </Link>

      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link
            key={item.href}
            href={item.href}
            className={`sidebar-nav-link ${item.cls}${active ? " active" : ""}`}
            title={item.label}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {item.icon}
            </svg>
            <span className="sidebar-label">{item.label}</span>
          </Link>
        );
      })}

      <div className="sidebar-history" id="chat-history-list">
        <ChatHistory />
      </div>

      <div className="sidebar-bottom" id="sidebar-bottom">
        <UserMenu />
      </div>
    </aside>
    {/* Mobile-only floating opener (index.html #sidebar-float-btn). ≤900px the
        collapsed sidebar is width:0 — the in-rail brand glyph collapses with
        it, so without this sibling button there is no way to reopen. CSS shows
        it only when .sidebar-collapsed is active under 900px. */}
    <button
      id="sidebar-float-btn"
      className="sidebar-float-btn"
      title="Open sidebar"
      aria-label="Open sidebar"
      onClick={() => setCollapsed(false)}
    >
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2" />
        <line x1="9" y1="3" x2="9" y2="21" />
      </svg>
    </button>
    </>
  );
}
