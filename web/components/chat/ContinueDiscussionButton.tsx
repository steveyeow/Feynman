"use client";

/**
 * "Continue this conversation" — the ChatGPT-style fork CTA on a public shared
 * discussion (/discussions/[id]). POSTs to /continue, which copies the shared
 * transcript into a NEW session owned by the signed-in viewer, then routes them
 * into the live chat to keep going. Signed-out → bounce to /login.
 */

import { useState } from "react";
import { useRouter } from "next/navigation";
import { post, ApiError } from "@/lib/api";

export default function ContinueDiscussionButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);

  const onClick = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const res = await post<{ session_id: string; url?: string }>(
        `/api/public-discussions/${encodeURIComponent(id)}/continue`,
      );
      router.push(res.url || `/chat/${res.session_id}`);
    } catch (e) {
      // Signed out → go authenticate, then they can continue. Other errors →
      // re-enable so they can retry.
      if (e instanceof ApiError && e.status === 401) {
        router.push("/login");
      } else {
        setBusy(false);
      }
    }
  };

  return (
    <button
      type="button"
      className="shared-continue-btn"
      onClick={onClick}
      disabled={busy}
    >
      {busy ? "Starting…" : "Continue this conversation →"}
    </button>
  );
}
