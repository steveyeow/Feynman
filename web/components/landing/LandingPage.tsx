"use client";

import { useEffect, useRef, useCallback, useState } from "react";
import Link from "next/link";
import * as d3 from "d3";
import { getLandingStats, type LandingStats } from "@/lib/api";
import styles from "./LandingPage.module.css";

/* ════════════════════════════════════════════════════════════════════
   LANDING PAGE — faithful 1:1 port of the legacy renderLandingPage()
   (app/static/app.js ~783-1628). Same DOM structure, copy, class roles,
   and the three animation drivers (_startLandingChatDemo,
   _startLandingSearchDemo, _renderLandingMindsGraph).

   The static markup is JSX; the animations run imperatively in a single
   effect that mutates refs by setting .value / building message nodes —
   exactly the way the legacy mutated DOM by id. The home↔active toggle
   uses the global `hidden` class, like the original.
   ════════════════════════════════════════════════════════════════════ */

/* ---- Demo scenes: copy VERBATIM from app.js lines 788-824 ---- */
type DemoMessage =
  | { role: "user"; text: string }
  | { role: "assistant"; text: string; sources?: string[] }
  | { role: "join"; names: string[] }
  | { role: "mind"; name: string; color: string; text: string };

type DemoScene = {
  title: string;
  bookChip?: string;
  messages: DemoMessage[];
};

const DEMO_SCENES: DemoScene[] = [
  {
    title: "Thinking, Fast and Slow",
    bookChip: "Thinking, Fast and Slow",
    messages: [
      { role: "user", text: "What are System 1 and System 2?" },
      {
        role: "assistant",
        text: "System 1 is fast, automatic intuition. System 2 is slow, deliberate thinking. Most decisions start in System 1, but System 2 kicks in for hard problems.",
        sources: ["Ch.1 Two Systems"],
      },
      { role: "user", text: "How does this affect our decisions?" },
      {
        role: "assistant",
        text: 'System 1 creates cognitive biases — we jump to conclusions, anchor on first impressions, and confuse "easy to recall" with "likely to happen."',
        sources: ["Ch.12 Anchoring", "Ch.13 Availability"],
      },
      { role: "join", names: ["Richard Feynman"] },
      {
        role: "mind",
        name: "Richard Feynman",
        color: "#e76f51",
        text: "The first principle is — you must not fool yourself, and you are the easiest person to fool. That's exactly the System 1 trap.",
      },
    ],
  },
  {
    title: "General Chat",
    messages: [
      { role: "user", text: "How should I think about building a startup?" },
      {
        role: "assistant",
        text: "Find a real problem you understand deeply. Build for a small group who love it, not a large group who merely like it.",
      },
      { role: "user", text: "What about competition?" },
      {
        role: "assistant",
        text: "The best strategy is often to avoid direct competition entirely — find an underserved niche and dominate it.",
      },
      { role: "join", names: ["Paul Graham"] },
      {
        role: "mind",
        name: "Paul Graham",
        color: "#588157",
        text: "Make something people want. Talk to users, build fast, iterate. Most startups die from building something nobody needs.",
      },
    ],
  },
  {
    title: "The Art of War",
    bookChip: "The Art of War",
    messages: [
      { role: "user", text: "What is the supreme art of war?" },
      {
        role: "assistant",
        text: '"To subdue the enemy without fighting." Sun Tzu argues true mastery is winning through strategy, not force.',
        sources: ["Ch.3 Strategic Attack"],
      },
      { role: "user", text: "How does this apply today?" },
      {
        role: "assistant",
        text: "In business, it means building advantages that make competition irrelevant — positioning over confrontation.",
      },
      { role: "join", names: ["Charlie Munger"] },
      {
        role: "mind",
        name: "Charlie Munger",
        color: "#9b2226",
        text: "The best competitive advantage avoids competition entirely. Find a niche where you're the only one, not the best one.",
      },
    ],
  },
];

/* Search-demo terms (app.js line 1088) */
const SEARCH_TERMS = ["Feynman", "Munger", "Socrates", "Einstein", "Paul Graham"];

/* Join-notice avatar colors (app.js line 1602) */
const JOIN_COLORS: Record<string, string> = {
  "Richard Feynman": "#e76f51",
  "Charlie Munger": "#9b2226",
  "Paul Graham": "#588157",
  "Elon Musk": "#0077b6",
  "Albert Einstein": "#457b9d",
  Socrates: "#264653",
};

/* Background minds graph palette + deterministic color (app.js _LP_COLORS / _lpColor) */
const LP_COLORS = [
  "#6d597a",
  "#355070",
  "#264653",
  "#2a9d8f",
  "#e76f51",
  "#b56576",
  "#0077b6",
  "#588157",
  "#9b2226",
  "#457b9d",
];
function lpColor(name: string): string {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = ((h << 5) - h + name.charCodeAt(i)) | 0;
  return LP_COLORS[Math.abs(h) % LP_COLORS.length];
}
function hexToRgb(hex: string): [number, number, number] {
  return [
    parseInt(hex.slice(1, 3), 16),
    parseInt(hex.slice(3, 5), 16),
    parseInt(hex.slice(5, 7), 16),
  ];
}

/* Background minds-graph seed data — VERBATIM from legacy app.js LP_MINDS
   (lines 714-767). The legacy _renderLandingMindsGraph() builds nodes from this
   hardcoded list (NOT the API), then derives `color` via _lpColor(name). Keeping
   the same data + count is what makes the visual density/placement match. */
