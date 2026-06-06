/**
 * Hand-off for "Continue this conversation" on a public shared discussion.
 *
 * The shared page's inline composer forks the discussion (a new session owned by
 * the viewer) and stashes the viewer's first follow-up here; ChatView, after it
 * has loaded the forked transcript, sends that follow-up (so the continuation
 * keeps the prior context). Distinct from the home-composer first-message
 * handoff (feynman:pendingChat), which SKIPS loading messages — a fork must load
 * its copied transcript first, so it needs its own channel.
 */

const KEY = "feynman:continueFollowup";

export function setContinueFollowup(sessionId: string, message: string): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify({ sessionId, message }));
  } catch {
    /* sessionStorage unavailable — continuation just opens without the message */
  }
}

/** Read + clear the follow-up for this session (returns the message, or null). */
export function takeContinueFollowup(sessionId: string): string | null {
  try {
    const raw = sessionStorage.getItem(KEY);
    if (!raw) return null;
    const data = JSON.parse(raw) as { sessionId: string; message: string };
    if (data.sessionId !== sessionId) return null;
    sessionStorage.removeItem(KEY);
    return data.message || null;
  } catch {
    return null;
  }
}
