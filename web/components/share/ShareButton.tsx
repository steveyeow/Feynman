"use client";

import { useState } from "react";
import ShareDialog from "@/components/share/ShareDialog";

/**
 * Standalone "Share" affordance for surfaces without an EntityActions bar
 * (a shared answer, a public discussion). Opens the preview ShareDialog.
 */
export default function ShareButton({
  url,
  subject,
  title,
  previewImage,
  defaultText,
  label = "Share",
  variant = "ghost",
}: {
  url: string;
  subject?: string;
  title?: string;
  /** og:image to preview; when omitted ShareDialog reads the page's meta. */
  previewImage?: string;
  defaultText?: string;
  label?: string;
  variant?: "ghost" | "secondary";
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`seo-action ${variant}`} onClick={() => setOpen(true)} title="Share">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
          <polyline points="16 6 12 2 8 6" />
          <line x1="12" y1="2" x2="12" y2="15" />
        </svg>
        {label}
      </button>
      {open ? (
        <ShareDialog url={url} subject={subject} title={title} previewImage={previewImage} defaultText={defaultText} onClose={() => setOpen(false)} />
      ) : null}
    </>
  );
}
