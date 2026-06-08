import EntitySkeleton from "@/components/seo/EntitySkeleton";

// Instant Suspense fallback for /topic/[slug] — the most frequently navigated
// SEO hub (4 parallel fetches: agents, minds, topics, overview). Without it,
// clicking a topic sat on the previous page with no feedback.
export default function Loading() {
  return <EntitySkeleton variant="topic" />;
}
