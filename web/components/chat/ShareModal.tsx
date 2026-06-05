"use client";

/**
 * Publish-success toast for the share flow.
 *
 * The old title/handle modal was removed in the share redesign (Phase 1) in
 * favor of one-click publish wired directly in ChatView (`doShare`). This file
 * now holds only the clean popup that surfaces the public link with Copy / Open
 * / Make private — the affordance ChatGPT/Claude show after you share.
 *
 * Reuses the .publish-toast classes. Auto-publish model: POST /share sets
 * public_status 'approved' immediately; the public URL is /discussions/{id}.
 */

import { useState } from "react";
import { post } from "@/lib/api";

export function PublishToast({
  url,
  sessionId,
  onClose,
  onUnshared,
}: {
  url: string;
  sessionId: string;
  onClose: () => void;
  onUnshared: () => void;
}) {
  const [copied, setCopied] = useState(false);

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
    if (
      !window.confirm(
        "Make this conversation private again? The public link will stop working immediately.",
      )
    )
      return;
    try {
      await post(`/api/chat-sessions/${encodeURIComponent(sessionId)}/withdraw`);
      onUnshared();
    } catch {
      /* fail silently — user can retry */
    }
  };

  return (
    <div className="publish-toast">
      <p className="publish-toast-title">Published</p>
      <p className="publish-toast-msg">Anyone with this link can read the conversation.</p>
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
        <button className="publish-toast-unshare" onClick={unshare}>
          Make private
        </button>
        <button className="publish-toast-close" aria-label="Dismiss" onClick={onClose}>
          ×
        </button>
      </div>
    </div>
  );
}