const LP_MINDS: { name: string; domain: string; color: string }[] = (
  [
    { name: "Aristotle", domain: "ancient philosophy, logic, ethics, metaphysics, rhetoric" },
    { name: "Socrates", domain: "ancient philosophy, ethics, epistemology, dialectic" },
    { name: "Plato", domain: "ancient philosophy, metaphysics, political theory, epistemology" },
    { name: "Marcus Aurelius", domain: "stoicism, ancient philosophy, ethics, leadership" },
    { name: "Confucius", domain: "eastern philosophy, ethics, governance, education" },
    { name: "Laozi", domain: "eastern philosophy, Taoism, metaphysics" },
    { name: "Sun Tzu", domain: "eastern philosophy, military strategy, leadership, game theory" },
    { name: "Friedrich Nietzsche", domain: "modern philosophy, existentialism, ethics, cultural criticism" },
    { name: "Niccolò Machiavelli", domain: "political philosophy, statecraft, power, realism" },
    { name: "Bertrand Russell", domain: "analytic philosophy, logic, mathematics, social criticism" },
    { name: "Michel Foucault", domain: "modern philosophy, power, social theory, knowledge systems" },
    { name: "Immanuel Kant", domain: "modern philosophy, epistemology, ethics, metaphysics" },
    { name: "Richard Feynman", domain: "physics, quantum mechanics, science education" },
    { name: "Albert Einstein", domain: "physics, relativity, philosophy of science" },
    { name: "Isaac Newton", domain: "physics, mathematics, classical mechanics, optics" },
    { name: "Nikola Tesla", domain: "physics, electrical engineering, invention" },
    { name: "Stephen Hawking", domain: "physics, cosmology, science communication" },
    { name: "John von Neumann", domain: "mathematics, computer science, game theory, quantum mechanics" },
    { name: "Charles Darwin", domain: "biology, evolution, natural history" },
    { name: "E.O. Wilson", domain: "biology, sociobiology, ecology, biodiversity" },
    { name: "Adam Smith", domain: "economics, free markets, moral philosophy" },
    { name: "John Maynard Keynes", domain: "economics, macroeconomics, fiscal policy" },
    { name: "Charlie Munger", domain: "investing, mental models, multidisciplinary thinking" },
    { name: "Warren Buffett", domain: "investing, value investing, business analysis" },
    { name: "Ray Dalio", domain: "investing, macroeconomics, principles, systems thinking" },
    { name: "Daniel Kahneman", domain: "cognitive psychology, behavioral economics, decision-making" },
    { name: "Carl Jung", domain: "depth psychology, psychoanalysis, mythology, archetypes" },
    { name: "Sigmund Freud", domain: "depth psychology, psychoanalysis, unconscious mind" },
    { name: "Steven Pinker", domain: "cognitive psychology, linguistics, human nature, rationality" },
    { name: "Fyodor Dostoevsky", domain: "literature, existentialism, human nature" },
    { name: "Leo Tolstoy", domain: "literature, moral philosophy, pacifism" },
    { name: "William Shakespeare", domain: "literature, drama, human nature, language" },
    { name: "Jorge Luis Borges", domain: "literature, metaphysics, philosophy of mind" },
    { name: "Winston Churchill", domain: "political leadership, history, wartime strategy, rhetoric" },
    { name: "Leonardo da Vinci", domain: "art, engineering, anatomy, invention, polymathy" },
    { name: "Steve Jobs", domain: "technology, product design, entrepreneurship, innovation" },
    { name: "Elon Musk", domain: "technology, engineering, space, first principles thinking" },
    { name: "Jensen Huang", domain: "technology, semiconductors, AI, computing" },
    { name: "Jeff Bezos", domain: "technology, business strategy, customer obsession, e-commerce" },
    { name: "Marc Andreessen", domain: "venture capital, software, startups, techno-optimism" },
    { name: "Paul Graham", domain: "startups, programming, essays, venture capital" },
    { name: "Peter Thiel", domain: "venture capital, contrarian thinking, startups, monopoly theory" },
    { name: "Sam Altman", domain: "AI, startups, technology, venture capital" },
    { name: "Peter Drucker", domain: "management, business strategy, leadership, knowledge work" },
    { name: "Naval Ravikant", domain: "startups, personal philosophy, wealth, decision-making" },
    { name: "Nassim Nicholas Taleb", domain: "risk, probability, antifragility, epistemology" },
    { name: "Yuval Noah Harari", domain: "history, futurism, cognitive science, anthropology" },
    { name: "Jordan Peterson", domain: "depth psychology, personal development, mythology, cultural criticism" },
    { name: "Tim Ferriss", domain: "productivity, self-optimization, entrepreneurship, podcasting" },
    { name: "James Clear", domain: "habits, behavioral psychology, productivity, self-improvement" },
    { name: "Balaji Srinivasan", domain: "technology, network state, crypto, futurism" },
    { name: "Tyler Cowen", domain: "economics, cultural commentary, innovation, blogging" },
  ] as { name: string; domain: string }[]
).map((m) => ({ ...m, color: lpColor(m.name) }));
function initials(name: string): string {
  return name
    .split(/\s+/)
    .slice(0, 2)
    .map((w) => w[0])
    .join("");
}
function tokensOf(domain: string): string[] {
  return (domain || "")
    .split(/[,;/&]+/)
    .map((d) => d.trim())
    .filter(Boolean);
}

function prefersReducedMotion(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(prefers-reduced-motion: reduce)").matches
  );
}
function isDarkMode(): boolean {
  if (typeof document === "undefined") return false;
  const el = document.documentElement;
  if (el.classList.contains("dark")) return true;
  if (el.classList.contains("light")) return false;
  return (
    typeof window !== "undefined" &&
    !!window.matchMedia &&
    window.matchMedia("(prefers-color-scheme: dark)").matches
  );
}

/* Build a mind-avatar <span> (ports _mindAvatar). */
function mindAvatarEl(name: string, color: string): HTMLSpanElement {
  const span = document.createElement("span");
  span.className = styles.mnAvatar;
  span.style.background = color;
  span.textContent = initials(name);
  return span;
}

/* ════════════════════════════════════════════════════════════════════
   Background minds force-graph — FAITHFUL d3-force port of the legacy
   _renderLandingMindsGraph() (app/static/app.js 1112-1436).

   Nodes come from the hardcoded LP_MINDS list (exactly like the legacy,
   which never hit the API for this background). Links are derived from
   shared domain tokens. A real d3.forceSimulation runs the same forces
   the legacy used (link / charge / center / collide / x / y) plus the
   hero-text + chat-card "avoid" clear-zones so nodes never cover the
   foreground. Full-color node circles, the legacy link-alpha formula
   (rgba(160,170,190, 0.12 + strength*0.08)) and subtle particles flowing
   along links. prefers-reduced-motion settles synchronously, draws one
   frame, and starts no rAF / particles.
   ════════════════════════════════════════════════════════════════════ */
type GNode = d3.SimulationNodeDatum & {
  id: string;
  name: string;
  initials: string;
  color: string;
  domain: string;
  tokens: string[];
};
type GLink = d3.SimulationLinkDatum<GNode> & {
  source: GNode | string;
  target: GNode | string;
  strength: number;
};
type GParticle = {
  link: GLink;
  t: number;
  speed: number;
  size: number;
  opacity: number;
};

/* ════════════════════════════════════════════════════════════════════
   BELOW-THE-HERO FEATURE SECTIONS — static helpers + data.
   These render NON-animated feature mocks that reuse the demo message
   classes (.msg*, .mnAvatar, .joinInner …) so they look native. The hero
   above is untouched.
   ════════════════════════════════════════════════════════════════════ */

/* One mind message — same DOM shape as the animated demo's mind row. */
function MockMind({ name, text }: { name: string; text: string }) {
  return (
    <div className={`${styles.msg} ${styles.msgMind}`}>
      <span className={styles.mnAvatar} style={{ background: lpColor(name) }}>
        {initials(name)}
      </span>
      <div className={styles.mindBodyWrap}>
        <div className={styles.mindHeader}>
          <span className={styles.mnName}>{name}</span>
        </div>
        <div className={styles.mindBody}>{text}</div>
      </div>
    </div>
  );
}

/* A "minds joined" / "in conversation" notice — ports the demo's join row. */
function MockJoin({ names, verb }: { names: string[]; verb: string }) {
  const label =
    names.length === 1
      ? names[0]
      : names.slice(0, -1).join(", ") + " and " + names[names.length - 1];
  return (
    <div className={styles.systemNotice}>
      <div className={styles.joinInner}>
        {names.map((n) => (
          <span key={n} className={styles.mnAvatar} style={{ background: lpColor(n) }}>
            {initials(n)}
          </span>
        ))}
        <span>
          {label} {verb}
        </span>
      </div>
    </div>
  );
}

/* Stats-band number that counts up from 0 the first time it scrolls into view.
   Reduced-motion / no-IO → shows the final value immediately. */
function StatNumber({ value }: { value: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const fmt = (n: number) => n.toLocaleString();
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") {
      el.textContent = fmt(value);
      return;
    }
    el.textContent = fmt(0);
    let raf = 0;
    let started = false;
    const run = () => {
      const start = performance.now();
      const dur = 1100;
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / dur);
        const eased = 1 - Math.pow(1 - t, 3);
        el.textContent = fmt(Math.round(eased * value));
        if (t < 1) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting && !started) {
            started = true;
            run();
            io.disconnect();
          }
        }
      },
      { threshold: 0.4 }
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);
  return (
    <span ref={ref} className={styles.statNum}>
      {value.toLocaleString()}
    </span>
  );
}

/* §3 constellation — node placements (left/top = CSS %, cx/cy = SVG viewBox
   coords in a 420×264 box, kept in sync so the links land on the avatars). */
const NETWORK_NODES: { name: string; left: string; top: string; cx: number; cy: number }[] = [
  { name: "Richard Feynman", left: "20%", top: "26%", cx: 84, cy: 68.6 },
  { name: "Socrates", left: "52%", top: "16%", cx: 218.4, cy: 42.2 },
  { name: "Adam Smith", left: "82%", top: "33%", cx: 344.4, cy: 87.1 },
  { name: "Ada Lovelace", left: "26%", top: "74%", cx: 109.2, cy: 195.4 },
];
const NETWORK_UPLOAD = { left: "72%", top: "78%", cx: 302.4, cy: 205.9 };
/* Links as [x1,y1,x2,y2] in the same viewBox. */
const NETWORK_LINKS: [number, number, number, number][] = [
  [84, 68.6, 218.4, 42.2],
  [218.4, 42.2, 344.4, 87.1],
  [84, 68.6, 109.2, 195.4],
  [109.2, 195.4, 302.4, 205.9],
  [302.4, 205.9, 344.4, 87.1],
  [218.4, 42.2, 302.4, 205.9],
];

