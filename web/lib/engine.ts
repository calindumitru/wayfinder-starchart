// The star-map: a pannable, zoomable canvas of tickets as stars. Ported from the vanilla JS of
// rengwu/wayfinder-maps (MIT): the deterministic rank-biased layout, the parallax starfield, the
// status-coloured stars, the flowing edges and the fog nebulae. Additions here: wheel deltas in
// lines or pages count as pixels, a ticket with a live T3 thread carries an orbiting moon, hubs
// gather their neighbours into clusters, and hovering anything explains it (see Hover).

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
  // Hover state, eased toward its target every frame: emphasis (the hovered thing itself),
  // relation (a neighbour of it) and fade (unrelated to it).
  emph: number;
  rel: number;
  dim: number;
  moon: number;
};
type FogPt = { index: number; title: string; anchor: Node | null; x: number; y: number; emph: number };
// A hub (a ticket wired to three or more others) and the neighbours that hang off it.
type Cluster = { hub: Node; members: Node[]; cx: number; cy: number; k: number; emph: number; dim: number };
type Cam = { x: number; y: number; s: number };

export const COL: Record<Status, { core: string; glow: string; r: number; gr: number }> = {
  resolved: { core: "#b4f5cb", glow: "#2fbf6e", r: 5.2, gr: 22 },
  frontier: { core: "#d6eeff", glow: "#3b8cff", r: 8.4, gr: 54 },
  claimed: { core: "#fff1bd", glow: "#ffb22e", r: 7.6, gr: 44 },
  blocked: { core: "#ff9b8c", glow: "#ff3d3d", r: 6.4, gr: 26 },
  out_of_scope: { core: "#7d7789", glow: "#4a4550", r: 4.2, gr: 16 },
};
const LABELCOL: Record<Status, string> = {
  resolved: "#cfe9d8",
  frontier: "#e4f2ff",
  claimed: "#ffeec2",
  blocked: "#ffd2cb",
  out_of_scope: "#8a8496",
};

const TAU = 6.2831853;
const FOG_R = 150;
const EASE = 0.28;
const POSEASE = 0.12;

const mod = (a: number, n: number) => ((a % n) + n) % n;
const clamp = (v: number, a: number, b: number) => (v < a ? a : v > b ? b : v);

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

// Clusters: every hub (a ticket wired to three or more others), strongest first, takes the
// neighbours no stronger hub has taken. A cluster needs at least three stars to count.
export function findClusters(nodes: { num: number }[], edges: Edge[]) {
  const on = new Set(nodes.map((n) => n.num)), deg: Record<number, number> = {}, nb: Record<number, number[]> = {};
  for (const e of edges) {
    if (!on.has(e.from) || !on.has(e.to)) continue;
    deg[e.from] = (deg[e.from] ?? 0) + 1; deg[e.to] = (deg[e.to] ?? 0) + 1;
    (nb[e.from] ??= []).push(e.to); (nb[e.to] ??= []).push(e.from);
  }
  const hubs = nodes.map((n) => n.num).filter((n) => (deg[n] ?? 0) >= 3).sort((a, b) => deg[b] - deg[a] || a - b);
  const owner = new Map<number, number>();
  hubs.forEach((h) => owner.set(h, h));
  for (const h of hubs) for (const o of nb[h] ?? []) if (!owner.has(o)) owner.set(o, h);
  return hubs
    .map((hub) => ({ hub, members: nodes.map((n) => n.num).filter((n) => owner.get(n) === hub) }))
    .filter((c) => c.members.length >= 3);
}

// After layout: pull each cluster's members into a ring around their hub, keeping each one's
// direction from it, then push clusters apart and stray tickets out of them, so a cluster reads
// as one small system. Pure, like layout.
export function gather(nodes: XY[], edges: Edge[]) {
  const by: Record<number, XY> = {};
  nodes.forEach((n) => (by[n.num] = n));
  const groups = findClusters(nodes, edges).map((c) => {
    const hub = by[c.hub], others = c.members.filter((m) => m !== c.hub).map((m) => by[m]);
    const R = 70 + 11 * others.length;
    others
      .map((m) => ({ m, ang: Math.atan2(m.y - hub.y, m.x - hub.x) }))
      .sort((a, b) => a.ang - b.ang)
      .forEach(({ m }, i, all) => {
        // Even spacing, starting from the first member's own direction.
        const ang = all[0].ang + (i * TAU) / all.length, r = R * (i % 2 ? 0.78 : 1);
        m.x = hub.x + Math.cos(ang) * r; m.y = hub.y + Math.sin(ang) * r;
      });
    return { hub, all: [hub, ...others], R: R + 40 };
  });
  for (let it = 0; it < 120; it++) {
    let moved = false;
    for (let i = 0; i < groups.length; i++) {
      for (let j = i + 1; j < groups.length; j++) {
        const a = groups[i], b = groups[j];
        let dx = b.hub.x - a.hub.x, dy = b.hub.y - a.hub.y;
        const d = Math.hypot(dx, dy) || 0.01, need = a.R + b.R;
        if (d >= need) continue;
        if (d < 0.02) { dx = 1; dy = 0; }
        const push = (need - d) / 2 + 1, ux = dx / d, uy = dy / d;
        a.all.forEach((n) => { n.x -= ux * push; n.y -= uy * push; });
        b.all.forEach((n) => { n.x += ux * push; n.y += uy * push; });
        moved = true;
      }
    }
    if (!moved) break;
  }
  const inGroup = new Set(groups.flatMap((g) => g.all.map((n) => n.num)));
  for (const n of nodes) {
    if (inGroup.has(n.num)) continue;
    for (const g of groups) {
      const dx = n.x - g.hub.x, dy = n.y - g.hub.y, d = Math.hypot(dx, dy) || 0.01;
      if (d < g.R) { n.x = g.hub.x + (dx / d) * g.R; n.y = g.hub.y + (dy / d) * g.R; }
    }
  }
}

