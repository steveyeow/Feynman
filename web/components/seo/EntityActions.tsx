"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Top action bar for SEO entity pages: prominent primary actions (Read /
 * Preview / Chat) + a Feynman SHARE control. Share opens a custom popup
 * (Post on X / Copy link) — the production share affordance — NOT the OS
 * share sheet (navigator.share triggered the macOS sheet, which is wrong
 * for the web product). Chat routes into the conversational surface, never
 * the reader, so catalog stubs can still start a chat.
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
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  function postOnX() {
    if (!shareUrl) return;
    const text = encodeURIComponent(`${shareTitle || "Explore this"} on Feynman`);
    const url = encodeURIComponent(shareUrl);
    window.open(`https://twitter.com/intent/tweet?text=${text}&url=${url}`, "_blank", "noopener");
    setOpen(false);
  }

  async function copyLink() {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1600);
    } catch {
      /* clipboard blocked */
    }
    setOpen(false);
  }

  return (
    <div className="seo-actions">
      {actions.map((a) => (
        <Link key={a.label} href={a.href} className={`seo-action ${a.variant}`}>
          {a.label}
        </Link>
      ))}
      {shareUrl ? (
        <div className="seo-share-wrap" ref={wrapRef}>
          <button
            type="button"
            className="seo-action ghost"
            onClick={() => setOpen((o) => !o)}
            title="Share"
          >
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" y1="2" x2="12" y2="15" />
            </svg>
            {copied ? "Copied" : "Share"}
          </button>
          {open ? (
            <div className="seo-share-popup">
              <button type="button" className="seo-share-opt" onClick={postOnX}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                  <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
                </svg>
                Post on X
              </button>
              <button type="button" className="seo-share-opt" onClick={copyLink}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                  <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
                </svg>
                Copy link
              </button>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
