"use client";

/**
 * Inline "continue this conversation" composer on a public shared discussion
 * (/discussions/[id]) — ChatGPT-style: just type a follow-up to keep going.
 *
 * On send it forks the discussion into a NEW session owned by the signed-in
 * viewer (POST /continue), stashes the typed message (continueHandoff), and
 * routes to /chat/{newId}, where ChatView loads the copied transcript and sends
 * the follow-up with full context. Signed-out → bounce to /login (then return
 * here and retype). The continuation is private to the viewer.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post, ApiError } from "@/lib/api";
import { setContinueFollowup } from "@/lib/continueHandoff";

export default function ContinueComposer({ id }: { id: string }) {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    const msg = text.trim();
    if (!msg || busy) return;
    setBusy(true);
    try {
      const res = await post<{ session_id: string; url?: string }>(
        `/api/public-discussions/${encodeURIComponent(id)}/continue`,
      );
      setContinueFollowup(res.session_id, msg);
      router.push(res.url || `/chat/${res.session_id}`);
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) {
        router.push(`/login?next=${encodeURIComponent(`/discussions/${id}`)}`);
      } else {
        setBusy(false);
      }
    }
  };

  return (
    <div className="shared-continue">
      <p className="shared-continue-hint">
        Continue privately — your follow-ups create a copy only you can see.
      </p>
      <div className="shared-continue-bar">
        <textarea
          className="shared-continue-input"
          placeholder="Ask a follow-up to continue this conversation…"
          rows={1}
          value={text}
          disabled={busy}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="shared-continue-send"
          onClick={() => void submit()}
          disabled={busy || !text.trim()}
          aria-label="Continue this conversation"
        >
          {busy ? "…" : "↑"}
        </button>
      </div>
    </div>
  );
}
