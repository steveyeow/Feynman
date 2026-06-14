"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";

/**
 * A per-turn share permalink (/symposium/{slug}/t/{i}) exists ONLY so a social
 * scrape resolves to that turn's OG card. A human who clicks through should land
 * on the full symposium — one canonical page, no confusing near-duplicate. We
 * can't SSR-redirect (a 3xx carries no OG meta for the crawler), so the route
 * serves 200 + the turn's OG in <head>, then this client component redirects to
 * the symposium, anchored to that turn.
 */
export default function TurnRedirect({ href, label }: { href: string; label: string }) {
  const router = useRouter();
  useEffect(() => {
    router.replace(href);
  }, [href, router]);
  return (
    <div className="turn-redirect">
      <p className="turn-redirect-note">Opening the symposium…</p>
      <a className="turn-redirect-link" href={href}>
        {label}
      </a>
    </div>
  );
}
