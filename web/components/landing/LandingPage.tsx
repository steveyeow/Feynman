"use client";

import { useEffect, useRef, useCallback } from "react";
import { get } from "@/lib/api";
import ThemeToggle from "@/components/theme/ThemeToggle";
import styles from "./LandingPage.module.css";

/* ============================================================
   Demo chat scenes — copy VERBATIM from legacy app.js.
   The card animates these with no backend; hardcoded on purpose.
   ============================================================ */
type DemoMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; sources: string[] }
  | { role: "join"; mind: string }
  | { role: "mind"; mind: string; text: string };

type DemoScene = {
  book: string;
  author: string | null;
  messages: DemoMessage[];
};

const DEMO_SCENES: DemoScene[] = [
  {
    book: "Thinking, Fast and Slow",
    author: "Daniel Kahneman",
    messages: [
      { role: "user", text: "Why do smart people make irrational decisions?" },
      {
        role: "assistant",
        text: 'Because we run on two systems. System 1 is fast and intuitive; System 2 is slow and deliberate. Most "irrational" choices are System 1 shortcuts firing when we think we\'re reasoning carefully.',
        sources: ["Ch. 1 — The Two Systems", "Ch. 5 — Cognitive Ease"],
      },
      { role: "join", mind: "Daniel Kahneman" },
      {
        role: "mind",
        mind: "Daniel Kahneman",
        text: "The key insight: we have far more confidence in our judgments than is warranted. WYSIATI — what you see is all there is.",
      },
    ],
  },
  {
    book: "General Chat",
    author: null,
    messages: [
      { role: "user", text: "What should I read to understand how the mind works?" },
      {
        role: "assistant",
        text: "Start with the tension between intuition and reason. Kahneman maps the machinery; then bring in the philosophers who asked what a mind even is.",
        sources: [],
      },
      { role: "join", mind: "William James" },
      {
        role: "mind",
        mind: "William James",
        text: "Begin with attention. My definition still holds: it is the taking possession by the mind, in clear and vivid form, of one out of several possible objects.",
      },
    ],
  },
  {
    book: "The Art of War",
    author: "Sun Tzu",
    messages: [
      { role: "user", text: "How do I win without fighting?" },
      {
        role: "assistant",
        text: "Supreme excellence is breaking the enemy's resistance without fighting. Win first through position, information, and timing—then the battle is a formality.",
        sources: ["Ch. 3 — Attack by Stratagem"],
      },
      { role: "join", mind: "Sun Tzu" },
      {
        role: "mind",
        mind: "Sun Tzu",
        text: "Know the enemy and know yourself; in a hundred battles you will never be in peril. The greatest victory requires no battle.",
      },
    ],
  },
];

const SEARCH_TERMS = [
  "Stoic philosophy",
  "quantum mechanics",
  "strategy & war",
  "the human mind",
  "creativity",
];

/* ---- Deterministic avatar helpers (ported from app.js) ---- */
function initialsFor(name: string): string {
  const parts = String(name || "")
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

function colorFor(name: string): string {
  let h = 0;
  const s = String(name || "");
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) % 360;
  return `hsl(${h}, 70%, 55%)`;
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}

/* ---- Static constellation fallback (drawn once) when the minds API is empty
   or down — a tasteful scatter of nodes + a few proximity links, so the
   background never goes blank. Kept faint; the host element sets the color +
   low opacity. ---- */
function drawConstellation(
  ctx: CanvasRenderingContext2D,
  W: number,
  H: number,
  color: string
) {
  ctx.clearRect(0, 0, W, H);
  // Deterministic-ish scatter via a tiny LCG so it doesn't reshuffle on resize.
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const count = Math.max(18, Math.min(46, Math.round((W * H) / 42000)));
  const pts: Array<{ x: number; y: number; r: number }> = [];
  for (let i = 0; i < count; i++) {
    pts.push({
      x: rand() * W,
      y: rand() * H,
      r: 2 + rand() * 3.5,
    });
  }
  // Links between nearby points.
  ctx.strokeStyle = color;
  ctx.lineWidth = 1;
  const maxD = Math.min(W, H) * 0.22;
  for (let i = 0; i < pts.length; i++) {
    for (let j = i + 1; j < pts.length; j++) {
      const dx = pts[i].x - pts[j].x;
      const dy = pts[i].y - pts[j].y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < maxD) {
        ctx.globalAlpha = 0.1 * (1 - d / maxD);
        ctx.beginPath();
        ctx.moveTo(pts[i].x, pts[i].y);
        ctx.lineTo(pts[j].x, pts[j].y);
        ctx.stroke();
      }
    }
  }
  // Nodes.
  ctx.fillStyle = color;
  pts.forEach((p) => {
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
}

/* ---- Safely extract an array from an API payload that may be either a bare
   array or an object wrapping it under `key` (matches legacy defensiveness). ---- */
function pickArray<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
}

