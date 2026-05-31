import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import Subscription from "@/components/subscription/Subscription";

export const metadata: Metadata = {
  title: "Plans — Feynman",
  description:
    "Upgrade to Feynman Pro: write the book you need on-demand, invite great minds into your chats, expand the minds network, and higher daily limits.",
  // Account/billing page — not a public SEO surface.
  robots: { index: false, follow: false },
};

export default function SubscriptionPage() {
  return (
    <AppShell>
      <div className="page-view subscription-page">
        <Subscription />
      </div>
    </AppShell>
  );
}
