import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import ChatView from "@/components/chat/ChatView";

/**
 * A chat session. Real path /chat/[id] (no hash). The session row + messages
 * are loaded client-side by ChatView (these are private, per-user rows; SSR
 * runs unauthenticated, so client load is the right boundary).
 */

export const metadata: Metadata = {
  title: "Chat · Feynman",
  // Private conversations should never be indexed.
  robots: { index: false, follow: false },
};

export default function ChatSessionPage({ params }: { params: { id: string } }) {
  return (
    <AppShell>
      <ChatView sessionId={params.id} />
    </AppShell>
  );
}