/* ---- Build a message row matching the legacy markup, scoped classnames.
   `typed === true` leaves text bubbles empty so the caller can type into them;
   otherwise the full text is rendered immediately (static / final state). ---- */
function buildMessageRow(
  styles: Record<string, string>,
  msg: DemoMessage,
  typed: boolean
): HTMLDivElement {
  const row = document.createElement("div");
  const roleClass =
    msg.role === "user"
      ? styles.msgUser
      : msg.role === "assistant"
      ? styles.msgAssistant
      : msg.role === "join"
      ? styles.msgJoin
      : styles.msgMind;
  row.className = `${styles.msg} ${roleClass}`;

  if (msg.role === "user") {
    const bubble = document.createElement("div");
    bubble.className = styles.bubble;
    bubble.textContent = msg.text;
    row.appendChild(bubble);
  } else if (msg.role === "assistant") {
    const bubble = document.createElement("div");
    bubble.className = styles.bubble;
    if (!typed) bubble.textContent = msg.text;
    row.appendChild(bubble);
    if (msg.sources && msg.sources.length) {
      const src = document.createElement("div");
      src.className = styles.sources;
      msg.sources.forEach((s) => {
        const chip = document.createElement("span");
        chip.className = styles.sourceChip;
        chip.textContent = s;
        src.appendChild(chip);
      });
      row.appendChild(src);
    }
  } else if (msg.role === "join") {
    const pill = document.createElement("div");
    pill.className = styles.joinPill;
    const avatar = document.createElement("span");
    avatar.className = styles.joinAvatar;
    avatar.style.background = colorFor(msg.mind);
    avatar.textContent = initialsFor(msg.mind);
    pill.appendChild(avatar);
    pill.appendChild(
      document.createTextNode(`${msg.mind} joined the conversation`)
    );
    row.appendChild(pill);
  } else {
    // mind
    const avatar = document.createElement("div");
    avatar.className = styles.msgAvatar;
    avatar.style.background = colorFor(msg.mind);
    avatar.textContent = initialsFor(msg.mind);
    row.appendChild(avatar);
    const bubble = document.createElement("div");
    bubble.className = styles.bubble;
    if (!typed) bubble.textContent = msg.text;
    row.appendChild(bubble);
  }
  return row;
}

/* ---- Brand mark (Feynman diagram), ported from _brandMarkSVG ---- */
function BrandMark() {
  return (
    <svg
      className={styles.brandMark}
      width="28"
      height="28"
      viewBox="0 0 100 100"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      aria-hidden="true"
    >
      <circle cx="50" cy="50" r="6" fill="currentColor" />
      <path
        d="M50 50 L20 20 M50 50 L80 20 M50 50 L20 80 M50 50 L80 80"
        stroke="currentColor"
        strokeWidth="3"
        strokeLinecap="round"
      />
      <path
        d="M20 20 Q50 5 80 20"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <path
        d="M20 80 Q50 95 80 80"
        stroke="currentColor"
        strokeWidth="3"
        fill="none"
        strokeLinecap="round"
      />
      <circle cx="20" cy="20" r="4" fill="currentColor" />
      <circle cx="80" cy="20" r="4" fill="currentColor" />
      <circle cx="20" cy="80" r="4" fill="currentColor" />
      <circle cx="80" cy="80" r="4" fill="currentColor" />
    </svg>
  );
}

type GraphNode = {
  id: string;
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};
type GraphLink = { source: GraphNode; target: GraphNode; w: number };

