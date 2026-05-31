import { Suspense } from "react";
import AppShell from "@/components/shell/AppShell";
import HomeComposer from "@/components/chat/HomeComposer";

/**
 * App home — faithful port of legacy `#page-home > #home-center-main`
 * (index.html 185-265). The greeting row (two logos + time-based heading), the
 * composer, and the starter pills all live inside <HomeComposer> (one client
 * island, since they share state + need localStorage for the greeting name).
 * This server wrapper supplies the page chrome + the home-quote.
 *
 * HomeComposer reads ?book & ?q for the cross-surface contract, so it sits
 * behind a Suspense boundary (useSearchParams requirement).
 */
export default function HomePage() {
  return (
    <AppShell>
      <div className="page-view home-page">
        <Suspense fallback={<div className="home-center" id="home-center-main" />}>
          <HomeComposer />
        </Suspense>
        <p className="home-quote">
          &quot;You learn by asking questions, by thinking, and by experimenting.&quot; — Richard Feynman
        </p>
      </div>
    </AppShell>
  );
}
