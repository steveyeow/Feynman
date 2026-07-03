import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import Library from "@/components/library/Library";

export const metadata: Metadata = {
  title: "Library — Feynman",
  description:
    "Browse and chat with the world's most important books. Search any title; if it's not here yet, Feynman finds and adds it in real time.",
};

export default function LibraryPage() {
  return (
    <AppShell>
      <div className="page-view library-page">
        {/* Crawler/AT heading — same "H1 tag missing" gap Bing WT flagged on
            /minds; the Library client island renders no server-side heading. */}
        <h1 className="sr-only">Library — browse and chat with books</h1>
        <Library />
      </div>
    </AppShell>
  );
}