export function LandingPage({
  ctaLabel,
  onCta,
}: {
  ctaLabel: string;
  onCta: () => void;
}) {
  // Refs to the live DOM the animations imperatively drive (mirrors legacy).
  const composerInputRef = useRef<HTMLDivElement>(null);
  const messagesRef = useRef<HTMLDivElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLDivElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);

  // Timers / handles tracked for cleanup (the legacy _stopLandingAnimations set).
  const chatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const mindsRAF = useRef<number | null>(null);
  const mindsResize = useRef<(() => void) | null>(null);
  const aborted = useRef(false);

  /* ---- Render one full scene instantly (reduced-motion / fallback) ---- */
  const renderSceneStatic = useCallback((idx: number) => {
    const messagesEl = messagesRef.current;
    const card = cardRef.current;
    if (!messagesEl || !card) return;
    const scene = DEMO_SCENES[idx];
    card.classList.add(styles.chatCardActive);
    messagesEl.innerHTML = "";
    scene.messages.forEach((msg) => {
      messagesEl.appendChild(buildMessageRow(styles, msg, false));
    });
  }, []);

  /* ---- Animated chat demo (ports _startLandingChatDemo timing exactly) ---- */
  const startChatDemo = useCallback(() => {
    const composerInput = composerInputRef.current;
    const messagesEl = messagesRef.current;
    const card = cardRef.current;
    if (!composerInput || !messagesEl || !card) return;

    // Type body text into an element: +2 chars every `speed` ms, then a 1s
    // pause before `done` — verbatim from legacy typeText.
    const typeText = (
      el: HTMLElement,
      text: string,
      speed: number,
      done?: () => void
    ) => {
      let i = 0;
      const step = () => {
        if (aborted.current) return;
        i += 2;
        el.textContent = text.slice(0, i);
        messagesEl.scrollTop = messagesEl.scrollHeight;
        if (i < text.length) {
          chatTimer.current = setTimeout(step, speed);
        } else {
          el.textContent = text;
          if (done) chatTimer.current = setTimeout(done, 1000);
        }
      };
      step();
    };

    const runScene = (idx: number) => {
      if (aborted.current) return;
      const scene = DEMO_SCENES[idx];
      messagesEl.innerHTML = "";
      composerInput.textContent = "";
      composerInput.classList.add(styles.composerInputTyping);
      card.classList.remove(styles.chatCardActive);

      // Phase 1: type the first user question into the composer (~40ms/char).
      const firstUser = scene.messages.find((m) => m.role === "user") as
        | Extract<DemoMessage, { role: "user" }>
        | undefined;
      const q = firstUser ? firstUser.text : "";
      let ci = 0;
      const typeComposer = () => {
        if (aborted.current) return;
        ci += 1;
        composerInput.textContent = q.slice(0, ci);
        if (ci < q.length) {
          chatTimer.current = setTimeout(typeComposer, 40);
        } else {
          // Phase 2: switch to active chat, render messages progressively.
          chatTimer.current = setTimeout(() => {
            if (aborted.current) return;
            card.classList.add(styles.chatCardActive);
            composerInput.classList.remove(styles.composerInputTyping);
            renderMessagesProgressively(scene, idx);
          }, 600);
        }
      };
      typeComposer();
    };

    const renderMessagesProgressively = (scene: DemoScene, idx: number) => {
      let mi = 0;
      const addNext = () => {
        if (aborted.current) return;
        if (mi >= scene.messages.length) {
          // Pause, then advance to the next scene (loop).
          chatTimer.current = setTimeout(() => {
            runScene((idx + 1) % DEMO_SCENES.length);
          }, 3200);
          return;
        }
        const msg = scene.messages[mi];
        if (msg.role === "user") {
          messagesEl.appendChild(buildMessageRow(styles, msg, false));
          mi += 1;
          chatTimer.current = setTimeout(addNext, 700);
        } else if (msg.role === "assistant") {
          const row = buildMessageRow(styles, msg, true);
          messagesEl.appendChild(row);
          const bubble = row.querySelector(`.${styles.bubble}`) as HTMLElement;
          typeText(bubble, msg.text, 18, () => {
            mi += 1;
            addNext();
          });
        } else if (msg.role === "join") {
          messagesEl.appendChild(buildMessageRow(styles, msg, false));
          mi += 1;
          chatTimer.current = setTimeout(addNext, 900);
        } else {
          // mind
          const row = buildMessageRow(styles, msg, true);
          messagesEl.appendChild(row);
          const bubble = row.querySelector(`.${styles.bubble}`) as HTMLElement;
          typeText(bubble, msg.text, 18, () => {
            mi += 1;
            addNext();
          });
        }
        messagesEl.scrollTop = messagesEl.scrollHeight;
      };
      addNext();
    };

    runScene(0);
  }, []);

  /* ---- Decorative search demo (ports _startLandingSearchDemo) ---- */
  const startSearchDemo = useCallback(() => {
    const el = searchInputRef.current;
    if (!el) return;
    let ti = 0;
    let ci = 0;
    let deleting = false;
    const tick = () => {
      if (aborted.current) return;
      const term = SEARCH_TERMS[ti];
      if (!deleting) {
        ci += 1;
        el.textContent = term.slice(0, ci);
        if (ci >= term.length) {
          deleting = true;
          searchTimer.current = setTimeout(tick, 1400);
          return;
        }
      } else {
        ci -= 1;
        el.textContent = term.slice(0, ci);
        if (ci <= 0) {
          deleting = false;
          ti = (ti + 1) % SEARCH_TERMS.length;
        }
      }
      searchTimer.current = setTimeout(tick, deleting ? 40 : 90);
    };
    tick();
  }, []);

  /* ---- Background minds graph: real-ish force sim on canvas (no d3) ----
     Pulls /api/minds + /api/minds/similarities; degrades to a static
     constellation if empty/down. Kept low-opacity behind the hero. */
  const startMindsGraph = useCallback(async () => {
    const host = bgRef.current;
    if (!host) return;

    let minds: Array<{ id?: string; name?: string }> = [];
    let sims: Array<Record<string, unknown>> = [];
    try {
      const [m, s] = await Promise.all([
        get<unknown>("/api/minds"),
        get<unknown>("/api/minds/similarities"),
      ]);
      minds = pickArray<{ id?: string; name?: string }>(m, "minds");
      // /api/minds/similarities returns { links: [{source,target,strength}], layout }
      sims = pickArray<Record<string, unknown>>(s, "links");
    } catch {
      minds = [];
    }
    if (aborted.current || !host.isConnected) return;

    const reduced = prefersReducedMotion();
    const W = host.clientWidth || 1200;
    const H = host.clientHeight || 800;
    const dpr =
      typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    const canvas = document.createElement("canvas");
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = "100%";
    canvas.style.height = "100%";
    host.innerHTML = "";
    host.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    const accent =
      getComputedStyle(host).color || "rgba(107,91,255,1)";

    // Static constellation fallback when there's no data.
    if (!minds.length) {
      drawConstellation(ctx, W, H, accent);
      // Redraw on resize so it stays full-bleed.
      const onResize = () => {
        const w = host.clientWidth || W;
        const h = host.clientHeight || H;
        canvas.width = w * dpr;
        canvas.height = h * dpr;
        ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
        drawConstellation(ctx, w, h, accent);
      };
      window.addEventListener("resize", onResize);
      mindsResize.current = () => window.removeEventListener("resize", onResize);
      return;
    }

    // Build nodes (cap 40, like legacy) + links from similarities (cap 80).
    const nodes: GraphNode[] = minds.slice(0, 40).map((mm, i) => {
      const id = String(mm.id || mm.name || i);
      const angle = (i / Math.min(minds.length, 40)) * Math.PI * 2;
      const rad = Math.min(W, H) * (0.18 + 0.12 * Math.random());
      return {
        id,
        x: W / 2 + Math.cos(angle) * rad,
        y: H / 2 + Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        r: 3 + Math.random() * 4,
      };
    });
    const byId: Record<string, GraphNode> = {};
    nodes.forEach((n) => (byId[n.id] = n));
    const links: GraphLink[] = sims
      .map((s) => {
        const src = String(s.a ?? s.source ?? "");
        const tgt = String(s.b ?? s.target ?? "");
        const w = Number(s.score ?? s.weight ?? 0.5);
        return byId[src] && byId[tgt]
          ? { source: byId[src], target: byId[tgt], w }
          : null;
      })
      .filter((l): l is GraphLink => !!l)
      .slice(0, 80);

    const linkDist = 60;
    let alpha = 1;

    const tickSim = () => {
      // Many-body repulsion (strength ~ -30, like d3.forceManyBody).
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          let dx = a.x - b.x;
          let dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const force = (30 * alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force * 6;
          const fy = (dy / d) * force * 6;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      // Link springs (target distance 60).
      links.forEach((l) => {
        const dx = l.target.x - l.source.x;
        const dy = l.target.y - l.source.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const k = ((d - linkDist) / d) * 0.05 * alpha;
        const fx = dx * k;
        const fy = dy * k;
        l.source.vx += fx;
        l.source.vy += fy;
        l.target.vx -= fx;
        l.target.vy -= fy;
      });
      // Gentle centering + integrate with velocity decay.
      nodes.forEach((n) => {
        n.vx += (W / 2 - n.x) * 0.0015 * alpha;
        n.vy += (H / 2 - n.y) * 0.0015 * alpha;
        n.vx *= 0.9;
        n.vy *= 0.9;
        n.x += n.vx;
        n.y += n.vy;
      });
      alpha *= 0.99; // cool down like a force sim
    };

    const draw = () => {
      ctx.clearRect(0, 0, W, H);
      ctx.strokeStyle = accent;
      ctx.lineWidth = 1;
      links.forEach((l) => {
        ctx.globalAlpha = 0.12 * Math.min(1, Math.max(0.3, l.w));
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.stroke();
      });
      ctx.fillStyle = accent;
      nodes.forEach((n) => {
        ctx.globalAlpha = 0.55;
        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fill();
      });
      ctx.globalAlpha = 1;
    };

    if (reduced) {
      // Settle synchronously, draw once, no rAF loop.
      for (let i = 0; i < 120; i++) tickSim();
      draw();
      return;
    }

    const loop = () => {
      if (aborted.current) return;
      tickSim();
      draw();
      mindsRAF.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  /* ---- Mount: kick off animations; unmount: tear everything down ---- */
  useEffect(() => {
    aborted.current = false;
    const reduced = prefersReducedMotion();

    if (reduced) {
      renderSceneStatic(0);
    } else {
      startChatDemo();
      startSearchDemo();
    }
    startMindsGraph();

    return () => {
      // Replicates legacy _stopLandingAnimations discipline.
      aborted.current = true;
      if (chatTimer.current) {
        clearTimeout(chatTimer.current);
        chatTimer.current = null;
      }
      if (searchTimer.current) {
        clearTimeout(searchTimer.current);
        searchTimer.current = null;
      }
      if (mindsRAF.current) {
        cancelAnimationFrame(mindsRAF.current);
        mindsRAF.current = null;
      }
      if (mindsResize.current) {
        mindsResize.current();
        mindsResize.current = null;
      }
    };
  }, [renderSceneStatic, startChatDemo, startSearchDemo, startMindsGraph]);

  return (
    <div className={styles.root}>
      <div ref={bgRef} className={styles.mindsBg} aria-hidden="true" />

      <header className={styles.topbar}>
        <div className={styles.brand}>
          <BrandMark />
          <span className={styles.brandName}>Feynman</span>
        </div>
        <div className={styles.topbarActions}>
          <a
            className={styles.link}
            href="https://discord.gg/bCShwbFnCd"
            target="_blank"
            rel="noopener noreferrer"
          >
            Discord
          </a>
          <ThemeToggle />
          <button className={styles.ctaSm} onClick={onCta}>
            {ctaLabel}
          </button>
        </div>
      </header>

      <main className={styles.main}>
        <div className={styles.hero}>
          <h1 className={styles.heroTitle}>
            Chat with books.
            <br />
            Great minds join in.
          </h1>
          <p className={styles.heroSub}>
            An interactive knowledge network built on the world&apos;s most important
            books and great minds. Turn any book into a conversation that goes beyond
            the page, or start from a topic to learn across a library that grows as you
            explore — or write the book you want to read, with an evolving network of
            agent-simulated great minds that joins your discussion, learning and growing
            with you.
          </p>
          <button className={styles.cta} onClick={onCta}>
            {ctaLabel}
            <span className={styles.ctaArrow} aria-hidden="true">
              →
            </span>
          </button>
        </div>

        <div className={styles.demo}>
          <div ref={cardRef} className={styles.chatCard}>
            <div className={styles.composer}>
              <div
                ref={composerInputRef}
                className={styles.composerInput}
                aria-hidden="true"
              />
              <button className={styles.composerSend} tabIndex={-1} aria-hidden="true">
                →
              </button>
            </div>
            <div ref={messagesRef} className={styles.messages} aria-hidden="true" />
          </div>
        </div>
      </main>

      <div className={styles.searchWrap}>
        <div className={styles.searchBox} aria-hidden="true">
          <span className={styles.searchIcon}>⌕</span>
          <div ref={searchInputRef} className={styles.searchInput} />
        </div>
      </div>
    </div>
  );
}
