"use client";

/**
 * "Join this discussion" — the symposium → live multi-mind chat bridge.
 *
 * Turns a read-only symposium into the core minds-join experience: creates a
 * chat session, pre-selects the symposium's participants as mind chips, and
 * replays the prior debate as panel-chat history (seedHistory) so the minds pick
 * up where the page left off. Reuses the home-composer handoff channel
 * (feynman:pendingChat) — ChatView reads it on mount, seeds the chips + history,
 * and sends the question. Gated by the signin→Pro double wall (useProGate), like
 * every minds chat.
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
      // The prior debate, in the same "[Name]: …" shape buildPanelHistory emits,
      // so the minds continue the symposium instead of starting cold.
      const seedHistory = turns
        .filter((t) => t.content)
        .map((t) => ({ role: "assistant", content: `[${t.mind_name}]: ${t.content}` }));
      const session = await createSession({ title: question, sessionType: "chat" });
      sessionStorage.setItem(
        PENDING_KEY,
        JSON.stringify({ sessionId: session.id, message: question, minds, seedHistory }),
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
