import type { Metadata } from "next";
import AppShell from "@/components/shell/AppShell";
import Reader from "@/components/reader/Reader";
import { getBookMeta } from "@/lib/reader";

interface Params {
  params: { id: string };
}

/**
 * Per-book title/description so a shared reader link previews well. Falls back
 * gracefully when the API is unreachable during SSR (dev without keys).
 */
export async function generateMetadata({ params }: Params): Promise<Metadata> {
  try {
    const meta = await getBookMeta(params.id);
    const title = meta.author
      ? `${meta.name} — ${meta.author} | Feynman`
      : `${meta.name} | Feynman`;
    return {
      title,
      description: `Read and chat with “${meta.name}” on Feynman. Ask questions and explore the ideas with great minds.`,
    };
  } catch {
    return {
      title: "Read — Feynman",
      description: "Read and chat with the world's most important books on Feynman.",
    };
  }
}

export default function ReadPage({ params }: Params) {
  return (
    <AppShell>
      <div className="page-view reader-page-shell">
        <Reader id={params.id} />
      </div>
    </AppShell>
  );
}
