// The star-map: a pannable, zoomable canvas of tickets as stars. Ported from the vanilla JS of
// rengwu/wayfinder-maps (MIT): the deterministic rank-biased layout, the parallax starfield, the
// status-coloured stars, the flowing edges and the fog nebulae. Additions here: wheel deltas in
// lines or pages count as pixels, a ticket with a live T3 thread carries an orbiting moon, hubs
// gather their neighbours into clusters, and hovering anything explains it (see Hover).

import { attention, bodyOf, collapsed, isFoldIn, nursery, GLOW_HOURS, recent, type Attention, type Body, type Look } from "./attention";
import { texture, textureBudget, type Kind, type Palette } from "./textures";
import type { BuildSlice, Edge, Status, Ticket, WayMap } from "./types";

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
  body: Body;
};
type FogPt = { index: number; title: string; anchor: Node | null; x: number; y: number; emph: number };
// A build slice on the canvas, at a fixed offset (ox, oy) from its anchor: its fold-in, or for a
// slice on the map itself the map's build hub. Open work orbits the anchor; finished work (built,
// nothing open on it) folds into a ring of dust nearer in. `vis` eases toward whether an open
// slice is shown: a fold-in's appear when zoomed in, or when the fold-in or one of them is in
// focus.
type SNode = BuildSlice & { ox: number; oy: number; _x: number; _y: number; vis: number; emph: number; dim: number; look: Look; dust: boolean };
// Where a group of slices hangs: a ticket, or the hub for the map's own slices.
type Anchor = { num: number; _x: number; _y: number; r: number };

// Slice colours by look: green to start, blue being built, gold for you, rust gone quiet.
export const LCOL: Record<Look, string> = {
  you: "#ffc53d",
  stalled: "#c8643c",
  ready: "#34d399",
  building: "#4d9bff",
  blocked: "#c2555a",
  built: "#9fb0c8",
  dropped: "#6f6a7c",
};
export const GOLD = "#ffc53d";
const SLICE_R = 5.2;
const DEST_R = 110;
// How long a finished slice's sparkle keeps its glow.
const AFTERGLOW_HOURS = 12;
const SLICES_FROM_ZOOM = 0.85;
// A hub (a ticket wired to three or more others) and the neighbours that hang off it.
type Cluster = { hub: Node; members: Node[]; cx: number; cy: number; k: number; emph: number; dim: number };
type Cam = { x: number; y: number; s: number };

export const COL: Record<Status, { core: string; glow: string; r: number; gr: number }> = {
  resolved: { core: "#e6ecf6", glow: "#7d8cab", r: 5.2, gr: 20 },
  frontier: { core: "#d2fbe6", glow: "#22c58b", r: 8.4, gr: 54 },
  claimed: { core: "#d6eeff", glow: "#3b8cff", r: 7.6, gr: 44 },
  blocked: { core: "#ff9b8c", glow: "#ff3d3d", r: 6.4, gr: 26 },
  out_of_scope: { core: "#7d7789", glow: "#4a4550", r: 4.2, gr: 16 },
};
const LABELCOL: Record<Status, string> = {
  resolved: "#c9d2e2",
  frontier: "#dcfbea",
  claimed: "#e4f2ff",
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

// A colour darkened toward black by k (0 keeps it, 1 is black).
function shade(hex: string, k: number) {
  const h = hex.replace("#", ""), c = (i: number) => Math.round(parseInt(h.slice(i, i + 2), 16) * (1 - k));
  return `rgb(${c(0)},${c(2)},${c(4)})`;
}

// Hex colour mixed toward another by t (0 keeps a, 1 is b).
function mix(a: string, b: string, t: number) {
  const p = (h: string, i: number) => parseInt(h.slice(1 + i, 3 + i), 16);
  return "#" + [0, 2, 4].map((i) => Math.round(p(a, i) + (p(b, i) - p(a, i)) * t).toString(16).padStart(2, "0")).join("");
}

// A slice's world by its look: green for ready, ochre for you, magma while blocked, grey once
// built; being built, an ice world in blue, and gone quiet, a cooled rust one (the greyscale
// set, tinted).
const WORLD: Partial<Record<Look, Kind>> = { ready: "planet-green", you: "planet-yellow", blocked: "planet-red", stalled: "planet-mono", built: "planet-gray", building: "planet-mono" };
const TINT: Partial<Record<Look, Palette>> = {
  building: { stops: ["#06142e", "#1d4f9a", "#6aa8ff", "#eef6ff"], gain: 1, disc: true },
  stalled: { stops: ["#1c0b06", "#5c2617", "#b45a35", "#e9a27c"], gain: 1, disc: true },
};

// Concluded research's colours, one per ticket, like the varied gas of real nebulae: teal, rose,
// indigo, amber, ice and violet.
const SPENT: [string, string, string, string][] = [
  ["#0d3b4a", "#1fa3a8", "#8ff0e0", "#f0fffb"],
  ["#3d0f3a", "#c2408f", "#ffb0d8", "#fff0f8"],
  ["#1a1650", "#5a5ad8", "#b8b8ff", "#f4f4ff"],
  ["#4a2208", "#d8782a", "#ffd09a", "#fff6ea"],
  ["#0b2a50", "#2f86d8", "#a8d8ff", "#f2faff"],
  ["#2a0f4a", "#9a4ad8", "#e0b0ff", "#fbf2ff"],
];

// How each painted body is coloured: research over violet, in its status's colour; prototypes
// in theirs; nurseries a warm forming glow; a sun's corona gold, or grey once ruled out.
function palette(kind: Kind, status: Status, seed = 0): Palette {
  const c = COL[status], settled = status === "resolved" || status === "out_of_scope";
  if (kind === "nebula") {
    if (status === "out_of_scope") return { stops: [mix(c.glow, "#000000", 0.7), mix(c.glow, "#000000", 0.3), c.glow, c.core], gain: 0.55 };
    return settled ? { stops: SPENT[seed % SPENT.length], gain: 0.9 } : { stops: ["#3a2a8f", mix("#6a4cff", c.glow, 0.6), c.core, "#ffffff"], gain: 1.3 };
  }
  if (kind === "protostar") return { stops: [mix(c.glow, "#000000", 0.5), c.glow, c.core, "#ffffff"], gain: settled ? 0.8 : 1.1 };
  if (kind === "nursery") return { stops: ["#4a2380", "#e0662a", "#ffc65a", "#fff3dc"], gain: 1.2 };
  return status === "out_of_scope"
    ? { stops: ["#3a3844", "#7a7688", "#c8c6d2", "#f0eef6"], gain: 0.9 }
    : { stops: ["#7a3208", "#f08a1e", "#ffd257", "#fffbe8"], gain: 1.2 };
}

// A label's status line, in a lighter tint of its look.
function statusCol(l: Look) {
  return { you: "#ffd36b", stalled: "#e8875c", ready: "#7fe3b8", building: "#8fbcff", blocked: "#e48a8e", built: "#b9c5d8", dropped: "#8a8496" }[l];
}

export const ringR = (rank: number) => 110 + rank * 125;

type XY = { num: number; rank: number; x: number; y: number };

// Where each ticket rests, as a distance from the centre. The map's fold-in holds the centre (its
// sun, or its nursery while the spec forms; the completed one, and the latest, if there are
// several), and the rank rings step out to make room for it. Concluded research drifts out past
// them into a belt of its own, so the open work keeps the middle. Pure, so it's testable.
export function rests(m: WayMap) {
  const settled = (t: Ticket) => t.status === "resolved" || t.status === "out_of_scope";
  const folds = m.tickets.filter((t) => isFoldIn(t) && t.status !== "out_of_scope")
    .sort((a, b) => Number(b.status === "resolved") - Number(a.status === "resolved") || b.num - a.num);
  const centre = folds[0]?.num ?? null, shift = centre == null ? 0 : 30;
  const belt = new Set(m.tickets.filter((t) => t.type === "research" && settled(t) && t.num !== centre).map((t) => t.num));
  const inner = m.tickets.filter((t) => !belt.has(t.num) && t.num !== centre);
  const beltR = ringR(Math.max(0, ...inner.map((t) => t.rank))) + shift + (inner.length ? 80 : 0);
  const ring = (n: { num: number; rank: number }) => (n.num === centre ? 0 : belt.has(n.num) ? beltR : ringR(n.rank) + shift);
  return { centre, belt, ring };
}

// Seed each node on its rank's ring, then relax: nodes repel, edges spring to a rest length,
// and each node is pulled back toward its ring. Pure, so it's testable without a canvas.
export function layout(nodes: XY[], edges: Edge[], ring = (n: XY) => ringR(n.rank), pin: number | null = null) {
  const by: Record<number, XY> = {};
  nodes.forEach((n) => (by[n.num] = n));
  const rnd = mulberry32(1337);
  nodes.forEach((n) => {
    const ang = rnd() * TAU;
    const R = ring(n) + (rnd() - 0.5) * 70;
    n.x = Math.cos(ang) * R;
    n.y = Math.sin(ang) * R;
  });
  const REP = 6500, SPRING = 0.02, REST = 120, RADIAL = 0.05;
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
      if (n.num === pin) { n.x = 0; n.y = 0; continue; }
      const d = Math.hypot(n.x, n.y) || 0.01, f = (ring(n) - d) * RADIAL;
      n.x += (n.x / d) * f; n.y += (n.y / d) * f;
    }
  }
}

