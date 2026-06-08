import EntitySkeleton from "@/components/seo/EntitySkeleton";

// Instant Suspense fallback for /mind/[id] (the page awaits the mind + 6 parallel
// enrichment fetches). Without it, clicking a mind's Profile sat on the previous
// page with no feedback for the whole round-trip.
export default function Loading() {
  return <EntitySkeleton variant="mind" />;
}
