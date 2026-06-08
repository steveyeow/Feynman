"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";

/**
 * Persistent "Chat with {mind}" affordance for the long SEO mind page. The hero
 * has the primary Chat button, but it scrolls away — an engaged reader who gets
 * to the bottom (voice → perspectives → phrases → bio → works) has no way to
 * start a chat without scrolling back up. This floating accent pill fades in
 * ONLY after the hero has scrolled out of view (so it's never present at the top
 * = not obtrusive), and works regardless of which element is the scroll
 * container (IntersectionObserver on an in-flow sentinel, not window.scrollY).
 */
export default function MindStickyCta({ name, href }: { name: string; href: string }) {
  const sentinel = useRef<HTMLSpanElement>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    const el = sentinel.current;
    if (!el) return;
    const io = new IntersectionObserver(
      ([entry]) => setShow(entry.boundingClientRect.top < 0),
      { threshold: 0 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <>
      {/* In-flow marker near the top of the content; once it scrolls above the
          viewport the pill appears. */}
      <span ref={sentinel} aria-hidden="true" style={{ display: "block", height: 0 }} />
      <Link
        href={href}
        className={`mind-sticky-cta${show ? " visible" : ""}`}
        aria-hidden={!show}
        tabIndex={show ? 0 : -1}
      >
        Chat with {name}
        <span className="mind-sticky-cta-arrow" aria-hidden="true">→</span>
      </Link>
    </>
  );
}
