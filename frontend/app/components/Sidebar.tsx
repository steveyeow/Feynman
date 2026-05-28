"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState } from "react";

/* The one shared shell. Ported from the production app's sidebar
   (app/static/index.html) — same logo SVG, same nav, same account slot —
   so every page (SEO content + interactive app) wears identical chrome.
   Account wiring (real Supabase session) lands in the next Phase-0 step;
   for now the slot renders a sign-in affordance. */

function LogoIcon() {
  return (
    <svg className="sidebar-logo-icon" width="19" height="19" viewBox="0 0 64 64" fill="none">
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
    icon: <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />,
  },
  {
    href: "/library",
    label: "Library",
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
  const pathname = usePathname();
  const [collapsed, setCollapsed] = useState(false);

  return (
    <aside className="app-sidebar">
      <div className="sidebar-header">
        <Link href="/" className="sidebar-logo">
          <LogoIcon />
          <span className="sidebar-label">Feynman</span>
        </Link>
        <button
          className="sidebar-icon-btn"
          title="Toggle sidebar"
          onClick={() => {
            setCollapsed((c) => !c);
            document.getElementById("app-layout")?.classList.toggle("sidebar-collapsed");
          }}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" />
            <line x1="9" y1="3" x2="9" y2="21" />
          </svg>
        </button>
      </div>

      <Link href="/" className="new-chat-action">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <line x1="12" y1="5" x2="12" y2="19" />
          <line x1="5" y1="12" x2="19" y2="12" />
        </svg>
        <span className="sidebar-label">New Chat</span>
      </Link>

      {NAV.map((item) => {
        const active = pathname === item.href || pathname.startsWith(item.href + "/");
        return (
          <Link key={item.href} href={item.href} className={`sidebar-nav-link${active ? " active" : ""}`}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {item.icon}
            </svg>
            <span className="sidebar-label">{item.label}</span>
          </Link>
        );
      })}

      <div className="sidebar-history" />

      <div className="sidebar-bottom">
        <button className="sidebar-profile" title="Account">
          <span className="profile-avatar">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
              <circle cx="12" cy="7" r="4" />
            </svg>
          </span>
          <span className="sidebar-label profile-name">Sign in</span>
        </button>
      </div>
    </aside>
  );
}
