import { describe, expect, it } from "vitest";
import { layout, mulberry32, ringR } from "./engine";

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

describe("mulberry32", () => {
  it("is a repeatable sequence in [0, 1)", () => {
    const a = mulberry32(7), b = mulberry32(7);
    const xs = Array.from({ length: 5 }, a);
    expect(xs).toEqual(Array.from({ length: 5 }, b));
    xs.forEach((x) => expect(x >= 0 && x < 1).toBe(true));
  });
});
