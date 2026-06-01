/**
 * Next.js config.
 *
 * The Python FastAPI app stays as the JSON API (RAG / minds / qa / Stripe /
 * auth). In dev we proxy /api/* to it so the browser talks same-origin and we
 * avoid CORS. Set API_BASE to point at a running FastAPI (default :8000).
 *
 * In production the same rewrite lets the Next app and the Python API live
 * behind one origin (configured at cutover in vercel.json); nothing here
 * couples us to a specific host.
 */
// Local default matches the `feynman-backend` launch config (port 8001) and
// uses 127.0.0.1 (not "localhost") so Node doesn't resolve to IPv6 ::1 while
// uvicorn binds IPv4 → ECONNREFUSED. Override with API_BASE in other envs.
const API_BASE =
  process.env.API_BASE || process.env.NEXT_PUBLIC_API_BASE || "http://127.0.0.1:8001";

/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    // afterFiles semantics (plain array): these fire only for paths WITHOUT a
    // matching Next page, so /book/[id] (a Next page) is served by Next while
    // /book/[id]/og.png (no page) proxies to Python. /terms + /privacy are NOT
    // rewritten — the Next pages serve them (design-consistent). API + all
    // SEO/OG/share infra stay on the Python backend (Pillow OG images +
    // sitemap/llms corpora are pure-Python, not ported). In prod
    // API_BASE = https://api.feynman.wiki.
    return [
      { source: "/api/:path*", destination: `${API_BASE}/api/:path*` },
      { source: "/sitemap.xml", destination: `${API_BASE}/sitemap.xml` },
      { source: "/sitemap", destination: `${API_BASE}/sitemap` },
      { source: "/robots.txt", destination: `${API_BASE}/robots.txt` },
      { source: "/llms.txt", destination: `${API_BASE}/llms.txt` },
      { source: "/llms-full.txt", destination: `${API_BASE}/llms-full.txt` },
      { source: "/book/:id/og.png", destination: `${API_BASE}/book/:id/og.png` },
      { source: "/mind/:id/og.png", destination: `${API_BASE}/mind/:id/og.png` },
      { source: "/share/:path*", destination: `${API_BASE}/share/:path*` },
    ];
  },
};

export default nextConfig;
