import Sidebar from "./Sidebar";

/**
 * The one app frame. Reproduces index.html's `.app-layout > (.app-sidebar +
 * .app-main)` structure so styles.css applies unchanged. Every page — app
 * surfaces AND SEO entity pages — renders inside this, which is what makes the
 * site feel like one product instead of two.
 */
export default function AppShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="app-layout" id="app-layout">
      <Sidebar />
      <div className="app-main">{children}</div>
    </div>
  );
}
