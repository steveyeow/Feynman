"use client";

import Link from "next/link";
import { useState } from "react";
import ShareDialog from "@/components/share/ShareDialog";
import { track } from "@/lib/analytics";

/**
 * Top action bar for SEO entity pages: prominent primary actions (Read /
 * Preview / Chat) + a Feynman SHARE control. Share opens the preview
 * ShareDialog (live card preview + editable tweet + copy link) — the
 * production share affordance, NOT the OS share sheet.
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
  shareSubject,
}: {
  actions: EntityAction[];
  shareUrl?: string;
  shareTitle?: string;
  /** Optional "what am I sharing" label for the dialog header. */
  shareSubject?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div className="seo-actions">
      {actions.map((a) => (
        <Link
          key={a.label}
          href={a.href}
          className={`seo-action ${a.variant}`}
          onClick={() => {
            // The SEO→chat funnel's intent step. href carries the entity
            // (/?book={slug} | /mind/{slug}/chat), so no per-page wiring.
            if (/^chat\b/i.test(a.label)) {
              track("chat_cta_clicked", { label: a.label, href: a.href });
            }
          }}
        >
          {a.label}
        </Link>
      ))}
      {shareUrl ? (
        <button
          type="button"
          className="seo-action ghost"
          onClick={() => setOpen(true)}
          title="Share"
        >
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
            <polyline points="16 6 12 2 8 6" />
            <line x1="12" y1="2" x2="12" y2="15" />
          </svg>
          Share
        </button>
      ) : null}
      {open && shareUrl ? (
        <ShareDialog
          url={shareUrl}
          subject={shareSubject}
          title={shareTitle}
          defaultText={shareTitle ? `${shareTitle} on Feynman` : undefined}
          onClose={() => setOpen(false)}
        />
      ) : null}
    </div>
  );
}
