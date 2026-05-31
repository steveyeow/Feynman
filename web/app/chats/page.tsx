import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import ChatsList from "@/components/chat/ChatsList";

export const metadata: Metadata = {
  title: "Chats — Feynman",
  robots: { index: false },
};

export default function ChatsPage() {
  return (
    <AppShell>
      <div className="page-view chats-page">
        <ChatsList />
      </div>
    </AppShell>
  );
}
