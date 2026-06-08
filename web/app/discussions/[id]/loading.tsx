import { SeoColumnSkeleton } from "@/components/seo/EntitySkeleton";

// Instant fallback for the public shared-discussion permalink (awaits
// fetchPublicDiscussion before render). Streams the shell first instead of a
// blank page.
export default function Loading() {
  return <SeoColumnSkeleton />;
}
