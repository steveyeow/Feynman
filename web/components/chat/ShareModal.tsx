"use client";

/**
 * Publish-success toast for the share flow.
 *
 * The old title/handle modal was removed in the share redesign (Phase 1) in
 * favor of one-click publish wired directly in ChatView (`doShare`). This file
 * now holds only the clean popup that surfaces the public link with Copy / Open
 * / Make private — the affordance ChatGPT/Claude show after you share.
 *
 * Reuses the .publish-toast classes. Auto-publish model: the /share endpoint
 * sets public_status 'approved' immediately. Used for BOTH whole-session shares
 * (URL /discussions/{id}) and per-turn answer shares (URL /a/{id}); the
 * make-private action is caller-provided since the withdraw endpoint differs.
 */

import { useState } from "react";

export function PublishToast({
  url,
  shareText,
  onClose,
  onWithdraw,
}: {
  url: string;
  /** Pre-fill for the tweet composer (the question / session title). The card
   *  itself carries the content, so this is just opening context the user can
   *  edit in X. */
  shareText?: string;
  onClose: () => void;
  /** Make-private action. The caller owns the endpoint (session vs single
   *  answer) + any local state updates; the toast only confirms and invokes it. */
  onWithdraw: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [unsharing, setUnsharing] = useState(false);

  // Absolute URL for the tweet intent (public_url is usually absolute already;
  // absolutize the relative fallback against the current origin).
  const absUrl =
    /^https?:\/\//.test(url)
      ? url
      : `${typeof window !== "undefined" ? window.location.origin : "https://feynman.wiki"}${url}`;

  const postOnX = () => {
    const intent = `https://twitter.com/intent/tweet?text=${encodeURIComponent(
      (shareText || "").trim(),
    )}&url=${encodeURIComponent(absUrl)}`;
    window.open(intent, "_blank", "noopener,noreferrer");
  };

  const copy = () => {
    try {
      navigator.clipboard.writeText(absUrl);
    } catch {
      /* clipboard unavailable — user can select manually */
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 1500);
  };

  const unshare = async () => {
    if (unsharing) return;
    if (
      !window.confirm(
        "Make this private again? The public link will stop working immediately.",
      )
    )
      return;
    setUnsharing(true);
    try {
      await onWithdraw();
    } catch {
      /* fail silently — caller handles errors */
    } finally {
      setUnsharing(false);
    }
  };

  return (
    <div className="publish-toast">
      <p className="publish-toast-title">Published</p>
      <p className="publish-toast-msg">Anyone with this link can read it.</p>
      <div className="publish-toast-link-row">
        <input className="publish-toast-url" readOnly value={absUrl} onFocus={(e) => e.target.select()} />
        <button className="publish-toast-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <button className="publish-toast-x" onClick={postOnX} type="button">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
        </svg>
        Post on X
      </button>
      <div className="publish-toast-actions">
        <a className="publish-toast-open" href={absUrl} target="_blank" rel="noopener noreferrer">
          Open
        </a>
        <button className="publish-toast-unshare" onClick={unshare} disabled={unsharing}>
          {unsharing ? "Making private…" : "Make private"}
        </button>
        <button className="publish-toast-close" aria-label="Dismiss" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}
