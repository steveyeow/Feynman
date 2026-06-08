import EntitySkeleton from "@/components/seo/EntitySkeleton";

// Instant Suspense fallback for /book/[id] (the page awaits 5 enrichment fetches
// before first byte). Without it, clicking a book's Details sat on the previous
// page with no feedback for the whole round-trip.
export default function Loading() {
  return <EntitySkeleton variant="book" />;
}
