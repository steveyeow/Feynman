import { SeoColumnSkeleton } from "@/components/seo/EntitySkeleton";

// Instant fallback for the public shared-answer permalink (awaits
// fetchPublicAnswer before render). Streams the shell first instead of a
// blank page.
export default function Loading() {
  return <SeoColumnSkeleton />;
}
