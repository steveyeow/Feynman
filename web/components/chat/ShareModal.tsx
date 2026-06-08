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
  onClose,
  onWithdraw,
}: {
  url: string;
  onClose: () => void;
  /** Make-private action. The caller owns the endpoint (session vs single
   *  answer) + any local state updates; the toast only confirms and invokes it. */
  onWithdraw: () => Promise<void>;
}) {
  const [copied, setCopied] = useState(false);
  const [unsharing, setUnsharing] = useState(false);

  const copy = () => {
    try {
      navigator.clipboard.writeText(url);
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
        <input className="publish-toast-url" readOnly value={url} onFocus={(e) => e.target.select()} />
        <button className="publish-toast-copy" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <div className="publish-toast-actions">
        <a className="publish-toast-open" href={url} target="_blank" rel="noopener noreferrer">
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
