/**
 * Renders a JSON-LD structured-data block. Used by every SEO entity page.
 * Server component (no client JS). Pass a schema.org object (or array).
 */
export default function JsonLd({ data }: { data: unknown }) {
  return (
    <script
      type="application/ld+json"
      dangerouslySetInnerHTML={{ __html: JSON.stringify(data) }}
    />
  );
}
