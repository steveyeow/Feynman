"use client";

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type TouchEvent as ReactTouchEvent,
} from "react";
import { useRouter } from "next/navigation";
import {
  getBookContent,
  type BookContent,
  ApiError,
} from "@/lib/reader";
import { useAuth } from "@/lib/auth";
import { savePendingBookIntent } from "@/lib/pendingIntent";
import { track } from "@/lib/analytics";
import styles from "./Reader.module.css";

/**
 * Book Reader — client island. Port of renderReader() in app.js, restoring the
 * legacy horizontal PAGE-FLIP model: the book flows into viewport-height CSS
 * columns and we translateX between them. Navigate with ←/→ (and space/Home/
 * End), edge arrows, or swipe; a page counter + progress bar track position.
 * The cover and each chapter start on a fresh page; the TOC jumps by page.
 * Keeps the glass topbar (back · title · details · share) and the right
 * "try asking" sidebar.
 *
 * Cross-surface contract: a question click routes to `/?book={id}&q={encoded}`.
 */
export default function Reader({ id }: { id: string }) {
  const router = useRouter();
  const { authEnabled, user } = useAuth();
  const [content, setContent] = useState<BookContent | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const shareWrapRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Page-flip state ───────────────────────────────────────────────────
  const viewportRef = useRef<HTMLDivElement | null>(null); // overflow-clip box
  const flowRef = useRef<HTMLDivElement | null>(null); // the multi-column flow
  const windowRef = useRef<HTMLDivElement | null>(null); // the one-page clip window
  const flipDir = useRef<"left" | "right">("right");
  const firstFlip = useRef(true);
  const [page, setPage] = useState(0);
  const [totalPages, setTotalPages] = useState(1);
  // colW = one page's text measure; gap = off-screen spacing; step = flip stride;
  // pageH = usable column height (drives the centered cover).
  const [metrics, setMetrics] = useState({
    colW: 0,
    gap: 72,
    padV: 44,
    step: 0,
    pageH: 0,
  });
  const [activeChapter, setActiveChapter] = useState<number | "cover" | null>(
    null,
  );
  const chapterPagesRef = useRef<Map<number, number>>(new Map());
  const pageRef = useRef(0);
  pageRef.current = page;
  const totalRef = useRef(1);
  totalRef.current = totalPages;

  const detailsHref = `/book/${encodeURIComponent(id)}`;

  // ── Data load ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setContent(null);
    setPage(0);

    (async () => {
      try {
        // Hosted + anonymous → the public read endpoint (shared-link reads must
        // not 401 → /login). Open-source / signed-in → the authed endpoint.
        const usePublic = authEnabled && !user;
        const c = await getBookContent(id, { publicRead: usePublic });
        if (!alive) return;
        setContent(c);
      } catch (e) {
        if (!alive) return;
        const status = e instanceof ApiError ? e.status : 0;
        setError(
          status === 404
            ? "This book has no readable content yet."
            : "Couldn't load this book. Is the API running?",
        );
      } finally {
        if (alive) setLoading(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, [id]);

  // ── Pagination measurement ──────────────────────────────────────────────
  // Two passes (both pre-paint, so no flash): (1) derive the column metrics from
  // the viewport size → state → React applies them; (2) read the laid-out flow's
  // scrollWidth → page count + per-chapter start pages.
  const measureMetrics = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const W = vp.clientWidth;
    const H = vp.clientHeight;
    if (!W || !H) return;
    const minMargin = W < 700 ? 22 : 56;
    const colW = Math.max(240, Math.min(W - 2 * minMargin, 660));
    const padV = H < 560 ? 28 : 44;
    const gap = 72;
    setMetrics((m) =>
      m.colW === colW && m.padV === padV && m.pageH === H - 2 * padV
        ? m
        : { colW, gap, padV, step: colW + gap, pageH: H - 2 * padV },
    );
  }, []);

  useLayoutEffect(() => {
    if (!content || content.sections.length === 0) return;
    measureMetrics();
    const vp = viewportRef.current;
    if (!vp) return;
    const ro = new ResizeObserver(() => measureMetrics());
    ro.observe(vp);
    return () => ro.disconnect();
  }, [content, measureMetrics]);

  useLayoutEffect(() => {
    const flow = flowRef.current;
    if (!flow || !content || content.sections.length === 0 || metrics.colW === 0)
      return;
    const sw = flow.scrollWidth;
    const total = Math.max(1, Math.round((sw + metrics.gap) / metrics.step));
    const map = new Map<number, number>();
    flow.querySelectorAll<HTMLElement>("[data-chapter]").forEach((el) => {
      const ch = Number(el.getAttribute("data-chapter"));
      if (!Number.isNaN(ch)) map.set(ch, Math.round(el.offsetLeft / metrics.step));
    });
    chapterPagesRef.current = map;
    setTotalPages(total);
    setPage((p) => Math.min(p, total - 1));
  }, [metrics, content]);

  // Active chapter follows the current page (largest chapter whose start ≤ page).
  useEffect(() => {
    if (!content?.hasChapters) return;
    const entries = Array.from(chapterPagesRef.current.entries()).sort(
      (a, b) => a[1] - b[1],
    );
    let active: number | "cover" = "cover";
    for (const [ch, start] of entries) {
      if (page >= start) active = ch;
      else break;
    }
    setActiveChapter(active);
  }, [page, content, totalPages]);

  // Replay the legacy fade-shift on each page turn — the flow is positioned
  // instantly (no transition); the window plays flipLeft/flipRight (opacity +
  // 12px shift), matching the old innerHTML page swap. Skip the initial mount.
  useEffect(() => {
    if (firstFlip.current) {
      firstFlip.current = false;
      return;
    }
    const el = windowRef.current;
    if (!el) return;
    el.classList.remove(styles.flipLeft, styles.flipRight);
    void el.offsetWidth; // reflow to restart the CSS animation
    el.classList.add(
      flipDir.current === "left" ? styles.flipLeft : styles.flipRight,
    );
  }, [page]);

  // ── Navigation ──────────────────────────────────────────────────────────
  const goToPage = useCallback((n: number) => {
    const clamped = Math.max(0, Math.min(n, totalRef.current - 1));
    flipDir.current = clamped < pageRef.current ? "left" : "right";
    setPage(clamped);
  }, []);
  const prev = useCallback(() => goToPage(pageRef.current - 1), [goToPage]);
  const next = useCallback(() => goToPage(pageRef.current + 1), [goToPage]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const el = e.target as Element | null;
      if (
        el &&
        ((el.closest &&
          el.closest("input, textarea, select, [contenteditable='true']")) ||
          (el as HTMLElement).isContentEditable)
      )
        return;
      if (e.key === "ArrowRight" || e.key === " ") {
        e.preventDefault();
        next();
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        prev();
      } else if (e.key === "Home") {
        e.preventDefault();
        goToPage(0);
      } else if (e.key === "End") {
        e.preventDefault();
        goToPage(totalRef.current - 1);
      }
    }
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [next, prev, goToPage]);

  // Swipe (touch) on the viewport.
  const touchX = useRef<number | null>(null);
  function onTouchStart(e: ReactTouchEvent) {
    touchX.current = e.changedTouches[0]?.clientX ?? null;
  }
  function onTouchEnd(e: ReactTouchEvent) {
    if (touchX.current == null) return;
    const dx = (e.changedTouches[0]?.clientX ?? 0) - touchX.current;
    if (Math.abs(dx) > 45) {
      if (dx < 0) next();
      else prev();
    }
    touchX.current = null;
  }

  // ── Share popup: close on outside click / Escape ──────────────────────
  useEffect(() => {
    if (!shareOpen) return;
    function onDocClick(e: MouseEvent) {
      if (!shareWrapRef.current?.contains(e.target as Node)) setShareOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setShareOpen(false);
    }
    document.addEventListener("click", onDocClick, true);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("click", onDocClick, true);
      document.removeEventListener("keydown", onKey);
    };
  }, [shareOpen]);

  // Clear any pending toast timer on unmount.
  useEffect(() => {
    return () => {
      if (toastTimer.current) clearTimeout(toastTimer.current);
    };
  }, []);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  // ── Share helpers (port of reader-share-* handlers) ───────────────────
  const shareUrl =
    typeof window !== "undefined"
      ? `${window.location.origin}/book/${encodeURIComponent(id)}`
      : `https://feynman.wiki/book/${encodeURIComponent(id)}`;

  function copyLink() {
    navigator.clipboard?.writeText(shareUrl).then(
      () => showToast("Link copied"),
      () => showToast("Couldn't copy link"),
    );
    setShareOpen(false);
  }

  function shareOnX() {
    const author = (content?.author || "").replace(/ · AI$/, "");
    const text = encodeURIComponent(
      `${content?.title || "A book"} — by ${author || "AI"} on Feynman`,
    );
    const url = encodeURIComponent(shareUrl);
    window.open(
      `https://twitter.com/intent/tweet?text=${text}&url=${url}`,
      "_blank",
      "noopener,noreferrer",
    );
    setShareOpen(false);
  }

  function goBack() {
    if (typeof window !== "undefined" && window.history.length > 1) {
      router.back();
    } else {
      router.push("/library");
    }
  }

  // ── Chapter TOC → jump by page ────────────────────────────────────────
  const toc = (content?.sections || [])
    .filter((s) => s.chapter != null)
    .map((s) => ({
      num: s.chapter as number,
      title: s.title || `Chapter ${s.chapter}`,
    }));
  const showToc = !loading && !error && !!content && toc.length >= 2;

  function jumpToChapter(target: number | "cover") {
    if (target === "cover") {
      goToPage(0);
      return;
    }
    const p = chapterPagesRef.current.get(target);
    if (p != null) goToPage(p);
  }

  function askQuestion(q: string) {
    // Anonymous visitor on the hosted build: stash the book + question, then
    // bounce through login (port of app.js 4930 + _savePendingBookIntent).
    if (authEnabled && !user) {
      savePendingBookIntent(id, { question: q, via: "reader" });
      track("pending_intent_saved", { via: "reader" });
      router.push("/login");
      return;
    }
    router.push(`/?book=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`);
  }

  const title = content?.title || "";
  const paginated = !loading && !error && !!content && content.sections.length > 0;
  const progress =
    totalPages > 1 ? Math.round((page / (totalPages - 1)) * 100) : 0;

  // ── Render ────────────────────────────────────────────────────────────
  return (
    <div className={styles.reader}>
      <div className="reader-topbar">
        <button
          type="button"
          className="reader-back-btn"
          title="Back"
          aria-label="Back"
          onClick={goBack}
        >
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="15 18 9 12 15 6" />
          </svg>
        </button>
        <div className="reader-topbar-title">{title}</div>

        <button
          type="button"
          className="reader-topbar-details-btn"
          aria-label="Book details"
          title="Book details"
          onClick={() => router.push(detailsHref)}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="10" />
            <line x1="12" y1="16" x2="12" y2="12" />
            <line x1="12" y1="8" x2="12.01" y2="8" />
          </svg>
        </button>

        <div
          className={`reader-topbar-share-wrap${shareOpen ? " open" : ""}`}
          ref={shareWrapRef}
        >
          <button
            type="button"
            className="reader-topbar-share-trigger"
            aria-label="Share"
            title="Share"
            onClick={(e) => {
              e.stopPropagation();
              setShareOpen((o) => !o);
            }}
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M4 12v8a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-8" />
              <polyline points="16 6 12 2 8 6" />
              <line x1="12" y1="2" x2="12" y2="15" />
            </svg>
          </button>
          <div className="reader-topbar-share-popup">
            <button type="button" className="reader-topbar-share-opt" onClick={shareOnX}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
              Post on X
            </button>
            <button type="button" className="reader-topbar-share-opt" onClick={copyLink}>
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                <path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71" />
                <path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71" />
              </svg>
              Copy link
            </button>
          </div>
        </div>
      </div>

      <div className={styles.layout}>
        {showToc && (
          <aside className={styles.toc} aria-label="Chapters">
            <nav className={styles.tocNav}>
              <button
                type="button"
                className={`${styles.tocItem} ${styles.tocCover}${activeChapter === "cover" ? " " + styles.tocActive : ""}`}
                onClick={() => jumpToChapter("cover")}
              >
                <span className={styles.tocNum}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z" />
                    <path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z" />
                  </svg>
                </span>
                <span className={styles.tocLabel}>Cover</span>
              </button>
              {toc.map((t) => (
                <button
                  key={t.num}
                  type="button"
                  className={`${styles.tocItem}${activeChapter === t.num ? " " + styles.tocActive : ""}`}
                  onClick={() => jumpToChapter(t.num)}
                  title={t.title}
                >
                  <span className={styles.tocNum}>{t.num}</span>
                  <span className={styles.tocLabel}>{t.title}</span>
                </button>
              ))}
            </nav>
          </aside>
        )}
        <main
          className={styles.stage}
          ref={viewportRef}
          onTouchStart={onTouchStart}
          onTouchEnd={onTouchEnd}
        >
          {loading && (
            <div className="reader-loading">
              <span className={styles.dot}>Loading book…</span>
            </div>
          )}

          {!loading && error && (
            <div className="reader-empty">
              <p>{error}</p>
              <button type="button" className={styles.emptyAction} onClick={goBack}>
                ← Back
              </button>
            </div>
          )}

          {!loading && !error && content && content.sections.length === 0 && (
            <div className="reader-empty">
              <p>This book is still being prepared.</p>
              <button
                type="button"
                className={styles.emptyAction}
                onClick={() => router.push("/library")}
              >
                ← Back to Library
              </button>
            </div>
          )}

          {paginated && content && (
            <div
              className={styles.window}
              ref={windowRef}
              style={{ width: metrics.colW || undefined }}
            >
            <div
              className={styles.flow}
              ref={flowRef}
              style={
                {
                  width: metrics.colW || undefined,
                  columnWidth: metrics.colW || undefined,
                  columnGap: metrics.gap,
                  paddingTop: metrics.padV,
                  paddingBottom: metrics.padV,
                  "--page-h": `${metrics.pageH}px`,
                  transform: `translateX(${-page * metrics.step}px)`,
                } as CSSProperties
              }
            >
              <article className={styles.book}>
                <header className={`${styles.cover} ${styles.pageBreakAfter}`}>
                  <div className={styles.coverBody}>
                    <h1 className={styles.coverTitle}>{content.title}</h1>
                    {content.subtitle && (
                      <p className={styles.coverSubtitle}>{content.subtitle}</p>
                    )}
                    {content.author && (
                      <p className={styles.coverAuthor}>{content.author}</p>
                    )}
                    <div className={styles.coverStats}>
                      <span>{content.totalWords.toLocaleString()} words</span>
                      <span className={styles.dot2} />
                      <span>~{content.readMinutes} min read</span>
                      {content.hasChapters && (
                        <>
                          <span className={styles.dot2} />
                          <span>{content.sections.length} chapters</span>
                        </>
                      )}
                    </div>
                    {content.contentTier === "preview" && (
                      <span className={styles.previewLabel}>Preview</span>
                    )}
                  </div>
                  {/* Publisher imprint — Feynman logo, AI books only (legacy). */}
                  {content.type === "ai_book" && (
                    <div className={styles.imprint}>
                      <svg className={styles.imprintLogo} width="22" height="22" viewBox="0 0 64 64" fill="none">
                        <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                        <circle cx="32" cy="30" r="3.5" fill="currentColor" />
                        <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                      </svg>
                      <span className={styles.imprintName}>Feynman</span>
                    </div>
                  )}
                </header>

                {content.sections.map((s, i) => (
                  <section
                    key={s.chapter != null ? `ch-${s.chapter}` : `sec-${i}`}
                    className={`${styles.section}${s.chapter != null ? " " + styles.pageBreakBefore : ""}`}
                    id={s.chapter != null ? `chapter-${s.chapter}` : undefined}
                    data-chapter={s.chapter != null ? s.chapter : undefined}
                  >
                    {s.title && (
                      <div className={styles.chapterHeader}>
                        {s.chapter != null && (
                          <span className={styles.chapterNum}>
                            Chapter {s.chapter}
                          </span>
                        )}
                        <h2 className={styles.chapterTitle}>{s.title}</h2>
                      </div>
                    )}
                    <div
                      className={styles.prose}
                      // Sanitized at build time: renderReaderMarkdown escapes all
                      // book text before emitting only its own tags.
                      dangerouslySetInnerHTML={{ __html: s.html }}
                    />
                  </section>
                ))}

                <footer className={`${styles.endPage} ${styles.pageBreakBefore}`}>
                  {content.contentTier === "preview" ? (
                    <>
                      <p>End of preview</p>
                      <p className={styles.endSub}>
                        Chat with this book to explore further
                      </p>
                      <button
                        type="button"
                        className={styles.endChatBtn}
                        onClick={() => askQuestion("")}
                      >
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                          <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                        </svg>
                        Chat
                      </button>
                    </>
                  ) : (
                    <>
                      <p>End of book</p>
                      <p className={styles.endSub}>
                        Enjoyed this book? Use the share control in the top bar, or{" "}
                        <button
                          type="button"
                          className={styles.copyLinkInline}
                          onClick={copyLink}
                        >
                          copy link
                        </button>
                      </p>
                    </>
                  )}
                </footer>
              </article>
            </div>
            </div>
          )}

          {/* Page-flip controls (only with >1 page) */}
          {paginated && totalPages > 1 && (
            <>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.navPrev}`}
                aria-label="Previous page"
                onClick={prev}
                style={{ visibility: page === 0 ? "hidden" : undefined }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="15 18 9 12 15 6" />
                </svg>
              </button>
              <button
                type="button"
                className={`${styles.navBtn} ${styles.navNext}`}
                aria-label="Next page"
                onClick={next}
                style={{ visibility: page >= totalPages - 1 ? "hidden" : undefined }}
              >
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="9 18 15 12 9 6" />
                </svg>
              </button>
              <div className={styles.pageNum} aria-live="polite">
                {page + 1} / {totalPages}
              </div>
            </>
          )}
        </main>
      </div>

      {paginated && totalPages > 1 && (
        <div className={styles.progressBar}>
          <div className={styles.progressFill} style={{ width: `${progress}%` }} />
        </div>
      )}

      <div className={`${styles.toast} ${toast ? styles.toastShow : ""}`} aria-live="polite">
        {toast}
      </div>
    </div>
  );
}
