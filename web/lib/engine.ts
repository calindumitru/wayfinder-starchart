// The star-map: a pannable, zoomable canvas of tickets as stars. Ported from the vanilla JS of
// rengwu/wayfinder-maps (MIT): the deterministic rank-biased layout, the parallax starfield, the
// status-coloured stars, the flowing edges and the fog nebulae. Additions here: wheel deltas in
// lines or pages count as pixels, and a ticket with a live T3 thread carries an orbiting moon.

import type { Edge, Status, Ticket, WayMap } from "./types";

type Node = Ticket & {
  x: number;
  y: number;
  px?: number;
  py?: number;
  _x: number;
  _y: number;
  flare: number;
  enter?: number;
};
type FogPt = { index: number; title: string; anchor: Node | null; x: number; y: number };
type Cam = { x: number; y: number; s: number };

export const COL: Record<Status, { core: string; glow: string; r: number; gr: number }> = {
  resolved: { core: "#b9d6c4", glow: "#5b9077", r: 5.4, gr: 24 },
  frontier: { core: "#8ad8ff", glow: "#2f9be0", r: 8.1, gr: 49 },
  claimed: { core: "#ffd873", glow: "#ffb020", r: 7.2, gr: 36 },
  blocked: { core: "#e2c3c3", glow: "#9a6f6f", r: 4.5, gr: 20 },
  out_of_scope: { core: "#7d7789", glow: "#4a4550", r: 4.5, gr: 18 },
};
const LABELCOL: Record<Status, string> = {
  resolved: "#a2c1ac",
  frontier: "#b3e5ff",
  claimed: "#ffe6a0",
  blocked: "#d0b3b3",
  out_of_scope: "#8a8496",
};

const TAU = 6.2831853;
const EASE = 0.28;
const POSEASE = 0.12;

const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);
const pad2 = (n: number) => (n < 10 ? "0" : "") + n;

// Deterministic PRNG: the same map lays out the same way on every load.
export function mulberry32(seed: number) {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hexA(hex: string, al: number) {
  const h = hex.replace("#", "");
  return `rgba(${parseInt(h.slice(0, 2), 16)},${parseInt(h.slice(2, 4), 16)},${parseInt(h.slice(4, 6), 16)},${al})`;
}

export const ringR = (rank: number) => 130 + rank * 165;

type XY = { num: number; rank: number; x: number; y: number };

// Seed each node on its rank's ring, then relax: nodes repel, edges spring to a rest length,
// and each node is pulled back toward its ring. Pure, so it's testable without a canvas.
export function layout(nodes: XY[], edges: Edge[]) {
  const by: Record<number, XY> = {};
  nodes.forEach((n) => (by[n.num] = n));
  const rnd = mulberry32(1337);
  nodes.forEach((n) => {
    const ang = rnd() * TAU;
    const R = ringR(n.rank) + (rnd() - 0.5) * 70;
    n.x = Math.cos(ang) * R;
    n.y = Math.sin(ang) * R;
  });
  const REP = 9000, SPRING = 0.02, REST = 150, RADIAL = 0.05;
  for (let it = 0; it < 420; it++) {
    for (let i = 0; i < nodes.length; i++) {
      const a = nodes[i];
      for (let j = i + 1; j < nodes.length; j++) {
        const b = nodes[j];
        const dx = a.x - b.x, dy = a.y - b.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2);
        const f = REP / d2, ux = dx / d, uy = dy / d;
        a.x += ux * f; a.y += uy * f; b.x -= ux * f; b.y -= uy * f;
      }
    }
    for (const e of edges) {
      const a = by[e.from], b = by[e.to];
      if (!a || !b) continue;
      const dx = b.x - a.x, dy = b.y - a.y, d = Math.hypot(dx, dy) || 0.01;
      const f = (d - REST) * SPRING, ux = dx / d, uy = dy / d;
      a.x += ux * f; a.y += uy * f; b.x -= ux * f; b.y -= uy * f;
    }
    for (const n of nodes) {
      const d = Math.hypot(n.x, n.y) || 0.01, f = (ringR(n.rank) - d) * RADIAL;
      n.x += (n.x / d) * f; n.y += (n.y / d) * f;
    }
  }
}

