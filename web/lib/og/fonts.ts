/**
 * Font loading for the Satori `/api/og` cards.
 *
 * Satori needs the raw TTF bytes. We fetch Georgia (the project's editorial
 * serif — already shipped at /static/fonts for the Pillow cards) from the
 * site's own static origin and memoize the bytes at module scope so a warm
 * lambda reuses them across renders. Resilient: a fetch failure yields an empty
 * font set, and the route falls back to next/og's built-in font rather than
 * throwing (the card just renders in the default face).
 */

export type OgFont = {
  name: string;
  data: ArrayBuffer;
  weight: 400 | 700;
  style: "normal";
};

const ORIGIN =
  process.env.NEXT_PUBLIC_SITE_URL || "https://feynman.wiki";

let cache: Promise<OgFont[]> | null = null;

async function grab(file: string): Promise<ArrayBuffer | null> {
  try {
    const res = await fetch(`${ORIGIN}/static/fonts/${file}`, {
      // The static asset is immutable; let the platform cache it.
      cache: "force-cache",
    });
    if (!res.ok) return null;
    return await res.arrayBuffer();
  } catch {
    return null;
  }
}

/** Georgia 400 + 700, memoized. Empty array if the static fonts are unreachable. */
export function loadOgFonts(): Promise<OgFont[]> {
  if (!cache) {
    cache = (async () => {
      const [reg, bold] = await Promise.all([
        grab("Georgia-Regular.ttf"),
        grab("Georgia-Bold.ttf"),
      ]);
      const out: OgFont[] = [];
      if (reg) out.push({ name: "Georgia", data: reg, weight: 400, style: "normal" });
      if (bold) out.push({ name: "Georgia", data: bold, weight: 700, style: "normal" });
      return out;
    })();
  }
  return cache;
}
