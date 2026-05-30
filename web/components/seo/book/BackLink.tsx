/**
 * Small "← back to parent entity" link used at the top of compound pages
 * (/q/{slug}, /insights). Mirrors the legacy <nav class="qa-back"> etc.
 */
import Link from "next/link";

export default function BackLink({
  href,
  label,
}: {
  href: string;
  label: string;
}) {
  return (
    <nav className="seo-back">
      <Link href={href}>← {label}</Link>
    </nav>
  );
}
