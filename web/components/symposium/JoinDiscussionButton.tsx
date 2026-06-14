"use client";

/**
 * "Join this discussion" — the symposium → live multi-mind chat bridge.
 *
 * Turns a read-only symposium into the core minds-join experience: creates a
 * chat session, pre-selects the symposium's participants as mind chips, and
 * loads the prior debate AS the opening transcript (symposiumTurns → a join
 * notice + each mind's remark). Reuses the home-composer handoff channel
 * (feynman:pendingChat) — ChatView reads it on mount, seeds the chips, replays
 * the transcript, and waits for the user's follow-up (no synthetic question
 * message). Gated by the signin→Pro double wall (useProGate), like every minds chat.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createSession } from "@/lib/chat";
import { useProGate } from "@/components/pro/ProOverlay";

const PENDING_KEY = "feynman:pendingChat";

interface Participant {
  mind_id: string;
  mind_name: string;
}
interface Turn {
  mind_id: string;
  mind_name: string;
  content: string;
}

export default function JoinDiscussionButton({
  question,
  participants,
  turns,
}: {
  question: string;
  participants: Participant[];
  turns: Turn[];
}) {
  const router = useRouter();
  const { requirePro } = useProGate();
  const [busy, setBusy] = useState(false);

  async function join() {
    if (busy) return;
    // signin→Pro double wall (by design): anon → /login, free → upgrade overlay,
    // pro → proceed. requirePro() with no action returns true only for pro users.
    if (!requirePro()) return;
    setBusy(true);
    try {
      const minds = participants
        .filter((p) => p.mind_id)
        .map((p) => ({ id: p.mind_id, name: p.mind_name }));
      // Load the prior debate AS the opening transcript (mind turns), so the chat
      // continues with full context — not a synthetic user "question" message
      // (which would render right-aligned). ChatView replays these as a join
      // notice + mind messages and waits for the user's follow-up.
      const symposiumTurns = turns
        .filter((t) => t.content)
        .map((t) => ({ mindId: t.mind_id, mindName: t.mind_name, content: t.content }));
      const session = await createSession({ title: question, sessionType: "chat" });
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ sessionId: session.id, message: "", minds, symposiumTurns }),
      );
      router.push(`/chat/${session.id}`);
    } catch {
      setBusy(false); // stay on the page; the user can retry
    }
  }

  return (
    <button type="button" className="symposium-join-cta" onClick={join} disabled={busy}>
      {busy ? "Opening…" : "Join this discussion"}
    </button>
  );
}