export type EngineEvents = {
  onSelect: (num: number | null) => void;
  onFog: (index: number) => void;
};

export class Engine {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cam: Cam = { x: 0, y: 0, s: 1 };
  private goal: Cam = { x: 0, y: 0, s: 1 };
  private ec: Cam = { x: 0, y: 0, s: 1 };
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private byNum: Record<number, Node> = {};
  private fogPts: FogPt[] = [];
  private selected: Node | null = null;
  private threads = new Map<number, string>();
  private mapNum: number | null = null;
  private clock = 0;
  private lastClock = 0;
  private t0 = performance.now();
  private mapAlpha = 1;
  private fade = { on: false, t: 0, dur: 1.4, from: 0, to: 1 };
  private stars: { f: number; sz: number; a: number; stars: { x: number; y: number; t: number }[] }[] = [];
  private raf = 0;
  private cleanup: (() => void)[] = [];

  constructor(private canvas: HTMLCanvasElement, private events: EngineEvents) {
    this.ctx = canvas.getContext("2d")!;
    this.initStars();
    this.resize();
    this.wire();
    this.raf = requestAnimationFrame(this.render);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.cleanup.forEach((f) => f());
  }

  // A different map lays out afresh and fades in; the same map again (a refresh) keeps every
  // star where it was, flares the ones whose status changed and grows in the new ones.
  setMap(m: WayMap) {
    const same = this.mapNum === m.num && this.nodes.length > 0;
    const old = same ? this.byNum : {};
    this.mapNum = m.num;
    this.nodes = m.tickets.map((t) => {
      const o = old[t.num];
      return {
        ...t,
        x: o?.x ?? 0,
        y: o?.y ?? 0,
        px: o?.px,
        py: o?.py,
        _x: o?._x ?? 0,
        _y: o?._y ?? 0,
        flare: o && o.status !== t.status ? 1 : 0,
        enter: same && !o ? 0 : undefined,
      };
    });
    this.edges = m.edges;
    this.byNum = {};
    this.nodes.forEach((n) => (this.byNum[n.num] = n));
    if (same) {
      this.placeFresh();
    } else {
      layout(this.nodes, this.edges);
      this.nodes.forEach((n) => { n.px = n.x; n.py = n.y; });
    }
    this.setupFog(m);
    if (this.selected) this.selected = this.byNum[this.selected.num] ?? null;
    if (!same) {
      this.fitCamera();
      Object.assign(this.cam, this.goal);
      Object.assign(this.fade, { on: true, t: 0, from: 0, to: 1 });
      this.mapAlpha = 0;
    }
  }

  setThreads(t: Map<number, string>) {
    this.threads = t;
  }

  // Ease the camera so the star sits centred in the space the panel leaves.
  select(num: number | null, panelWidth = 0) {
    const n = num == null ? null : this.byNum[num] ?? null;
    this.selected = n;
    if (n) {
      this.goal.x = (innerWidth - panelWidth) / 2 - n.x * this.goal.s;
      this.goal.y = innerHeight / 2 - n.y * this.goal.s;
    }
  }

