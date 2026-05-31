"use client";

import { useEffect, useRef, useCallback } from "react";
import { get } from "@/lib/api";
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

/* Extract an array from a payload that's either a bare array or { key: [...] }. */
function pickArray<T>(payload: unknown, key: string): T[] {
  if (Array.isArray(payload)) return payload as T[];
  if (payload && typeof payload === "object") {
    const v = (payload as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v as T[];
  }
  return [];
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
   Background minds force-graph (ports _renderLandingMindsGraph).

   Reads the live API: /api/minds (bare array of {id,name,domain}) and
   /api/minds/similarities → { links: [{source,target,strength}], layout }.
   Links use the `links` key + source/target/strength (mind ids). Nodes
   are colored via the legacy palette. Drawn faint on canvas behind
   everything. No d3 — a small force sim, kept low-opacity.
   ════════════════════════════════════════════════════════════════════ */
type GNode = {
  id: string;
  name: string;
  initials: string;
  color: string;
  tokens: string[];
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
};
type GLink = { source: GNode; target: GNode; strength: number };

interface GraphMind {
  id?: string | number;
  name?: string;
  domain?: string;
}
interface GraphSim {
  source?: string | number;
  target?: string | number;
  strength?: number;
}

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
  const graphCleanup = useRef<(() => void) | null>(null);
  const aborted = useRef(false);

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

  /* ---- Background minds graph: ports _renderLandingMindsGraph ---- */
  const startMindsGraph = useCallback(async () => {
    const container = bgRef.current;
    if (!container) return;

    let minds: GraphMind[] = [];
    let sims: GraphSim[] = [];
    try {
      const [m, s] = await Promise.all([
        get<unknown>("/api/minds"),
        get<unknown>("/api/minds/similarities"),
      ]);
      minds = pickArray<GraphMind>(m, "minds");
      // /api/minds/similarities → { links: [{source,target,strength}], layout }
      sims = pickArray<GraphSim>(s, "links");
    } catch {
      minds = [];
    }
    if (aborted.current || !container.isConnected) return;

    const reduced = prefersReducedMotion();
    const W = container.clientWidth || 1200;
    const H = container.clientHeight || 800;
    const dpr =
      typeof window !== "undefined" ? Math.min(window.devicePixelRatio || 1, 2) : 1;

    // Build nodes (cap to keep the background light); derive color from name.
    const capped = minds.slice(0, 60);
    const nodes: GNode[] = capped.map((m, i) => {
      const name = String(m.name || "");
      const angle = (i / Math.max(1, capped.length)) * Math.PI * 2;
      const rad = Math.min(W, H) * (0.18 + 0.12 * Math.random());
      return {
        id: String(m.id ?? m.name ?? i),
        name,
        initials: initials(name),
        color: lpColor(name),
        tokens: tokensOf(String(m.domain || "")),
        x: W / 2 + Math.cos(angle) * rad,
        y: H / 2 + Math.sin(angle) * rad,
        vx: 0,
        vy: 0,
        r: 3 + Math.random() * 4,
      };
    });
    if (!nodes.length) return;

    const byId: Record<string, GNode> = {};
    nodes.forEach((n) => (byId[n.id] = n));

    // Links: read the `links` key with source/target/strength (mind ids).
    let links: GLink[] = sims
      .map((l) => {
        const src = byId[String(l.source ?? "")];
        const tgt = byId[String(l.target ?? "")];
        const strength = Number(l.strength ?? 0.5);
        return src && tgt ? { source: src, target: tgt, strength } : null;
      })
      .filter((l): l is GLink => !!l);

    // Fallback: derive links from shared domain tokens (legacy heuristic) when
    // the similarities endpoint returns nothing useful.
    if (!links.length && nodes.length > 1) {
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const shared = nodes[i].tokens.filter((t) =>
            nodes[j].tokens.some((u) => t === u || t.includes(u) || u.includes(t))
          );
          if (shared.length > 0)
            links.push({ source: nodes[i], target: nodes[j], strength: shared.length });
        }
      }
      links = links.slice(0, 120);
    }

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

    let alpha = 1;
    const linkDist = (l: GLink) => Math.max(80, 280 - l.strength * 70);

    function tickSim() {
      // Many-body repulsion.
      for (let i = 0; i < nodes.length; i++) {
        for (let j = i + 1; j < nodes.length; j++) {
          const a = nodes[i];
          const b = nodes[j];
          const dx = a.x - b.x;
          const dy = a.y - b.y;
          let d2 = dx * dx + dy * dy;
          if (d2 < 1) d2 = 1;
          const force = (60 * alpha) / d2;
          const d = Math.sqrt(d2);
          const fx = (dx / d) * force * 6;
          const fy = (dy / d) * force * 6;
          a.vx += fx;
          a.vy += fy;
          b.vx -= fx;
          b.vy -= fy;
        }
      }
      // Link springs toward the strength-weighted distance.
      links.forEach((l) => {
        const dx = l.target.x - l.source.x;
        const dy = l.target.y - l.source.y;
        const d = Math.sqrt(dx * dx + dy * dy) || 1;
        const k = ((d - linkDist(l)) / d) * 0.04 * alpha;
        const fx = dx * k;
        const fy = dy * k;
        l.source.vx += fx;
        l.source.vy += fy;
        l.target.vx -= fx;
        l.target.vy -= fy;
      });
      // Gentle centering + velocity decay.
      nodes.forEach((n) => {
        n.vx += (W / 2 - n.x) * 0.0015 * alpha;
        n.vy += (H / 2 - n.y) * 0.0015 * alpha;
        n.vx *= 0.9;
        n.vy *= 0.9;
        n.x += n.vx;
        n.y += n.vy;
      });
      alpha *= 0.99;
    }

    function draw() {
      if (!ctx) return;
      ctx.clearRect(0, 0, W, H);
      const dk = isDarkMode();

      // Links — faint.
      for (const l of links) {
        const a = 0.12 + Math.min(1, l.strength) * 0.08;
        ctx.beginPath();
        ctx.moveTo(l.source.x, l.source.y);
        ctx.lineTo(l.target.x, l.target.y);
        ctx.strokeStyle = `rgba(160,170,190,${a})`;
        ctx.lineWidth = 0.6 + Math.min(2, l.strength) * 0.4;
        ctx.stroke();
      }

      // Nodes — colored dots, kept low-opacity behind the foreground.
      for (const n of nodes) {
        const [cr, cg, cb] = hexToRgb(n.color);
        const glowR = n.r * 4;
        const grad = ctx.createRadialGradient(n.x, n.y, n.r, n.x, n.y, glowR);
        grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.06)`);
        grad.addColorStop(1, "rgba(255,255,255,0)");
        ctx.beginPath();
        ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
        ctx.fillStyle = grad;
        ctx.fill();

        ctx.beginPath();
        ctx.arc(n.x, n.y, n.r, 0, Math.PI * 2);
        ctx.fillStyle = n.color;
        ctx.globalAlpha = 0.55;
        ctx.fill();
        ctx.globalAlpha = 1;
        ctx.strokeStyle = dk ? "rgba(255,255,255,0.12)" : "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1;
        ctx.stroke();
      }
    }

    if (reduced) {
      for (let i = 0; i < 160; i++) tickSim();
      draw();
      const onResize = () => {
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
      return;
    }

    const loop = () => {
      if (aborted.current) return;
      tickSim();
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
      if (graphCleanup.current) {
        graphCleanup.current();
        graphCleanup.current = null;
      }
    };
  }, [renderChatStatic, startChatDemo, startSearchDemo, startMindsGraph]);

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
          <a
            href="https://discord.gg/bCShwbFnCd"
            target="_blank"
            rel="noopener noreferrer"
            className={styles.discordLink}
            title="Join our Discord"
          >
            <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
              <path d="M20.317 4.37a19.791 19.791 0 0 0-4.885-1.515.074.074 0 0 0-.079.037c-.21.375-.444.864-.608 1.25a18.27 18.27 0 0 0-5.487 0 12.64 12.64 0 0 0-.617-1.25.077.077 0 0 0-.079-.037A19.736 19.736 0 0 0 3.677 4.37a.07.07 0 0 0-.032.027C.533 9.046-.32 13.58.099 18.057a.082.082 0 0 0 .031.057 19.9 19.9 0 0 0 5.993 3.03.078.078 0 0 0 .084-.028c.462-.63.874-1.295 1.226-1.994a.076.076 0 0 0-.041-.106 13.107 13.107 0 0 1-1.872-.892.077.077 0 0 1-.008-.128 10.2 10.2 0 0 0 .372-.292.074.074 0 0 1 .077-.01c3.928 1.793 8.18 1.793 12.062 0a.074.074 0 0 1 .078.01c.12.098.246.198.373.292a.077.077 0 0 1-.006.127 12.299 12.299 0 0 1-1.873.892.077.077 0 0 0-.041.107c.36.698.772 1.362 1.225 1.993a.076.076 0 0 0 .084.028 19.839 19.839 0 0 0 6.002-3.03.077.077 0 0 0 .032-.054c.5-5.177-.838-9.674-3.549-13.66a.061.061 0 0 0-.031-.03zM8.02 15.33c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.956-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.956 2.418-2.157 2.418zm7.975 0c-1.183 0-2.157-1.085-2.157-2.419 0-1.333.955-2.419 2.157-2.419 1.21 0 2.176 1.095 2.157 2.42 0 1.333-.946 2.418-2.157 2.418z" />
            </svg>
          </a>
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
                  <div className={styles.greetingLogoWrap} style={{ width: 28, height: 28 }}>
                    <svg
                      className={styles.greetingLogo}
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
                      className={styles.greetingFeynmanLogo}
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
    </div>
  );
}
