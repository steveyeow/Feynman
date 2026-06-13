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
  async redirects() {
    // The feature shipped briefly at /debate(s) before being renamed to
    // /symposium(s). Those URLs were in one sitemap render, so 301 them so any
    // early crawl consolidates onto the new path instead of 404-ing.
    return [
      { source: "/debate/:slug", destination: "/symposium/:slug", permanent: true },
      { source: "/debates", destination: "/symposiums", permanent: true },
    ];
  },
  async rewrites() {
    // Local-dev proxy so the browser talks same-origin to the FastAPI on :8001.
    // PRODUCTION rewrites (incl. SEO/OG/share → the Python backend) live in
    // web/vercel.json — that file is also what makes feynman-web read its OWN
    // config instead of falling back to the repo-root (Python) vercel.json.
    return [
      { source: "/api/:path*", destination: `${API_BASE}/api/:path*` },
    ];
  },
};

export default nextConfig;