  // New tickets on a refresh: survivors stay pinned, each newcomer starts beside a neighbour
  // (or on its ring) and relaxes against the fixed others.
  private placeFresh() {
    const fresh = this.nodes.filter((n) => n.px == null);
    if (!fresh.length) return;
    const rnd = mulberry32(97 + fresh.length);
    for (const n of fresh) {
      let anchor: Node | null = null;
      for (const e of this.edges) {
        const o = e.to === n.num ? this.byNum[e.from] : e.from === n.num ? this.byNum[e.to] : null;
        if (o && o.px != null) anchor = o;
      }
      const ang = rnd() * TAU;
      if (anchor) { n.x = anchor.x + Math.cos(ang) * 120; n.y = anchor.y + Math.sin(ang) * 120; }
      else { n.x = Math.cos(ang) * ringR(n.rank); n.y = Math.sin(ang) * ringR(n.rank); }
    }
    for (let it = 0; it < 200; it++) {
      for (const n of fresh) {
        let fx = 0, fy = 0;
        for (const o of this.nodes) {
          if (o === n) continue;
          const dx = n.x - o.x, dy = n.y - o.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2), f = 9000 / d2;
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
        for (const e of this.edges) {
          const o = e.from === n.num ? this.byNum[e.to] : e.to === n.num ? this.byNum[e.from] : null;
          if (!o) continue;
          const dx = o.x - n.x, dy = o.y - n.y, d = Math.hypot(dx, dy) || 0.01, f = (d - 150) * 0.02;
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
        const d = Math.hypot(n.x, n.y) || 0.01, rf = (ringR(n.rank) - d) * 0.05;
        n.x += fx + (n.x / d) * rf; n.y += fy + (n.y / d) * rf;
      }
    }
  }

  // Fog sits beyond the rim: an anchored patch out past its ticket, the rest by golden angle.
  private setupFog(m: WayMap) {
    this.fogPts = [];
    if (!m.fog.length || !this.nodes.length) return;
    let cx = 0, cy = 0;
    this.nodes.forEach((n) => { cx += n.x; cy += n.y; });
    cx /= this.nodes.length; cy /= this.nodes.length;
    let rim = 0;
    this.nodes.forEach((n) => (rim = Math.max(rim, Math.hypot(n.x - cx, n.y - cy))));
    rim += 130;
    const rnd = mulberry32(4242);
    m.fog.forEach((f, i) => {
      const anc = f.clearsWith != null ? this.byNum[f.clearsWith] ?? null : null;
      const ang = anc ? Math.atan2(anc.y - cy, anc.x - cx) + (rnd() - 0.5) * 0.3 : i * 2.399963 + rnd() * 0.4;
      this.fogPts.push({ index: i, title: f.title, anchor: anc, x: cx + Math.cos(ang) * rim, y: cy + Math.sin(ang) * rim });
    });
  }

  private fitCamera() {
    if (!this.nodes.length) { this.goal = { x: innerWidth / 2, y: innerHeight / 2, s: 1 }; return; }
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    const grow = (x: number, y: number, r: number) => {
      minx = Math.min(minx, x - r); miny = Math.min(miny, y - r); maxx = Math.max(maxx, x + r); maxy = Math.max(maxy, y + r);
    };
    this.nodes.forEach((n) => grow(n.x, n.y, 0));
    this.fogPts.forEach((f) => grow(f.x, f.y, 90));
    const pad = 70;
    minx -= pad; miny -= pad; maxx += pad; maxy += pad;
    const top = 54, bottom = 72, availH = Math.max(120, innerHeight - top - bottom);
    const s = clamp(Math.min(innerWidth / (maxx - minx || 1), availH / (maxy - miny || 1)), 0.15, 1.4);
    this.goal = { s, x: innerWidth / 2 - ((minx + maxx) / 2) * s, y: top + availH / 2 - ((miny + maxy) / 2) * s };
  }

  private resize = () => {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = innerWidth * this.dpr;
    this.canvas.height = innerHeight * this.dpr;
    this.canvas.style.width = innerWidth + "px";
    this.canvas.style.height = innerHeight + "px";
  };

  private w2s(n: { _x: number; _y: number }) {
    return { x: n._x * this.ec.s + this.ec.x, y: n._y * this.ec.s + this.ec.y };
  }

  private zoomAt(px: number, py: number, ns: number) {
    const wx = (px - this.goal.x) / this.goal.s, wy = (py - this.goal.y) / this.goal.s;
    this.goal.s = ns;
    this.goal.x = px - wx * ns;
    this.goal.y = py - wy * ns;
  }

  private hitTest(mx: number, my: number) {
    let best: Node | null = null, bd = 1e9;
    for (const n of this.nodes) {
      const s = this.w2s(n), d = Math.hypot(s.x - mx, s.y - my);
      if (d < Math.max(15, COL[n.status].r * this.ec.s + 6) && d < bd) { bd = d; best = n; }
    }
    if (best) { this.events.onSelect(best.num); return; }
    for (const f of this.fogPts) {
      const sx = f.x * this.ec.s + this.ec.x, sy = f.y * this.ec.s + this.ec.y;
      if (Math.hypot(sx - mx, sy - my) < Math.max(24, 40 * this.ec.s)) { this.events.onFog(f.index); return; }
    }
    this.events.onSelect(null);
  }

  private wire() {
    const c = this.canvas;
    let down = false, moved = 0, last = { x: 0, y: 0 };
    let pinch: { cx: number; cy: number; d: number } | null = null;
    let gestureS0 = 1;
    const on = <K extends keyof HTMLElementEventMap>(t: EventTarget, ev: K | string, f: (e: never) => void, o?: AddEventListenerOptions) => {
      t.addEventListener(ev, f as EventListener, o);
      this.cleanup.push(() => t.removeEventListener(ev, f as EventListener, o));
    };
    on(window, "resize", this.resize);
    on(c, "mousedown", (e: MouseEvent) => { down = true; moved = 0; last = { x: e.clientX, y: e.clientY }; c.classList.add("drag"); });
    on(window, "mousemove", (e: MouseEvent) => {
      if (!down) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      this.goal.x += dx; this.goal.y += dy;
      last = { x: e.clientX, y: e.clientY };
    });
    on(window, "mouseup", (e: MouseEvent) => {
      c.classList.remove("drag");
      if (!down) return;
      down = false;
      if (moved < 5) this.hitTest(e.clientX, e.clientY);
    });
    on(c, "wheel", (e: WheelEvent) => {
      e.preventDefault();
      // Lines (Firefox mouse wheels) and pages count as pixels; about 33% per notch.
      const dy = e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
      this.zoomAt(e.clientX, e.clientY, clamp(this.goal.s * Math.exp(-dy * 0.004), 0.15, 4));
    }, { passive: false });
    const pinchState = (e: TouchEvent) => {
      const a = e.touches[0], b = e.touches[1];
      return { cx: (a.clientX + b.clientX) / 2, cy: (a.clientY + b.clientY) / 2, d: Math.hypot(a.clientX - b.clientX, a.clientY - b.clientY) || 1 };
    };
    on(c, "touchstart", (e: TouchEvent) => {
      e.preventDefault();
      if (e.touches.length === 1) { down = true; moved = 0; last = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }
      else if (e.touches.length === 2) { down = false; pinch = pinchState(e); }
    }, { passive: false });
    on(c, "touchmove", (e: TouchEvent) => {
      e.preventDefault();
      if (pinch && e.touches.length === 2) {
        const p = pinchState(e);
        this.zoomAt(p.cx, p.cy, clamp(this.goal.s * (p.d / pinch.d), 0.15, 4));
        this.goal.x += p.cx - pinch.cx; this.goal.y += p.cy - pinch.cy;
        pinch = p;
      } else if (down && e.touches.length === 1) {
        const t = e.touches[0], dx = t.clientX - last.x, dy = t.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        this.goal.x += dx; this.goal.y += dy;
        last = { x: t.clientX, y: t.clientY };
      }
    }, { passive: false });
    on(c, "touchend", (e: TouchEvent) => {
      e.preventDefault();
      if (down && moved < 8 && e.changedTouches[0]) this.hitTest(e.changedTouches[0].clientX, e.changedTouches[0].clientY);
      if (e.touches.length < 2) pinch = null;
      if (e.touches.length === 0) down = false;
    }, { passive: false });
    // Safari's trackpad pinch: nonstandard gesture events with a cumulative scale.
    on(c, "gesturestart", (e: Event) => { e.preventDefault(); gestureS0 = this.goal.s; });
    on(c, "gesturechange", (e: Event & { scale?: number; clientX?: number; clientY?: number }) => {
      e.preventDefault();
      this.zoomAt(e.clientX ?? innerWidth / 2, e.clientY ?? innerHeight / 2, clamp(gestureS0 * (e.scale ?? 1), 0.15, 4));
    });
  }

  private initStars() {
    const rnd = mulberry32(9001);
    this.stars = [
      { f: 0.15, n: 140, sz: 0.7, a: 0.45 },
      { f: 0.3, n: 80, sz: 1.1, a: 0.65 },
      { f: 0.5, n: 34, sz: 1.7, a: 0.9 },
    ].map((sp) => ({ f: sp.f, sz: sp.sz, a: sp.a, stars: Array.from({ length: sp.n }, () => ({ x: rnd(), y: rnd(), t: rnd() })) }));
  }

  private drawStars(W: number, H: number) {
    const ctx = this.ctx;
    for (const L of this.stars) {
      ctx.fillStyle = "#fff";
      for (const s of L.stars) {
        ctx.globalAlpha = L.a * (0.65 + 0.35 * Math.sin(s.t * TAU));
        ctx.fillRect(mod(s.x * W + this.cam.x * L.f, W), mod(s.y * H + this.cam.y * L.f, H), L.sz, L.sz);
      }
    }
    ctx.globalAlpha = 1;
  }

  // A curve from blocker to dependent: solid and flowing once the blocker is resolved, a faint
  // dashed thread while it's open, with an arrowhead at the midpoint.
  private drawEdge(e: Edge) {
    const a = this.byNum[e.from], b = this.byNum[e.to];
    if (!a || !b) return;
    const ctx = this.ctx;
    const ax = a._x, ay = a._y, bx = b._x, by = b._y;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1;
    const bow = Math.min(46, len * 0.13);
    const cx = (ax + bx) / 2 + (-dy / len) * bow, cy = (ay + by) / 2 + (dx / len) * bow;
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by);
    if (e.satisfied) { ctx.strokeStyle = "rgba(160,192,166,0.62)"; ctx.lineWidth = 1.8; ctx.setLineDash([]); }
    else { ctx.strokeStyle = "rgba(132,146,168,0.34)"; ctx.lineWidth = 1.3; ctx.setLineDash([4, 6]); }
    ctx.stroke(); ctx.setLineDash([]);
    if (e.satisfied) {
      for (let k = 0; k < 2; k++) {
        const u = mod(this.clock * 0.1 + k / 2 + (e.from * 0.13 + e.to * 0.07), 1), m = 1 - u;
        ctx.fillStyle = `rgba(190,225,200,${0.16 + 0.44 * Math.sin(u * Math.PI)})`;
        ctx.beginPath();
        ctx.arc(m * m * ax + 2 * m * u * cx + u * u * bx, m * m * ay + 2 * m * u * cy + u * u * by, 1.7, 0, TAU);
        ctx.fill();
      }
    }
    const midx = 0.25 * ax + 0.5 * cx + 0.25 * bx, midy = 0.25 * ay + 0.5 * cy + 0.25 * by;
    const ux = dx / len, uy = dy / len, ah = 7, aw = 3.8, px = -uy, py = ux;
    const tipx = midx + ux * ah * 0.5, tipy = midy + uy * ah * 0.5;
    ctx.beginPath(); ctx.moveTo(tipx, tipy);
    ctx.lineTo(tipx - ux * ah + px * aw, tipy - uy * ah + py * aw);
    ctx.lineTo(tipx - ux * ah - px * aw, tipy - uy * ah - py * aw);
    ctx.closePath(); ctx.fillStyle = e.satisfied ? "#aecdb6" : "#6f7889"; ctx.fill();
  }

