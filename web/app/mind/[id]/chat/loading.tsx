import AppShell from "@/components/shell/AppShell";

// Instant fallback for the 1:1 mind chat (force-dynamic → always awaits fetchMind
// before render). A chat-shaped shimmer inside the app shell beats a blank page
// while the mind loads. Its own loading.tsx (rather than the parent /mind/[id]
// one) keeps the profile skeleton from flashing on a chat navigation.
function Bar({ w, h = 14, r = 6, mt = 0 }: { w: number | string; h?: number; r?: number; mt?: number }) {
  return (
    <span
      className="skeleton-block"
      style={{ display: "block", width: w, height: h, borderRadius: r, marginTop: mt }}
      aria-hidden="true"
    />
  );
}

export default function Loading() {
  return (
    <AppShell>
      <div
        style={{ maxWidth: 760, margin: "0 auto", padding: "32px 20px", width: "100%" }}
        aria-busy="true"
        aria-label="Loading chat"
      >
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span className="skeleton-block" style={{ width: 44, height: 44, borderRadius: "50%" }} aria-hidden="true" />
          <div>
            <Bar w={160} h={18} r={6} />
            <Bar w={100} h={12} mt={8} />
          </div>
        </div>
        <Bar w="85%" h={14} mt={40} />
        <Bar w="92%" h={14} mt={12} />
        <Bar w="60%" h={14} mt={12} />
        <div style={{ marginTop: 28 }}>
          <Bar w="100%" h={52} r={16} />
        </div>
      </div>
    </AppShell>
  );
}
