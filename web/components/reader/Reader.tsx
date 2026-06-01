"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import {
  getBookContent,
  getQuestions,
  type BookContent,
  ApiError,
} from "@/lib/reader";
import { useAuth } from "@/lib/auth";
import { savePendingBookIntent } from "@/lib/pendingIntent";
import { track } from "@/lib/analytics";
import styles from "./Reader.module.css";

/**
 * Book Reader — client island. Port of renderReader() in app.js, adapted to the
 * brief's cleaner reading model: instead of the legacy page-flip paginator we
 * render the whole book as one scrollable serif column (calmer, link-shareable,
 * no resize math). Keeps the glass topbar (back · title · details · share) and
 * adds a right sidebar of "try asking" questions that hand off to the home
 * composer.
 *
 * Cross-surface contract: a question click routes to `/?book={id}&q={encoded}`.
 * The home composer (Chat migration) is expected to read those query params and
 * prefill the book context + question. Until then the link is harmless (lands
 * on home).
 */
export default function Reader({ id }: { id: string }) {
  const router = useRouter();
  const { authEnabled, user } = useAuth();
  const [content, setContent] = useState<BookContent | null>(null);
  const [questions, setQuestions] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const shareWrapRef = useRef<HTMLDivElement | null>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Chapter TOC (scroll-spy) — the scroll container is the reading stage.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const [activeChapter, setActiveChapter] = useState<number | "cover" | null>(null);

  const detailsHref = `/book/${encodeURIComponent(id)}`;

  // ── Data load ─────────────────────────────────────────────────────────
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    setContent(null);

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

    // Questions are best-effort and never block the read.
    getQuestions(id)
      .then((qs) => {
        if (alive) setQuestions(qs);
      })
      .catch(() => {});

    return () => {
      alive = false;
    };
  }, [id]);

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

  // ── Chapter TOC (port of reader-toc + active-chapter highlight, adapted to
  //    the scroll model with a scroll-spy IntersectionObserver) ─────────────
  const toc = (content?.sections || [])
    .filter((s) => s.chapter != null)
    .map((s) => ({ num: s.chapter as number, title: s.title || `Chapter ${s.chapter}` }));
  const showToc = !loading && !error && !!content && toc.length >= 2;

  useEffect(() => {
    if (!content?.hasChapters) return;
    const stage = stageRef.current;
    if (!stage) return;
    const els = Array.from(stage.querySelectorAll<HTMLElement>("[data-chapter]"));
    if (els.length < 2) return;
    setActiveChapter((prev) => (prev == null ? "cover" : prev));
    const io = new IntersectionObserver(
      (entries) => {
        const visible = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top);
        const n = visible[0]?.target.getAttribute("data-chapter");
        if (n != null) setActiveChapter(Number(n));
      },
      { root: stage, rootMargin: "0px 0px -65% 0px", threshold: 0 },
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, [content]);

  function jumpToChapter(target: number | "cover") {
    const stage = stageRef.current;
    if (!stage) return;
    if (target === "cover") {
      stage.scrollTo({ top: 0, behavior: "smooth" });
      setActiveChapter("cover");
      return;
    }
    stage
      .querySelector(`#chapter-${target}`)
      ?.scrollIntoView({ behavior: "smooth", block: "start" });
    setActiveChapter(target);
  }

  function askQuestion(q: string) {
    // Anonymous visitor on the hosted build: stash the book they came for + the
    // question, then bounce through login. After sign-up the home composer
    // restores the intent and resumes the chat (port of app.js 4930 +
    // _savePendingBookIntent). Open-source (auth off) or signed-in users go
    // straight to the composer.
    if (authEnabled && !user) {
      savePendingBookIntent(id, { question: q, via: "reader" });
      track("pending_intent_saved", { via: "reader" });
      router.push("/login");
      return;
    }
    router.push(`/?book=${encodeURIComponent(id)}&q=${encodeURIComponent(q)}`);
  }

  const title = content?.title || "";

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
                className={`${styles.tocItem}${activeChapter === "cover" ? " " + styles.tocActive : ""}`}
                onClick={() => jumpToChapter("cover")}
              >
                Cover
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
        <main className={styles.stage} ref={stageRef}>
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

          {!loading && !error && content && content.sections.length > 0 && (
            <article className={styles.book}>
              <header className={styles.cover}>
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
              </header>

              {content.sections.map((s, i) => (
                <section
                  key={s.chapter != null ? `ch-${s.chapter}` : `sec-${i}`}
                  className={styles.section}
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
                    // book text before emitting only its own <p>/<strong>/<em>/<h*> tags.
                    dangerouslySetInnerHTML={{ __html: s.html }}
                  />
                </section>
              ))}

              <footer className={styles.endPage}>
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
                      Chat with this book
                    </button>
                  </>
                ) : (
                  <>
                    <p>End of book</p>
                    <p className={styles.endSub}>
                      Enjoyed this? Share it from the top bar, or{" "}
                      <button
                        type="button"
                        className={styles.copyLinkInline}
                        onClick={copyLink}
                      >
                        copy link
                      </button>
                      .
                    </p>
                  </>
                )}
              </footer>
            </article>
          )}
        </main>

        {questions.length > 0 && (
          <aside className={`chat-sidebar-right visible ${styles.sidebar}`}>
            <h3 className="sidebar-title">TRY ASKING</h3>
            <div className={styles.questionList}>
              {questions.map((q, i) => (
                <button
                  key={i}
                  type="button"
                  className={styles.questionBtn}
                  onClick={() => askQuestion(q)}
                >
                  {q}
                </button>
              ))}
            </div>
          </aside>
        )}
      </div>

      <div className={`${styles.toast} ${toast ? styles.toastShow : ""}`} aria-live="polite">
        {toast}
      </div>
    </div>
  );
}