/* §2 Library cards — colored gradient cover + faded initials + title (mirrors
   the real /library cards). */
const LIB_BOOKS: { title: string; initials: string; grad: string }[] = [
  { title: "Thinking, Fast and Slow", initials: "TF", grad: "linear-gradient(135deg,#6d597a,#355070)" },
  { title: "The Wealth of Nations", initials: "WN", grad: "linear-gradient(135deg,#2a9d8f,#264653)" },
  { title: "Meditations", initials: "Md", grad: "linear-gradient(135deg,#e76f51,#9b2226)" },
  { title: "The Art of War", initials: "AW", grad: "linear-gradient(135deg,#457b9d,#264653)" },
  { title: "Gödel, Escher, Bach", initials: "GE", grad: "linear-gradient(135deg,#b56576,#6d597a)" },
  { title: "Sapiens", initials: "Sp", grad: "linear-gradient(135deg,#588157,#2a9d8f)" },
];

export function LandingPage({
  ctaLabel,
  onCta,
}: {
  ctaLabel: string;
  onCta: () => void;
}) {
  // Live DOM the imperative animations drive (mirrors legacy getElementById).
  const homeRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const homeInputRef = useRef<HTMLTextAreaElement>(null);
  const activeChipsRef = useRef<HTMLDivElement>(null);
  const startersRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const bgRef = useRef<HTMLDivElement>(null);
  const greetingRef = useRef<HTMLSpanElement>(null);

  // Handles tracked for cleanup (the legacy _stopLandingAnimations set).
  const chatTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const graphRAF = useRef<number | null>(null);
  const graphSim = useRef<d3.Simulation<GNode, GLink> | null>(null);
  const graphCleanup = useRef<(() => void) | null>(null);
  const aborted = useRef(false);

  // Live counts for the stats band (null until loaded / on failure → band hidden).
  const [stats, setStats] = useState<LandingStats | null>(null);

  /* ---- Chat demo: ports _startLandingChatDemo timing verbatim ---- */
  const startChatDemo = useCallback(() => {
    const homeEl = homeRef.current;
    const activeEl = activeRef.current;
    const bodyEl = bodyRef.current;
    const homeInputEl = homeInputRef.current;
    const activeChipsEl = activeChipsRef.current;
    const startersEl = startersRef.current;
    if (!bodyEl || !homeEl || !activeEl) return;

    let sceneIdx = 0;

    function animateIn(el: HTMLElement) {
      el.style.opacity = "0";
      el.style.transform = "translateY(8px)";
      requestAnimationFrame(() => {
        el.style.transition = "opacity 0.3s, transform 0.3s";
        el.style.opacity = "1";
        el.style.transform = "translateY(0)";
      });
    }

    // Body text typing: +2 chars / 18ms, 1s pause before cb.
    function typeText(container: HTMLElement, el: HTMLElement, text: string, cb?: () => void) {
      let i = 0;
      function tick() {
        if (aborted.current) return;
        if (i < text.length) {
          el.textContent = (el.textContent || "") + text.slice(i, i + 2);
          i += 2;
          container.scrollTop = container.scrollHeight;
          chatTimer.current = setTimeout(tick, 18);
        } else if (cb) {
          chatTimer.current = setTimeout(cb, 1000);
        }
      }
      chatTimer.current = setTimeout(tick, 250);
    }

    // Composer typing: 1 char / ~40ms into the home input.
    function typeInput(text: string, cb?: () => void) {
      if (!homeInputEl) {
        if (cb) cb();
        return;
      }
      homeInputEl.value = "";
      let i = 0;
      function tick() {
        if (aborted.current) return;
        if (i < text.length) {
          i++;
          homeInputEl!.value = text.slice(0, i);
          chatTimer.current = setTimeout(tick, 40 + Math.random() * 30);
        } else {
          chatTimer.current = setTimeout(() => {
            homeInputEl!.value = "";
            if (cb) cb();
          }, 400);
        }
      }
      chatTimer.current = setTimeout(tick, 300);
    }

    function switchToChat(scene: DemoScene) {
      homeEl!.classList.add("hidden");
      activeEl!.classList.remove("hidden");
      if (activeChipsEl) {
        activeChipsEl.innerHTML = "";
        if (scene.bookChip) {
          const chip = document.createElement("div");
          chip.className = styles.bookChip;
          const span = document.createElement("span");
          span.textContent = scene.bookChip;
          chip.appendChild(span);
          activeChipsEl.appendChild(chip);
        }
      }
    }

    function switchToHome() {
      activeEl!.classList.add("hidden");
      homeEl!.classList.remove("hidden");
      bodyEl!.innerHTML = "";
      if (activeChipsEl) activeChipsEl.innerHTML = "";
    }

    function playScene() {
      const scene = DEMO_SCENES[sceneIdx % DEMO_SCENES.length];
      sceneIdx++;

      bodyEl!.innerHTML = "";
      if (startersEl) startersEl.style.display = "none";

      const firstUserMsg = scene.messages.find((m) => m.role === "user") as
        | Extract<DemoMessage, { role: "user" }>
        | undefined;
      if (!firstUserMsg) {
        switchToChat(scene);
        startMessages(scene, 0);
        return;
      }

      typeInput(firstUserMsg.text, () => {
        switchToChat(scene);
        const div = document.createElement("div");
        div.className = `${styles.msg} ${styles.msgUser}`;
        div.textContent = firstUserMsg.text;
        animateIn(div);
        bodyEl!.appendChild(div);
        bodyEl!.scrollTop = bodyEl!.scrollHeight;
        chatTimer.current = setTimeout(() => startMessages(scene, 1), 800);
      });
    }

    function startMessages(scene: DemoScene, fromIdx: number) {
      let msgIdx = fromIdx;

      function showNext() {
        if (aborted.current) return;
        if (msgIdx >= scene.messages.length) {
          chatTimer.current = setTimeout(() => {
            activeEl!.style.opacity = "0";
            setTimeout(() => {
              if (aborted.current) return;
              activeEl!.style.opacity = "1";
              switchToHome();
              if (startersEl) startersEl.style.display = "";
              playScene();
            }, 400);
          }, 3500);
          return;
        }

        const msg = scene.messages[msgIdx];
        msgIdx++;

        if (msg.role === "user") {
          const div = document.createElement("div");
          div.className = `${styles.msg} ${styles.msgUser}`;
          div.textContent = msg.text;
          animateIn(div);
          bodyEl!.appendChild(div);
          bodyEl!.scrollTop = bodyEl!.scrollHeight;
          chatTimer.current = setTimeout(showNext, 800);
        } else if (msg.role === "assistant") {
          const div = document.createElement("div");
          div.className = `${styles.msg} ${styles.msgAssistant}`;
          const textSpan = document.createElement("span");
          div.appendChild(textSpan);
          animateIn(div);
          bodyEl!.appendChild(div);
          typeText(bodyEl!, textSpan, msg.text, () => {
            if (msg.sources && msg.sources.length) {
              const srcEl = document.createElement("div");
              srcEl.className = styles.msgSources;
              msg.sources.forEach((s) => {
                const tag = document.createElement("span");
                tag.className = styles.sourceTag;
                tag.textContent = s;
                srcEl.appendChild(tag);
              });
              animateIn(srcEl);
              div.appendChild(srcEl);
              bodyEl!.scrollTop = bodyEl!.scrollHeight;
            }
            chatTimer.current = setTimeout(showNext, 1000);
          });
        } else if (msg.role === "join") {
          const div = document.createElement("div");
          div.className = styles.systemNotice;
          const inner = document.createElement("div");
          inner.className = styles.joinInner;
          msg.names.forEach((n) => inner.appendChild(mindAvatarEl(n, JOIN_COLORS[n] || "#6d597a")));
          const label =
            msg.names.length === 1
              ? msg.names[0]
              : msg.names.slice(0, -1).join(", ") + " and " + msg.names[msg.names.length - 1];
          const labelSpan = document.createElement("span");
          labelSpan.textContent = `${label} joined the discussion`;
          inner.appendChild(labelSpan);
          div.appendChild(inner);
          animateIn(div);
          bodyEl!.appendChild(div);
          bodyEl!.scrollTop = bodyEl!.scrollHeight;
          chatTimer.current = setTimeout(showNext, 800);
        } else {
          // mind
          const div = document.createElement("div");
          div.className = `${styles.msg} ${styles.msgMind}`;
          div.appendChild(mindAvatarEl(msg.name, msg.color));
          const wrap = document.createElement("div");
          wrap.className = styles.mindBodyWrap;
          const header = document.createElement("div");
          header.className = styles.mindHeader;
          const nameSpan = document.createElement("span");
          nameSpan.className = styles.mnName;
          nameSpan.textContent = msg.name;
          header.appendChild(nameSpan);
          const bodyDiv = document.createElement("div");
          bodyDiv.className = styles.mindBody;
          wrap.appendChild(header);
          wrap.appendChild(bodyDiv);
          div.appendChild(wrap);
          animateIn(div);
          bodyEl!.appendChild(div);
          typeText(bodyEl!, bodyDiv, msg.text, () => {
            chatTimer.current = setTimeout(showNext, 1000);
          });
        }
      }

      showNext();
    }

    playScene();
  }, []);

  /* ---- Static one-shot render for prefers-reduced-motion ---- */
  const renderChatStatic = useCallback(() => {
    const homeEl = homeRef.current;
    const activeEl = activeRef.current;
    const bodyEl = bodyRef.current;
    const activeChipsEl = activeChipsRef.current;
    const startersEl = startersRef.current;
    if (!bodyEl || !homeEl || !activeEl) return;
    const scene = DEMO_SCENES[0];

    homeEl.classList.add("hidden");
    activeEl.classList.remove("hidden");
    if (startersEl) startersEl.style.display = "none";
    if (activeChipsEl && scene.bookChip) {
      const chip = document.createElement("div");
      chip.className = styles.bookChip;
      const span = document.createElement("span");
      span.textContent = scene.bookChip;
      chip.appendChild(span);
      activeChipsEl.appendChild(chip);
    }
    bodyEl.innerHTML = "";
    scene.messages.forEach((msg) => {
      if (msg.role === "user") {
        const div = document.createElement("div");
        div.className = `${styles.msg} ${styles.msgUser}`;
        div.textContent = msg.text;
        bodyEl.appendChild(div);
      } else if (msg.role === "assistant") {
        const div = document.createElement("div");
        div.className = `${styles.msg} ${styles.msgAssistant}`;
        const span = document.createElement("span");
        span.textContent = msg.text;
        div.appendChild(span);
        if (msg.sources && msg.sources.length) {
          const srcEl = document.createElement("div");
          srcEl.className = styles.msgSources;
          msg.sources.forEach((s) => {
            const tag = document.createElement("span");
            tag.className = styles.sourceTag;
            tag.textContent = s;
            srcEl.appendChild(tag);
          });
          div.appendChild(srcEl);
        }
        bodyEl.appendChild(div);
      } else if (msg.role === "join") {
        const div = document.createElement("div");
        div.className = styles.systemNotice;
        const inner = document.createElement("div");
        inner.className = styles.joinInner;
        msg.names.forEach((n) => inner.appendChild(mindAvatarEl(n, JOIN_COLORS[n] || "#6d597a")));
        const labelSpan = document.createElement("span");
        labelSpan.textContent = `${msg.names.join(", ")} joined the discussion`;
        inner.appendChild(labelSpan);
        div.appendChild(inner);
        bodyEl.appendChild(div);
      } else {
        const div = document.createElement("div");
        div.className = `${styles.msg} ${styles.msgMind}`;
        div.appendChild(mindAvatarEl(msg.name, msg.color));
        const wrap = document.createElement("div");
        wrap.className = styles.mindBodyWrap;
        const header = document.createElement("div");
        header.className = styles.mindHeader;
        const nameSpan = document.createElement("span");
        nameSpan.className = styles.mnName;
        nameSpan.textContent = msg.name;
        header.appendChild(nameSpan);
        const bodyDiv = document.createElement("div");
        bodyDiv.className = styles.mindBody;
        bodyDiv.textContent = msg.text;
        wrap.appendChild(header);
        wrap.appendChild(bodyDiv);
        div.appendChild(wrap);
        bodyEl.appendChild(div);
      }
    });
  }, []);

  /* ---- Search demo: ports _startLandingSearchDemo typing ---- */
  const startSearchDemo = useCallback(() => {
    const input = searchRef.current;
    if (!input) return;

    function typeTerm(term: string, cb: () => void) {
      input!.value = "";
      let i = 0;
      function typeNext() {
        if (aborted.current) return;
        if (i < term.length) {
          i++;
          input!.value = term.slice(0, i);
          searchTimer.current = setTimeout(typeNext, 80 + Math.random() * 50);
        } else {
          searchTimer.current = setTimeout(cb, 1800);
        }
      }
      typeNext();
    }

    function clearTerm(cb: () => void) {
      const term = input!.value;
      let i = term.length;
      function delNext() {
        if (aborted.current) return;
        if (i > 0) {
          i--;
          input!.value = term.slice(0, i);
          searchTimer.current = setTimeout(delNext, 30);
        } else {
          searchTimer.current = setTimeout(cb, 400);
        }
      }
      delNext();
    }

    let termIdx = 0;
    function runCycle() {
      if (aborted.current) return;
      const term = SEARCH_TERMS[termIdx % SEARCH_TERMS.length];
      termIdx++;
      typeTerm(term, () => {
        clearTerm(() => {
          searchTimer.current = setTimeout(runCycle, 1000);
        });
      });
    }

    searchTimer.current = setTimeout(runCycle, 3000);
  }, []);

  /* ---- Background minds graph: faithful d3-force port of
         _renderLandingMindsGraph (app.js 1112-1436) ---- */
  const startMindsGraph = useCallback(() => {
    const container = bgRef.current;
    if (!container) return;

    // Nodes from the hardcoded LP_MINDS list (legacy 1116-1122). Never throws on
    // empty data — the sim simply renders nothing.
    const nodes: GNode[] = LP_MINDS.map((m, i) => ({
      id: "lp_" + i,
      name: m.name,
      domain: m.domain,
      color: m.color,
      initials: initials(m.name),
      tokens: tokensOf(m.domain),
    }));
    if (!nodes.length) {
      container.innerHTML = "";
      return;
    }

    // Links from shared domain tokens (legacy 1123-1132); star-fallback if none.
    const links: GLink[] = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const shared = nodes[i].tokens.filter((t) =>
          nodes[j].tokens.some((u) => t === u || t.includes(u) || u.includes(t))
        );
        if (shared.length > 0)
          links.push({ source: nodes[i].id, target: nodes[j].id, strength: shared.length });
      }
    }
    if (!links.length && nodes.length > 1) {
      for (let i = 1; i < nodes.length; i++)
        links.push({ source: nodes[0].id, target: nodes[i].id, strength: 0.3 });
    }

    const reduced = prefersReducedMotion();
    const W = container.clientWidth || 1200;
    const H = container.clientHeight || 800;
    const dpr =
      typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;
    // Node radius shrinks as the set grows (legacy 1141).
    const BASE_R = Math.max(20, Math.min(30, W / (nodes.length * 2)));

    const canvas = document.createElement("canvas");
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    container.innerHTML = "";
    container.appendChild(canvas);
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.scale(dpr, dpr);

    // Particles flowing along links (legacy 1152-1158); skipped under reduced.
    const particles: GParticle[] = [];
    if (!reduced) {
      links.forEach((l) => {
        const count = Math.max(1, Math.round(l.strength * 1.5));
        for (let i = 0; i < count; i++) {
          particles.push({
            link: l,
            t: Math.random(),
            speed: 0.001 + Math.random() * 0.003,
            size: 1 + Math.random() * 1.5,
            opacity: 0.3 + Math.random() * 0.5,
          });
        }
      });
    }

    // ── Hero-text (left) + chat-card (right) clear-zones (legacy 1167-1180).
    //    Nodes are pushed out of these so they never cover the foreground. ──
    const heroW = 300,
      heroH = 200;
    const heroCx = W * 0.06 + heroW / 2,
      heroCy = H / 2;
    const heroHalfW = heroW / 2 + 30,
      heroHalfH = heroH / 2 + 10;

    const cardW = Math.min(620, W * 0.55);
    const cardH = Math.min(520, H - 120);
    const cardCx = W - W * 0.04 - cardW / 2,
      cardCy = H / 2;
    const cardHalfW = cardW / 2 + 50,
      cardHalfH = cardH / 2 + 40;

    const clearZones = [
      { cx: heroCx, cy: heroCy, hw: heroHalfW, hh: heroHalfH },
      { cx: cardCx, cy: cardCy, hw: cardHalfW, hh: cardHalfH },
    ];

    // Custom force: shove any node out of a clear-zone along its shallower
    // overlap axis (legacy makeAvoidForce, 1182-1207).
    function makeAvoidForce(): d3.Force<GNode, GLink> {
      let ns: GNode[] = [];
      const force = () => {
        for (const n of ns) {
          for (const z of clearZones) {
            const dx = (n.x ?? 0) - z.cx,
              dy = (n.y ?? 0) - z.cy;
            const overlapX = z.hw - Math.abs(dx);
            const overlapY = z.hh - Math.abs(dy);
            if (overlapX > 0 && overlapY > 0) {
              if (overlapX < overlapY) {
                const sign = dx >= 0 ? 1 : -1;
                n.vx = (n.vx ?? 0) + sign * overlapX * 0.08;
                n.vx *= 0.85;
              } else {
                const sign = dy >= 0 ? 1 : -1;
                n.vy = (n.vy ?? 0) + sign * overlapY * 0.08;
                n.vy *= 0.85;
              }
            }
          }
        }
      };
      (force as d3.Force<GNode, GLink>).initialize = (n) => {
        ns = n as GNode[];
      };
      return force as d3.Force<GNode, GLink>;
    }

    // ── Forces: identical to legacy 1209-1219 ──
    const graphCx = W * 0.55;
    const sim = d3
      .forceSimulation<GNode, GLink>(nodes)
      .force(
        "link",
        d3
          .forceLink<GNode, GLink>(links)
          .id((d) => d.id)
          .distance((d) => Math.max(80, 280 - d.strength * 70))
          .strength((d) => 0.08 + d.strength * 0.15)
      )
      .force("charge", d3.forceManyBody<GNode>().strength(-600).distanceMax(800))
      .force("center", d3.forceCenter<GNode>(graphCx, H / 2).strength(0.02))
      .force("collision", d3.forceCollide<GNode>().radius(BASE_R + 20))
      .force("x", d3.forceX<GNode>(graphCx).strength(0.01))
      .force("y", d3.forceY<GNode>(H / 2).strength(0.01))
      .force("avoid", makeAvoidForce())
      .alphaDecay(0.03)
      .velocityDecay(0.35);
    graphSim.current = sim;

    function draw() {
      if (!ctx) return;
      const now = typeof performance !== "undefined" ? performance.now() : Date.now();
      ctx.clearRect(0, 0, W, H);
      const dk = isDarkMode();

      // Links — legacy alpha formula (1252-1262).
      for (const l of links) {
        const s = l.source as GNode;
        const t = l.target as GNode;
        const alpha = 0.12 + l.strength * 0.08;
        ctx.beginPath();
        ctx.moveTo(s.x ?? 0, s.y ?? 0);
        ctx.lineTo(t.x ?? 0, t.y ?? 0);
        ctx.strokeStyle = `rgba(160,170,190,${alpha})`;
        ctx.lineWidth = 0.6 + l.strength * 0.4;
        ctx.stroke();
      }

      // Particles flowing along links (legacy 1264-1276).
      for (const p of particles) {
        p.t += p.speed;
        if (p.t > 1) p.t -= 1;
        const s = p.link.source as GNode;
        const t = p.link.target as GNode;
        const px = (s.x ?? 0) + ((t.x ?? 0) - (s.x ?? 0)) * p.t;
        const py = (s.y ?? 0) + ((t.y ?? 0) - (s.y ?? 0)) * p.t;
        ctx.beginPath();
        ctx.arc(px, py, p.size, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(130,150,200,${p.opacity * 0.45})`;
        ctx.fill();
      }

      // Nodes — full-color circles with glow, initials, name, domain (legacy
      // 1291-1427, minus the interactive hover/highlight/NEW/add-node states).
      for (const n of nodes) {
        const nx = n.x ?? 0,
          ny = n.y ?? 0;
        const pulse = 1 + Math.sin(now * 0.002 + n.name.length) * 0.04;
        const rr = BASE_R * pulse;
        const [cr, cg, cb] = hexToRgb(n.color);

        const glowR = rr * 2.5;
        const grad = ctx.createRadialGradient(nx, ny, rr * 0.5, nx, ny, glowR);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.05)`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.beginPath();
        ctx.arc(nx, ny, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(nx, ny, rr, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.fill();
        ctx.strokeStyle = "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        ctx.fillStyle = "rgba(255,255,255,0.95)";
        ctx.font = `700 ${rr * 0.6}px Inter, sans-serif`;
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(n.initials, nx, ny);

        ctx.fillStyle = dk ? "rgba(245,245,247,0.8)" : "rgba(30,35,50,0.7)";
        ctx.font = "600 11px 'Libre Baskerville', Georgia, serif";
        ctx.fillText(n.name, nx, ny + rr + 14);

        ctx.fillStyle = dk ? "rgba(200,200,210,0.6)" : "rgba(100,110,130,0.6)";
        ctx.font = "400 9px Inter, sans-serif";
        const domainLabel =
          n.domain.length > 30 ? n.domain.slice(0, 28) + "…" : n.domain;
        ctx.fillText(domainLabel, nx, ny + rr + 27);
      }
    }

    // Keep the canvas backing store sized to the host (legacy used a fixed
    // canvas; we add a resize so the bg tracks viewport changes). On resize we
    // only repaint — under reduced-motion the sim is already settled.
    const onResize = () => {
      if (aborted.current || !ctx) return;
      const w = container.clientWidth || W;
      const h = container.clientHeight || H;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = w + "px";
      canvas.style.height = h + "px";
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      draw();
    };
    window.addEventListener("resize", onResize);
    graphCleanup.current = () => window.removeEventListener("resize", onResize);

    if (reduced) {
      // Settle synchronously, draw one frame, no rAF / particles.
      sim.stop();
      sim.tick(180);
      draw();
      return;
    }

    // The sim ticks itself; the rAF only drives canvas repaints + particles.
    sim.on("tick", () => {});
    const loop = () => {
      if (aborted.current) return;
      draw();
      graphRAF.current = requestAnimationFrame(loop);
    };
    loop();
  }, []);

  /* ---- Mount: kick off animations; unmount: tear everything down ---- */
  useEffect(() => {
    aborted.current = false;
    const reduced = prefersReducedMotion();

    // Time-of-day greeting, computed client-side to avoid SSR/hydration drift
    // (ports the legacy `hour < 12 ? 'Morning' : hour < 18 ? 'Afternoon' : 'Evening'`).
    if (greetingRef.current) {
      const hour = new Date().getHours();
      const word = hour < 12 ? "Morning" : hour < 18 ? "Afternoon" : "Evening";
      greetingRef.current.textContent = `${word}, Steve`;
    }

    if (reduced) {
      renderChatStatic();
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
      if (graphRAF.current) {
        cancelAnimationFrame(graphRAF.current);
        graphRAF.current = null;
      }
      if (graphSim.current) {
        graphSim.current.on("tick", null);
        graphSim.current.stop();
        graphSim.current = null;
      }
      if (graphCleanup.current) {
        graphCleanup.current();
        graphCleanup.current = null;
      }
    };
  }, [renderChatStatic, startChatDemo, startSearchDemo, startMindsGraph]);

  /* ---- Scroll-reveal for the below-hero sections (motion users only;
         reduced-motion keeps them statically visible via the CSS gate). ---- */
  useEffect(() => {
    if (prefersReducedMotion()) return;
    if (typeof IntersectionObserver === "undefined") return;
    const els = Array.from(document.querySelectorAll<HTMLElement>("[data-reveal]"));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add(styles.isVisible);
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12, rootMargin: "0px 0px -8% 0px" }
    );
    els.forEach((el) => io.observe(el));
    return () => io.disconnect();
  }, []);

  /* ---- Live stats band counts (public; band hides if this fails) ---- */
  useEffect(() => {
    let alive = true;
    getLandingStats()
      .then((s) => {
        if (alive && s && typeof s.books === "number") setStats(s);
      })
      .catch(() => {
        /* leave stats null → band stays hidden */
      });
    return () => {
      alive = false;
    };
  }, []);

  /* ---- Theme toggle (ports the inline lp-theme-toggle handler) ---- */
  const toggleTheme = useCallback(() => {
    const root = document.documentElement;
    if (isDarkMode()) {
      root.classList.add("light");
      root.classList.remove("dark");
      try {
        localStorage.setItem("feynman-theme", "light");
      } catch {
        /* storage may be unavailable */
      }
    } else {
      root.classList.add("dark");
      root.classList.remove("light");
      try {
        localStorage.setItem("feynman-theme", "dark");
      } catch {
        /* storage may be unavailable */
      }
    }
  }, []);

  return (
    <div className={styles.container}>
      <nav className={styles.topbar}>
        <span className={styles.topbarBrand}>
          <svg width="19" height="19" viewBox="0 0 64 64" fill="none">
            <line
              x1="8"
              y1="58"
              x2="32"
              y2="30"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <line
              x1="56"
              y1="58"
              x2="32"
              y2="30"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
            <circle cx="32" cy="30" r="3.5" fill="currentColor" />
            <path
              d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4"
              stroke="currentColor"
              strokeWidth="3"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Feynman
        </span>
        <div className={styles.topbarActions}>
          <button className={styles.themeToggle} onClick={toggleTheme} title="Toggle dark mode">
            <svg
              className={styles.iconSun}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="5" />
              <line x1="12" y1="1" x2="12" y2="3" />
              <line x1="12" y1="21" x2="12" y2="23" />
              <line x1="4.22" y1="4.22" x2="5.64" y2="5.64" />
              <line x1="18.36" y1="18.36" x2="19.78" y2="19.78" />
              <line x1="1" y1="12" x2="3" y2="12" />
              <line x1="21" y1="12" x2="23" y2="12" />
              <line x1="4.22" y1="19.78" x2="5.64" y2="18.36" />
              <line x1="18.36" y1="5.64" x2="19.78" y2="4.22" />
            </svg>
            <svg
              className={styles.iconMoon}
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
            </svg>
          </button>
          <button className={styles.topbarCta} onClick={onCta}>
            {ctaLabel}
          </button>
        </div>
      </nav>

      <section className={styles.fullscreen}>
        <div className={styles.bgCanvas} ref={bgRef} aria-hidden="true" />

        <div className={styles.mindsToolbar}>
          <input
            type="text"
            ref={searchRef}
            placeholder="Search minds..."
            autoComplete="off"
            readOnly
          />
          <button className={styles.mindsToolbarBtn} disabled>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <circle cx="12" cy="12" r="3" />
              <circle cx="4" cy="6" r="2" />
              <circle cx="20" cy="6" r="2" />
              <circle cx="4" cy="18" r="2" />
              <circle cx="20" cy="18" r="2" />
              <line x1="9.5" y1="10" x2="5.5" y2="7.5" />
              <line x1="14.5" y1="10" x2="18.5" y2="7.5" />
              <line x1="9.5" y1="14" x2="5.5" y2="16.5" />
              <line x1="14.5" y1="14" x2="18.5" y2="16.5" />
            </svg>
            Expand Network
          </button>
          <button className={styles.mindsToolbarBtn} disabled>
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <polyline points="17 8 12 3 7 8" />
              <line x1="12" y1="3" x2="12" y2="15" />
            </svg>
            Upload a Mind
          </button>
        </div>

        <div className={styles.fgCenter}>
          <div className={styles.heroLeft}>
            <h1 className={styles.heroHeadline}>
              Chat with books.
              <br />
              Great minds join in.
            </h1>
            <p className={styles.heroSub}>
              An interactive knowledge network built on the world&apos;s most important books
              and great minds. Turn any book into a conversation that goes beyond the page, or
              start from a topic to learn across a library that grows as you explore or write the
              book you want to read, with an evolving network of agent-simulated great minds joins
              your discussion, learn and grow with you.
            </p>
            <button className={styles.heroCta} onClick={onCta}>
              {ctaLabel}
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12" />
                <polyline points="12 5 19 12 12 19" />
              </svg>
            </button>
          </div>

          <div className={styles.chatCard}>
            <div className={styles.chatHome} ref={homeRef}>
              <div className={styles.chatHomeInner}>
                <div className={styles.greetingRow}>
                  <div className="greeting-logo-wrap" style={{ width: 28, height: 28 }}>
                    <svg
                      className="greeting-logo"
                      width="28"
                      height="28"
                      viewBox="0 0 56 56"
                      xmlns="http://www.w3.org/2000/svg"
                      shapeRendering="crispEdges"
                    >
                      <rect x="24" y="0" width="8" height="4" fill="#FDCB6E" />
                      <rect x="26" y="4" width="4" height="4" fill="#B8B8B8" />
                      <rect x="8" y="8" width="40" height="28" fill="#DA7756" />
                      <rect x="12" y="12" width="32" height="20" fill="#FFF1E0" />
                      <rect x="16" y="16" width="8" height="8" fill="#2D3436" />
                      <rect x="32" y="16" width="8" height="8" fill="#2D3436" />
                      <rect x="18" y="18" width="4" height="4" fill="#fff" />
                      <rect x="34" y="18" width="4" height="4" fill="#fff" />
                      <rect x="22" y="28" width="12" height="2" fill="#C45E3E" />
                      <rect x="18" y="38" width="4" height="8" fill="#B8B8B8" />
                      <rect x="34" y="38" width="4" height="8" fill="#B8B8B8" />
                    </svg>
                    <svg
                      className="greeting-feynman-logo"
                      width="28"
                      height="28"
                      viewBox="0 0 64 64"
                      fill="none"
                      xmlns="http://www.w3.org/2000/svg"
                    >
                      <line
                        x1="8"
                        y1="58"
                        x2="32"
                        y2="30"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <line
                        x1="56"
                        y1="58"
                        x2="32"
                        y2="30"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                      <circle cx="32" cy="30" r="3.5" fill="currentColor" />
                      <path
                        d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4"
                        stroke="currentColor"
                        strokeWidth="3"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      />
                    </svg>
                  </div>
                  <span className={styles.greeting} ref={greetingRef}>
                    Evening, Steve
                  </span>
                </div>
                <div className={`${styles.chatComposer} ${styles.composerDisabled}`}>
                  <div className={styles.selectedChips} />
                  <textarea
                    className={styles.composerInput}
                    ref={homeInputRef}
                    rows={1}
                    placeholder="Explore books, topics, or ideas — minds join the conversation..."
                    readOnly
                  />
                  <div className={styles.composerToolbar}>
                    <div className={styles.composerLeft}>
                      <button type="button" className={styles.composerIconBtn} disabled>
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`${styles.composerIconBtn} ${styles.composerMindsBtn}`}
                        disabled
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="6" cy="6" r="2.5" />
                          <circle cx="18" cy="8" r="2.5" />
                          <circle cx="8" cy="18" r="2.5" />
                          <circle cx="18" cy="18" r="2" />
                          <line x1="8.2" y1="7.2" x2="15.8" y2="7.2" />
                          <line x1="7" y1="8.3" x2="7.5" y2="15.5" />
                          <line x1="10.2" y1="17.2" x2="16" y2="17.8" />
                          <line x1="16.5" y1="10.3" x2="17.5" y2="16" />
                        </svg>
                      </button>
                    </div>
                    <button type="button" className={styles.composerSendBtn} disabled>
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                    </button>
                  </div>
                </div>
                <div className={`${styles.homeStarters} ${styles.startersCompact}`} ref={startersRef}>
                  <button className={styles.starterPill} disabled>
                    Key ideas in &quot;Thinking, Fast and Slow&quot;?
                  </button>
                  <button className={styles.starterPill} disabled>
                    Teach me the fundamentals of philosophy
                  </button>
                </div>
              </div>
            </div>

            <div className={`${styles.chatActive} hidden`} ref={activeRef}>
              <div className={styles.chatMessages} ref={bodyRef} />
              <div className={styles.chatInputArea}>
                <div className={`${styles.chatComposerInline} ${styles.composerDisabled}`}>
                  <div className={styles.selectedChips} ref={activeChipsRef} />
                  <textarea
                    className={`${styles.composerInput} ${styles.activeTextarea}`}
                    rows={1}
                    placeholder="Ask a follow-up question..."
                    readOnly
                  />
                  <div className={styles.composerToolbar}>
                    <div className={styles.composerLeft}>
                      <button type="button" className={styles.composerIconBtn} disabled>
                        <svg
                          width="20"
                          height="20"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <line x1="12" y1="5" x2="12" y2="19" />
                          <line x1="5" y1="12" x2="19" y2="12" />
                        </svg>
                      </button>
                      <button
                        type="button"
                        className={`${styles.composerIconBtn} ${styles.composerMindsBtn}`}
                        disabled
                      >
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <circle cx="6" cy="6" r="2.5" />
                          <circle cx="18" cy="8" r="2.5" />
                          <circle cx="8" cy="18" r="2.5" />
                          <circle cx="18" cy="18" r="2" />
                          <line x1="8.2" y1="7.2" x2="15.8" y2="7.2" />
                          <line x1="7" y1="8.3" x2="7.5" y2="15.5" />
                          <line x1="10.2" y1="17.2" x2="16" y2="17.8" />
                          <line x1="16.5" y1="10.3" x2="17.5" y2="16" />
                        </svg>
                      </button>
                    </div>
                    <button type="button" className={styles.composerSendBtn} disabled>
                      <svg
                        width="18"
                        height="18"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="19" x2="12" y2="5" />
                        <polyline points="5 12 12 5 19 12" />
                      </svg>
                    </button>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* Live stats band (real counts from /api/stats; hidden until loaded). */}
      {stats && (
        <section className={styles.statsBand}>
          <div className={styles.statsInner}>
            <div className={styles.stat}>
              <StatNumber value={stats.books} />
              <span className={styles.statLabel}>Books</span>
            </div>
            <span className={styles.statDivider} aria-hidden="true" />
            <div className={styles.stat}>
              <StatNumber value={stats.minds} />
              <span className={styles.statLabel}>Great minds</span>
            </div>
            <span className={styles.statDivider} aria-hidden="true" />
            <div className={styles.stat}>
              <StatNumber value={stats.symposiums} />
              <span className={styles.statLabel}>Symposiums</span>
            </div>
          </div>
        </section>
      )}

      {/* ═══════════ BELOW-THE-HERO SECTIONS (appended) ═══════════
          The hero <section> above is 100% untouched. Order follows the README's
          narrative — three ways to enter (a book, a topic, a mind), then the two
          extensions (symposiums, on-demand books). Consistent layout: every feature
          row is text-left / visual-right; the CTA is a centered band. Visuals reuse
          the demo message classes. */}
      <div className={styles.sections}>
        {/* 1 — Chat with a book or a topic; great minds join in (the core) */}
        <section className={`${styles.section} ${styles.reveal}`} data-reveal>
          <div className={`${styles.sectionInner} ${styles.featureRow}`}>
            <div className={styles.featureCopy}>
              <p className={styles.eyebrow}>Chat with books</p>
              <h2 className={styles.sectionTitle}>Chat with any book — and the most relevant minds join in.</h2>
              <p className={styles.bodyText}>
                Start from a book or a topic — every answer cited to the page, and great minds
                share their perspectives.
              </p>
              <button type="button" className={styles.softLink} onClick={onCta}>
                Start a chat
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.mockFrame}>
                <div className={styles.mockStack}>
                  <div className={styles.bookChip}>
                    <span>The Wealth of Nations</span>
                  </div>
                  <div className={`${styles.msg} ${styles.msgUser}`}>
                    What really creates the wealth of a nation?
                  </div>
                  <div className={`${styles.msg} ${styles.msgAssistant}`}>
                    <span>
                      The division of labour — productivity rises when work is specialized and
                      freely exchanged, not from hoarding gold.
                    </span>
                    <div className={styles.msgSources}>
                      <span className={styles.sourceTag}>Bk.1 Ch.1 — Of the Division of Labour</span>
                    </div>
                  </div>
                  <MockJoin
                    names={["Adam Smith", "Karl Marx", "John Maynard Keynes"]}
                    verb="joined the discussion"
                  />
                  <MockMind
                    name="Adam Smith"
                    text="Just so — and the wider the market, the further that division of labour can go."
                  />
                  <MockMind
                    name="Karl Marx"
                    text="But who owns that labour, Adam? The value the workers create accrues to capital, not to them."
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 2 — Library (the growing collection of books) */}
        <section className={`${styles.section} ${styles.reveal}`} data-reveal>
          <div className={`${styles.sectionInner} ${styles.featureRow}`}>
            <div className={styles.featureCopy}>
              <p className={styles.eyebrow}>Library</p>
              <h2 className={styles.sectionTitle}>A library that grows as you explore.</h2>
              <p className={styles.bodyText}>
                No fixed catalog — every book you chat, search, or mention joins it.
              </p>
              <Link className={styles.softLink} href="/library">
                Browse the library
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
            </div>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.mockFrame}>
                <div className={styles.libraryGrid}>
                  {LIB_BOOKS.map((b) => (
                    <div key={b.title} className={styles.libCard}>
                      <div className={styles.libArt} style={{ background: b.grad }}>
                        <span className={styles.libArtInitials}>{b.initials}</span>
                      </div>
                      <span className={styles.libTitle}>{b.title}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 3 — On-demand books: write the book you need */}
        <section className={`${styles.section} ${styles.reveal}`} data-reveal>
          <div className={`${styles.sectionInner} ${styles.featureRow}`}>
            <div className={styles.featureCopy}>
              <p className={styles.eyebrow}>On-demand books</p>
              <h2 className={styles.sectionTitle}>The book you need, written on demand.</h2>
              <p className={styles.bodyText}>
                Describe what you want to know, and Feynman generates a book for you in real time.
              </p>
              <button type="button" className={styles.softLink} onClick={onCta}>
                Write a book
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </button>
            </div>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.mockFrame}>
                <div className={styles.bookBuild}>
                  <div className={styles.bookBuildTitle}>The History of Coffee</div>
                  <div className={styles.bookBuildStatus}>All chapters complete · 100%</div>
                  <div className={styles.bookBuildBar}>
                    <div className={styles.bookBuildBarFill} />
                  </div>
                  <div className={styles.bookChapters}>
                    <div className={styles.bookChapter}>
                      <span className={styles.bookChapterCheck}>✓</span>
                      <span className={styles.bookChapterTitle}>Ch.1 · Origins in Ethiopia</span>
                      <span className={styles.bookChapterWords}>1,240 words</span>
                    </div>
                    <div className={styles.bookChapter}>
                      <span className={styles.bookChapterCheck}>✓</span>
                      <span className={styles.bookChapterTitle}>Ch.2 · The Spread of Coffee</span>
                      <span className={styles.bookChapterWords}>1,610 words</span>
                    </div>
                    <div className={styles.bookChapter}>
                      <span className={styles.bookChapterCheck}>✓</span>
                      <span className={styles.bookChapterTitle}>Ch.3 · Coffeehouse Culture</span>
                      <span className={styles.bookChapterWords}>1,090 words</span>
                    </div>
                    <div className={styles.bookChapter}>
                      <span className={styles.bookChapterCheck}>✓</span>
                      <span className={styles.bookChapterTitle}>Ch.4 · Coffee &amp; Commerce</span>
                      <span className={styles.bookChapterWords}>1,375 words</span>
                    </div>
                    <div className={styles.bookChapter}>
                      <span className={styles.bookChapterCheck}>✓</span>
                      <span className={styles.bookChapterTitle}>Ch.5 · The Modern Cup</span>
                      <span className={styles.bookChapterWords}>980 words</span>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 4 — Great minds: an ever-evolving network of simulated minds (chat 1:1 + upload) */}
        <section className={`${styles.section} ${styles.reveal}`} data-reveal>
          <div className={`${styles.sectionInner} ${styles.featureRow}`}>
            <div className={styles.featureCopy}>
              <p className={styles.eyebrow}>Great minds</p>
              <h2 className={styles.sectionTitle}>An ever-evolving network of simulated great minds.</h2>
              <p className={styles.bodyText}>
                A living map where minds connect by the ideas they share — chat with anyone,
                or upload your own.
              </p>
              <Link className={styles.softLink} href="/minds">
                Explore the network
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
            </div>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.mockFrame}>
                <div className={styles.constellation}>
                  <svg viewBox="0 0 420 264" preserveAspectRatio="xMidYMid meet">
                    {NETWORK_LINKS.map(([x1, y1, x2, y2], i) => (
                      <line
                        key={i}
                        x1={x1}
                        y1={y1}
                        x2={x2}
                        y2={y2}
                        stroke="rgba(150,160,180,0.35)"
                        strokeWidth="1.2"
                      />
                    ))}
                  </svg>
                  {NETWORK_NODES.map((n) => (
                    <div
                      key={n.name}
                      className={styles.cNode}
                      style={{ left: n.left, top: n.top }}
                    >
                      <span className={styles.cAvatar} style={{ background: lpColor(n.name) }}>
                        {initials(n.name)}
                      </span>
                      <span className={styles.cName}>{n.name}</span>
                    </div>
                  ))}
                  <div
                    className={`${styles.cNode} ${styles.cNodeUpload}`}
                    style={{ left: NETWORK_UPLOAD.left, top: NETWORK_UPLOAD.top }}
                  >
                    <span className={styles.cUpload}>
                      <svg
                        width="13"
                        height="13"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <line x1="12" y1="5" x2="12" y2="19" />
                        <line x1="5" y1="12" x2="19" y2="12" />
                      </svg>
                    </span>
                    <span className={styles.cName}>Upload a Mind</span>
                  </div>
                </div>
              </div>
            </div>
          </div>
        </section>

        {/* 5 — Symposiums */}
        <section className={`${styles.section} ${styles.reveal}`} data-reveal>
          <div className={`${styles.sectionInner} ${styles.featureRow}`}>
            <div className={styles.featureCopy}>
              <p className={styles.eyebrow}>Symposiums</p>
              <h2 className={styles.sectionTitle}>Put your question to a panel of great minds.</h2>
              <p className={styles.bodyText}>
                See how the sharpest minds view the questions we care about today.
              </p>
              <Link className={styles.softLink} href="/symposiums">
                Browse symposiums
                <svg
                  width="15"
                  height="15"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <line x1="5" y1="12" x2="19" y2="12" />
                  <polyline points="12 5 19 12 12 19" />
                </svg>
              </Link>
            </div>
            <div className={styles.featureVisual} aria-hidden="true">
              <div className={styles.mockFrame}>
                <div className={styles.mockStack}>
                  <div className={styles.symQuestion}>Is it better to be feared or loved?</div>
                  <MockJoin
                    names={["Machiavelli", "Sun Tzu", "Marcus Aurelius"]}
                    verb="in conversation"
                  />
                  <MockMind
                    name="Machiavelli"
                    text="It is far safer to be feared than loved, if one cannot be both."
                  />
                  <MockMind
                    name="Marcus Aurelius"
                    text="Yet a ruler governed by fear governs nothing in himself, Niccolò. Virtue commands more than dread."
                  />
                </div>
              </div>
            </div>
          </div>
        </section>

      </div>

      {/* Footer — social links live here (moved out of the topbar) */}
      <footer className={styles.footer}>
        <div className={styles.footerInner}>
          <span className={styles.footerLogo}>
            <svg width="18" height="18" viewBox="0 0 64 64" fill="none">
              <line x1="8" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <line x1="56" y1="58" x2="32" y2="30" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
              <circle cx="32" cy="30" r="3.5" fill="currentColor" />
              <path d="M32,30 C26,24 38,18 32,12 C26,6 38,0 32,-4" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            Feynman
          </span>
          <div className={styles.footerRight}>
            <span className={styles.footerCopy}>© 2026 Feynman. All rights reserved.</span>
            <div className={styles.footerSocials}>
            <a
              className={styles.footerSocial}
              href="https://github.com/steveyeow/feynman"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="GitHub"
              title="GitHub"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 .5C5.37.5 0 5.78 0 12.29c0 5.2 3.44 9.6 8.21 11.16.6.11.82-.25.82-.56 0-.28-.01-1.02-.02-2-3.34.71-4.04-1.58-4.04-1.58-.55-1.37-1.34-1.74-1.34-1.74-1.09-.73.08-.72.08-.72 1.2.08 1.84 1.21 1.84 1.21 1.07 1.79 2.81 1.27 3.49.97.11-.76.42-1.27.76-1.56-2.67-.3-5.47-1.31-5.47-5.81 0-1.28.47-2.33 1.24-3.15-.12-.3-.54-1.51.12-3.15 0 0 1.01-.32 3.3 1.2.96-.26 1.98-.39 3-.4 1.02.01 2.04.14 3 .4 2.28-1.52 3.29-1.2 3.29-1.2.66 1.64.24 2.85.12 3.15.77.82 1.24 1.87 1.24 3.15 0 4.51-2.81 5.5-5.49 5.79.43.36.81 1.08.81 2.18 0 1.58-.01 2.85-.01 3.24 0 .31.22.68.83.56C20.57 21.88 24 17.49 24 12.29 24 5.78 18.63.5 12 .5z" />
              </svg>
            </a>
            <a
              className={styles.footerSocial}
              href="https://discord.gg/bCShwbFnCd"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="Discord"
              title="Discord"
            >
              <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
              </svg>
            </a>
            <a
              className={styles.footerSocial}
              href="https://x.com/steve_yeow"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="X (Twitter)"
              title="X (Twitter)"
            >
              <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24h-6.66l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231zm-1.161 17.52h1.833L7.084 4.126H5.117z" />
              </svg>
            </a>
          </div>
          </div>
        </div>
      </footer>
    </div>
  );
}
