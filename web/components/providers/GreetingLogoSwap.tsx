"use client";

import { useEffect } from "react";

/**
 * Auto-swaps the greeting logo between the pixel-book and the Feynman-diagram —
 * faithful port of app.js `startGreetingIconSwap`. A single global timer toggles
 * the `.swap` class (with a bounce) on every VISIBLE `.greeting-logo-wrap` in the
 * DOM, so the home greeting AND the landing-page demo logo both alternate. Cadence
 * matches production: 2.5s, 4s, 6s, then every 8–20s. Renders nothing.
 */
export default function GreetingLogoSwap() {
  useEffect(() => {
    let stopped = false;
    let timer: number | undefined;
    const intervals = [2500, 4000, 6000];
    let tick = 0;

    const doSwap = () => {
      document.querySelectorAll<HTMLElement>(".greeting-logo-wrap").forEach((wrap) => {
        if (wrap.offsetParent === null) return; // skip hidden wraps
        wrap.classList.add("bounce");
        window.setTimeout(() => wrap.classList.toggle("swap"), 200);
        wrap.addEventListener("animationend", () => wrap.classList.remove("bounce"), {
          once: true,
        });
      });
    };

    const scheduleNext = () => {
      if (stopped) return;
      const delay =
        tick < intervals.length ? intervals[tick++] : 8000 + Math.random() * 12000;
      timer = window.setTimeout(() => {
        doSwap();
        scheduleNext();
      }, delay);
    };
    scheduleNext();

    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  return null;
}
