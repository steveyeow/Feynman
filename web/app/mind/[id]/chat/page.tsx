import type { Metadata } from "next";
import { notFound } from "next/navigation";
import AppShell from "@/components/shell/AppShell";
import MindChat from "@/components/mind/MindChat";
import { fetchMind } from "@/lib/seo-mind";

// Interactive app surface (the 1:1 chat), NOT the SEO profile — the indexable
// page stays at /mind/[id]. Keep this out of the index.
export const dynamic = "force-dynamic";

export async function generateMetadata({
  params,
}: {
  params: { id: string };
}): Promise<Metadata> {
  const mind = await fetchMind(params.id);
  return {
    title: mind ? `Chat with ${mind.name} — Feynman` : "Mind not found — Feynman",
    robots: { index: false, follow: false },
  };
}

export default async function MindChatPage({
  params,
}: {
  params: { id: string };
}) {
  const mind = await fetchMind(params.id);
  if (!mind) notFound();
  return (
    <AppShell>
      <MindChat mindId={params.id} mind={mind} />
    </AppShell>
  );
}
