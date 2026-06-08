"use client";

/**
 * MINDS NETWORK — d3 force-directed graph on a <canvas>. Faithful port of the
 * legacy app.js `_renderMindsGraph` / `_fetchGraphData` / `_makeEmbeddingForce`
 * plus the minds toolbar / tooltip / search handlers.
 *
 * Forces (matching the legacy):
 *   link    — distance max(80, 280 - strength*70), strength 0.08 + strength*0.15
 *   charge  — forceManyBody().strength(-600).distanceMax(800)
 *   embed   — custom: nudge each node toward its PCA layout pos (strength ~0.04,
 *             scaled to the viewport)
 *   collide — radius ~ BASE_R + 20
 *
 * Interactions: zoom/pan (d3.zoom), hover (proximity focus + highlight node &
 * its links + glass tooltip with Chat/Profile), click → /mind/{id}, search
 * highlight (dim non-matches).
 *
 * Cleanup (fixing the legacy listener leak): on unmount we cancel the rAF, stop
 * the simulation, disconnect the ResizeObserver, and abort all canvas/window
 * listeners via an AbortController. Re-entrant-safe under React StrictMode's
 * double-mount.
 */

import { useEffect, useRef, useState, useCallback } from "react";
import { useRouter } from "next/navigation";
import * as d3 from "d3";
import {
  Mind,
  GraphNode,
  SimLink,
  buildGraphData,
  hexToRgb,
  listMinds,
  getSimilarities,
} from "@/lib/minds";
import { post } from "@/lib/api";
import { useProGate } from "@/components/pro/ProOverlay";
import styles from "./MindsGraph.module.css";

const BASE_R = 20; // node radius (legacy ~20–30 clamped; we fix at 20 then scale on focus)
const FOCUS_RADIUS = 250; // proximity-grow radius
const EMBED_STRENGTH = 0.04;

type ModalKind = null | "upload" | "expand";

