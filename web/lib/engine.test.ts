import { describe, expect, it } from "vitest";
import type { Attention } from "./attention";
import { criticalChain, findClusters, gather, layout, mulberry32, rests, ringR } from "./engine";
import type { Ticket, WayMap } from "./types";

const nodes = () => [
  { num: 2, rank: 0, x: 0, y: 0 },
  { num: 3, rank: 1, x: 0, y: 0 },
  { num: 4, rank: 2, x: 0, y: 0 },
  { num: 5, rank: 0, x: 0, y: 0 },
];
const edges = [
  { from: 2, to: 3, satisfied: true },
  { from: 3, to: 4, satisfied: false },
];

describe("layout", () => {
  it("lays the same map out the same way every time", () => {
    const a = nodes(), b = nodes();
    layout(a, edges);
    layout(b, edges);
    expect(a).toEqual(b);
  });

  it("keeps deeper tickets further out than roots", () => {
    const n = nodes();
    layout(n, edges);
    const r = (num: number) => { const p = n.find((x) => x.num === num)!; return Math.hypot(p.x, p.y); };
    expect(r(2)).toBeLessThan(r(3));
    expect(r(3)).toBeLessThan(r(4));
    expect(Math.abs(r(4) - ringR(2))).toBeLessThan(125);
  });
});

// Two hubs, 1 and 10, each blocking four tickets, plus a lone pair.
const hubby = () => {
  const nodes = [1, 2, 3, 4, 5, 10, 11, 12, 13, 14, 20, 21].map((num) => ({ num, rank: num % 10 ? 1 : 0, x: 0, y: 0 }));
  const edges = [2, 3, 4, 5].map((to) => ({ from: 1, to, satisfied: true }))
    .concat([11, 12, 13, 14].map((to) => ({ from: 10, to, satisfied: false })))
    .concat([{ from: 20, to: 21, satisfied: true }]);
  return { nodes, edges };
};

describe("clusters", () => {
  it("are a hub and the neighbours it owns", () => {
    const { nodes, edges } = hubby();
    expect(findClusters(nodes, edges)).toEqual([
      { hub: 1, members: [1, 2, 3, 4, 5] },
      { hub: 10, members: [10, 11, 12, 13, 14] },
    ]);
  });

  it("gather into separate rings that keep strays out", () => {
    const { nodes, edges } = hubby();
    layout(nodes, edges);
    gather(nodes, edges);
    const at = (num: number) => nodes.find((n) => n.num === num)!;
    const d = (a: number, b: number) => Math.hypot(at(a).x - at(b).x, at(a).y - at(b).y);
    for (const m of [2, 3, 4, 5]) expect(d(1, m)).toBeLessThanOrEqual(120);
    for (const m of [11, 12, 13, 14]) expect(d(10, m)).toBeLessThanOrEqual(120);
    expect(d(1, 10)).toBeGreaterThan(2 * 120);
    for (const s of [20, 21]) { expect(d(1, s)).toBeGreaterThan(120); expect(d(10, s)).toBeGreaterThan(120); }
  });
});

describe("mulberry32", () => {
  it("is a repeatable sequence in [0, 1)", () => {
    const a = mulberry32(7), b = mulberry32(7);
    const xs = Array.from({ length: 5 }, a);
    expect(xs).toEqual(Array.from({ length: 5 }, b));
    xs.forEach((x) => expect(x >= 0 && x < 1).toBe(true));
  });
});

const t = (num: number, status: Ticket["status"], more: Partial<Ticket> = {}): Ticket => ({
  num, title: "", type: "grilling", status, url: "", body: "", answer: null, gist: null, assignee: null,
  staleClaim: false, blockers: [], outsideBlockers: [], rank: 0, slices: null, ...more,
});

describe("criticalChain", () => {
  const att = (path: Attention["path"] = []): Attention => ({ looks: {}, unlocks: {}, path, open: { decisions: 0, slices: 0 }, now: 0 });
  const m = (tickets: Ticket[], es: [number, number][]) =>
    ({ tickets, edges: es.map(([from, to]) => ({ from, to, satisfied: false })) }) as unknown as WayMap;

  it("follows the longest run of open dependencies, not the history behind them", () => {
    // 1 (resolved) → 2 → 3 → 4 is the long run among open ones; 2 → 5 is a short branch.
    const map = m([t(1, "resolved"), t(2, "frontier"), t(3, "blocked"), t(4, "blocked"), t(5, "blocked")], [[1, 2], [2, 3], [3, 4], [2, 5]]);
    expect([...criticalChain(map, att())].sort()).toEqual([1, 2]);
  });

  it("adds the links the suggested path follows", () => {
    const map = m([t(2, "frontier"), t(3, "blocked"), t(4, "frontier"), t(5, "blocked")], [[2, 3], [4, 5]]);
    const chain = criticalChain(map, att([{ kind: "ticket", num: 4 }, { kind: "ticket", num: 5 }, { kind: "dest", num: 1 }]));
    expect(chain.has(1)).toBe(true);
  });
});

describe("rests", () => {
  const m = (tickets: Ticket[]) => ({ tickets, edges: [] }) as unknown as WayMap;

  it("puts the completed fold-in at the centre and steps the rings out for it", () => {
    const fold = (num: number, status: Ticket["status"]) => t(num, status, { type: "task", title: "Fold the spec" });
    const r = rests(m([fold(7, "frontier"), fold(8, "resolved"), t(2, "frontier", { rank: 1 })]));
    expect(r.centre).toBe(8);
    expect(r.ring({ num: 8, rank: 0 })).toBe(0);
    expect(r.ring({ num: 2, rank: 1 })).toBeGreaterThan(ringR(1));
  });

  it("sends concluded research out past the rings, and keeps open research in", () => {
    const r = rests(m([t(2, "frontier", { rank: 2 }), t(3, "resolved", { type: "research" }), t(4, "frontier", { type: "research" })]));
    expect(r.centre).toBeNull();
    expect(r.ring({ num: 3, rank: 0 })).toBeGreaterThan(ringR(2));
    expect(r.ring({ num: 4, rank: 0 })).toBe(ringR(0));
  });
});