  private drawNode(n: Node) {
    const ctx = this.ctx, c = COL[n.status], x = n._x, y = n._y;
    const en = n.enter ?? 1, fl = n.flare;
    const isF = n.status === "frontier", isC = n.status === "claimed";
    const beat = 0.5 + 0.5 * Math.sin(this.clock * 2.8);
    const pulse = isF ? 0.8 + 0.2 * beat : 1;
    const gr = (isF ? c.gr * (0.92 + 0.16 * beat) : c.gr) * (0.55 + 0.45 * en) * (1 + fl * 0.5);
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
    g.addColorStop(0, hexA(c.glow, Math.min(1, (0.85 * pulse + fl * 0.5) * en)));
    g.addColorStop(0.4, hexA(c.glow, 0.22 * pulse * en));
    g.addColorStop(1, hexA(c.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
    const cr = c.r * (0.4 + 0.6 * en);
    const cg = ctx.createRadialGradient(x, y, 0, x, y, cr * 1.35);
    cg.addColorStop(0, hexA(c.core, 1)); cg.addColorStop(0.6, hexA(c.core, 0.92));
    cg.addColorStop(0.82, hexA(c.core, 0.45)); cg.addColorStop(1, hexA(c.core, 0));
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(x, y, cr * 1.35, 0, TAU); ctx.fill();
    if (fl > 0) {
      ctx.strokeStyle = hexA(c.core, fl * 0.7); ctx.lineWidth = 1.5 + 2 * fl;
      ctx.beginPath(); ctx.arc(x, y, c.r + (1 - fl) * 40, 0, TAU); ctx.stroke();
    }
    if (isC) {
      ctx.strokeStyle = hexA(c.core, 0.45 + 0.25 * beat); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, c.r + 5 + 1.2 * beat, 0, TAU); ctx.stroke();
      ctx.strokeStyle = hexA(c.core, 0.18 + 0.14 * beat); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, c.r + 11 + 1.8 * beat, 0, TAU); ctx.stroke();
    }
    // A live T3 thread on this ticket: a moon in orbit, quicker and brighter while it runs.
    const thread = this.threads.get(n.num);
    if (thread) {
      const running = thread === "running" || thread === "starting";
      const ang = this.clock * (running ? 1.9 : 0.6) + n.num;
      const R = c.r + 15;
      ctx.strokeStyle = running ? "rgba(214,198,255,0.30)" : "rgba(170,160,210,0.16)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
      ctx.fillStyle = running ? "#e6dcff" : "#a59cc8";
      ctx.beginPath(); ctx.arc(x + Math.cos(ang) * R, y + Math.sin(ang) * R, running ? 2.8 : 2.2, 0, TAU); ctx.fill();
    }
    if (this.selected === n) {
      ctx.strokeStyle = "rgba(255,255,255,0.85)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, c.r + 11, 0, TAU); ctx.stroke();
    }
  }