export default function MindsGraph() {
  const router = useRouter();
  const containerRef = useRef<HTMLDivElement>(null);
  // Expand-network / upload-a-mind / chat-with-a-mind are pro features on the
  // hosted build (legacy app.js 6784/6838/6846/6807/7693/7697). Node click →
  // /mind/{id} stays FREE (legacy keeps the paywall on explicit Chat only).
  const { requirePro } = useProGate();

  const [minds, setMinds] = useState<Mind[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // Tooltip is React-rendered (positioned absolutely) so it gets the glass
  // .minds-tooltip styling and real next/router navigation on its buttons.
  const [tooltip, setTooltip] = useState<{
    node: GraphNode;
    left: number;
    top: number;
  } | null>(null);
  const tooltipHoveredRef = useRef(false);
  // Grace timer so the pointer can travel from a node to its tooltip without
  // the tooltip vanishing mid-flight (legacy used the same 100ms idea).
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancelHide = useCallback(() => {
    if (hideTimerRef.current) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);
  const scheduleHide = useCallback(() => {
    cancelHide();
    hideTimerRef.current = setTimeout(() => {
      if (!tooltipHoveredRef.current) setTooltip(null);
    }, 140);
  }, [cancelHide]);

  const [modal, setModal] = useState<ModalKind>(null);

  // Search highlight is read by the draw loop via a ref so typing doesn't
  // re-run the whole simulation effect. Declared before the sim effect that
  // closes over it.
  const highlightRef = useRef("");
  const [searchValue, setSearchValue] = useState("");
  useEffect(() => {
    highlightRef.current = searchValue;
  }, [searchValue]);

  // ── Load data ───────────────────────────────────────────────────────────
  const reload = useCallback(() => setReloadKey((k) => k + 1), []);

  useEffect(() => {
    let cancelled = false;
    setMinds(null);
    setError(null);
    (async () => {
      try {
        const list = await listMinds();
        if (cancelled) return;
        setMinds(list);
      } catch {
        if (!cancelled) setError("Couldn't load the minds network.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [reloadKey]);

  // ── Build + run the simulation whenever minds change ─────────────────────
  useEffect(() => {
    const container = containerRef.current;
    if (!container || !minds || minds.length === 0) return;

    let disposed = false;
    let raf = 0;
    let sim: d3.Simulation<GraphNode, SimLink> | null = null;
    let resizeObs: ResizeObserver | null = null;
    const abort = new AbortController();
    const signal = abort.signal;

    let nodes: GraphNode[] = [];
    let links: SimLink[] = [];
    // Flowing particles that travel along links (production's elegant flow).
    type Particle = { link: SimLink; t: number; speed: number; size: number; opacity: number };
    let particles: Particle[] = [];

    const dpr = window.devicePixelRatio || 1;
    let W = container.clientWidth || 900;
    let H = container.clientHeight || 600;

    const canvas = document.createElement("canvas");
    canvas.className = styles.canvas;
    canvas.width = W * dpr;
    canvas.height = H * dpr;
    canvas.style.width = W + "px";
    canvas.style.height = H + "px";
    container.appendChild(canvas);
    const ctx2d = canvas.getContext("2d");
    if (!ctx2d) {
      canvas.remove();
      return;
    }
    const ctx: CanvasRenderingContext2D = ctx2d;
    ctx.scale(dpr, dpr);

    // Theme: read --canvas-bg + dark flag once; refresh cheaply on resize/draw
    // start. (The per-frame cost in the legacy was the reason this was cached.)
    const root = document.documentElement;
    const readTheme = () => {
      const dk =
        root.classList.contains("dark") ||
        (!root.classList.contains("light") &&
          window.matchMedia?.("(prefers-color-scheme: dark)").matches);
      const canvasBg =
        getComputedStyle(root).getPropertyValue("--canvas-bg").trim() ||
        (dk ? "#1c1c1e" : "#ffffff");
      return { dk: !!dk, canvasBg };
    };
    let theme = readTheme();
    const themeObserver = new MutationObserver(() => {
      theme = readTheme();
    });
    themeObserver.observe(root, { attributes: true, attributeFilter: ["class"] });

    // ── Embedding force: nudge nodes toward their PCA fractional position ──
    function embeddingForce(strength: number) {
      let ns: GraphNode[] = [];
      const force = (alpha: number) => {
        for (const n of ns) {
          if (!n.layoutPos) continue;
          n.vx = (n.vx || 0) + (n.layoutPos.rx * W - (n.x || 0)) * strength * alpha;
          n.vy = (n.vy || 0) + (n.layoutPos.ry * H - (n.y || 0)) * strength * alpha;
        }
      };
      (force as d3.Force<GraphNode, SimLink>).initialize = (n) => {
        ns = n as GraphNode[];
      };
      return force as d3.Force<GraphNode, SimLink>;
    }

    // ── Simulation builder (forces match production _renderMindsGraph) ──
    function buildSimulation(): d3.Simulation<GraphNode, SimLink> {
      const linkForce = d3
        .forceLink<GraphNode, SimLink>(links)
        .id((d) => d.id)
        .distance((d) => Math.max(80, 280 - (d.strength || 0) * 70))
        .strength((d) => 0.08 + (d.strength || 0) * 0.15);

      return d3
        .forceSimulation<GraphNode, SimLink>(nodes)
        .force("link", linkForce)
        .force("charge", d3.forceManyBody<GraphNode>().strength(-600).distanceMax(800))
        .force("embedding", embeddingForce(EMBED_STRENGTH))
        .force("collision", d3.forceCollide<GraphNode>().radius(BASE_R + 20))
        .alphaDecay(0.015)
        .on("tick", () => {
          /* draw loop reads positions; nothing to do here */
        });
    }

    // ── Fetch the PCA layout FIRST, then build the graph ONCE — exactly like
    //    production's _renderMindsGraph. We deliberately do NOT pre-seed node
    //    x/y: d3 then default-places them in a phyllotaxis cluster near the
    //    origin (top-left of the canvas), and the embedding force flows them
    //    out to their PCA targets in a single smooth entrance — not a random
    //    starburst from the center. (Layout fetch failure → empty layout →
    //    charge-only spread from the origin, still renders.) ──
    (async () => {
      const { links: simLinks, layout } = await getSimilarities();
      if (disposed) return;
      const built = buildGraphData(minds, simLinks, layout);
      nodes = built.nodes;
      links = built.links;
      // Seed flowing particles along the links (port of app.js: cap 1-2 per link).
      particles = [];
      for (const l of links) {
        const count = Math.min(2, Math.max(1, Math.round(l.strength || 0)));
        for (let i = 0; i < count; i++) {
          particles.push({
            link: l,
            t: Math.random(),
            speed: 0.001 + Math.random() * 0.003,
            size: 1 + Math.random() * 1.5,
            opacity: 0.3 + Math.random() * 0.5,
          });
        }
      }
      sim = buildSimulation(); // auto-starts at alpha 1, like production
    })();

    // ── Zoom / pan ─────────────────────────────────────────────────────────
    let transform = d3.zoomIdentity;
    let isOnNode = false;
    let draggedNode: GraphNode | null = null;
    let suppressClick = false;

    const zoomBehavior = d3
      .zoom<HTMLCanvasElement, unknown>()
      .scaleExtent([0.1, 6])
      .filter((e: Event) => {
        if ((e as WheelEvent).type === "wheel") return true;
        if ((e as MouseEvent).type === "dblclick") return true;
        if (draggedNode) return false;
        if (isOnNode) return false;
        return true;
      })
      .on("zoom", (e) => {
        transform = e.transform;
      });
    d3.select(canvas).call(zoomBehavior);

    // ── Hit testing (matches legacy proximity-grown hit radius) ────────────
    function nodeAt(cx: number, cy: number, mouseWorld: [number, number] | null): GraphNode | null {
      const [mx, my] = transform.invert([cx, cy]);
      for (let i = nodes.length - 1; i >= 0; i--) {
        const n = nodes[i];
        if (n.x == null || n.y == null) continue;
        let hr = BASE_R;
        if (mouseWorld) {
          const dd = Math.hypot(n.x - mx, n.y - my);
          hr = dd < FOCUS_RADIUS ? BASE_R * (1 + (1 - dd / FOCUS_RADIUS) * 0.7) : BASE_R * 0.75;
        }
        hr += 6;
        const dx = mx - n.x;
        const dy = my - n.y;
        if (dx * dx + dy * dy < hr * hr) return n;
      }
      return null;
    }

    // ── Interaction state ──────────────────────────────────────────────────
    let hoveredNode: GraphNode | null = null;
    let mouseWorld: [number, number] | null = null;
    let highlightQuery = highlightRef.current;

    // ── Node dragging (pin while dragging, like the legacy) ────────────────
    canvas.addEventListener(
      "mousedown",
      (e) => {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const [wx, wy] = transform.invert([cx, cy]);
        const hit = nodes.find((d) => {
          if (d.x == null || d.y == null) return false;
          const dx = wx - d.x;
          const dy = wy - d.y;
          return dx * dx + dy * dy < (BASE_R + 8) * (BASE_R + 8);
        });
        if (hit) {
          draggedNode = hit;
          hit.fx = hit.x;
          hit.fy = hit.y;
          sim?.alphaTarget(0.3).restart();
          e.stopPropagation();
          e.preventDefault();
        }
      },
      { signal },
    );

    window.addEventListener(
      "mousemove",
      (e) => {
        if (!draggedNode) return;
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const [wx, wy] = transform.invert([cx, cy]);
        draggedNode.fx = wx;
        draggedNode.fy = wy;
      },
      { signal },
    );

    window.addEventListener(
      "mouseup",
      () => {
        if (!draggedNode) return;
        draggedNode.fx = null;
        draggedNode.fy = null;
        draggedNode = null;
        suppressClick = true;
        sim?.alphaTarget(0);
      },
      { signal },
    );

    // ── Hover → tooltip + cursor + focus ───────────────────────────────────
    canvas.addEventListener(
      "mousemove",
      (e) => {
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        mouseWorld = transform.invert([cx, cy]);
        const n = nodeAt(cx, cy, mouseWorld);
        hoveredNode = n;
        isOnNode = !!n;
        canvas.style.cursor = n ? "pointer" : "grab";
        if (n) {
          cancelHide();
          // anchor tooltip near the cursor, flip left if it would overflow
          const left = cx + 16 + 320 > W ? cx - 330 : cx + 16;
          setTooltip({ node: n, left: Math.max(8, left), top: Math.max(8, cy - 10) });
        } else {
          scheduleHide();
        }
      },
      { signal },
    );

    canvas.addEventListener(
      "mouseleave",
      () => {
        mouseWorld = null;
        hoveredNode = null;
        // Defer the hide so the pointer can reach the (sibling) tooltip; the
        // tooltip's own onMouseEnter cancels this timer.
        scheduleHide();
      },
      { signal },
    );

    // ── Click → /mind/{id} ─────────────────────────────────────────────────
    canvas.addEventListener(
      "click",
      (e) => {
        if (suppressClick) {
          suppressClick = false;
          return;
        }
        const rect = canvas.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const n = nodeAt(cx, cy, transform.invert([cx, cy]));
        // Slug (not uuid) → skip the middleware's blocking uuid→slug 301 hop.
        if (n) router.push(`/mind/${encodeURIComponent(n.slug || n.id)}`);
      },
      { signal },
    );

    // ── Resize ───────────────────────────────────────────────────────────
    resizeObs = new ResizeObserver(() => {
      const newW = container.clientWidth || W;
      const newH = container.clientHeight || H;
      if (newW === W && newH === H) return;
      W = newW;
      H = newH;
      canvas.width = W * dpr;
      canvas.height = H * dpr;
      canvas.style.width = W + "px";
      canvas.style.height = H + "px";
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.scale(dpr, dpr);
      sim?.alpha(0.3).restart();
    });
    resizeObs.observe(container);

    // ── Draw loop ──────────────────────────────────────────────────────────
    function resolve(end: GraphNode | string): GraphNode | undefined {
      return typeof end === "object" ? end : nodes.find((n) => n.id === end);
    }

    function draw() {
      if (disposed) return;
      const now = performance.now();
      const dk = theme.dk;
      highlightQuery = highlightRef.current;

      ctx.save();
      ctx.fillStyle = theme.canvasBg;
      ctx.fillRect(0, 0, W, H);
      ctx.translate(transform.x, transform.y);
      ctx.scale(transform.k, transform.k);

      // search highlight set
      const q = highlightQuery.trim().toLowerCase();
      const matchIds = new Set<string>();
      if (q) for (const n of nodes) if (n.name.toLowerCase().includes(q)) matchIds.add(n.id);
      const filtering = !!q;

      // links — always THIN (production never thickens links on hover; only the
      // node glows). Search-filtering dims non-matches. (Port of app.js 6179-6189.)
      for (const l of links) {
        const s = resolve(l.source);
        const t = resolve(l.target);
        if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
        const dimmed = filtering && !matchIds.has(s.id) && !matchIds.has(t.id);
        const alpha = dimmed ? 0.04 : 0.12 + l.strength * 0.08;
        ctx.beginPath();
        ctx.moveTo(s.x, s.y);
        ctx.lineTo(t.x, t.y);
        ctx.strokeStyle = `rgba(160,170,190,${alpha})`;
        ctx.lineWidth = 0.6 + l.strength * 0.4;
        ctx.stroke();
      }

      // flowing particles along the links — the elegant flow from production
      // (app.js 6227-6239). Hidden when zoomed far out.
      for (const p of particles) {
        p.t += p.speed;
        if (p.t > 1) p.t -= 1;
        const s = resolve(p.link.source);
        const t = resolve(p.link.target);
        if (!s || !t || s.x == null || s.y == null || t.x == null || t.y == null) continue;
        if (filtering && !matchIds.has(s.id) && !matchIds.has(t.id)) continue;
        const sz = p.size * transform.k < 0.5 ? 0 : p.size;
        if (sz <= 0) continue;
        const px = s.x + (t.x - s.x) * p.t;
        const py = s.y + (t.y - s.y) * p.t;
        ctx.beginPath();
        ctx.arc(px, py, sz, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(130,150,200,${p.opacity * 0.45})`;
        ctx.fill();
      }

      // nodes
      for (const n of nodes) {
        if (n.x == null || n.y == null) continue;
        const dimmed = filtering && !matchIds.has(n.id);
        const hovered = hoveredNode === n;
        const highlighted = filtering && matchIds.has(n.id);

        let r = BASE_R;
        if (mouseWorld) {
          const dist = Math.hypot(n.x - mouseWorld[0], n.y - mouseWorld[1]);
          r = dist < FOCUS_RADIUS ? BASE_R * (1 + (1 - dist / FOCUS_RADIUS) * 0.7) : BASE_R * 0.75;
        }
        if (hovered) r = Math.max(r, BASE_R * 1.6);
        const pulse = 1 + Math.sin(now * 0.002 + n.name.length) * 0.04;
        const rr = r * pulse;
        const [cr, cg, cb] = hexToRgb(n.color);

        // halo (cheap flat for normal, gradient for hover) — legacy opacity 0.8→1
        if (!dimmed) {
          if (hovered) {
            const glowR = rr * 2.5;
            const grad = ctx.createRadialGradient(n.x, n.y, rr * 0.5, n.x, n.y, glowR);
            grad.addColorStop(0, `rgba(${cr},${cg},${cb},0.16)`);
            grad.addColorStop(1, "rgba(255,255,255,0)");
            ctx.beginPath();
            ctx.arc(n.x, n.y, glowR, 0, Math.PI * 2);
            ctx.fillStyle = grad;
            ctx.fill();
          } else {
            ctx.beginPath();
            ctx.arc(n.x, n.y, rr * 1.5, 0, Math.PI * 2);
            ctx.fillStyle = `rgba(${cr},${cg},${cb},0.04)`;
            ctx.fill();
          }
        }

        // selection/highlight ring
        if (highlighted || hovered) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, rr + 3, 0, Math.PI * 2);
          ctx.strokeStyle = `rgba(${cr},${cg},${cb},${hovered ? 0.5 : 0.3})`;
          ctx.lineWidth = 2;
          ctx.stroke();
        }

        // body — opacity 0.8 default, full on hover/highlight (legacy feel)
        const bodyAlpha = dimmed ? 0.12 : hovered || highlighted ? 1 : 0.85;
        ctx.beginPath();
        ctx.arc(n.x, n.y, rr, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(${cr},${cg},${cb},${bodyAlpha})`;
        ctx.fill();
        ctx.strokeStyle = dimmed
          ? dk
            ? "rgba(255,255,255,0.03)"
            : "rgba(0,0,0,0.03)"
          : "rgba(255,255,255,0.25)";
        ctx.lineWidth = 1.5;
        ctx.stroke();

        if (!dimmed) {
          ctx.fillStyle = "rgba(255,255,255,0.95)";
          ctx.font = `700 ${rr * 0.6}px Inter, sans-serif`;
          ctx.textAlign = "center";
          ctx.textBaseline = "middle";
          ctx.fillText(n.initials, n.x, n.y);

          ctx.fillStyle = dk
            ? `rgba(245,245,247,${hovered ? 0.95 : 0.8})`
            : `rgba(30,35,50,${hovered ? 0.9 : 0.7})`;
          ctx.font = `600 ${hovered ? 12 : 11}px 'Libre Baskerville', Georgia, serif`;
          ctx.fillText(n.name, n.x, n.y + rr + 14);

          if (n.era) {
            ctx.fillStyle = dk ? "rgba(200,200,210,0.6)" : "rgba(100,110,130,0.6)";
            ctx.font = "400 9px Inter, sans-serif";
            ctx.fillText(n.era, n.x, n.y + rr + 27);
          }
        }
      }

      ctx.restore();
      raf = requestAnimationFrame(draw);
    }
    raf = requestAnimationFrame(draw);

    // ── Cleanup (fixes the legacy listener leak) ───────────────────────────
    return () => {
      disposed = true;
      if (raf) cancelAnimationFrame(raf);
      sim?.stop();
      sim = null;
      resizeObs?.disconnect();
      themeObserver.disconnect();
      abort.abort(); // removes all canvas + window listeners
      d3.select(canvas).on(".zoom", null);
      canvas.remove();
      cancelHide();
      setTooltip(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [minds, router]);

  // ── Render ────────────────────────────────────────────────────────────────
  const loading = minds === null && !error;
  const empty = minds !== null && minds.length === 0;

  return (
    <>
      {/* Toolbar (glass via .minds-graph-toolbar). The page wrapper also renders
          a static toolbar for SSR, but the interactive one lives here so search
          + buttons are wired. */}
      <div className="minds-graph-toolbar">
        <input
          type="text"
          id="minds-search"
          value={searchValue}
          onChange={(e) => setSearchValue(e.target.value)}
          placeholder="Search minds..."
          autoComplete="off"
        />
        <button
          className="minds-add-btn"
          title="Invite a great mind to expand the network"
          onClick={() => requirePro(() => setModal("expand"))}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
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
        <button
          className="minds-add-btn"
          title="Upload your own mind to connect with the network"
          style={{ marginLeft: 4 }}
          onClick={() => requirePro(() => setModal("upload"))}
        >
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Upload a Mind
        </button>
      </div>

      <div ref={containerRef} id="minds-graph" className="minds-graph">
        {loading && (
          <div className={styles.state}>
            <span>Loading the minds network…</span>
          </div>
        )}
        {error && (
          <div className={styles.state}>
            <strong>{error}</strong>
            <div className={styles.stateActions}>
              <button className={styles.btnGhost} onClick={reload}>
                Retry
              </button>
            </div>
          </div>
        )}
        {empty && !error && (
          <div className={styles.state}>
            <strong>The network is empty.</strong>
            <span>Minds are being generated — or invite one to get started.</span>
            <div className={styles.stateActions}>
              <button
                className={styles.btnPrimary}
                onClick={() => requirePro(() => setModal("expand"))}
              >
                Invite a great mind
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Hover tooltip — glass via .minds-tooltip; buttons use next/router. */}
      {tooltip && (
        <div
          className="minds-tooltip"
          style={{ left: tooltip.left, top: tooltip.top }}
          onMouseEnter={() => {
            tooltipHoveredRef.current = true;
            cancelHide();
          }}
          onMouseLeave={() => {
            tooltipHoveredRef.current = false;
            scheduleHide();
          }}
        >
          <div className="tt-header-row">
            <div>
              <div className="tt-name">{tooltip.node.name}</div>
              {tooltip.node.era && <div className="tt-era">{tooltip.node.era}</div>}
            </div>
            <div className="tt-actions">
              <button
                className="tt-profile-btn"
                title={`View ${tooltip.node.name}'s profile`}
                // Link the descriptive slug (not the uuid) so navigation skips the
                // middleware's blocking uuid→slug origin fetch + 301 redirect.
                onClick={() => router.push(`/mind/${encodeURIComponent(tooltip.node.slug || tooltip.node.id)}`)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" />
                  <circle cx="12" cy="7" r="4" />
                </svg>
                <span>Profile</span>
              </button>
              <button
                className="tt-chat-icon-btn"
                title={`Chat with ${tooltip.node.name}`}
                // Chatting with a single mind is pro-gated (legacy app.js 6807);
                // the Profile button above stays free. Routes to the dedicated
                // 1:1 chat page (legacy #/mind/{id} WAS this chat surface).
                onClick={() =>
                  requirePro(() =>
                    router.push(`/mind/${encodeURIComponent(tooltip.node.slug || tooltip.node.id)}/chat`),
                  )
                }
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                </svg>
                <span>Chat</span>
              </button>
            </div>
          </div>
          {tooltip.node.tokens.length > 0 && (
            <div className="tt-domains">
              {tooltip.node.tokens.slice(0, 6).map((t) => (
                <span key={t} className="tt-domain-tag">
                  {t}
                </span>
              ))}
            </div>
          )}
          {tooltip.node.bio && <div className="tt-bio">{tooltip.node.bio}</div>}
        </div>
      )}

      {modal && (
        <MindModal
          kind={modal}
          onClose={() => setModal(null)}
          onSuccess={() => {
            setModal(null);
            reload();
          }}
        />
      )}
    </>
  );
}

// ── Minimal modal for Upload-a-Mind / Expand-Network ──────────────────────
// NOTE: intentionally minimal (a small glass form) vs. the legacy's richer
// "Noosphere" dialog + suggest→generate fan-out animation. Upload posts to
// /api/minds/create-from-content; Expand posts to /api/minds/generate by name.
function MindModal({
  kind,
  onClose,
  onSuccess,
}: {
  kind: Exclude<ModalKind, null>;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const router = useRouter();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [content, setContent] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  // When the backend reports the uploaded mind already exists (name_match or
  // semantic_match), we show an "already in your network — open it" state
  // instead of a misleading success (port of showMindDuplicateDialog).
  const [dup, setDup] = useState<{
    id: string;
    name: string;
    era?: string;
    reason?: string;
    similarity?: number;
  } | null>(null);

  async function submit() {
    const trimmedName = name.trim();
    if (!trimmedName) {
      setErr("A name is required.");
      return;
    }
    if (kind === "upload" && !url.trim() && !content.trim()) {
      setErr("Provide a profile/blog URL or paste some content.");
      return;
    }
    setBusy(true);
    setErr(null);
    try {
      if (kind === "upload") {
        const data = await post<{
          duplicate?: boolean;
          id: string;
          name: string;
          era?: string;
          duplicate_reason?: string;
          similarity?: number;
        }>("/api/minds/create-from-content", {
          name: trimmedName,
          source_url: url.trim() || undefined,
          content: content.trim() || undefined,
        });
        if (data?.duplicate) {
          // Already in the network — don't reload as if it succeeded.
          setDup({
            id: data.id,
            name: data.name,
            era: data.era,
            reason: data.duplicate_reason,
            similarity: data.similarity,
          });
          setBusy(false);
          return;
        }
      } else {
        await post("/api/minds/generate", { name: trimmedName });
      }
      onSuccess();
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Something went wrong. Try again.");
      setBusy(false);
    }
  }

  const isUpload = kind === "upload";

  // Duplicate-upload state: the mind already exists — offer to open it.
  if (dup) {
    return (
      <div className={styles.modalOverlay} onClick={onClose}>
        <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
          <h3>Already in your network</h3>
          <p className={styles.modalDesc}>
            {dup.reason === "semantic_match" && dup.similarity != null
              ? `This looks like the same person as “${dup.name}”${dup.era ? ` (${dup.era})` : ""}, already in your network (content similarity ${Math.round(dup.similarity * 100)}%).`
              : `A mind named “${dup.name}”${dup.era ? ` (${dup.era})` : ""} is already in your network.`}
          </p>
          <div className={styles.modalActions}>
            <button className={styles.btnGhost} onClick={onClose}>
              Cancel
            </button>
            <button
              className={styles.btnPrimary}
              onClick={() => router.push(`/mind/${encodeURIComponent(dup.id)}`)}
            >
              Open it →
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className={styles.modalOverlay} onClick={onClose}>
      <div className={styles.modalCard} onClick={(e) => e.stopPropagation()}>
        <h3>{isUpload ? "Upload a Mind" : "Expand the Network"}</h3>
        <p className={styles.modalDesc}>
          {isUpload
            ? "Upload a Twitter/X profile, blog URL, or paste text to connect a new mind to the network."
            : "Invite a great mind from the Noosphere — humanity's collective wisdom — to join the network."}
        </p>
        <input
          className={styles.modalField}
          type="text"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder={isUpload ? "Name" : "e.g. Socrates, Ada Lovelace, Zhuang Zhou…"}
          autoFocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && !isUpload) submit();
          }}
        />
        {isUpload && (
          <>
            <input
              className={styles.modalField}
              type="text"
              value={url}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="Twitter/X profile or blog URL (optional)"
            />
            <textarea
              className={styles.modalField}
              value={content}
              onChange={(e) => setContent(e.target.value)}
              placeholder="Or paste text content here — tweets, blog posts, notes, markdown…"
              rows={5}
            />
          </>
        )}
        {err && <p className={styles.modalError}>{err}</p>}
        <div className={styles.modalActions}>
          <button className={styles.btnGhost} onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className={styles.btnPrimary} onClick={submit} disabled={busy}>
            {busy ? (isUpload ? "Connecting…" : "Inviting…") : isUpload ? "Upload & Connect" : "Invite"}
          </button>
        </div>
      </div>
    </div>
  );
}
