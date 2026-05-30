"use client";

/**
 * Share-publicly modal + success toast. Port of the Phase 6 user-share UI in
 * app.js (~7798-7919). Auto-publish model: POST /share sets public_status
 * 'approved' immediately; the public URL is /discussions/{id}.
 *
 * Reuses .share-modal(.hidden) + .share-modal-card + .publish-toast classes.
 * Eligibility (feature flag + min message count) is decided by ChatView; this
 * component only renders when asked and reports the published record back up.
 */

import { useEffect, useState } from "react";
import { post, ApiError } from "@/lib/api";
import type { Session } from "@/lib/chat";

interface ShareRecord {
  public_status: string;
  public_title?: string | null;
  public_handle?: string | null;
  public_url?: string | null;
}

export function ShareModal({
  session,
  onClose,
  onShared,
}: {
  session: Session;
  onClose: () => void;
  onShared: (rec: ShareRecord) => void;
}) {
  const [title, setTitle] = useState(
    (session.publicTitle || session.title || "").slice(0, 200),
  );
  const [handle, setHandle] = useState(session.publicHandle || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);

  // Esc closes (mirrors the legacy global keydown handler).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  const submit = async () => {
    setSubmitting(true);
    setError("");
    try {
      const rec = await post<ShareRecord>(
        `/api/chat-sessions/${encodeURIComponent(session.id)}/share`,
        {
          title: title.trim() || undefined,
          handle: handle.trim() || undefined,
        },
      );
      onShared(rec);
    } catch (e) {
      const detail =
        e instanceof ApiError &&
        typeof (e.body as { detail?: string })?.detail === "string"
          ? (e.body as { detail: string }).detail
          : "Could not publish.";
      setError(detail);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="share-modal">
      <div className="share-modal-backdrop" onClick={onClose} />
      <div className="share-modal-card" role="dialog" aria-modal="true">
        <div className="share-modal-header">
          <h2>Share publicly</h2>
          <button className="share-modal-close" aria-label="Close" onClick={onClose}>
            ×
          </button>
        </div>
        <div className="share-modal-body">
          <p className="share-modal-intro">
            Publish this conversation to a public page anyone can read. You can make
            it private again at any time.
          </p>
          <label className="share-field">
            <span className="share-field-label">Title</span>
            <input
              className="share-field-input"
              value={title}
              maxLength={200}
              placeholder="Conversation title"
              onChange={(e) => setTitle(e.target.value)}
            />
          </label>
          <label className="share-field">
            <span className="share-field-label">Your handle (optional)</span>
            <input
              className="share-field-input"
              value={handle}
              placeholder="e.g. feynman_fan"
              onChange={(e) => setHandle(e.target.value)}
            />
            <span className="share-field-hint">Shown as the author of the public page.</span>
          </label>
          {error && <div className="share-modal-error">{error}</div>}
        </div>
        <div className="share-modal-footer">
          <button className="share-modal-cancel" onClick={onClose} disabled={submitting}>
            Cancel
          </button>
          <button className="share-modal-submit" onClick={submit} disabled={submitting}>
            {submitting ? "Publishing…" : "Publish"}
          </button>
        </div>
      </div>
    </div>
  );
}

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
