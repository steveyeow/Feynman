import { notFound } from "next/navigation";
import { getBookData } from "@/lib/seo-book";

// Entity gate for every /book/[id]/* route. It must live in the LAYOUT —
// above the loading.tsx Suspense boundary — because once that boundary
// flushes its 200 shell, a notFound() anywhere lower (page body, even
// generateMetadata) can no longer set the status code: the dead URL serves
// HTTP 200 and Google files it as Soft 404 (GSC alert 2026-08-08), then
// keeps recrawling it. The layout resolves before the first byte, so a
// missing book is a real 404. Request-deduped with the page's own
// getBookData call — no extra backend fetch.
export default async function BookEntityLayout({
  params,
  children,
}: {
  params: { id: string };
  children: React.ReactNode;
}) {
  const data = await getBookData(params.id);
  if (!data) notFound();
  return children;
}
