"use client";

/**
 * "Continue this conversation" — the ChatGPT-style fork CTA on a public shared
 * discussion (/discussions/[id]). POSTs to /continue, which copies the shared
 * transcript into a NEW session owned by the signed-in viewer, then routes them
 * into the live chat to keep going.
 *
 * Signed-out flow: 401 → bounce to /login with a ?next= back here carrying
 * ?continue=1, so after login we land back and auto-continue once.
 */

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { post, ApiError } from "@/lib/api";

export default function ContinueDiscussionButton({ id }: { id: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const autofired = useRef(false);

  const go = async (fromAutofire: boolean) => {
    setBusy(true);
    try {
      const res = await post<{ session_id: string; url?: string }>(
        `/api/public-discussions/${encodeURIComponent(id)}/continue`,
      );
      router.push(res.url || `/chat/${res.session_id}`);
    } catch (e) {
      // Signed out → log in, then return here and auto-continue. Don't loop if
      // the auto-continue itself 401s.
      if (e instanceof ApiError && e.status === 401 && !fromAutofire) {
        const back = `/discussions/${encodeURIComponent(id)}?continue=1`;
        router.push(`/login?next=${encodeURIComponent(back)}`);
      } else {
        setBusy(false);
      }
    }
  };

  // Returning from login with ?continue=1 → auto-continue once.
  useEffect(() => {
    if (autofired.current || typeof window === "undefined") return;
    if (new URLSearchParams(window.location.search).get("continue") === "1") {
      autofired.current = true;
      void go(true);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <button
      type="button"
      className="shared-continue-btn"
      onClick={() => !busy && go(false)}
      disabled={busy}
    >
      {busy ? "Starting…" : "Continue this conversation →"}
    </button>
  );
}