  private drawFog() {
    const ctx = this.ctx;
    for (const f of this.fogPts) {
      if (f.anchor) {
        ctx.strokeStyle = "rgba(150,132,205,0.28)"; ctx.lineWidth = 1; ctx.setLineDash([3, 7]); ctx.lineDashOffset = -this.clock * 4;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.anchor._x, f.anchor._y); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      const breathe = 0.85 + 0.18 * Math.sin(this.clock * 0.8 + f.x * 0.01), R = 92;
      const g = ctx.createRadialGradient(f.x, f.y, 0, f.x, f.y, R);
      g.addColorStop(0, `rgba(140,112,216,${0.36 * breathe})`);
      g.addColorStop(0.45, `rgba(104,92,186,${0.16 * breathe})`);
      g.addColorStop(1, "rgba(92,82,170,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(f.x, f.y, R, 0, TAU); ctx.fill();
      ctx.fillStyle = "rgba(196,180,232,0.62)"; ctx.beginPath(); ctx.arc(f.x, f.y, 2.4, 0, TAU); ctx.fill();
    }
  }

  // Labels take the fade as colour alpha: WebKit ignores globalAlpha on shadowed text.
  private drawLabels(a: number) {
    const ctx = this.ctx, s = this.cam.s;
    if (s < 0.22 || a <= 0.002) return;
    const numOnly = s < 0.42;
    const fs = clamp(11 * Math.pow(s, 0.3), 8, 13);
    ctx.textAlign = "center"; ctx.font = `${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
    ctx.shadowColor = `rgba(0,0,0,${(0.85 * a).toFixed(3)})`; ctx.shadowBlur = 4;
    const placed: { x: number; y: number; w: number }[] = [];
    const h = fs + 2, step = h + 2, tries = [0, step, -step, 2 * step, -2 * step, 3 * step];
    for (const n of this.nodes) {
      const p = this.w2s(n);
      let label = pad2(n.num);
      if (!numOnly) label += "  " + (n.title.length > 30 ? n.title.slice(0, 29) + "…" : n.title);
      const w = ctx.measureText(label).width, cy = p.y + COL[n.status].r * s + fs + 3;
      let fy = cy;
      for (const t of tries) {
        const ty = cy + t;
        if (placed.every((q) => !(Math.abs(p.x - q.x) < (w + q.w) / 2 + 4 && Math.abs(ty - q.y) < h + 2))) { fy = ty; break; }
      }
      placed.push({ x: p.x, y: fy, w });
      ctx.fillStyle = hexA(LABELCOL[n.status], a);
      ctx.fillText(label, p.x, fy);
    }
    if (s >= 0.42 && this.fogPts.length) {
      const ffs = clamp(10 * Math.pow(s, 0.3), 7.5, 11.5);
      ctx.font = `italic ${ffs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = `rgba(184,168,220,${(0.8 * a).toFixed(3)})`;
      for (const f of this.fogPts) {
        const t = f.title.length > 26 ? f.title.slice(0, 25) + "…" : f.title;
        ctx.fillText(t, f.x * this.ec.s + this.ec.x, f.y * this.ec.s + this.ec.y + 18);
      }
    }
    ctx.shadowBlur = 0;
  }

  private render = () => {
    const W = innerWidth, H = innerHeight, ctx = this.ctx;
    const now = (performance.now() - this.t0) / 1000;
    let dt = now - this.lastClock;
    if (dt < 0 || dt > 0.1) dt = 0.016;
    this.lastClock = now; this.clock = now;
    for (const n of this.nodes) {
      const ph = n.num * 1.7;
      if (n.px == null || n.py == null) { n.px = n.x; n.py = n.y; }
      n.px += (n.x - n.px) * POSEASE; n.py += (n.y - n.py) * POSEASE;
      n._x = n.px + Math.sin(this.clock * 0.7 + ph) * 2.4;
      n._y = n.py + Math.cos(this.clock * 0.55 + ph) * 2.4;
      if (n.flare > 0) n.flare = Math.max(0, n.flare - dt / 1.1);
      if (n.enter != null && n.enter < 1) n.enter = Math.min(1, n.enter + dt / 0.55);
    }
    this.cam.x += (this.goal.x - this.cam.x) * EASE;
    this.cam.y += (this.goal.y - this.cam.y) * EASE;
    this.cam.s += (this.goal.s - this.cam.s) * EASE;
    if (this.fade.on) {
      this.fade.t += dt;
      const u = clamp(this.fade.t / this.fade.dur, 0, 1), e = u * u * (3 - 2 * u);
      this.mapAlpha = this.fade.from + (this.fade.to - this.fade.from) * e;
      if (u >= 1) this.fade.on = false;
    }
    const zt = 0.95 + 0.05 * this.mapAlpha, Cx = W / 2, Cy = H / 2;
    this.ec = { s: this.cam.s * zt, x: Cx + (this.cam.x - Cx) * zt, y: Cy + (this.cam.y - Cy) * zt };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.fillStyle = "#05070d"; ctx.fillRect(0, 0, W, H);
    this.drawStars(W, H);
    ctx.save();
    ctx.globalAlpha = this.mapAlpha;
    ctx.translate(this.ec.x, this.ec.y); ctx.scale(this.ec.s, this.ec.s);
    this.drawFog();
    this.edges.forEach((e) => this.drawEdge(e));
    this.nodes.forEach((n) => this.drawNode(n));
    ctx.restore();
    this.drawLabels(this.mapAlpha);
    this.raf = requestAnimationFrame(this.render);
  };
}
