import { notFound } from "next/navigation";
import { fetchMind } from "@/lib/seo-mind";

// Entity gate for every /mind/[id]/* route — real 404 for missing minds.
// Must be a layout (above the loading.tsx boundary): see /book/[id]/layout.
export default async function MindEntityLayout({
  params,
  children,
}: {
  params: { id: string };
  children: React.ReactNode;
}) {
  const mind = await fetchMind(params.id);
  if (!mind) notFound();
  return children;
}