// What the pointer is over. Hover explains; clicking acts.
export type Hover =
  | { kind: "node"; num: number }
  | { kind: "edge"; from: number; to: number; satisfied: boolean }
  | { kind: "moon"; num: number }
  | { kind: "fog"; index: number }
  | { kind: "cluster"; hub: number; members: number[] };

export type EngineEvents = {
  onSelect: (num: number | null) => void;
  onFog: (index: number) => void;
  onMoon: (num: number) => void;
  onHover: (h: Hover | null) => void;
};

const hoverKey = (h: Hover | null) =>
  !h ? "" : h.kind === "edge" ? `e${h.from}-${h.to}` : h.kind === "fog" ? `f${h.index}` : h.kind === "cluster" ? `c${h.hub}` : `${h.kind[0]}${h.num}`;

// Hover transitions settle in about 170 ms.
const HOVER_TAU = 0.055;
const CLUSTER_ASPECT = { x: 1.12, y: 0.8 };

export class Engine {
  private ctx: CanvasRenderingContext2D;
  private dpr = 1;
  private cam: Cam = { x: 0, y: 0, s: 1 };
  private goal: Cam = { x: 0, y: 0, s: 1 };
  private ec: Cam = { x: 0, y: 0, s: 1 };
  private nodes: Node[] = [];
  private edges: Edge[] = [];
  private edgeFx: { emph: number; dim: number }[] = [];
  private byNum: Record<number, Node> = {};
  private fogPts: FogPt[] = [];
  private clusters: Cluster[] = [];
  private selected: Node | null = null;
  private hover: Hover | null = null;
  private pointer: { x: number; y: number } | null = null;
  private match: Set<number> | null = null;
  private panelW = 0;
  private tip: HTMLElement | null = null;
  private mini: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; box: { x: number; y: number; s: number } } | null = null;
  private fogSprites: HTMLCanvasElement[] = [];
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
        emph: 0, rel: 0, dim: 0,
        moon: o?.moon ?? t.num,
      };
    });
    this.edges = m.edges;
    this.edgeFx = m.edges.map(() => ({ emph: 0, dim: 0 }));
    this.byNum = {};
    this.nodes.forEach((n) => (this.byNum[n.num] = n));
    if (same) {
      this.placeFresh();
    } else {
      layout(this.nodes, this.edges);
      gather(this.nodes, this.edges);
      this.nodes.forEach((n) => { n.px = n.x; n.py = n.y; });
    }
    this.setupClusters();
    this.setupFog(m);
    if (this.selected) this.selected = this.byNum[this.selected.num] ?? null;
    this.setHover(null);
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

  // A search: the matching tickets stay lit and the rest dim. Null lights everything.
  setMatch(nums: Set<number> | null) {
    this.match = nums;
  }

  fit() {
    this.fitCamera();
  }

  // The hover card. The engine only moves it, beside whatever is hovered and kept on screen;
  // React fills it.
  attachTip(el: HTMLElement | null) {
    this.tip = el;
  }

  // A small overview of the whole map with the visible part outlined; click or drag on it to
  // move the camera there.
  attachMinimap(canvas: HTMLCanvasElement) {
    const ctx = canvas.getContext("2d")!;
    this.mini = { canvas, ctx, box: { x: 0, y: 0, s: 1 } };
    let down = false;
    const go = (e: MouseEvent) => {
      if (!this.mini) return;
      const r = canvas.getBoundingClientRect(), b = this.mini.box;
      const wx = (e.clientX - r.left - b.x) / b.s, wy = (e.clientY - r.top - b.y) / b.s;
      this.goal.x = innerWidth / 2 - wx * this.goal.s;
      this.goal.y = innerHeight / 2 - wy * this.goal.s;
    };
    const dn = (e: MouseEvent) => { down = true; go(e); };
    const mv = (e: MouseEvent) => { if (down) go(e); };
    const up = () => { down = false; };
    canvas.addEventListener("mousedown", dn);
    addEventListener("mousemove", mv);
    addEventListener("mouseup", up);
    return () => {
      canvas.removeEventListener("mousedown", dn);
      removeEventListener("mousemove", mv);
      removeEventListener("mouseup", up);
      this.mini = null;
    };
  }

  // Ease the camera so the star sits centred in the space the panel leaves.
  select(num: number | null, panelWidth = 0) {
    const n = num == null ? null : this.byNum[num] ?? null;
    this.selected = n;
    this.panelW = panelWidth;
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

  private setupClusters() {
    this.clusters = findClusters(this.nodes, this.edges).map((c) => ({
      hub: this.byNum[c.hub], members: c.members.map((m) => this.byNum[m]), cx: 0, cy: 0, k: 0, emph: 0, dim: 0,
    }));
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
      this.fogPts.push({ index: i, title: f.title, anchor: anc, x: cx + Math.cos(ang) * rim, y: cy + Math.sin(ang) * rim, emph: 0 });
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
    // Clear of the top bar, the bottom bar and (on wide screens) the legend on the left.
    const top = 64, bottom = 96, left = innerWidth > 900 ? 250 : 0;
    const availH = Math.max(120, innerHeight - top - bottom), availW = Math.max(160, innerWidth - left);
    const s = clamp(Math.min(availW / (maxx - minx || 1), availH / (maxy - miny || 1)), 0.15, 1.4);
    this.goal = { s, x: left + availW / 2 - ((minx + maxx) / 2) * s, y: top + availH / 2 - ((miny + maxy) / 2) * s };
  }

  private resize = () => {
    this.dpr = Math.max(1, window.devicePixelRatio || 1);
    this.canvas.width = innerWidth * this.dpr;
    this.canvas.height = innerHeight * this.dpr;
    this.canvas.style.width = innerWidth + "px";
    this.canvas.style.height = innerHeight + "px";
  };

  private w2s(p: { x: number; y: number } | { _x: number; _y: number }) {
    const x = "_x" in p ? p._x : p.x, y = "_y" in p ? p._y : p.y;
    return { x: x * this.ec.s + this.ec.x, y: y * this.ec.s + this.ec.y };
  }

  private zoomAt(px: number, py: number, ns: number) {
    const wx = (px - this.goal.x) / this.goal.s, wy = (py - this.goal.y) / this.goal.s;
    this.goal.s = ns;
    this.goal.x = px - wx * ns;
    this.goal.y = py - wy * ns;
  }

  // The radius a star draws at, grown by up to 20% while hovered.
  private radius(n: Node) {
    return COL[n.status].r * (1 + 0.2 * n.emph);
  }

  // Where a live thread's moon is now, in world space, on its tilted orbit.
  private moonAt(n: Node) {
    const r = COL[n.status].r, rx = r + 20, ry = (r + 20) * 0.42, tilt = -0.55;
    const ox = Math.cos(n.moon) * rx, oy = Math.sin(n.moon) * ry;
    return { x: n._x + ox * Math.cos(tilt) - oy * Math.sin(tilt), y: n._y + ox * Math.sin(tilt) + oy * Math.cos(tilt), rx, ry, tilt };
  }

  // The control point of the gentle curve an edge draws along.
  private curve(a: Node, b: Node) {
    const ax = a._x, ay = a._y, bx = b._x, by = b._y;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, bow = Math.min(46, len * 0.13);
    return { ax, ay, bx, by, cx: (ax + bx) / 2 + (-dy / len) * bow, cy: (ay + by) / 2 + (dx / len) * bow, len };
  }

  private pickMoon(mx: number, my: number) {
    for (const n of this.nodes) {
      if (!this.threads.has(n.num)) continue;
      const p = this.w2s(this.moonAt(n));
      if (Math.hypot(p.x - mx, p.y - my) < 9) return n;
    }
    return null;
  }

  private pickNode(mx: number, my: number) {
    let best: Node | null = null, bd = 1e9;
    for (const n of this.nodes) {
      const s = this.w2s(n), d = Math.hypot(s.x - mx, s.y - my);
      if (d < Math.max(15, this.radius(n) * this.ec.s + 6) && d < bd) { bd = d; best = n; }
    }
    return best;
  }

  private pickEdge(mx: number, my: number) {
    let best: Edge | null = null, bd = 6;
    for (const e of this.edges) {
      const a = this.byNum[e.from], b = this.byNum[e.to];
      if (!a || !b) continue;
      const q = this.curve(a, b);
      let px = 0, py = 0;
      for (let i = 0; i <= 20; i++) {
        const u = i / 20, m = 1 - u;
        const s = this.w2s({ x: m * m * q.ax + 2 * m * u * q.cx + u * u * q.bx, y: m * m * q.ay + 2 * m * u * q.cy + u * u * q.by });
        if (i) {
          // Distance from the pointer to this short segment of the curve.
          const vx = s.x - px, vy = s.y - py, l2 = vx * vx + vy * vy || 1;
          const t = clamp(((mx - px) * vx + (my - py) * vy) / l2, 0, 1);
          const d = Math.hypot(mx - (px + t * vx), my - (py + t * vy));
          if (d < bd) { bd = d; best = e; }
        }
        px = s.x; py = s.y;
      }
    }
    return best;
  }

  private pickFog(mx: number, my: number) {
    for (const f of this.fogPts) {
      const s = this.w2s(f);
      if (Math.hypot(s.x - mx, s.y - my) < Math.max(28, 60 * this.ec.s)) return f;
    }
    return null;
  }

  // The innermost cluster boundary around the pointer.
  private pickCluster(mx: number, my: number) {
    let best: Cluster | null = null;
    const wx = (mx - this.ec.x) / this.ec.s, wy = (my - this.ec.y) / this.ec.s;
    for (const c of this.clusters) {
      const dx = (wx - c.cx) / CLUSTER_ASPECT.x, dy = (wy - c.cy) / CLUSTER_ASPECT.y;
      if (Math.hypot(dx, dy) < c.k && (!best || c.k < best.k)) best = c;
    }
    return best;
  }

  // In order of what sits on top: a moon over its star, a star over an edge, an edge over
  // fog, and a cluster's empty space last.
  private pick(mx: number, my: number): Hover | null {
    const moon = this.pickMoon(mx, my);
    if (moon) return { kind: "moon", num: moon.num };
    const n = this.pickNode(mx, my);
    if (n) return { kind: "node", num: n.num };
    const e = this.pickEdge(mx, my);
    if (e) return { kind: "edge", from: e.from, to: e.to, satisfied: e.satisfied };
    const f = this.pickFog(mx, my);
    if (f) return { kind: "fog", index: f.index };
    const c = this.pickCluster(mx, my);
    if (c) return { kind: "cluster", hub: c.hub.num, members: c.members.map((m) => m.num) };
    return null;
  }

  private setHover(h: Hover | null) {
    if (hoverKey(h) === hoverKey(this.hover)) return;
    this.hover = h;
    this.canvas.classList.toggle("pointer", !!h && h.kind !== "cluster" && h.kind !== "edge");
    this.events.onHover(h);
  }

  private hitTest(mx: number, my: number) {
    const moon = this.pickMoon(mx, my);
    if (moon) { this.events.onMoon(moon.num); return; }
    const n = this.pickNode(mx, my);
    if (n) { this.events.onSelect(n.num); return; }
    const f = this.pickFog(mx, my);
    if (f) { this.events.onFog(f.index); return; }
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
    on(c, "mousemove", (e: MouseEvent) => { this.pointer = down ? null : { x: e.clientX, y: e.clientY }; });
    on(c, "mouseleave", () => { this.pointer = null; });
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

  // Set each thing's hover targets from what is hovered, then ease toward them.
  private stepHover(dt: number) {
    const h = this.hover, k = 1 - Math.exp(-dt / HOVER_TAU);
    const ease = (v: number, t: number) => v + (t - v) * k;
    const lit = new Set<number>(), near = new Set<number>(), litEdges = new Set<number>();
    let focusing = false, hubFocus: Cluster | null = null;
    if (h?.kind === "node") {
      focusing = true; lit.add(h.num);
      this.edges.forEach((e, i) => {
        if (e.from === h.num || e.to === h.num) { litEdges.add(i); near.add(e.from === h.num ? e.to : e.from); }
      });
    } else if (h?.kind === "edge") {
      focusing = true; lit.add(h.from); lit.add(h.to);
      this.edges.forEach((e, i) => { if (e.from === h.from && e.to === h.to) litEdges.add(i); });
    } else if (h?.kind === "moon") {
      near.add(h.num);
    } else if (h?.kind === "fog") {
      const f = this.fogPts[h.index];
      if (f?.anchor) near.add(f.anchor.num);
    } else if (h?.kind === "cluster") {
      hubFocus = this.clusters.find((c) => c.hub.num === h.hub) ?? null;
      hubFocus?.members.forEach((m) => near.add(m.num));
      focusing = !!hubFocus;
    }
    for (const n of this.nodes) {
      n.emph = ease(n.emph, lit.has(n.num) ? 1 : 0);
      n.rel = ease(n.rel, near.has(n.num) ? 1 : 0);
      n.dim = ease(n.dim, focusing && !lit.has(n.num) && !near.has(n.num) ? 1 : 0);
      // A hovered moon holds still, so it can be clicked.
      const thread = this.threads.get(n.num);
      if (thread && !(h?.kind === "moon" && h.num === n.num)) n.moon += dt * (thread === "running" || thread === "starting" ? 1.9 : 0.6);
    }
    this.edges.forEach((e, i) => {
      const fx = this.edgeFx[i];
      const inCluster = hubFocus && hubFocus.members.some((m) => m.num === e.from) && hubFocus.members.some((m) => m.num === e.to);
      fx.emph = ease(fx.emph, litEdges.has(i) ? 1 : 0);
      fx.dim = ease(fx.dim, focusing && !litEdges.has(i) && !inCluster ? 1 : 0);
    });
    for (const f of this.fogPts) f.emph = ease(f.emph, h?.kind === "fog" && h.index === f.index ? 1 : 0);
    for (const c of this.clusters) {
      c.emph = ease(c.emph, c === hubFocus ? 1 : 0);
      c.dim = ease(c.dim, hubFocus && c !== hubFocus ? 1 : 0);
    }
  }

  // Each cluster's boundary: an ellipse around its hub that holds every member with room to
  // spare.
  private measureClusters() {
    for (const c of this.clusters) {
      c.cx = c.hub._x; c.cy = c.hub._y;
      let k = 0;
      for (const m of c.members) k = Math.max(k, Math.hypot((m._x - c.cx) / CLUSTER_ASPECT.x, (m._y - c.cy) / CLUSTER_ASPECT.y));
      c.k = k + 34;
    }
  }

  // Keep the hover card beside what it describes: to its right, or its left when that would
  // run under the panel or off screen, and always clear of the top and bottom bars.
  private placeTip() {
    const el = this.tip;
    if (!el) return;
    const h = this.hover;
    let a: { x: number; y: number; r: number } | null = null;
    if (h?.kind === "node") {
      const n = this.byNum[h.num];
      if (n && n !== this.selected) { const p = this.w2s(n); a = { ...p, r: this.radius(n) * this.ec.s + 14 }; }
    } else if (h?.kind === "moon") {
      const n = this.byNum[h.num];
      if (n) { const p = this.w2s(this.moonAt(n)); a = { ...p, r: 14 }; }
    } else if (h?.kind === "edge") {
      const A = this.byNum[h.from], B = this.byNum[h.to];
      if (A && B) {
        const q = this.curve(A, B);
        a = { ...this.w2s({ x: 0.25 * q.ax + 0.5 * q.cx + 0.25 * q.bx, y: 0.25 * q.ay + 0.5 * q.cy + 0.25 * q.by }), r: 12 };
      }
    } else if (h?.kind === "fog") {
      const f = this.fogPts[h.index];
      if (f) a = { ...this.w2s(f), r: 70 * this.ec.s };
    } else if (h?.kind === "cluster") {
      const c = this.clusters.find((x) => x.hub.num === h.hub);
      if (c) { const p = this.w2s({ x: c.cx, y: c.cy }); a = { x: p.x, y: p.y, r: c.k * CLUSTER_ASPECT.x * this.ec.s * 0.75 }; }
    }
    if (!a || this.mapAlpha < 0.5) { el.dataset.show = ""; return; }
    const w = el.offsetWidth, ht = el.offsetHeight, right = innerWidth - this.panelW - 12;
    let x = a.x + a.r;
    if (x + w > right) x = a.x - a.r - w;
    x = clamp(x, 12, Math.max(12, right - w));
    const y = clamp(a.y - ht / 2, 66, Math.max(66, innerHeight - 100 - ht));
    el.style.transform = `translate(${Math.round(x)}px,${Math.round(y)}px)`;
    el.dataset.show = "1";
  }

  private initStars() {
    const rnd = mulberry32(9001);
    this.stars = [
      { f: 0.15, n: 170, sz: 0.7, a: 0.45 },
      { f: 0.3, n: 90, sz: 1.1, a: 0.65 },
      { f: 0.5, n: 34, sz: 1.7, a: 0.9 },
    ].map((sp) => ({ f: sp.f, sz: sp.sz, a: sp.a, stars: Array.from({ length: sp.n }, () => ({ x: rnd(), y: rnd(), t: rnd() })) }));
  }

  private drawStars(W: number, H: number) {
    const ctx = this.ctx;
    for (const L of this.stars) {
      ctx.fillStyle = "#fff";
      for (const s of L.stars) {
        ctx.globalAlpha = L.a * (0.65 + 0.35 * Math.sin(s.t * TAU + this.clock * 0.4 * s.t));
        ctx.fillRect(mod(s.x * W + this.cam.x * L.f, W), mod(s.y * H + this.cam.y * L.f, H), L.sz, L.sz);
      }
    }
    ctx.globalAlpha = 1;
  }

  // How visible a star is: dimmed by a search that skips it, and by a hover elsewhere.
  private vis(n: Node) {
    const searched = this.match != null && !this.match.has(n.num) ? 0.18 : 1;
    return searched * (1 - 0.68 * n.dim);
  }

  // Faint orbits: the rank rings the layout hangs tickets on, and each cluster's boundary and
  // inner orbit, with its name over the top. A hovered cluster's boundary brightens and
  // dashes; the others fade.
  private drawClusters() {
    const ctx = this.ctx, lw = 1 / this.ec.s;
    ctx.lineWidth = lw;
    ctx.strokeStyle = "rgba(120,140,210,0.06)";
    for (const r of new Set(this.nodes.map((n) => n.rank))) {
      ctx.beginPath(); ctx.arc(0, 0, ringR(r), 0, TAU); ctx.stroke();
    }
    for (const c of this.clusters) {
      const base = 1 - 0.7 * c.dim, glow = c.emph;
      const rx = c.k * CLUSTER_ASPECT.x, ry = c.k * CLUSTER_ASPECT.y;
      if (glow > 0.01) {
        const g = ctx.createRadialGradient(c.cx, c.cy, 0, c.cx, c.cy, rx);
        g.addColorStop(0, `rgba(70,120,255,${0.1 * glow})`); g.addColorStop(1, "rgba(70,120,255,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.ellipse(c.cx, c.cy, rx, ry, 0, 0, TAU); ctx.fill();
      }
      ctx.strokeStyle = `rgba(140,165,235,${(0.1 + 0.5 * glow) * base})`;
      ctx.lineWidth = lw * (1 + 0.6 * glow);
      if (glow > 0.01) { ctx.setLineDash([5 / this.ec.s, 5 / this.ec.s]); ctx.lineDashOffset = -this.clock * 8 / this.ec.s; }
      ctx.beginPath(); ctx.ellipse(c.cx, c.cy, rx, ry, 0, 0, TAU); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0; ctx.lineWidth = lw;
      ctx.strokeStyle = `rgba(140,165,235,${(0.06 + 0.12 * glow) * base})`;
      ctx.beginPath(); ctx.ellipse(c.cx, c.cy, rx * 0.55, ry * 0.55, 0, 0, TAU); ctx.stroke();
    }
  }

  // Cluster names over their boundaries, in screen space so they stay crisp.
  private drawClusterNames(a: number) {
    const ctx = this.ctx, s = this.cam.s;
    if (s < 0.3 || !this.clusters.length) return;
    const fs = clamp(14 * Math.pow(s, 0.35), 11, 16);
    ctx.font = `600 ${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
    ctx.textAlign = "center"; ctx.textBaseline = "bottom";
    ctx.shadowColor = `rgba(0,0,0,${0.9 * a})`; ctx.shadowBlur = 6;
    for (const c of this.clusters) {
      const p = this.w2s({ x: c.cx, y: c.cy - c.k * CLUSTER_ASPECT.y });
      const t = c.hub.title.length > 30 ? c.hub.title.slice(0, 29) + "…" : c.hub.title;
      ctx.fillStyle = `rgba(236,240,250,${(a * (0.62 + 0.38 * c.emph) * (1 - 0.7 * c.dim)).toFixed(3)})`;
      ctx.fillText(t, p.x, p.y - 6);
    }
    ctx.shadowBlur = 0; ctx.textBaseline = "alphabetic";
  }

  // A curve from blocker to dependent: blue and flowing once the blocker is resolved, a red
  // dashed thread while it's open, with an arrowhead just short of the dependent. Hover
  // brightens and thickens it, or fades it when it has nothing to do with the hover.
  private drawEdge(e: Edge, i: number) {
    const a = this.byNum[e.from], b = this.byNum[e.to];
    if (!a || !b) return;
    const ctx = this.ctx, fx = this.edgeFx[i];
    const { ax, ay, bx, by, cx, cy, len } = this.curve(a, b);
    const searched = this.match != null && !this.match.has(a.num) && !this.match.has(b.num) ? 0.15 : 1;
    ctx.globalAlpha = this.mapAlpha * searched * (1 - 0.8 * fx.dim);
    const col = e.satisfied ? "120,170,255" : "255,96,96", hi = fx.emph;
    if (hi > 0.01) {
      ctx.strokeStyle = `rgba(${col},${0.25 * hi})`; ctx.lineWidth = 7;
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
    }
    ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by);
    ctx.lineWidth = (e.satisfied ? 1.5 : 1.3) + 1.2 * hi;
    ctx.strokeStyle = `rgba(${col},${0.5 + 0.45 * hi})`;
    if (!e.satisfied) { ctx.setLineDash(hi > 0.5 ? [] : [3, 6]); ctx.lineDashOffset = -this.clock * 6; }
    ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
    if (e.satisfied) {
      for (let k = 0; k < 2; k++) {
        const u = mod(this.clock * 0.1 + k / 2 + (e.from * 0.13 + e.to * 0.07), 1), m = 1 - u;
        ctx.fillStyle = `rgba(190,215,255,${0.2 + 0.6 * Math.sin(u * Math.PI)})`;
        ctx.beginPath();
        ctx.arc(m * m * ax + 2 * m * u * cx + u * u * bx, m * m * ay + 2 * m * u * cy + u * u * by, 1.8, 0, TAU);
        ctx.fill();
      }
    }
    // The arrowhead sits where the curve meets the target's glow, pointing along the curve.
    const u = clamp(1 - (this.radius(b) + 12) / len, 0.5, 0.95), m = 1 - u;
    const tx = m * m * ax + 2 * m * u * cx + u * u * bx, ty = m * m * ay + 2 * m * u * cy + u * u * by;
    const gx = 2 * m * (cx - ax) + 2 * u * (bx - cx), gy = 2 * m * (cy - ay) + 2 * u * (by - cy), gl = Math.hypot(gx, gy) || 1;
    const ux = gx / gl, uy = gy / gl, ah = 8 + 3 * hi, aw = 4.2 + 1.5 * hi, px = -uy, py = ux;
    ctx.beginPath(); ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ux * ah + px * aw, ty - uy * ah + py * aw);
    ctx.lineTo(tx - ux * ah * 0.6, ty - uy * ah * 0.6);
    ctx.lineTo(tx - ux * ah - px * aw, ty - uy * ah - py * aw);
    ctx.closePath(); ctx.fillStyle = `rgba(${col},0.9)`; ctx.fill();
    ctx.globalAlpha = this.mapAlpha;
  }

  private drawNode(n: Node) {
    const ctx = this.ctx, c = COL[n.status], x = n._x, y = n._y;
    const en = n.enter ?? 1, fl = n.flare, hi = n.emph, near = n.rel;
    const isF = n.status === "frontier", isC = n.status === "claimed", isB = n.status === "blocked";
    const beat = 0.5 + 0.5 * Math.sin(this.clock * 2.8);
    const pulse = isF ? 0.8 + 0.2 * beat : 1;
    const grow = 1 + 0.2 * hi;
    ctx.globalAlpha = this.mapAlpha * this.vis(n);
    const gr = (isF ? c.gr * (0.92 + 0.16 * beat) : c.gr) * (0.55 + 0.45 * en) * (1 + fl * 0.5) * (1 + 0.45 * hi + 0.15 * near);
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
    g.addColorStop(0, hexA(c.glow, Math.min(1, (0.85 * pulse + fl * 0.5 + 0.15 * hi) * en)));
    g.addColorStop(0.35, hexA(c.glow, (0.26 * pulse + 0.14 * hi + 0.08 * near) * en));
    g.addColorStop(1, hexA(c.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
    const cr = c.r * (0.4 + 0.6 * en) * grow;
    if (isB) {
      // Blocked: a faceted red gem rather than a star.
      const d = cr * 1.35;
      const lg = ctx.createLinearGradient(x - d, y - d, x + d, y + d);
      lg.addColorStop(0, "#ffd0c8"); lg.addColorStop(0.45, c.core); lg.addColorStop(1, "#d8323a");
      ctx.fillStyle = lg;
      ctx.beginPath(); ctx.moveTo(x, y - d); ctx.lineTo(x + d, y); ctx.lineTo(x, y + d); ctx.lineTo(x - d, y); ctx.closePath(); ctx.fill();
      ctx.fillStyle = "rgba(255,255,255,0.35)";
      ctx.beginPath(); ctx.moveTo(x, y - d); ctx.lineTo(x + d * 0.5, y - d * 0.5); ctx.lineTo(x, y); ctx.lineTo(x - d * 0.5, y - d * 0.5); ctx.closePath(); ctx.fill();
    } else {
      const cg = ctx.createRadialGradient(x, y, 0, x, y, cr * 1.35);
      cg.addColorStop(0, "#ffffff"); cg.addColorStop(0.35, hexA(c.core, 1));
      cg.addColorStop(0.72, hexA(c.glow, 0.95)); cg.addColorStop(1, hexA(c.glow, 0));
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(x, y, cr * 1.35, 0, TAU); ctx.fill();
      // Resolved stars get a thin rim, like a closed ring.
      if (n.status === "resolved") {
        ctx.strokeStyle = hexA(c.core, 0.55); ctx.lineWidth = 1;
        ctx.beginPath(); ctx.arc(x, y, cr + 1.6, 0, TAU); ctx.stroke();
      }
    }
    if (fl > 0) {
      ctx.strokeStyle = hexA(c.core, fl * 0.7); ctx.lineWidth = 1.5 + 2 * fl;
      ctx.beginPath(); ctx.arc(x, y, c.r + (1 - fl) * 40, 0, TAU); ctx.stroke();
    }
    // A neighbour of the hovered star: a soft ring in its own colour.
    if (near > 0.01) {
      ctx.strokeStyle = hexA(c.core, 0.45 * near); ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.arc(x, y, cr + 6, 0, TAU); ctx.stroke();
    }
    if (isF) {
      ctx.strokeStyle = hexA(c.glow, 0.28 + 0.15 * beat + 0.3 * hi); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, c.r * grow + 7 + 1.5 * beat, 0, TAU); ctx.stroke();
    }
    if (isC) {
      ctx.strokeStyle = hexA(c.core, 0.45 + 0.25 * beat); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, c.r * grow + 5 + 1.2 * beat, 0, TAU); ctx.stroke();
      ctx.strokeStyle = hexA(c.core, 0.18 + 0.14 * beat); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, c.r * grow + 11 + 1.8 * beat, 0, TAU); ctx.stroke();
    }
    // A live T3 thread on this ticket: a ringed moon on a tilted orbit, quicker while it runs.
    // Hovered, it stops, grows and brightens its orbit.
    const thread = this.threads.get(n.num);
    if (thread) {
      const running = thread === "running" || thread === "starting";
      const mh = this.hover?.kind === "moon" && this.hover.num === n.num ? 1 : 0;
      const m = this.moonAt(n);
      ctx.strokeStyle = running || mh ? `rgba(214,198,255,${0.45 + 0.3 * mh})` : "rgba(170,160,210,0.25)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(x, y, m.rx, m.ry, m.tilt, 0, TAU); ctx.stroke();
      const R = 8 + 6 * mh, mg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, R);
      mg.addColorStop(0, running || mh ? "rgba(225,215,255,0.75)" : "rgba(180,170,220,0.4)"); mg.addColorStop(1, "rgba(180,170,255,0)");
      ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(m.x, m.y, R, 0, TAU); ctx.fill();
      ctx.fillStyle = running || mh ? "#f1ebff" : "#b7aed8";
      ctx.beginPath(); ctx.arc(m.x, m.y, (running ? 2.8 : 2.2) * (1 + 0.4 * mh), 0, TAU); ctx.fill();
      ctx.strokeStyle = running || mh ? "rgba(241,235,255,0.85)" : "rgba(183,174,216,0.6)";
      ctx.beginPath(); ctx.arc(m.x, m.y, (running ? 4.6 : 4) * (1 + 0.4 * mh), 0, TAU); ctx.stroke();
    }
    if (this.selected === n) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, c.r * grow + 12, 0, TAU); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, c.r * grow + 18, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // An open question's nebula: a few overlapping violet puffs and specks, painted once per fog
  // (seeded by its index, so it keeps its shape) into a sprite FOG_R world units in radius.
  private paintFog(index: number) {
    const R = FOG_R, k = 1.5, c = document.createElement("canvas");
    c.width = c.height = Math.ceil(R * 2 * k);
    const ctx = c.getContext("2d")!;
    ctx.scale(k, k);
    const rnd = mulberry32(index * 31 + 7);
    for (let i = 0; i < 7; i++) {
      const ang = rnd() * TAU, off = i ? 18 + rnd() * 40 : 0, r = i ? 40 + rnd() * 36 : 92;
      const px = R + Math.cos(ang) * off, py = R + Math.sin(ang) * off * 0.7;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(${i % 2 ? "150,96,236" : "112,92,226"},${i ? 0.22 : 0.28})`);
      g.addColorStop(0.5, "rgba(104,72,196,0.09)");
      g.addColorStop(1, "rgba(92,62,170,0)");
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
    }
    for (let i = 0; i < 7; i++) {
      const a = rnd() * TAU, d = 12 + rnd() * 50;
      ctx.fillStyle = `rgba(226,206,255,${0.4 + rnd() * 0.4})`;
      ctx.beginPath(); ctx.arc(R + Math.cos(a) * d, R + Math.sin(a) * d * 0.7, 1.2 + rnd() * 0.6, 0, TAU); ctx.fill();
    }
    return c;
  }

  private drawFog() {
    const ctx = this.ctx;
    for (const f of this.fogPts) {
      const hi = f.emph;
      if (f.anchor) {
        ctx.strokeStyle = `rgba(170,132,235,${0.32 + 0.4 * hi})`; ctx.lineWidth = 1 + hi; ctx.setLineDash([2, 6]); ctx.lineDashOffset = -this.clock * 4;
        ctx.beginPath(); ctx.moveTo(f.x, f.y); ctx.lineTo(f.anchor._x, f.anchor._y); ctx.stroke();
        ctx.setLineDash([]); ctx.lineDashOffset = 0;
      }
      const sprite = (this.fogSprites[f.index] ??= this.paintFog(f.index));
      const breathe = 0.85 + 0.15 * Math.sin(this.clock * 0.8 + f.index);
      const grow = (1 + 0.03 * Math.sin(this.clock * 0.5 + f.index)) * (1 + 0.1 * hi);
      ctx.globalAlpha = this.mapAlpha * Math.min(1, breathe + 0.35 * hi);
      ctx.drawImage(sprite, f.x - FOG_R * grow, f.y - FOG_R * grow, FOG_R * 2 * grow, FOG_R * 2 * grow);
      if (hi > 0.01) {
        // The hovered nebula's edge: a dotted ring around it.
        ctx.globalAlpha = this.mapAlpha * hi;
        ctx.strokeStyle = "rgba(200,160,255,0.55)"; ctx.lineWidth = 1.2; ctx.setLineDash([2, 5]);
        ctx.beginPath(); ctx.ellipse(f.x, f.y, 88 * grow, 66 * grow, 0, 0, TAU); ctx.stroke(); ctx.setLineDash([]);
      }
      ctx.globalAlpha = this.mapAlpha;
    }
  }

  // Up to two lines of about `width` characters, ellipsed past that.
  private wrap(text: string, width: number) {
    const words = text.split(/\s+/), lines: string[] = [];
    let cur = "";
    for (const w of words) {
      if (cur && (cur + " " + w).length > width) {
        lines.push(cur); cur = w;
        if (lines.length === 2) break;
      } else cur = cur ? cur + " " + w : w;
    }
    if (lines.length < 2 && cur) lines.push(cur);
    else if (lines.length === 2 && words.join(" ").length > lines.join(" ").length) lines[1] = lines[1].replace(/\W*$/, "") + "…";
    return lines;
  }

  // Numbers by default; a title for the hovered or selected ticket, or for every ticket once
  // zoomed well in. Zoomed out, resolved tickets go unlabelled, and any label with no free spot
  // is dropped rather than piled on. Hovered and selected labels are placed first, so they win.
  // Labels take the fade as colour alpha: WebKit ignores globalAlpha on shadowed text.
  private drawLabels(a: number) {
    const ctx = this.ctx, s = this.cam.s;
    if (s < 0.22 || a <= 0.002) return;
    const titles = s >= 1.15, sparse = s < 0.5;
    const fs = clamp(12 * Math.pow(s, 0.3), 9, 14);
    ctx.textAlign = "left"; ctx.textBaseline = "middle";
    ctx.shadowColor = `rgba(0,0,0,${(0.9 * a).toFixed(3)})`; ctx.shadowBlur = 5;
    const placed: { x: number; y: number; w: number }[] = [];
    const h = fs + 2, step = h + 2, tries = [0, step, -step, 2 * step, -2 * step];
    const focus = (n: Node) => n.emph > 0.5 || n === this.selected;
    const order = [...this.nodes].sort((p, q) => Number(focus(q)) - Number(focus(p)) || q.rel - p.rel);
    for (const n of order) {
      const f = focus(n);
      if (sparse && !f && n.rel < 0.5 && (n.status === "resolved" || n.status === "out_of_scope")) continue;
      const p = this.w2s(n), num = String(n.num);
      const title = titles || f ? (n.title.length > 40 ? n.title.slice(0, 39) + "…" : n.title) : "";
      ctx.font = `600 ${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      const nw = ctx.measureText(num).width;
      ctx.font = `${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      const tw = title ? ctx.measureText("  " + title).width : 0;
      const w = nw + tw, off = this.radius(n) * s + 9;
      const lx = p.x + off, cy = p.y + off * 0.55;
      let fy: number | null = f ? cy : null;
      if (fy == null) {
        for (const t of tries) {
          const ty = cy + t;
          if (placed.every((q) => !(lx < q.x + q.w + 4 && lx + w + 4 > q.x && Math.abs(ty - q.y) < h))) { fy = ty; break; }
        }
      }
      if (fy == null) continue;
      placed.push({ x: lx, y: fy, w });
      const al = a * this.vis(n);
      ctx.font = `600 ${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA(LABELCOL[n.status], al);
      ctx.fillText(num, lx, fy);
      if (title) {
        ctx.font = `${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
        ctx.fillStyle = `rgba(214,220,232,${(al * (f ? 1 : 0.8)).toFixed(3)})`;
        ctx.fillText("  " + title, lx + nw, fy);
      }
    }
    if (s >= 0.32 && this.fogPts.length) {
      const ffs = clamp(12 * Math.pow(s, 0.3), 9, 13.5);
      ctx.font = `italic ${ffs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.textAlign = "center";
      for (const f of this.fogPts) {
        ctx.fillStyle = `rgba(214,198,248,${(0.9 * a * (1 - 0.6 * f.emph)).toFixed(3)})`;
        const lines = this.wrap(f.title, 20), p = this.w2s(f);
        lines.forEach((l, i) => ctx.fillText(l, p.x, p.y + (i - (lines.length - 1) / 2) * (ffs + 4)));
      }
    }
    ctx.shadowBlur = 0; ctx.textBaseline = "alphabetic";
  }

  private drawMinimap() {
    const mm = this.mini;
    if (!mm || !this.nodes.length) return;
    const { canvas, ctx } = mm, W = canvas.clientWidth, H = canvas.clientHeight;
    if (canvas.width !== Math.round(W * this.dpr)) { canvas.width = Math.round(W * this.dpr); canvas.height = Math.round(H * this.dpr); }
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    for (const n of this.nodes) { minx = Math.min(minx, n._x); miny = Math.min(miny, n._y); maxx = Math.max(maxx, n._x); maxy = Math.max(maxy, n._y); }
    for (const f of this.fogPts) { minx = Math.min(minx, f.x); miny = Math.min(miny, f.y); maxx = Math.max(maxx, f.x); maxy = Math.max(maxy, f.y); }
    const pad = 8, s = Math.min((W - pad * 2) / (maxx - minx || 1), (H - pad * 2) / (maxy - miny || 1));
    const ox = W / 2 - ((minx + maxx) / 2) * s, oy = H / 2 - ((miny + maxy) / 2) * s;
    mm.box = { x: ox, y: oy, s };
    ctx.strokeStyle = "rgba(120,170,255,0.25)"; ctx.lineWidth = 0.6;
    for (const e of this.edges) {
      const a = this.byNum[e.from], b = this.byNum[e.to];
      if (!a || !b) continue;
      ctx.beginPath(); ctx.moveTo(a._x * s + ox, a._y * s + oy); ctx.lineTo(b._x * s + ox, b._y * s + oy); ctx.stroke();
    }
    for (const f of this.fogPts) {
      ctx.fillStyle = "rgba(150,100,236,0.35)"; ctx.beginPath(); ctx.arc(f.x * s + ox, f.y * s + oy, 4, 0, TAU); ctx.fill();
    }
    for (const n of this.nodes) {
      ctx.fillStyle = COL[n.status].glow;
      ctx.beginPath(); ctx.arc(n._x * s + ox, n._y * s + oy, n.status === "frontier" ? 2 : 1.4, 0, TAU); ctx.fill();
    }
    const vx = (0 - this.ec.x) / this.ec.s, vy = (0 - this.ec.y) / this.ec.s;
    const vw = innerWidth / this.ec.s, vh = innerHeight / this.ec.s;
    ctx.strokeStyle = "rgba(200,215,255,0.7)"; ctx.lineWidth = 1;
    ctx.strokeRect(vx * s + ox, vy * s + oy, vw * s, vh * s);
  }

  private render = () => {
    const W = innerWidth, H = innerHeight, ctx = this.ctx;
    const now = (performance.now() - this.t0) / 1000;
    let dt = now - this.lastClock;
    if (dt < 0 || dt > 0.1) dt = 0.016;
    this.lastClock = now; this.clock = now;
    // Hover is re-read every frame, so it follows the map as the camera eases under a still
    // pointer.
    this.setHover(this.pointer && this.mapAlpha > 0.5 ? this.pick(this.pointer.x, this.pointer.y) : null);
    this.stepHover(dt);
    for (const n of this.nodes) {
      const ph = n.num * 1.7, bob = 2.4 * (1 - Math.max(n.emph, n.rel));
      if (n.px == null || n.py == null) { n.px = n.x; n.py = n.y; }
      n.px += (n.x - n.px) * POSEASE; n.py += (n.y - n.py) * POSEASE;
      // Hovered stars and their neighbours stop drifting: a moving target is hard to click.
      n._x = n.px + Math.sin(this.clock * 0.7 + ph) * bob;
      n._y = n.py + Math.cos(this.clock * 0.55 + ph) * bob;
      if (n.flare > 0) n.flare = Math.max(0, n.flare - dt / 1.1);
      if (n.enter != null && n.enter < 1) n.enter = Math.min(1, n.enter + dt / 0.55);
    }
    this.measureClusters();
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
    ctx.clearRect(0, 0, W, H);
    this.drawStars(W, H);
    ctx.save();
    ctx.globalAlpha = this.mapAlpha;
    ctx.translate(this.ec.x, this.ec.y); ctx.scale(this.ec.s, this.ec.s);
    this.drawClusters();
    this.drawFog();
    // Whatever the hover touches draws last, over its neighbours.
    const up = (i: number) => this.edgeFx[i].emph > 0.01;
    this.edges.forEach((e, i) => { if (!up(i)) this.drawEdge(e, i); });
    const raised = (n: Node) => n.emph > 0.01 || n.rel > 0.01;
    this.nodes.forEach((n) => { if (!raised(n)) this.drawNode(n); });
    this.edges.forEach((e, i) => { if (up(i)) this.drawEdge(e, i); });
    this.nodes.forEach((n) => { if (raised(n)) this.drawNode(n); });
    ctx.restore();
    this.drawClusterNames(this.mapAlpha);
    this.drawLabels(this.mapAlpha);
    this.drawMinimap();
    this.placeTip();
    this.raf = requestAnimationFrame(this.render);
  };
}
