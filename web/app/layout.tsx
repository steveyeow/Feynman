import type { Metadata } from "next";
import "@/styles/app.css";
// Loaded AFTER app.css: re-skins the product to macOS Tahoe Liquid Glass by
// overriding the design tokens + layering glass onto the control layer.
import "@/styles/liquid.css";
import ClientProviders from "@/components/providers/ClientProviders";

export const metadata: Metadata = {
  title: "Feynman — Chat with Books. Great Minds Join In.",
  description:
    "An interactive knowledge network built on the world's most important books and great minds. Chat with any book, explore topics with AI-curated sources, and discuss ideas with simulated great thinkers.",
  metadataBase: new URL("https://feynman.wiki"),
};

// Replicates the legacy theme-init trick (index.html): apply the saved theme
// class to <html> before first paint to avoid a flash of the wrong theme.
const THEME_INIT = `(function(){try{var t=localStorage.getItem('feynman-theme');if(t)document.documentElement.classList.add(t);}catch(e){}})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT }} />
      </head>
      <body>
        <ClientProviders>{children}</ClientProviders>
      </body>
    </html>
  );
}
