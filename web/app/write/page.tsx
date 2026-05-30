import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import WriteBook from "@/components/write/WriteBook";

export const metadata: Metadata = {
  title: "Write the Book You Need — Feynman",
  description:
    "Describe a person, idea, skill, or topic and Feynman generates a complete book on-demand for your current needs — outline first, then full chapters you can read and chat with.",
};

export default function WritePage() {
  return (
    <AppShell>
      <div className="page-view write-book-page">
        <WriteBook />
      </div>
    </AppShell>
  );
}