// The critical chain, as edge indices: the longest run of dependencies between open tickets
// (one of them, at a tie), plus the links the suggested path follows. Pure, so it's testable.
export function criticalChain(m: WayMap, att: Attention) {
  const open = new Set(m.tickets.filter((t) => t.status !== "resolved" && t.status !== "out_of_scope").map((t) => t.num));
  const out: Record<number, number[]> = {};
  m.edges.forEach((e, i) => { if (open.has(e.from) && open.has(e.to)) (out[e.from] ??= []).push(i); });
  // The longest run from each ticket, guarding against a cycle.
  const memo = new Map<number, { len: number; next: number | null }>(), busy = new Set<number>();
  const longest = (n: number): number => {
    const got = memo.get(n);
    if (got) return got.len;
    if (busy.has(n)) return 0;
    busy.add(n);
    let best = { len: 0, next: null as number | null };
    for (const i of out[n] ?? []) {
      const len = 1 + longest(m.edges[i].to);
      if (len > best.len) best = { len, next: i };
    }
    busy.delete(n);
    memo.set(n, best);
    return best.len;
  };
  let start: number | null = null, top = 0;
  for (const n of [...open].sort((a, b) => a - b)) if (longest(n) > top) { top = longest(n); start = n; }
  const chain = new Set<number>();
  for (let n = start, guard = 0; n != null && guard < 1000; guard++) {
    const i = memo.get(n)?.next;
    if (i == null || chain.has(i)) break;
    chain.add(i);
    n = m.edges[i].to;
  }
  const steps = att.path.filter((p) => p.kind === "ticket").map((p) => p.num);
  steps.slice(1).forEach((to, k) => {
    const i = m.edges.findIndex((e) => e.from === steps[k] && e.to === to);
    if (i >= 0) chain.add(i);
  });
  return chain;
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
  | { kind: "cluster"; hub: number; members: number[] }
  | { kind: "slice"; num: number }
  | { kind: "dust"; anchor: number }
  | { kind: "dest" }
  | { kind: "nursery" };

export type EngineEvents = {
  onSelect: (num: number | null) => void;
  onFog: (index: number) => void;
  onMoon: (num: number) => void;
  onHover: (h: Hover | null) => void;
  onSlice: (num: number) => void;
};

const hoverKey = (h: Hover | null) =>
  !h ? "" : h.kind === "edge" ? `e${h.from}-${h.to}` : h.kind === "fog" ? `f${h.index}` : h.kind === "cluster" ? `c${h.hub}`
    : h.kind === "slice" ? `s${h.num}` : h.kind === "dust" ? `d${h.anchor}` : h.kind === "dest" || h.kind === "nursery" ? h.kind : `${h.kind[0]}${h.num}`;

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
  private edgeFx: { emph: number; dim: number; chain: number }[] = [];
  // The edges of the critical chain: the longest run of open dependencies, and the links the
  // suggested path follows.
  private critical = new Set<number>();
  private ring = (n: { num: number; rank: number }) => ringR(n.rank);
  private byNum: Record<number, Node> = {};
  private fogPts: FogPt[] = [];
  private clusters: Cluster[] = [];
  private selected: Node | null = null;
  private slices: SNode[] = [];
  private sliceBy: Record<number, SNode> = {};
  private kids: Record<number, SNode[]> = {};
  private sliceEdges: { from: number; to: number; open: boolean }[] = [];
  // The hub the map's own slices hang on, when it has any; and where the map leads.
  private hub: Anchor | null = null;
  private dest: { x: number; y: number; text: string; reached: boolean } | null = null;
  // The map's own nursery, at its centre, while it has no fold-in.
  private core: { x: number; y: number } | null = null;
  private att: Attention = { looks: {}, unlocks: {}, path: [], open: { decisions: 0, slices: 0 }, now: 0 };
  private now = Date.now();
  // Labels off: only what's hovered or selected keeps its label.
  private labels = true;
  private selectedSlice: SNode | null = null;
  private hover: Hover | null = null;
  private pointer: { x: number; y: number } | null = null;
  private match: Set<number> | null = null;
  private panelW = 0;
  private tip: HTMLElement | null = null;
  private mini: { canvas: HTMLCanvasElement; ctx: CanvasRenderingContext2D; box: { x: number; y: number; s: number } } | null = null;
  private fogSprites: HTMLCanvasElement[] = [];
  private destSprite: HTMLCanvasElement | null = null;
  private bodySprites = new Map<string, HTMLCanvasElement>();
  private widths = new Map<string, number>();
  private threads = new Map<number, string>();
  private mapNum: number | null = null;
  private clock = 0;
  private lastClock = 0;
  private t0 = performance.now();
  private mapAlpha = 1;
  private fade = { on: false, t: 0, dur: 1.4, from: 0, to: 1 };
  private stars: { f: number; sz: number; a: number; stars: { x: number; y: number; t: number }[] }[] = [];
  private raf = 0;
  // When the pointer, wheel or keys last did something, and when a frame was last drawn: idle,
  // the map redraws at about 30 fps, enough for its slow drift and twinkle.
  private lastInput = 0;
  private lastDraw = 0;
  // The part of the world on screen this frame, for skipping what's off it.
  private view = { x0: 0, y0: 0, x1: 0, y1: 0 };
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
        body: bodyOf(t),
      };
    });
    this.edges = m.edges;
    this.edgeFx = m.edges.map(() => ({ emph: 0, dim: 0, chain: 0 }));
    this.byNum = {};
    this.nodes.forEach((n) => (this.byNum[n.num] = n));
    const rest = rests(m);
    this.ring = rest.ring;
    if (same) {
      this.placeFresh();
    } else {
      layout(this.nodes, this.edges, this.ring, rest.centre);
      gather(this.nodes, this.edges);
      // Clusters may have tugged the centre off; move everything back so it holds it.
      const c = rest.centre != null ? this.byNum[rest.centre] : null;
      if (c && (c.x || c.y)) { const { x, y } = c; this.nodes.forEach((n) => { n.x -= x; n.y -= y; }); }
      this.nodes.forEach((n) => { n.px = n.x; n.py = n.y; });
    }
    this.setupClusters();
    this.now = Date.now();
    this.att = attention(m, this.now);
    this.setupSlices(m.slices ?? [], same);
    this.setupFog(m);
    this.setupDest(m);
    this.critical = criticalChain(m, this.att);
    this.core = nursery(m) && this.nodes.length ? { x: 0, y: 0 } : null;
    if (this.selected) this.selected = this.byNum[this.selected.num] ?? null;
    if (this.selectedSlice) this.selectedSlice = this.sliceBy[this.selectedSlice.num] ?? null;
    this.setHover(null);
    if (!same) {
      this.fitCamera();
      Object.assign(this.cam, this.goal);
      Object.assign(this.fade, { on: true, t: 0, from: 0, to: 1 });
      this.mapAlpha = 0;
    }
  }

  setLabels(on: boolean) {
    this.labels = on;
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

  // Ease the camera onto a slice, close enough that its fold-in's slices show.
  selectSlice(num: number | null, panelWidth = 0) {
    const sn = num == null ? null : this.sliceBy[num] ?? null;
    this.selectedSlice = sn;
    this.panelW = panelWidth;
    if (sn) {
      const p = sn.parent != null ? this.byNum[sn.parent] : null;
      const x = (p ? p.x : this.hub?._x ?? 0) + sn.ox, y = (p ? p.y : this.hub?._y ?? 0) + sn.oy;
      this.goal.s = Math.max(this.goal.s, 1);
      this.goal.x = (innerWidth - panelWidth) / 2 - x * this.goal.s;
      this.goal.y = innerHeight / 2 - y * this.goal.s;
    }
  }

  // A ticket's slices built, of those not dropped: from the slices once they're loaded, else
  // from the map's count of them (where a dropped slice counts as closed and in the total).
  private progress(n: Node): [number, number] | null {
    const kids = this.kids[n.num]?.filter((k) => k.state !== "dropped");
    if (kids?.length) return [kids.filter((k) => k.state === "built").length, kids.length];
    return n.slices ? [n.slices.closed, n.slices.total] : null;
  }

  // Slices: each group around its anchor, open ones evenly spaced on an orbit from the top,
  // finished ones parked on the dust ring. The map's own slices get a hub of their own, set
  // beside the decisions.
  private setupSlices(list: BuildSlice[], same: boolean) {
    const old = same ? this.sliceBy : {};
    this.slices = list
      .filter((sl) => sl.parent == null || this.byNum[sl.parent])
      .map((sl) => ({
        ...sl, ox: 0, oy: 0, _x: 0, _y: 0, vis: old[sl.num]?.vis ?? 0, emph: 0, dim: 0,
        look: this.att.looks[sl.num] ?? sl.state, dust: collapsed(sl),
      }));
    this.sliceBy = {};
    this.kids = {};
    const loose: SNode[] = [];
    for (const sn of this.slices) {
      this.sliceBy[sn.num] = sn;
      if (sn.parent != null) (this.kids[sn.parent] ??= []).push(sn);
      else loose.push(sn);
    }
    const oldHub = this.hub;
    this.hub = null;
    if (loose.length) {
      let x = 0, y = 0;
      if (same && oldHub) ({ _x: x, _y: y } = oldHub);
      else if (this.nodes.length) {
        x = Math.max(...this.nodes.map((n) => n.x)) + 220;
        y = this.nodes.reduce((a, n) => a + n.y, 0) / this.nodes.length;
      }
      this.hub = { num: -1, _x: x, _y: y, r: 6 };
    }
    const place = (group: SNode[], a: number) => {
      const live = group.filter((sn) => !sn.dust), dust = group.filter((sn) => sn.dust);
      const R = Math.min(110, Math.max(58, 40 + 7 * live.length));
      live.forEach((sn, i) => {
        const t = -Math.PI / 2 + (i * TAU) / live.length;
        sn.ox = Math.cos(t) * R; sn.oy = Math.sin(t) * R * 0.85;
      });
      const D = this.dustR(a);
      dust.forEach((sn, i) => {
        const t = -Math.PI / 2 + ((i + 0.5) * TAU) / dust.length;
        sn.ox = Math.cos(t) * D; sn.oy = Math.sin(t) * D;
      });
    };
    for (const [p, group] of Object.entries(this.kids)) place(group, this.coreR(this.byNum[Number(p)]));
    if (loose.length) place(loose, 6);
    this.sliceEdges = this.slices.flatMap((sn) =>
      sn.dust ? [] : sn.blockers.filter((b) => this.sliceBy[b.num] && !this.sliceBy[b.num].dust).map((b) => ({ from: b.num, to: sn.num, open: b.open })),
    );
  }

  // World units for n screen pixels once zoomed in past 1:1, so strokes and specks stay fine
  // close up; zoomed out they shrink with the map as before.
  private px(n: number) {
    return n / Math.max(1, this.ec.s);
  }

  // Whether a circle of radius r around (x, y) reaches the screen.
  private seen(x: number, y: number, r: number) {
    const v = this.view;
    return x + r > v.x0 && x - r < v.x1 && y + r > v.y0 && y - r < v.y1;
  }

  // The radius of an anchor's dust ring, for a star (or hub) of radius r.
  private dustR(r: number) {
    return r + 30;
  }

  // An open slice's radius: larger the more it frees.
  private sliceR(sn: SNode) {
    return SLICE_R * Math.min(1.8, 1 + 0.3 * Math.sqrt(this.att.unlocks[sn.num] ?? 0));
  }

  private anchorOf(sn: SNode): Anchor | null {
    if (sn.parent == null) return this.hub;
    const n = this.byNum[sn.parent];
    return n ? { num: n.num, _x: n._x, _y: n._y, r: this.coreR(n) } : null;
  }

  // Where the map leads: past the rim, beyond its outermost tickets.
  private setupDest(m: WayMap) {
    this.dest = null;
    if (!this.nodes.length) return;
    let cx = 0, cy = 0;
    this.nodes.forEach((n) => { cx += n.x; cy += n.y; });
    cx /= this.nodes.length; cy /= this.nodes.length;
    let rim = 0;
    this.nodes.forEach((n) => (rim = Math.max(rim, Math.hypot(n.x - cx, n.y - cy))));
    const top = Math.max(...this.nodes.map((n) => n.rank)), outer = this.nodes.filter((n) => n.rank === top);
    const ox = outer.reduce((a, n) => a + n.x, 0) / outer.length - cx, oy = outer.reduce((a, n) => a + n.y, 0) / outer.length - cy;
    // Beyond the outermost tickets, turned aside (a little at a time) until clear of the fog.
    const base = Math.hypot(ox, oy) > 1 ? Math.atan2(oy, ox) : -Math.PI / 4, R = rim + 115;
    const clear = (t: number) => Math.min(1e9, ...this.fogPts.map((f) => Math.hypot(cx + Math.cos(t) * R - f.x, cy + Math.sin(t) * R - f.y)));
    let ang = base;
    for (let i = 1; i <= 16 && clear(ang) < 260; i++) {
      const t = base + Math.ceil(i / 2) * 0.2 * (i % 2 ? 1 : -1);
      if (clear(t) > clear(ang)) ang = t;
    }
    const first = m.destination.split(/(?<=[.!?])\s|\n/)[0].replace(/[*_`#>]/g, "").trim();
    this.dest = { x: cx + Math.cos(ang) * R, y: cy + Math.sin(ang) * R, text: first, reached: !m.open };
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
      else { n.x = Math.cos(ang) * this.ring(n); n.y = Math.sin(ang) * this.ring(n); }
    }
    for (let it = 0; it < 200; it++) {
      for (const n of fresh) {
        let fx = 0, fy = 0;
        for (const o of this.nodes) {
          if (o === n) continue;
          const dx = n.x - o.x, dy = n.y - o.y, d2 = dx * dx + dy * dy || 0.01, d = Math.sqrt(d2), f = 6500 / d2;
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
        for (const e of this.edges) {
          const o = e.from === n.num ? this.byNum[e.to] : e.to === n.num ? this.byNum[e.from] : null;
          if (!o) continue;
          const dx = o.x - n.x, dy = o.y - n.y, d = Math.hypot(dx, dy) || 0.01, f = (d - 120) * 0.02;
          fx += (dx / d) * f; fy += (dy / d) * f;
        }
        const d = Math.hypot(n.x, n.y) || 0.01, rf = (this.ring(n) - d) * 0.05;
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
    rim += 60;
    const rnd = mulberry32(4242);
    m.fog.forEach((f, i) => {
      const anc = f.clearsWith != null ? this.byNum[f.clearsWith] ?? null : null;
      const ang = anc ? Math.atan2(anc.y - cy, anc.x - cx) + (rnd() - 0.5) * 0.3 : i * 2.399963 + rnd() * 0.4;
      this.fogPts.push({ index: i, title: f.title, anchor: anc, x: cx + Math.cos(ang) * rim, y: cy + Math.sin(ang) * rim, emph: 0 });
    });
  }

  private fitCamera() {
    if (!this.nodes.length && !this.slices.length) { this.goal = { x: innerWidth / 2, y: innerHeight / 2, s: 1 }; return; }
    let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
    const grow = (x: number, y: number, r: number) => {
      minx = Math.min(minx, x - r); miny = Math.min(miny, y - r); maxx = Math.max(maxx, x + r); maxy = Math.max(maxy, y + r);
    };
    // The tickets and the destination in full; the open questions' clouds only to their middles,
    // so the map, not its haze, fills the screen.
    this.nodes.forEach((n) => grow(n.x, n.y, 0));
    if (this.hub) grow(this.hub._x, this.hub._y, 90);
    if (this.dest) grow(this.dest.x, this.dest.y, 50);
    this.fogPts.forEach((f) => grow(f.x, f.y, 0));
    const pad = 40;
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

  // The radius of a ticket's body at rest: a decision star's by its status; the others by their
  // form, a little smaller once they're settled.
  private coreR(n: Node) {
    const settled = n.status === "resolved" || n.status === "out_of_scope";
    switch (n.body) {
      case "sun": return n.status === "out_of_scope" ? 13.5 : 21;
      case "nursery": return 12;
      case "nebula": return settled ? 9 : 11;
      case "protostar": return settled ? 5 : 6.5;
      default: return COL[n.status].r;
    }
  }

  // The radius a ticket draws at, grown by up to 20% while hovered.
  private radius(n: Node) {
    return this.coreR(n) * (1 + 0.2 * n.emph);
  }

  // Where a fold-in's build ring sits: snug round a sun, so it stays the size it was.
  private ringAt(n: Node) {
    return this.radius(n) + (n.body === "sun" ? 7 : 10);
  }

  // Where a live thread's moon is now, in world space, on its tilted orbit.
  private moonAt(n: Node) {
    // Clear of a painted body's disk or cloud, not through it.
    const k = n.body === "protostar" ? 3.6 : n.body === "nebula" ? 2.6 : 1;
    const r = this.coreR(n) * k, rx = r + 20, ry = (r + 20) * 0.42, tilt = -0.55;
    const ox = Math.cos(n.moon) * rx, oy = Math.sin(n.moon) * ry;
    return { x: n._x + ox * Math.cos(tilt) - oy * Math.sin(tilt), y: n._y + ox * Math.sin(tilt) + oy * Math.cos(tilt), rx, ry, tilt };
  }

  // The indices of the edges in a ticket's dependency chain: everything upstream of it and
  // everything downstream, transitively.
  private chainOf(num: number) {
    const out = new Set<number>();
    const walk = (start: number, up: boolean) => {
      const seen = new Set([start]), stack = [start];
      while (stack.length) {
        const n = stack.pop()!;
        this.edges.forEach((e, i) => {
          if ((up ? e.to : e.from) !== n) return;
          out.add(i);
          const m = up ? e.from : e.to;
          if (!seen.has(m)) { seen.add(m); stack.push(m); }
        });
      }
    };
    walk(num, true); walk(num, false);
    return out;
  }

  // The control point of the gentle curve an edge draws along.
  private curve(a: Node, b: Node) {
    const ax = a._x, ay = a._y, bx = b._x, by = b._y;
    const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy) || 1, bow = Math.min(46, len * 0.13);
    return { ax, ay, bx, by, cx: (ax + bx) / 2 + (-dy / len) * bow, cy: (ay + by) / 2 + (dx / len) * bow, len };
  }

  // A live thread's moon under the pointer: a ticket's orbiting one, or a shown slice's, which
  // sits still on its dashed ring.
  private pickMoon(mx: number, my: number): { num: number } | null {
    for (const n of this.nodes) {
      if (!this.threads.has(n.num)) continue;
      const p = this.w2s(this.moonAt(n));
      if (Math.hypot(p.x - mx, p.y - my) < 9) return n;
    }
    for (const sn of this.slices) {
      if (!this.threads.has(sn.num) || sn.dust || sn.vis < 0.5) continue;
      const p = this.w2s(this.sliceMoonAt(sn));
      if (Math.hypot(p.x - mx, p.y - my) < 9) return sn;
    }
    return null;
  }

  // Where a slice's thread moon sits: on its dashed ring, low on the left, clear of the label
  // and of the check moons.
  private sliceMoonAt(sn: SNode) {
    const R = this.sliceR(sn) + this.px(6), t = Math.PI * 0.75;
    return { x: sn._x + Math.cos(t) * R, y: sn._y + Math.sin(t) * R, R };
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

  // A shown open slice under the pointer.
  private pickSlice(mx: number, my: number) {
    let best: SNode | null = null, bd = 1e9;
    for (const sn of this.slices) {
      if (sn.vis < 0.5 || sn.dust) continue;
      const p = this.w2s(sn), d = Math.hypot(p.x - mx, p.y - my);
      if (d < Math.max(10, this.sliceR(sn) * this.ec.s + 5) && d < bd) { bd = d; best = sn; }
    }
    return best;
  }

  // Every anchor with finished work to show, and how much: a fold-in's built slices (counted
  // until they're loaded), and the hub's.
  private dustGroups() {
    const out: { a: Anchor; count: number; vis: number }[] = [];
    for (const n of this.nodes) {
      const prog = this.progress(n), kids = this.kids[n.num];
      const count = kids ? kids.filter((k) => k.dust && k.state === "built").length : prog?.[0] ?? 0;
      if (count) out.push({ a: { num: n.num, _x: n._x, _y: n._y, r: this.coreR(n) }, count, vis: kids ? Math.max(...kids.map((k) => k.vis)) : 0 });
    }
    if (this.hub) {
      const loose = this.slices.filter((sn) => sn.parent == null);
      const count = loose.filter((k) => k.dust && k.state === "built").length;
      if (count) out.push({ a: this.hub, count, vis: 1 });
    }
    return out;
  }

  // The dust ring under the pointer.
  private pickDust(mx: number, my: number) {
    for (const g of this.dustGroups()) {
      const c = this.w2s(g.a), d = Math.hypot(c.x - mx, c.y - my), R = this.dustR(g.a.r) * this.ec.s;
      if (Math.abs(d - R) < Math.max(7, 6 * this.ec.s)) return g.a.num;
    }
    return null;
  }

  private pickCore(mx: number, my: number) {
    if (!this.core) return false;
    const p = this.w2s(this.core);
    return Math.hypot(p.x - mx, p.y - my) < Math.max(16, 45 * this.ec.s);
  }

  private pickDest(mx: number, my: number) {
    if (!this.dest) return false;
    const p = this.w2s(this.dest);
    return Math.hypot(p.x - mx, p.y - my) < Math.max(16, 26 * this.ec.s);
  }

  // In order of what sits on top: a moon over its star, a slice over a star, a star over an
  // edge, an edge over fog, and a cluster's empty space last.
  private pick(mx: number, my: number): Hover | null {
    const moon = this.pickMoon(mx, my);
    if (moon) return { kind: "moon", num: moon.num };
    const sl = this.pickSlice(mx, my);
    if (sl) return { kind: "slice", num: sl.num };
    const n = this.pickNode(mx, my);
    if (n) return { kind: "node", num: n.num };
    const dust = this.pickDust(mx, my);
    if (dust != null) return { kind: "dust", anchor: dust };
    if (this.pickDest(mx, my)) return { kind: "dest" };
    if (this.pickCore(mx, my)) return { kind: "nursery" };
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
    this.canvas.classList.toggle("pointer", !!h && h.kind !== "cluster" && h.kind !== "edge" && h.kind !== "dest" && h.kind !== "nursery" && !(h.kind === "dust" && h.anchor < 0));
    this.events.onHover(h);
  }

  private hitTest(mx: number, my: number) {
    const moon = this.pickMoon(mx, my);
    if (moon) { this.events.onMoon(moon.num); return; }
    const sl = this.pickSlice(mx, my);
    if (sl) { this.events.onSlice(sl.num); return; }
    const n = this.pickNode(mx, my);
    if (n) { this.events.onSelect(n.num); return; }
    const dust = this.pickDust(mx, my);
    if (dust != null && dust >= 0) { this.events.onSelect(dust); return; }
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
    const stamp = () => { this.lastInput = performance.now(); };
    for (const ev of ["pointermove", "pointerdown", "wheel", "touchmove", "keydown"]) on(window, ev, stamp, { passive: true });
    on(c, "mousedown", (e: MouseEvent) => { down = true; moved = 0; last = { x: e.clientX, y: e.clientY }; c.classList.add("drag"); });
    on(c, "mousemove", (e: MouseEvent) => { this.pointer = down ? null : { x: e.clientX, y: e.clientY }; });
    on(c, "mouseleave", () => { this.pointer = null; });
    on(window, "mousemove", (e: MouseEvent) => {
      if (!down) return;
      const dx = e.clientX - last.x, dy = e.clientY - last.y;
      moved += Math.abs(dx) + Math.abs(dy);
      // A drag moves the map under the pointer at once; easing it would trail behind the hand.
      this.goal.x += dx; this.goal.y += dy; this.cam.x += dx; this.cam.y += dy;
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
      // A trackpad (a pinch, or a scroll's many small steps) zooms at once, under the fingers; a
      // mouse wheel's notches, a third each, glide.
      if (e.ctrlKey || Math.abs(dy) < 40) Object.assign(this.cam, this.goal);
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
        Object.assign(this.cam, this.goal);
        pinch = p;
      } else if (down && e.touches.length === 1) {
        const t = e.touches[0], dx = t.clientX - last.x, dy = t.clientY - last.y;
        moved += Math.abs(dx) + Math.abs(dy);
        this.goal.x += dx; this.goal.y += dy; this.cam.x += dx; this.cam.y += dy;
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
      Object.assign(this.cam, this.goal);
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
    } else if (h?.kind === "slice") {
      // A slice keeps its fold-in and the slices it waits on or unblocks lit.
      focusing = true;
      const sn = this.sliceBy[h.num];
      if (sn?.parent != null) near.add(sn.parent);
    } else if (h?.kind === "dust" && h.anchor >= 0) {
      near.add(h.anchor);
    }
    // The slices that stay lit: a hovered fold-in's, or a hovered slice and its blocking edges.
    const litSlices = new Set<number>();
    if (h?.kind === "node") this.kids[h.num]?.forEach((sn) => litSlices.add(sn.num));
    if (h?.kind === "cluster") hubFocus?.members.forEach((m) => this.kids[m.num]?.forEach((sn) => litSlices.add(sn.num)));
    if (h?.kind === "slice") {
      litSlices.add(h.num);
      for (const e of this.sliceEdges) {
        if (e.from === h.num) litSlices.add(e.to);
        if (e.to === h.num) litSlices.add(e.from);
      }
    }
    for (const sn of this.slices) {
      sn.emph = ease(sn.emph, h?.kind === "slice" && h.num === sn.num ? 1 : 0);
      sn.dim = ease(sn.dim, focusing && !litSlices.has(sn.num) ? 1 : 0);
      // Shown when zoomed in, always when it has no fold-in to fold into, and whenever its
      // fold-in or a sibling is hovered or selected.
      const p = sn.parent != null ? this.byNum[sn.parent] : undefined;
      const focus = !p || this.cam.s >= SLICES_FROM_ZOOM || p === this.selected || p.emph > 0.3 || p.rel > 0.5
        || this.selectedSlice?.parent === sn.parent || (h?.kind === "slice" && this.sliceBy[h.num]?.parent === sn.parent);
      sn.vis = ease(sn.vis, focus ? 1 : 0);
    }
    for (const n of this.nodes) {
      n.emph = ease(n.emph, lit.has(n.num) ? 1 : 0);
      n.rel = ease(n.rel, near.has(n.num) ? 1 : 0);
      n.dim = ease(n.dim, focusing && !lit.has(n.num) && !near.has(n.num) ? 1 : 0);
      // A hovered moon holds still, so it can be clicked.
      const thread = this.threads.get(n.num);
      if (thread && !(h?.kind === "moon" && h.num === n.num)) n.moon += dt * (thread === "running" || thread === "starting" ? 1.9 : 0.6);
    }
    // Selected, a ticket's whole chain stands out, what it waits on and what waits on it, further
    // down too; otherwise the critical chain does.
    const chain = this.selected ? this.chainOf(this.selected.num) : this.critical;
    this.edges.forEach((e, i) => {
      const fx = this.edgeFx[i];
      const inCluster = hubFocus && hubFocus.members.some((m) => m.num === e.from) && hubFocus.members.some((m) => m.num === e.to);
      fx.emph = ease(fx.emph, litEdges.has(i) ? 1 : 0);
      fx.dim = ease(fx.dim, focusing && !litEdges.has(i) && !inCluster ? 1 : 0);
      fx.chain = ease(fx.chain, chain.has(i) ? 1 : 0);
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
      const n = this.byNum[h.num], sn = this.sliceBy[h.num];
      if (n) { const p = this.w2s(this.moonAt(n)); a = { ...p, r: 14 }; }
      else if (sn) { const p = this.w2s(this.sliceMoonAt(sn)); a = { ...p, r: 14 }; }
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
    } else if (h?.kind === "slice") {
      const sn = this.sliceBy[h.num];
      if (sn && sn !== this.selectedSlice) a = { ...this.w2s(sn), r: this.sliceR(sn) * this.ec.s + 14 };
    } else if (h?.kind === "dust") {
      const g = this.dustGroups().find((d) => d.a.num === h.anchor);
      if (g) a = { ...this.w2s(g.a), r: (this.dustR(g.a.r) + 8) * this.ec.s };
    } else if (h?.kind === "dest" && this.dest) {
      a = { ...this.w2s(this.dest), r: 24 * this.ec.s + 10 };
    } else if (h?.kind === "nursery" && this.core) {
      a = { ...this.w2s(this.core), r: 45 * this.ec.s + 10 };
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

  // Each group's orbit of open slices, faint, while they show.
  private drawOrbitsOfSlices() {
    const ctx = this.ctx;
    const groups: [Anchor | null, SNode[], number][] = Object.entries(this.kids).map(([p, g]) => {
      const n = this.byNum[Number(p)];
      return [n ? { num: n.num, _x: n._x, _y: n._y, r: 0 } : null, g, n?.dim ?? 0];
    });
    if (this.hub) groups.push([this.hub, this.slices.filter((sn) => sn.parent == null), 0]);
    for (const [a, group, dim] of groups) {
      const live = group.filter((g) => !g.dust);
      if (!a || !live.length) continue;
      const vis = Math.max(...live.map((g) => g.vis));
      if (vis < 0.02) continue;
      const R = Math.hypot(live[0].ox, live[0].oy / 0.85);
      ctx.globalAlpha = this.mapAlpha * vis * (1 - 0.7 * dim);
      ctx.strokeStyle = "rgba(170,190,240,0.14)"; ctx.lineWidth = 1 / this.ec.s;
      ctx.beginPath(); ctx.ellipse(a._x, a._y, R, R * 0.85, 0, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // Finished work: a ring of dust around its anchor, a speck per built slice, scattered the same
  // way every time. One built in the last two days flares white where it joined the ring.
  private drawDust() {
    const ctx = this.ctx, hov = this.hover?.kind === "dust" ? this.hover.anchor : null;
    for (const g of this.dustGroups()) {
      const n = g.a.num >= 0 ? this.byNum[g.a.num] : null, hi = hov === g.a.num ? 1 : 0;
      ctx.globalAlpha = this.mapAlpha * (0.55 + 0.45 * Math.max(g.vis, hi)) * (n ? 1 - 0.6 * n.dim : 1);
      const R = this.dustR(g.a.r), rnd = mulberry32(g.a.num * 7 + 3), specks = Math.min(160, g.count * 5);
      ctx.fillStyle = hi ? "rgba(225,232,248,0.95)" : "rgba(200,212,235,0.7)";
      for (let i = 0; i < specks; i++) {
        const t = rnd() * TAU, r = R + (rnd() - 0.5) * 9, sz = this.px(0.5 + rnd() * (i % 5 ? 0.6 : 1.1));
        ctx.beginPath(); ctx.arc(g.a._x + Math.cos(t) * r, g.a._y + Math.sin(t) * r, sz, 0, TAU); ctx.fill();
      }
      if (hi) {
        ctx.strokeStyle = "rgba(200,212,235,0.35)"; ctx.lineWidth = 1 / this.ec.s; ctx.setLineDash([2 / this.ec.s, 4 / this.ec.s]);
        ctx.beginPath(); ctx.arc(g.a._x, g.a._y, R + 8, 0, TAU); ctx.arc(g.a._x, g.a._y, R - 8, 0, TAU, true); ctx.stroke();
        ctx.setLineDash([]);
      }
    }
    // A slice built in the last two days marks where it joined the ring with a small sparkle,
    // kept well below a decision's brightness and fading as it ages; only in its first
    // AFTERGLOW_HOURS does it also glow.
    for (const sn of this.slices) {
      if (!sn.dust || !recent(sn, this.now)) continue;
      const a = this.anchorOf(sn), n = sn.parent != null ? this.byNum[sn.parent] : null;
      if (!a) continue;
      const x = sn._x, y = sn._y, age = (this.now - Date.parse(sn.closedAt!)) / 3_600_000;
      const glow = age < AFTERGLOW_HOURS;
      ctx.globalAlpha = this.mapAlpha * (n ? 1 - 0.6 * n.dim : 1) * (glow ? 1 : 0.6 * (1 - 0.4 * (age / GLOW_HOURS)));
      if (glow) {
        const G = this.px(9), g = ctx.createRadialGradient(x, y, 0, x, y, G);
        g.addColorStop(0, "rgba(235,240,255,0.6)"); g.addColorStop(1, "rgba(200,210,255,0)");
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, G, 0, TAU); ctx.fill();
      }
      this.sparkle(x, y, this.px(glow ? 5 : 4), glow ? "rgba(255,255,255,0.95)" : "rgba(214,222,240,0.9)");
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // A four-pointed sparkle.
  private sparkle(x: number, y: number, r: number, fill: string) {
    const ctx = this.ctx, w = r * 0.18;
    ctx.fillStyle = fill;
    ctx.beginPath();
    ctx.moveTo(x, y - r); ctx.quadraticCurveTo(x + w, y - w, x + r, y); ctx.quadraticCurveTo(x + w, y + w, x, y + r);
    ctx.quadraticCurveTo(x - w, y + w, x - r, y); ctx.quadraticCurveTo(x - w, y - w, x, y - r);
    ctx.fill();
  }

  // The hub the map's own slices hang on: a small pale core with its build ring.
  private drawHub() {
    const h = this.hub;
    if (!h) return;
    const ctx = this.ctx, loose = this.slices.filter((sn) => sn.parent == null && sn.state !== "dropped");
    const built = loose.filter((sn) => sn.state === "built").length;
    const g = ctx.createRadialGradient(h._x, h._y, 0, h._x, h._y, 22);
    g.addColorStop(0, "rgba(190,205,240,0.45)"); g.addColorStop(1, "rgba(150,170,230,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(h._x, h._y, 22, 0, TAU); ctx.fill();
    ctx.fillStyle = "#e3e9f6"; ctx.beginPath(); ctx.arc(h._x, h._y, 3.2, 0, TAU); ctx.fill();
    this.drawProgress(h._x, h._y, h.r + 12, built, loose.length);
  }

  // A build ring: a faint circle that fills green as slices are built.
  private drawProgress(x: number, y: number, R: number, done: number, all: number) {
    const ctx = this.ctx;
    ctx.lineWidth = this.px(2.6); ctx.lineCap = "round";
    ctx.strokeStyle = "rgba(200,215,255,0.14)";
    ctx.beginPath(); ctx.arc(x, y, R, 0, TAU); ctx.stroke();
    if (done) {
      ctx.strokeStyle = LCOL.ready;
      ctx.beginPath(); ctx.arc(x, y, R, -Math.PI / 2, -Math.PI / 2 + (TAU * done) / Math.max(1, all)); ctx.stroke();
    }
    ctx.lineCap = "butt";
  }

  // A blocking edge between two shown open slices: red and dashed while the blocker is open.
  private drawSliceEdge(e: { from: number; to: number; open: boolean }) {
    const a = this.sliceBy[e.from], b = this.sliceBy[e.to], ctx = this.ctx;
    const vis = Math.min(a.vis, b.vis);
    if (vis < 0.02) return;
    const hi = Math.max(a.emph, b.emph);
    const sel = this.selectedSlice === a || this.selectedSlice === b ? 1 : 0;
    ctx.globalAlpha = this.mapAlpha * vis * (1 - 0.75 * Math.min(a.dim, b.dim)) * (0.3 + 0.7 * Math.max(hi, sel));
    const col = e.open ? "255,96,96" : "120,170,255";
    const dx = b._x - a._x, dy = b._y - a._y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
    const ra = this.sliceR(a) + 3, rb = this.sliceR(b) + 4;
    const sx = a._x + ux * ra, sy = a._y + uy * ra, tx = b._x - ux * rb, ty = b._y - uy * rb;
    ctx.strokeStyle = `rgba(${col},${0.5 + 0.4 * hi})`; ctx.lineWidth = 1.1 + hi;
    if (e.open) { ctx.setLineDash([3, 4]); ctx.lineDashOffset = -this.clock * 6; }
    ctx.beginPath(); ctx.moveTo(sx, sy); ctx.lineTo(tx, ty); ctx.stroke();
    ctx.setLineDash([]); ctx.lineDashOffset = 0;
    const ah = 6, aw = 3.2;
    ctx.beginPath(); ctx.moveTo(tx, ty);
    ctx.lineTo(tx - ux * ah - uy * aw, ty - uy * ah + ux * aw);
    ctx.lineTo(tx - ux * ah + uy * aw, ty - uy * ah - ux * aw);
    ctx.closePath(); ctx.fillStyle = `rgba(${col},0.9)`; ctx.fill();
    ctx.globalAlpha = this.mapAlpha;
  }

  // An open slice: a small planet in its look's colour, sized by what it frees. Blocked is hollow; stalled is dull rust with no glow. Its open checks are
  // small fixed satellites (gold for the owner, blue for an agent), and a live T3 thread a dashed
  // ring that turns.
  private drawSlice(sn: SNode) {
    if (sn.vis < 0.02 || sn.dust || !this.seen(sn._x, sn._y, this.sliceR(sn) * 4 + 30)) return;
    const ctx = this.ctx, col = LCOL[sn.look], x = sn._x, y = sn._y;
    const searched = this.match != null && !this.match.has(sn.num) ? 0.2 : 1;
    ctx.globalAlpha = this.mapAlpha * sn.vis * searched * (1 - 0.7 * sn.dim);
    const r = this.sliceR(sn) * (1 + 0.2 * sn.emph) * (0.6 + 0.4 * sn.vis);
    if (sn.look !== "stalled" && sn.look !== "dropped") {
      const gr = r * 3;
      const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
      g.addColorStop(0, hexA(col, (sn.look === "blocked" ? 0.18 : 0.38) + 0.2 * sn.emph)); g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
    }
    if (sn.look === "dropped") {
      ctx.fillStyle = hexA(col, 0.14); ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      ctx.strokeStyle = hexA(col, 0.9); ctx.lineWidth = 1.4; ctx.stroke();
    } else {
      // Lit by its sun (the fold-in it orbits, or the hub): bright on that side, falling to
      // shadow past the terminator, with a thin lit rim. Its surface is painted, a world in its
      // look's colours, slightly tilted its own way; a plain shaded sphere until that loads.
      const an = this.anchorOf(sn), d = an ? Math.hypot(an._x - x, an._y - y) : 0;
      const lx = d ? (an!._x - x) / d : -0.6, ly = d ? (an!._y - y) / d : -0.8;
      const lit = sn.look === "stalled" ? "#e9a27c" : col, kind = WORLD[sn.look];
      const img = kind && texture(kind, sn.num * 7 + 3, TINT[sn.look] ?? null, 2 * r * this.ec.s * this.dpr);
      const sg = ctx.createRadialGradient(x + lx * r * 0.5, y + ly * r * 0.5, r * 0.05, x + lx * r * 0.25, y + ly * r * 0.25, r * 1.2);
      if (img) {
        ctx.save(); ctx.translate(x, y); ctx.rotate(((sn.num * 0.618) % 1) - 0.5);
        ctx.drawImage(img, -r, -r, 2 * r, 2 * r); ctx.restore();
        const sx = x + lx * r * 0.55, sy = y + ly * r * 0.55, sh = ctx.createRadialGradient(sx, sy, 0, sx, sy, r * 1.75);
        sh.addColorStop(0, "rgba(255,255,255,0.1)"); sh.addColorStop(0.4, "rgba(0,0,0,0)");
        sh.addColorStop(0.75, "rgba(2,4,12,0.72)"); sh.addColorStop(1, "rgba(2,4,12,0.92)");
        ctx.fillStyle = sh; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill();
      } else if (sn.look === "stalled") {
        sg.addColorStop(0, "#f6c9ae"); sg.addColorStop(0.3, "#b45a35"); sg.addColorStop(0.7, "#4a1d10"); sg.addColorStop(1, "#1c0b06");
      } else {
        sg.addColorStop(0, "#ffffff"); sg.addColorStop(0.25, hexA(col, 1)); sg.addColorStop(0.68, shade(col, 0.55)); sg.addColorStop(1, shade(col, 0.88));
      }
      if (!img) { ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(x, y, r, 0, TAU); ctx.fill(); }
      const ang = Math.atan2(ly, lx);
      ctx.strokeStyle = hexA(lit, 0.75); ctx.lineWidth = Math.min(r * 0.25, this.px(1));
      ctx.beginPath(); ctx.arc(x, y, r - ctx.lineWidth / 2, ang - 1.2, ang + 1.2); ctx.stroke();
    }
    // A live T3 thread on it: a dashed ring that turns, with a moon on it to click, which opens
    // the thread. Hovered, the moon grows.
    const thread = this.threads.get(sn.num);
    if (thread) {
      const m = this.sliceMoonAt(sn), mh = this.hover?.kind === "moon" && this.hover.num === sn.num ? 1 : 0;
      const running = thread === "running" || thread === "starting";
      ctx.strokeStyle = `rgba(225,215,255,${running ? 0.8 : 0.45})`; ctx.lineWidth = this.px(1);
      ctx.setLineDash([this.px(2.5), this.px(3.5)]); ctx.lineDashOffset = -this.clock * this.px(running ? 8 : 3);
      ctx.beginPath(); ctx.arc(x, y, m.R, 0, TAU); ctx.stroke(); ctx.setLineDash([]); ctx.lineDashOffset = 0;
      const gr = this.px(7 + 5 * mh), mg = ctx.createRadialGradient(m.x, m.y, 0, m.x, m.y, gr);
      mg.addColorStop(0, "rgba(225,215,255,0.7)"); mg.addColorStop(1, "rgba(180,170,255,0)");
      ctx.fillStyle = mg; ctx.beginPath(); ctx.arc(m.x, m.y, gr, 0, TAU); ctx.fill();
      ctx.fillStyle = "#f1ebff"; ctx.beginPath(); ctx.arc(m.x, m.y, this.px(2.6 * (1 + 0.4 * mh)), 0, TAU); ctx.fill();
    }
    // Its open checks are satellites, one per check (owner ones first, gold; an agent's blue),
    // up and to the left, clear of the label. They stay with it after its PR merges.
    const open = sn.checks.filter((c) => c.open).sort((p, q) => Number(q.kind === "owner") - Number(p.kind === "owner"));
    open.slice(0, 4).forEach((c, i) => {
      const t = -Math.PI * 0.5 - i * 0.5, d = r + this.px(7);
      const mx = x + Math.cos(t) * d, my = y + Math.sin(t) * d, mc = c.kind === "owner" ? GOLD : LCOL.building;
      ctx.fillStyle = hexA(mc, 0.3); ctx.beginPath(); ctx.arc(mx, my, this.px(4.2), 0, TAU); ctx.fill();
      ctx.fillStyle = mc; ctx.beginPath(); ctx.arc(mx, my, this.px(2.2), 0, TAU); ctx.fill();
    });
    if (this.selectedSlice === sn) {
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = this.px(1.4);
      ctx.beginPath(); ctx.arc(x, y, r + this.px(6), 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // Where the recommended path's steps sit now: a slice where it's drawn, or its anchor while
  // it's folded away; a ticket's star; the destination.
  private pathPoints() {
    type P = { x: number; y: number; r: number; kind: "slice" | "ticket" | "dest" };
    const pts: P[] = [];
    for (const st of this.att.path) {
      let p: P | null = null;
      if (st.kind === "dest") p = this.dest && { x: this.dest.x, y: this.dest.y, r: 12, kind: "dest" };
      else if (st.kind === "ticket") {
        // Clear of the build ring, when it has one.
        const n = this.byNum[st.num];
        p = n && { x: n._x, y: n._y, r: this.progress(n) ? this.ringAt(n) + this.px(9) : this.radius(n) + 8, kind: "ticket" };
      }
      else {
        const sn = this.sliceBy[st.num], a = sn && this.anchorOf(sn);
        if (sn && sn.vis > 0.5 && !sn.dust) p = { x: sn._x, y: sn._y, r: this.sliceR(sn) + this.px(6), kind: "slice" };
        else if (a) p = { x: a._x, y: a._y, r: a.r + 10 + this.px(9), kind: "ticket" };
      }
      const last = pts[pts.length - 1];
      if (p && !(last && Math.hypot(last.x - p.x, last.y - p.y) < 1)) pts.push(p);
    }
    return pts;
  }

  // The recommended path: a suggestion, not a dependency, so it's drawn unlike the edges: a
  // dashed gold line with an arrowhead on each leg. It follows real dependencies (a slice to the
  // slice it frees, a slice to its fold-in, a decision to the decision it unblocks), and each
  // ticket it passes through carries a gold ring, so it visibly runs through the fold-in. The
  // last leg, to the destination, isn't a dependency at all: fainter, and dotted.
  private drawPath() {
    const pts = this.pathPoints(), ctx = this.ctx;
    if (pts.length < 2) return;
    const dim = this.hover && this.hover.kind !== "dest" ? 0.45 : 0;
    ctx.globalAlpha = this.mapAlpha * (1 - dim);
    for (let i = 1; i < pts.length; i++) {
      const A = pts[i - 1], B = pts[i], toDest = B.kind === "dest";
      const dx = B.x - A.x, dy = B.y - A.y, len = Math.hypot(dx, dy) || 1, ux = dx / len, uy = dy / len;
      if (len < A.r + B.r + 4) continue;
      const ax = A.x + ux * A.r, ay = A.y + uy * A.r, bx = B.x - ux * B.r, by = B.y - uy * B.r;
      const bow = Math.min(36, len * 0.1), cx = (ax + bx) / 2 - uy * bow, cy = (ay + by) / 2 + ux * bow;
      ctx.strokeStyle = hexA(GOLD, toDest ? 0.06 : 0.12); ctx.lineWidth = this.px(6);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
      ctx.strokeStyle = hexA(GOLD, toDest ? 0.55 : 0.9); ctx.lineWidth = this.px(toDest ? 1.3 : 1.7);
      ctx.setLineDash(toDest ? [this.px(1.5), this.px(5)] : [this.px(7), this.px(5)]);
      ctx.lineDashOffset = -this.clock * this.px(6);
      ctx.beginPath(); ctx.moveTo(ax, ay); ctx.quadraticCurveTo(cx, cy, bx, by); ctx.stroke();
      ctx.setLineDash([]); ctx.lineDashOffset = 0;
      // The arrowhead at the leg's end, along the curve.
      const u = 0.98, m = 1 - u;
      const t = { x: m * m * ax + 2 * m * u * cx + u * u * bx, y: m * m * ay + 2 * m * u * cy + u * u * by };
      const gx = 2 * m * (cx - ax) + 2 * u * (bx - cx), gy = 2 * m * (cy - ay) + 2 * u * (by - cy), gl = Math.hypot(gx, gy) || 1;
      const vx = gx / gl, vy = gy / gl, ah = this.px(8), aw = this.px(4.2);
      ctx.beginPath(); ctx.moveTo(t.x, t.y);
      ctx.lineTo(t.x - vx * ah - vy * aw, t.y - vy * ah + vx * aw);
      ctx.lineTo(t.x - vx * ah * 0.6, t.y - vy * ah * 0.6);
      ctx.lineTo(t.x - vx * ah + vy * aw, t.y - vy * ah - vx * aw);
      ctx.closePath(); ctx.fillStyle = hexA(GOLD, toDest ? 0.6 : 0.95); ctx.fill();
    }
    // A ring on each ticket the path runs through.
    for (const p of pts.slice(1)) {
      if (p.kind !== "ticket") continue;
      ctx.strokeStyle = hexA(GOLD, 0.7); ctx.lineWidth = this.px(1.2);
      ctx.beginPath(); ctx.arc(p.x, p.y, p.r, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // The destination: a bright violet-white star out past the rim, with long thin cross spikes,
  // finer diagonal rays and a few faint rings round it, like a navigation mark. It holds still;
  // painted once into a sprite DEST_R world units in radius.
  private paintDest() {
    const R = DEST_R, k = 3, c = document.createElement("canvas");
    c.width = c.height = Math.ceil(R * 2 * k);
    const ctx = c.getContext("2d")!;
    ctx.scale(k, k);
    ctx.translate(R, R);
    // Rings: an inner solid one, a dashed one, and an outer dotted one with ticks at the
    // compass points.
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = "rgba(190,170,255,0.22)";
    ctx.beginPath(); ctx.arc(0, 0, 44, 0, TAU); ctx.stroke();
    ctx.strokeStyle = "rgba(170,150,255,0.16)"; ctx.setLineDash([5, 4]);
    ctx.beginPath(); ctx.arc(0, 0, 68, 0, TAU); ctx.stroke();
    ctx.setLineDash([0.8, 5]); ctx.lineCap = "round"; ctx.lineWidth = 1.1;
    ctx.strokeStyle = "rgba(170,150,255,0.2)";
    ctx.beginPath(); ctx.arc(0, 0, 92, 0, TAU); ctx.stroke();
    ctx.setLineDash([]); ctx.lineWidth = 0.7; ctx.strokeStyle = "rgba(190,170,255,0.28)";
    for (let i = 0; i < 4; i++) {
      const t = (i * TAU) / 4 + Math.PI / 4;
      ctx.beginPath(); ctx.moveTo(Math.cos(t) * 88, Math.sin(t) * 88); ctx.lineTo(Math.cos(t) * 96, Math.sin(t) * 96); ctx.stroke();
    }
    ctx.globalCompositeOperation = "lighter";
    // The bloom.
    const bloom = ctx.createRadialGradient(0, 0, 0, 0, 0, 62);
    bloom.addColorStop(0, "rgba(220,200,255,0.75)"); bloom.addColorStop(0.18, "rgba(170,120,255,0.35)");
    bloom.addColorStop(0.5, "rgba(120,80,230,0.1)"); bloom.addColorStop(1, "rgba(100,60,220,0)");
    ctx.fillStyle = bloom; ctx.beginPath(); ctx.arc(0, 0, 62, 0, TAU); ctx.fill();
    // A spike: a long thin lozenge, white at the core fading to violet and nothing at the tip.
    const spike = (angle: number, len: number, w: number, al: number) => {
      ctx.save(); ctx.rotate(angle);
      const g = ctx.createLinearGradient(0, 0, len, 0);
      g.addColorStop(0, `rgba(255,255,255,${al})`); g.addColorStop(0.25, `rgba(214,190,255,${al * 0.8})`);
      g.addColorStop(0.6, `rgba(160,110,255,${al * 0.35})`); g.addColorStop(1, "rgba(140,90,255,0)");
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.moveTo(0, -w); ctx.quadraticCurveTo(len * 0.12, -w * 0.25, len, 0);
      ctx.quadraticCurveTo(len * 0.12, w * 0.25, 0, w); ctx.closePath(); ctx.fill();
      ctx.restore();
    };
    // The cross, a little taller than wide; fine diagonals; fainter rays between.
    spike(-Math.PI / 2, 104, 3.4, 1); spike(Math.PI / 2, 104, 3.4, 1);
    spike(0, 92, 3.2, 1); spike(Math.PI, 92, 3.2, 1);
    for (let i = 0; i < 4; i++) spike(Math.PI / 4 + (i * Math.PI) / 2, 40, 1.2, 0.55);
    for (let i = 0; i < 8; i++) spike(Math.PI / 8 + (i * Math.PI) / 4, 26, 0.7, 0.3);
    // The core.
    const core = ctx.createRadialGradient(0, 0, 0, 0, 0, 13);
    core.addColorStop(0, "rgba(255,255,255,1)"); core.addColorStop(0.35, "rgba(255,255,255,0.9)");
    core.addColorStop(0.7, "rgba(210,185,255,0.4)"); core.addColorStop(1, "rgba(180,140,255,0)");
    ctx.fillStyle = core; ctx.beginPath(); ctx.arc(0, 0, 13, 0, TAU); ctx.fill();
    return c;
  }

  // The map's own nursery, at the centre its decisions ring.
  private drawCore() {
    const c = this.core;
    if (!c || this.mapNum == null) return;
    const hi = this.hover?.kind === "nursery" ? 1 : 0;
    if (!this.drawTex("nursery", this.mapNum, palette("nursery", "frontier"), c.x, c.y, 115, 0.7 + 0.2 * hi, TAU)) this.drawCloud(this.nurserySprite(this.mapNum), c.x, c.y, 100, 0.85 + 0.15 * hi);
  }

  private drawDest() {
    const d = this.dest;
    if (!d) return;
    const ctx = this.ctx, hi = this.hover?.kind === "dest" ? 1 : 0, R = DEST_R;
    const sprite = (this.destSprite ??= this.paintDest());
    // While the goal is open it breathes, slowly; reached, it holds steady and bright.
    const breath = d.reached ? 1 : 0.86 + 0.08 * Math.sin(this.clock * 1.3);
    ctx.globalAlpha = this.mapAlpha * Math.min(1, breath + 0.12 * hi);
    ctx.drawImage(sprite, d.x - R, d.y - R, R * 2, R * 2);
    if (hi) {
      ctx.strokeStyle = "rgba(210,190,255,0.45)"; ctx.lineWidth = this.px(1.2);
      ctx.beginPath(); ctx.arc(d.x, d.y, 44, 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // Why a gold slice is waiting on you, in a few words.
  private youWhy(sn: SNode) {
    const owner = sn.checks.filter((c) => c.open && c.kind === "owner");
    if (sn.state === "human") return "Waiting on you: needs a person";
    return owner.length === 1 ? `Waiting on you: check #${owner[0].num}` : `Waiting on you: ${owner.length} checks`;
  }

  // What a slice's label says under its number.
  private sliceStatus(sn: SNode) {
    const size = sn.size ? ` (${sn.size.toUpperCase()})` : "";
    return {
      you: this.youWhy(sn), stalled: `Stalled${size}`, ready: `Ready${size}`, building: `Building${size}`,
      blocked: "Blocked", built: "Built · checks open", dropped: "Dropped",
    }[sn.look];
  }

  // Slice labels, in screen space. The number once its planet is a fair size, with its status
  // when it's waiting on you or stalled; zoomed in (or in focus), the title, the status and
  // what it frees. The first step of the recommended path is always labelled while shown. They
  // yield to the tickets' labels already placed.
  private drawSliceLabels(a: number, placed: { x: number; y: number; w: number; h?: number }[], fs: number) {
    const ctx = this.ctx, s = this.cam.s, start = this.att.path[0];
    for (const sn of this.slices) {
      if (sn.dust || sn.vis < 0.6) continue;
      const focus = sn.emph > 0.5 || sn === this.selectedSlice || (this.labels && start?.kind === "slice" && start.num === sn.num);
      const loud = sn.look === "you" || sn.look === "stalled";
      if (!focus && (!this.labels || (!loud && s < 0.7))) continue;
      const full = focus || s >= 1.05, un = this.att.unlocks[sn.num] ?? 0;
      const p = this.w2s(sn), r = this.sliceR(sn) * s;
      const lx = p.x + r + 8, lh = fs + 3;
      const title = full ? "  " + (sn.title.length > 28 ? sn.title.slice(0, 27) + "…" : sn.title) : "";
      const lines: { text: string; col: string; font: string }[] = [];
      if (full || loud) lines.push({ text: this.sliceStatus(sn), col: statusCol(sn.look), font: `${(fs - 1.5).toFixed(1)}px` });
      if (full && un > 0) lines.push({ text: `unlocks ${un}`, col: "#9aa6bd", font: `${(fs - 1.5).toFixed(1)}px` });
      const num = `#${sn.num}`;
      ctx.font = `600 ${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      const nw = this.textW(num, fs - 0.5, true);
      ctx.font = `${(fs - 1).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      let w = nw + (title ? this.textW(title, fs - 1) : 0);
      for (const l of lines) w = Math.max(w, this.textW(l.text, parseFloat(l.font)));
      const h = lh * (1 + lines.length), ly = p.y - (h - lh) / 2;
      const hit = (q: { x: number; y: number; w: number; h?: number }) =>
        lx < q.x + q.w + 4 && lx + w + 4 > q.x && ly - lh / 2 < q.y - (q.h ?? lh) / 2 + (q.h ?? lh) && ly - lh / 2 + h > q.y - (q.h ?? lh) / 2;
      if (!focus && placed.some(hit)) continue;
      placed.push({ x: lx, y: ly - lh / 2 + h / 2, w, h });
      const al = a * sn.vis * (1 - 0.7 * sn.dim);
      ctx.font = `600 ${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA(sn.look === "dropped" ? "#8a8496" : "#e8edf6", al);
      ctx.fillText(num, lx, ly);
      if (title) {
        ctx.font = `${(fs - 1).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
        ctx.fillStyle = `rgba(222,228,240,${al.toFixed(3)})`;
        ctx.fillText(title, lx + nw, ly);
      }
      lines.forEach((l, i) => {
        ctx.font = `${l.font} ui-sans-serif,system-ui,sans-serif`;
        ctx.fillStyle = hexA(l.col, al);
        ctx.fillText(l.text, lx, ly + lh * (i + 1));
      });
    }
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
    for (const r of new Set(this.nodes.map(this.ring))) {
      if (r > 0) { ctx.beginPath(); ctx.arc(0, 0, r, 0, TAU); ctx.stroke(); }
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
      if (!this.labels && c.emph < 0.05) continue;
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
    // Off the chain an edge is a faint trace; on it, or hovered, it's drawn in full.
    const on = Math.max(fx.chain, fx.emph);
    ctx.globalAlpha = this.mapAlpha * searched * (1 - 0.8 * fx.dim) * (0.22 + 0.78 * on);
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

  // A ticket's body, by its form (see Body), in its status's colour. Open decisions and
  // prototypes keep their status rings; a fold-in's sun carries its build ring.
  private drawNode(n: Node) {
    const ctx = this.ctx, c = COL[n.status], x = n._x, y = n._y;
    if (!this.seen(x, y, this.coreR(n) * 6 + 60)) return;
    const en = n.enter ?? 1, fl = n.flare, hi = n.emph, near = n.rel;
    const isF = n.status === "frontier", isC = n.status === "claimed";
    const beat = 0.5 + 0.5 * Math.sin(this.clock * 2.8);
    const grow = 1 + 0.2 * hi, cr = this.coreR(n) * (0.4 + 0.6 * en) * grow;
    ctx.globalAlpha = this.mapAlpha * this.vis(n);
    if (n.body === "star") this.drawStar(n, x, y, cr, isF ? 0.8 + 0.2 * beat : 1);
    else if (n.body === "nebula") {
      // Concluded, it turns slowly where it drifted out to, each its own way.
      const settled = n.status === "resolved" || n.status === "out_of_scope";
      const drift = settled ? this.clock * 0.03 * (n.num % 2 ? 1 : -1) : 0;
      if (!this.drawTex("nebula", n.num, palette("nebula", n.status, n.num), x, y, cr * (settled ? 5.5 : 4.2), (settled ? 0.75 : 0.9) + 0.25 * hi, TAU, 0.12, drift)) this.drawCloud(this.nebulaSprite(n), x, y, cr * 3.8, 0.9 + 0.1 * hi);
    } else if (n.body === "nursery") {
      if (!this.drawTex("nursery", n.num, palette("nursery", n.status), x, y, cr * 3.8, 0.85 + 0.15 * hi, TAU)) this.drawCloud(this.nurserySprite(n.num), x, y, cr * 3.4, 0.85 + 0.15 * hi);
    }
    else if (n.body === "protostar") this.drawProtostar(n, x, y, cr);
    else this.drawSun(n, x, y, cr);
    if (fl > 0) {
      ctx.strokeStyle = hexA(c.core, fl * 0.7); ctx.lineWidth = 1.5 + 2 * fl;
      ctx.beginPath(); ctx.arc(x, y, cr + (1 - fl) * 40, 0, TAU); ctx.stroke();
    }
    // A neighbour of the hovered ticket: a soft ring in its own colour.
    if (near > 0.01) {
      ctx.strokeStyle = hexA(c.core, 0.45 * near); ctx.lineWidth = this.px(1.2);
      ctx.beginPath(); ctx.arc(x, y, cr + 6, 0, TAU); ctx.stroke();
    }
    // Painted bodies carry their status in their colour; only a decision's star is ringed.
    const ringed = n.body === "star";
    if (isF && ringed) {
      ctx.strokeStyle = hexA(c.glow, 0.28 + 0.15 * beat + 0.3 * hi); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, cr + 7 + 1.5 * beat, 0, TAU); ctx.stroke();
    }
    if (isC && ringed) {
      ctx.strokeStyle = hexA(c.core, 0.45 + 0.25 * beat); ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.arc(x, y, cr + 5 + 1.2 * beat, 0, TAU); ctx.stroke();
      ctx.strokeStyle = hexA(c.core, 0.18 + 0.14 * beat); ctx.lineWidth = 1;
      ctx.beginPath(); ctx.arc(x, y, cr + 11 + 1.8 * beat, 0, TAU); ctx.stroke();
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
    // A fold-in's build progress: a thin ring that fills green as its slices are built.
    const prog = this.progress(n), R = this.ringAt(n);
    if (prog) this.drawProgress(x, y, R, prog[0], prog[1]);
    // While its slices are folded away, pips say one is waiting on you (gold) or has stalled
    // (rust), so they show from the overview. A fixed size on screen.
    const kids = this.kids[n.num];
    if (kids) {
      const shown = Math.max(0, ...kids.map((k) => k.vis));
      const pips = [kids.some((k) => k.look === "you") && GOLD, kids.some((k) => k.look === "stalled") && LCOL.stalled].filter(Boolean) as string[];
      if (pips.length && shown < 0.95) {
        const k = 1 / this.ec.s, pr = 3.6 * k;
        ctx.globalAlpha = this.mapAlpha * this.vis(n) * (1 - shown);
        pips.forEach((pc, i) => {
          const t = -Math.PI / 4 + i * 0.5, px = x + Math.cos(t) * R, py = y + Math.sin(t) * R;
          ctx.fillStyle = hexA(pc, 0.35); ctx.beginPath(); ctx.arc(px, py, pr * 2, 0, TAU); ctx.fill();
          ctx.fillStyle = pc; ctx.beginPath(); ctx.arc(px, py, pr, 0, TAU); ctx.fill();
        });
        ctx.globalAlpha = this.mapAlpha * this.vis(n);
      }
    }
    // Selected: a thin white ring, outside the build ring when there is one.
    if (this.selected === n) {
      const S = prog ? R + this.px(5) : cr + 12;
      ctx.strokeStyle = "rgba(255,255,255,0.9)"; ctx.lineWidth = this.px(1.5);
      ctx.beginPath(); ctx.arc(x, y, S, 0, TAU); ctx.stroke();
      ctx.strokeStyle = "rgba(255,255,255,0.25)"; ctx.lineWidth = this.px(1);
      ctx.beginPath(); ctx.arc(x, y, S + this.px(6), 0, TAU); ctx.stroke();
    }
    ctx.globalAlpha = this.mapAlpha;
  }

  // A decision: a sharp star with four diffraction spikes in a soft glow. Open ones shine; a
  // resolved one is subdued, its spikes short.
  private drawStar(n: Node, x: number, y: number, cr: number, pulse: number) {
    const ctx = this.ctx, c = COL[n.status], en = n.enter ?? 1, fl = n.flare, hi = n.emph;
    const settled = n.status === "resolved" || n.status === "out_of_scope";
    const gr = c.gr * pulse * (0.55 + 0.45 * en) * (1 + fl * 0.5) * (1 + 0.45 * hi + 0.15 * n.rel);
    const g = ctx.createRadialGradient(x, y, 0, x, y, gr);
    g.addColorStop(0, hexA(c.glow, Math.min(1, (0.85 * pulse + fl * 0.5 + 0.15 * hi) * en)));
    g.addColorStop(0.35, hexA(c.glow, (0.26 * pulse + 0.14 * hi + 0.08 * n.rel) * en));
    g.addColorStop(1, hexA(c.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
    const len = cr * (settled ? 1.9 : 3.4) * (1 + 0.25 * hi), w = cr * 0.3, al = settled ? 0.5 : 0.95;
    for (let i = 0; i < 4; i++) {
      ctx.save(); ctx.translate(x, y); ctx.rotate((i * Math.PI) / 2);
      const sg = ctx.createLinearGradient(0, 0, len, 0);
      sg.addColorStop(0, hexA("#ffffff", al)); sg.addColorStop(0.35, hexA(c.core, al * 0.7)); sg.addColorStop(1, hexA(c.glow, 0));
      ctx.fillStyle = sg;
      ctx.beginPath(); ctx.moveTo(0, -w); ctx.quadraticCurveTo(len * 0.15, -w * 0.2, len, 0);
      ctx.quadraticCurveTo(len * 0.15, w * 0.2, 0, w); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
    const cg = ctx.createRadialGradient(x, y, 0, x, y, cr * 1.35);
    cg.addColorStop(0, "#ffffff"); cg.addColorStop(0.35, hexA(c.core, 1));
    cg.addColorStop(0.72, hexA(c.glow, settled ? 0.6 : 0.95)); cg.addColorStop(1, hexA(c.glow, 0));
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(x, y, cr * 1.35, 0, TAU); ctx.fill();
  }

  // A painted body, R world units in radius: which texture, its turn (within ±spin/2) and
  // whether it's mirrored all follow from the seed, so a ticket always looks the same. False
  // until the texture has loaded.
  private drawTex(kind: Kind, seed: number, p: Palette, x: number, y: number, R: number, al: number, spin: number, squash = 0.12, drift = 0) {
    const rnd = mulberry32(seed * 2654435 + kind.length * 977);
    const img = texture(kind, Math.floor(rnd() * 9973), p, 2 * R * this.ec.s * this.dpr);
    if (!img) return false;
    const ctx = this.ctx, a = ctx.globalAlpha, turn = (rnd() - 0.5) * spin + drift, flip = rnd() < 0.5 ? -1 : 1;
    ctx.save(); ctx.translate(x, y); ctx.rotate(turn); ctx.scale(flip, 1 - squash * rnd());
    ctx.globalAlpha = a * al;
    ctx.drawImage(img, -R, -R, R * 2, R * 2);
    ctx.restore();
    ctx.globalAlpha = a;
    return true;
  }

  // A cloud sprite (a nebula or a nursery), drawn R world units in radius.
  private drawCloud(sprite: HTMLCanvasElement, x: number, y: number, R: number, al: number) {
    const ctx = this.ctx, a = ctx.globalAlpha;
    ctx.globalAlpha = a * al;
    ctx.drawImage(sprite, x - R, y - R, R * 2, R * 2);
    ctx.globalAlpha = a;
  }

  // Seeded soft puffs in a sprite of radius 1 (scaled by k): the shared stuff of nebulae and
  // nurseries. Kept sparse, so a cloud reads as one body rather than texture.
  private paintPuffs(rnd: () => number, k: number, puffs: { col: string; n: number; al: number; spread: number; size: [number, number] }[]) {
    const c = document.createElement("canvas");
    c.width = c.height = Math.ceil(2 * k);
    const ctx = c.getContext("2d")!;
    ctx.translate(k, k);
    ctx.globalCompositeOperation = "lighter";
    for (const p of puffs) {
      for (let i = 0; i < p.n; i++) {
        const t = rnd() * TAU, d = Math.sqrt(rnd()) * p.spread * k, r = (p.size[0] + rnd() * (p.size[1] - p.size[0])) * k;
        const px = Math.cos(t) * d, py = Math.sin(t) * d * 0.8;
        const g = ctx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, hexA(p.col, p.al)); g.addColorStop(0.5, hexA(p.col, p.al * 0.4)); g.addColorStop(1, hexA(p.col, 0));
        ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
      }
    }
    return { c, ctx };
  }

  // Research: an irregular cloud with no central body, a few brighter knots for the threads of
  // inquiry in it, in its status's colour over violet. Concluded, it contracts and fades. Painted
  // once per ticket and status.
  private nebulaSprite(n: Node) {
    const key = `n${n.num}:${n.status}`, hit = this.bodySprites.get(key);
    if (hit) return hit;
    const settled = n.status === "resolved" || n.status === "out_of_scope", col = COL[n.status].glow;
    const rnd = mulberry32(n.num * 7919 + 3), k = 48, s = settled ? 0.8 : 1;
    const { c, ctx } = this.paintPuffs(rnd, k, [
      { col: "#7a5cff", n: 3, al: settled ? 0.26 : 0.3, spread: 0.45 * s, size: [0.35 * s, 0.55 * s] },
      { col, n: 4, al: settled ? 0.24 : 0.34, spread: 0.4 * s, size: [0.22 * s, 0.4 * s] },
    ]);
    const knots = settled ? 1 : 3;
    for (let i = 0; i < knots; i++) {
      const t = rnd() * TAU, d = rnd() * 0.3 * k * s, px = Math.cos(t) * d, py = Math.sin(t) * d * 0.8, r = 0.09 * k;
      const g = ctx.createRadialGradient(px, py, 0, px, py, r);
      g.addColorStop(0, `rgba(255,255,255,${settled ? 0.55 : 0.85})`); g.addColorStop(0.4, hexA(col, 0.4)); g.addColorStop(1, hexA(col, 0));
      ctx.fillStyle = g; ctx.beginPath(); ctx.arc(px, py, r, 0, TAU); ctx.fill();
    }
    this.bodySprites.set(key, c);
    return c;
  }

  // A spec still forming (a fold-in not yet completed, or a map with none): a stellar nursery,
  // warm gas gathering on a glowing centre that isn't a sun yet. Painted once per seed.
  private nurserySprite(seed: number) {
    const key = `f${seed}`, hit = this.bodySprites.get(key);
    if (hit) return hit;
    const rnd = mulberry32(seed * 104729 + 11), k = 56;
    const { c, ctx } = this.paintPuffs(rnd, k, [
      { col: "#8a5cff", n: 3, al: 0.14, spread: 0.5, size: [0.35, 0.55] },
      { col: "#ff8a3d", n: 4, al: 0.18, spread: 0.35, size: [0.2, 0.4] },
      { col: "#ffc65a", n: 3, al: 0.2, spread: 0.18, size: [0.15, 0.28] },
    ]);
    const g = ctx.createRadialGradient(0, 0, 0, 0, 0, 0.16 * k);
    g.addColorStop(0, "rgba(255,248,225,0.95)"); g.addColorStop(0.35, "rgba(255,200,110,0.55)"); g.addColorStop(1, "rgba(255,150,60,0)");
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(0, 0, 0.16 * k, 0, TAU); ctx.fill();
    this.bodySprites.set(key, c);
    return c;
  }

  // A prototype: a small bright core in an uneven, tilted accretion disk, thicker on one side.
  private drawProtostar(n: Node, x: number, y: number, cr: number) {
    const ctx = this.ctx, c = COL[n.status], settled = n.status === "resolved" || n.status === "out_of_scope";
    if (this.drawTex("protostar", n.num, palette("protostar", n.status), x, y, cr * 5, 1, 1.1, 0)) {
      const cg = ctx.createRadialGradient(x, y, 0, x, y, cr * 0.9);
      cg.addColorStop(0, "#ffffff"); cg.addColorStop(0.5, hexA(c.core, settled ? 0.6 : 0.95)); cg.addColorStop(1, hexA(c.glow, 0));
      ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(x, y, cr * 0.9, 0, TAU); ctx.fill();
      return;
    }
    const g = ctx.createRadialGradient(x, y, 0, x, y, cr * 3.2);
    g.addColorStop(0, hexA(c.glow, settled ? 0.35 : 0.6)); g.addColorStop(1, hexA(c.glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, cr * 3.2, 0, TAU); ctx.fill();
    const tilt = -0.42 + (n.num % 5) * 0.08, rx = cr * 2.5, ry = cr * 0.75;
    for (let i = 0; i < 3; i++) {
      ctx.strokeStyle = hexA(i === 1 ? "#ffd9a8" : c.core, (settled ? 0.3 : 0.55) * (1 - i * 0.25));
      ctx.lineWidth = cr * (0.5 - i * 0.12);
      const a0 = -0.6 + i * 0.9;
      ctx.beginPath(); ctx.ellipse(x, y, rx * (1 + i * 0.12), ry * (1 + i * 0.12), tilt, a0, a0 + TAU * (0.55 - i * 0.12)); ctx.stroke();
    }
    ctx.strokeStyle = hexA(c.core, settled ? 0.15 : 0.25); ctx.lineWidth = this.px(0.8);
    ctx.beginPath(); ctx.ellipse(x, y, rx, ry, tilt, 0, TAU); ctx.stroke();
    const cg = ctx.createRadialGradient(x, y, 0, x, y, cr);
    cg.addColorStop(0, "#ffffff"); cg.addColorStop(0.45, hexA(c.core, 1)); cg.addColorStop(1, hexA(c.glow, 0));
    ctx.fillStyle = cg; ctx.beginPath(); ctx.arc(x, y, cr, 0, TAU); ctx.fill();
  }

  // A folded fold-in: a stable golden sun, a defined photosphere darkening at the limb in a soft
  // corona, brighter once every slice is built. Ruled out, it's a cold grey.
  private drawSun(n: Node, x: number, y: number, cr: number) {
    const ctx = this.ctx, prog = this.progress(n), done = !!prog && prog[0] === prog[1];
    const cold = n.status === "out_of_scope";
    const [hot, mid, rim, glow] = cold ? ["#e8e6ee", "#9a96a8", "#5a5666", "#6f6a7c"] : ["#fff8dc", "#ffcf4d", "#e08a1a", "#ffb030"];
    const gr = cr * (done ? 3.8 : 3.3), g = ctx.createRadialGradient(x, y, cr * 0.8, x, y, gr);
    g.addColorStop(0, hexA(glow, done ? 0.5 : 0.4)); g.addColorStop(0.4, hexA(glow, 0.14)); g.addColorStop(1, hexA(glow, 0));
    ctx.fillStyle = g; ctx.beginPath(); ctx.arc(x, y, gr, 0, TAU); ctx.fill();
    // Painted, the corona texture is the whole sun, its own disc the photosphere.
    if (this.drawTex("corona", n.num, palette("corona", n.status), x, y, cr * 2.6, done ? 1 : 0.9, TAU, 0)) return;
    const sg = ctx.createRadialGradient(x - cr * 0.2, y - cr * 0.2, 0, x, y, cr);
    sg.addColorStop(0, hot); sg.addColorStop(0.55, mid); sg.addColorStop(1, rim);
    ctx.fillStyle = sg; ctx.beginPath(); ctx.arc(x, y, cr, 0, TAU); ctx.fill();
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
      if (!this.seen(f.x, f.y, FOG_R * 1.2)) continue;
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
  // A label's width at px pixels: measured once at 100px and scaled, since the font size follows
  // the zoom and would otherwise be measured afresh every frame of it.
  private textW(text: string, px: number, bold = false) {
    const key = (bold ? "b" : "") + text;
    let w = this.widths.get(key);
    if (w == null) {
      const ctx = this.ctx, font = ctx.font;
      ctx.font = `${bold ? "600 " : ""}100px ui-sans-serif,system-ui,sans-serif`;
      w = ctx.measureText(text).width / 100;
      ctx.font = font;
      this.widths.set(key, w);
    }
    return w * px;
  }

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
    if (this.core && (this.labels || this.hover?.kind === "nursery")) {
      const p = this.w2s(this.core);
      ctx.textAlign = "center";
      ctx.font = `600 ${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA("#ffd9a8", a * 0.85);
      ctx.fillText("Spec forming", p.x, p.y + 60 * s + 10);
      ctx.font = `${(fs - 1.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA("#b9a99a", a * 0.85);
      ctx.fillText("no fold-in yet", p.x, p.y + 60 * s + 10 + fs + 2);
      ctx.textAlign = "left";
      const w = 90;
      placed.push({ x: p.x - w / 2, y: p.y + 60 * s + 10, w }, { x: p.x - w / 2, y: p.y + 60 * s + 12 + fs, w });
    }
    const start = this.att.path[0];
    const focus = (n: Node) => n.emph > 0.5 || n === this.selected || (this.labels && start?.kind === "ticket" && start.num === n.num);
    const order = [...this.nodes].sort((p, q) => Number(focus(q)) - Number(focus(p)) || q.rel - p.rel);
    for (const n of order) {
      const f = focus(n);
      if (!this.labels && !f) continue;
      if (sparse && !f && n.rel < 0.5 && (n.status === "resolved" || n.status === "out_of_scope")) continue;
      const p = this.w2s(n), num = String(n.num);
      const title = titles || f ? (n.title.length > 40 ? n.title.slice(0, 39) + "…" : n.title) : "";
      ctx.font = `600 ${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      const nw = this.textW(num, fs, true);
      ctx.font = `${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      const tw = title ? this.textW("  " + title, fs - 0.5) : 0;
      const w = nw + tw, off = this.progress(n) ? this.ringAt(n) * s + 8 : this.radius(n) * s + 9;
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
      // A fold-in carries its slice count: built of defined.
      const prog = this.progress(n);
      if (prog && !title) {
        ctx.font = `600 ${(fs - 1.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
        ctx.fillStyle = hexA(LCOL.ready, al);
        ctx.fillText(`  ${prog[0]}/${prog[1]}`, lx + nw, fy);
      }
      if (title) {
        ctx.font = `${(fs - 0.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
        ctx.fillStyle = `rgba(214,220,232,${(al * (f ? 1 : 0.8)).toFixed(3)})`;
        ctx.fillText("  " + title, lx + nw, fy);
        // An open ticket says what deciding it frees.
        const un = this.att.unlocks[n.num] ?? 0;
        if (un > 0 && n.status !== "resolved" && n.status !== "out_of_scope") {
          ctx.font = `${(fs - 1.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
          ctx.fillStyle = hexA("#9aa6bd", al);
          ctx.fillText(`unlocks ${un}`, lx, fy + h);
          placed.push({ x: lx, y: fy + h, w: nw + 40 });
        }
      }
    }
    if (this.hub && this.labels) {
      const p = this.w2s(this.hub), loose = this.slices.filter((sn) => sn.parent == null && sn.state !== "dropped");
      const lx = p.x + (this.hub.r + 16) * s, ly = p.y + (this.hub.r + 16) * s * 0.55;
      ctx.font = `600 ${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA("#dfe6f2", a);
      ctx.fillText("Build", lx, ly);
      const bw = ctx.measureText("Build").width;
      ctx.font = `600 ${(fs - 1.5).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA(LCOL.ready, a);
      ctx.fillText(`  ${loose.filter((sn) => sn.state === "built").length}/${loose.length}`, lx + bw, ly);
      placed.push({ x: lx, y: ly, w: bw + 40 });
    }
    this.drawSliceLabels(a, placed, fs);
    if (this.dest && (this.labels || this.hover?.kind === "dest")) {
      // In the lower right quadrant, between the spikes.
      const p = this.w2s(this.dest), lx = p.x + 30 * s + 8, ty = p.y + 26 * s + 6, lh = fs + 4;
      ctx.font = `600 ${(fs + 2).toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA("#f1ebff", a);
      ctx.fillText("Destination", lx, ty);
      let row = 1;
      if (this.dest.reached) {
        ctx.font = `600 ${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
        ctx.fillStyle = hexA("#9fd0ff", a);
        ctx.fillText("Reached", lx, ty + lh);
        row = 2;
      }
      ctx.font = `${fs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.fillStyle = hexA("#d4cbe8", a);
      this.wrap(this.dest.text, 38).forEach((l, i) => ctx.fillText(l, lx, ty + (i + row) * lh));
    }
    if (s >= 0.32 && this.fogPts.length) {
      const ffs = clamp(12 * Math.pow(s, 0.3), 9, 13.5);
      ctx.font = `italic ${ffs.toFixed(1)}px ui-sans-serif,system-ui,sans-serif`;
      ctx.textAlign = "center";
      for (const f of this.fogPts) {
        if (!this.labels && f.emph < 0.05) continue;
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
    const extra = [...this.fogPts, ...(this.dest ? [this.dest] : []), ...(this.hub ? [{ x: this.hub._x, y: this.hub._y }] : [])];
    for (const f of extra) { minx = Math.min(minx, f.x); miny = Math.min(miny, f.y); maxx = Math.max(maxx, f.x); maxy = Math.max(maxy, f.y); }
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
    for (const sn of this.slices) {
      if (sn.dust || (sn.parent != null && sn.look !== "you" && sn.look !== "stalled")) continue;
      ctx.fillStyle = LCOL[sn.look];
      ctx.beginPath(); ctx.arc(sn._x * s + ox, sn._y * s + oy, sn.look === "you" ? 2.4 : 1.5, 0, TAU); ctx.fill();
    }
    const path = this.pathPoints();
    if (path.length > 1) {
      ctx.strokeStyle = hexA(GOLD, 0.85); ctx.lineWidth = 1.2;
      ctx.beginPath(); path.forEach((p, i) => (i ? ctx.lineTo : ctx.moveTo).call(ctx, p.x * s + ox, p.y * s + oy)); ctx.stroke();
    }
    if (this.dest) {
      ctx.fillStyle = "#e6d8ff"; ctx.beginPath(); ctx.arc(this.dest.x * s + ox, this.dest.y * s + oy, 2.6, 0, TAU); ctx.fill();
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
    const W = innerWidth, H = innerHeight, ctx = this.ctx, t = performance.now();
    const settling = this.fade.on || Math.abs(this.goal.s - this.cam.s) > 1e-3 * this.goal.s
      || Math.abs(this.goal.x - this.cam.x) > 0.3 || Math.abs(this.goal.y - this.cam.y) > 0.3;
    if (!settling && t - this.lastInput > 1500 && t - this.lastDraw < 32) {
      this.raf = requestAnimationFrame(this.render);
      return;
    }
    this.lastDraw = t;
    textureBudget(2);
    const now = (t - this.t0) / 1000;
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
    for (const sn of this.slices) {
      const p = sn.parent != null ? this.byNum[sn.parent] : this.hub;
      sn._x = (p?._x ?? 0) + sn.ox;
      sn._y = (p?._y ?? 0) + sn.oy;
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
    this.view = { x0: -this.ec.x / this.ec.s, y0: -this.ec.y / this.ec.s, x1: (W - this.ec.x) / this.ec.s, y1: (H - this.ec.y) / this.ec.s };
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    this.drawStars(W, H);
    ctx.save();
    ctx.globalAlpha = this.mapAlpha;
    ctx.translate(this.ec.x, this.ec.y); ctx.scale(this.ec.s, this.ec.s);
    this.drawClusters();
    this.drawFog();
    this.drawCore();
    this.drawDest();
    // Whatever the hover touches draws last, over its neighbours.
    const up = (i: number) => this.edgeFx[i].emph > 0.01;
    this.edges.forEach((e, i) => { if (!up(i)) this.drawEdge(e, i); });
    const raised = (n: Node) => n.emph > 0.01 || n.rel > 0.01;
    this.nodes.forEach((n) => { if (!raised(n)) this.drawNode(n); });
    this.edges.forEach((e, i) => { if (up(i)) this.drawEdge(e, i); });
    this.drawPath();
    this.nodes.forEach((n) => { if (raised(n)) this.drawNode(n); });
    // Slices sit over the stars: finished work's dust, the hub, the orbits, their blocking
    // edges, then the planets.
    this.drawDust();
    this.drawHub();
    this.drawOrbitsOfSlices();
    this.sliceEdges.forEach((e) => this.drawSliceEdge(e));
    this.slices.forEach((sn) => { if (sn.emph < 0.01) this.drawSlice(sn); });
    this.slices.forEach((sn) => { if (sn.emph >= 0.01) this.drawSlice(sn); });
    ctx.restore();
    this.drawClusterNames(this.mapAlpha);
    this.drawLabels(this.mapAlpha);
    this.drawMinimap();
    this.placeTip();
    this.raf = requestAnimationFrame(this.render);
  };
}
