"use client";

/**
 * "X and Y want to join" consent prompt. Rendered inline in the transcript when
 * the system auto-suggests minds (not on @-mention — there the user already
 * invited them). Port of showMindJoinPrompt in app.js.
 *
 * Reuses .chat-system-notice + .mind-consent-* classes. Allow/Not now resolve
 * back to ChatView, which then runs panel-chat or discards the suggestions.
 */

import { esc } from "./markdown";

export default function MindConsent({
  names,
  onAllow,
  onDecline,
}: {
  names: string[];
  onAllow: () => void;
  onDecline: () => void;
}) {
  const label =
    names.length === 1
      ? names[0]
      : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  return (
    <div className="chat-system-notice">
      <div className="mind-consent-inner">
        <span
          className="mind-consent-text"
          // label is plain text; esc keeps any stray markup inert.
          dangerouslySetInnerHTML={{ __html: esc(label) + " wants to join" }}
        />
        <span className="mind-consent-actions">
          <button
            type="button"
            className="mind-consent-btn mind-consent-allow"
            onClick={onAllow}
          >
            Allow
          </button>
          <button
            type="button"
            className="mind-consent-btn mind-consent-decline"
            onClick={onDecline}
          >
            Not now
          </button>
        </span>
      </div>
    </div>
  );
}
