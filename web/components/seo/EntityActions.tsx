"use client";

import Link from "next/link";
import { useState } from "react";

/**
 * Top action bar for SEO entity pages. Renders the prominent primary actions
 * (Read / Preview / Chat) + a Share control. Chat routes into the real
 * conversational surface (the home composer, preselected) — NOT the reader —
 * so catalog stubs with no readable text can still start a chat (fixes the
 * "no readable content" dead-end). Read/Preview go to the reader only when the
 * book actually has content.
 *
 * `chatHref`   — where Chat goes (book: /?book={id}; mind: /?mind={id}).
 * `readHref`   — reader, when canRead/canPreview.
 * `shareUrl`   — absolute canonical URL to copy.
 */
export interface EntityAction {
  label: string;
  href: string;
  variant: "primary" | "secondary";
}

export default function EntityActions({
  actions,
  shareUrl,
  shareTitle,
}: {
  actions: EntityAction[];
  shareUrl?: string;
  shareTitle?: string;
}) {
  const [copied, setCopied] = useState(false);

  async function share() {
    if (!shareUrl) return;
    // Native share sheet when available; otherwise copy the link.
    const nav = typeof navigator !== "undefined" ? navigator : undefined;
    if (nav && typeof nav.share === "function") {
      try {
        await nav.share({ title: shareTitle || document.title, url: shareUrl });
        return;
      } catch {
        /* user dismissed — fall through to copy */
      }
    }
    try {
      await nav?.clipboard?.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked — no-op */
    }
  }

  return (
    <div className="seo-actions">
      {actions.map((a) => (
        <Link key={a.label} href={a.href} className={`seo-action ${a.variant}`}>
          {a.label}
        </Link>
      ))}
      {shareUrl ? (
        <button type="button" className="seo-action ghost" onClick={share} title="Share">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
          {copied ? "Copied" : "Share"}
        </button>
      ) : null}
    </div>
  );
}
