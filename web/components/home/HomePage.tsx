import { Suspense } from "react";
import AppShell from "@/components/shell/AppShell";
import HomeComposer from "@/components/chat/HomeComposer";

/**
 * Home — the greeting + interactive composer inside the shared shell. This is
 * the exact markup that previously lived in app/page.tsx, extracted verbatim so
 * the route entry can delegate to <HomeOrLanding/> (which decides home vs.
 * landing) WITHOUT changing the home experience.
 *
 * The composer (HomeComposer) creates a session and routes to /chat/[id],
 * handing off the first message. It reads ?book & ?q for the cross-surface
 * contract, so it lives behind a Suspense boundary (useSearchParams).
 */
export default function HomePage() {
  return (
    <AppShell>
      <div className="page-view home-page">
        <div className="home-center" id="home-center-main">
          <div className="greeting-row">
            <div className="greeting-logo-wrap">
              <svg className="greeting-feynman-logo" width="42" height="42" viewBox="0 0 64 64" fill="none" aria-hidden="true">
                <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                <circle cx="32" cy="30" r="3.5" fill="currentColor" />
                <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              </svg>
            </div>
            <h1 className="greeting">What do you want to learn?</h1>
          </div>

          <Suspense fallback={<div className="chat-composer" aria-hidden />}>
            <HomeComposer />
          </Suspense>
        </div>
        <p className="home-quote">
          &quot;You learn by asking questions, by thinking, and by experimenting.&quot; — Richard Feynman
        </p>
      </div>
    </AppShell>
  );
}
