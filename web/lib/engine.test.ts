import { describe, expect, it } from "vitest";
import { findClusters, gather, layout, mulberry32, ringR } from "./engine";

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
    expect(Math.abs(r(4) - ringR(2))).toBeLessThan(165);
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
