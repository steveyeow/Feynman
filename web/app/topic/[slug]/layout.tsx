import { notFound } from "next/navigation";
import { resolveTopicSlug } from "@/lib/seo-mind";

// Entity gate for /topic/[slug] — real 404 for unknown topics.
// Must be a layout (above the loading.tsx boundary): see /book/[id]/layout.
export default async function TopicEntityLayout({
  params,
  children,
}: {
  params: { slug: string };
  children: React.ReactNode;
}) {
  const topic = await resolveTopicSlug(params.slug);
  if (!topic) notFound();
  return children;
}
