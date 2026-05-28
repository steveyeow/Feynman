export default function Home() {
  return (
    <div style={{ maxWidth: 720, margin: "0 auto", padding: "64px 24px" }}>
      <h1 style={{ fontFamily: "var(--font-serif), Georgia, serif", fontSize: 40, margin: 0 }}>
        Chat with Books. Great Minds Join In.
      </h1>
      <p style={{ color: "var(--text-secondary)", fontSize: 18, lineHeight: 1.6, marginTop: 16 }}>
        Unified shell — this page, the SEO content pages, and the interactive app
        all render inside one layout: same sidebar, same logo, same account. This
        is the Phase&nbsp;0 foundation for the Next.js migration.
      </p>
    </div>
  );
}
