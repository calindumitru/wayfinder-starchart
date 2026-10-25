import { describe, expect, it } from "vitest";
import { attention, collapsed, look, recent } from "./attention";
import type { BuildSlice, Ticket, WayMap } from "./types";

const NOW = Date.parse("2026-10-25T12:00:00Z");
const ago = (days: number) => new Date(NOW - days * 86_400_000).toISOString();

const slice = (num: number, over: Partial<BuildSlice> = {}): BuildSlice => ({
  num, title: `Slice ${num}`, url: "", body: "", parent: 10, state: "ready", size: "m", escalate: false,
  assignee: null, blockers: [], pr: null, shipped: null, checks: [], active: ago(0), closedAt: null, ...over,
});
const waits = (...nums: number[]) => nums.map((num) => ({ num, title: "", open: true }));
const ticket = (num: number, status: Ticket["status"], over: Partial<Ticket> = {}): Ticket => ({
  num, title: `T${num}`, type: "decision", status, url: "", body: "", answer: null, gist: null, assignee: null,
  staleClaim: false, blockers: [], outsideBlockers: [], rank: 0, slices: null, ...over,
});
const map = (tickets: Ticket[], slices: BuildSlice[], edges: WayMap["edges"] = []): WayMap => ({
  num: 1, name: "M", url: "", open: true, destination: "", notes: "", fog: [], tickets, edges, slices, checks: [],
  counts: { total: 0, resolved: 0, outOfScope: 0, claimed: 0, frontier: 0, blocked: 0 },
});
const owner = { num: 99, title: "", url: "", kind: "owner", open: true, due: null, slice: 1, parent: 10 };

describe("look", () => {
  it("is waiting on you for a human slice or an open owner check", () => {
    expect(look(slice(1, { state: "human" }), NOW)).toBe("you");
    expect(look(slice(1, { state: "built", checks: [owner] }), NOW)).toBe("you");
  });

  it("is stalled once a slice being built goes quiet for three days", () => {
    expect(look(slice(1, { state: "building", active: ago(2) }), NOW)).toBe("building");
    expect(look(slice(1, { state: "building", active: ago(4) }), NOW)).toBe("stalled");
    expect(look(slice(1, { state: "ready", active: ago(30) }), NOW)).toBe("ready");
  });

  it("glows for two days after a slice is built, and collapses once nothing is open on it", () => {
    expect(recent(slice(1, { state: "built", closedAt: ago(1) }), NOW)).toBe(true);
    expect(recent(slice(1, { state: "built", closedAt: ago(3) }), NOW)).toBe(false);
    expect(collapsed(slice(1, { state: "built" }))).toBe(true);
    expect(collapsed(slice(1, { state: "built", checks: [owner] }))).toBe(false);
  });
});

describe("attention", () => {
  // 1 → 2 → 3 within fold-in 10; 4 stands alone. Fold-in 10 frees ticket 11.
  const m = () => map(
    [ticket(10, "resolved", { slices: { total: 4, closed: 0 } }), ticket(11, "blocked"), ticket(12, "frontier")],
    [slice(1), slice(2, { blockers: waits(1) }), slice(3, { blockers: waits(2) }), slice(4)],
    [{ from: 10, to: 11, satisfied: true }],
  );

  it("counts what each item frees, further down included", () => {
    const a = attention(m(), NOW);
    expect(a.unlocks[1]).toBe(2);
    expect(a.unlocks[2]).toBe(1);
    expect(a.unlocks[4]).toBe(0);
    expect(a.unlocks[10]).toBe(1);
  });

  it("runs from the item that frees the most, through its fold-in, to the destination", () => {
    expect(attention(m(), NOW).path).toEqual([
      { kind: "slice", num: 1 }, { kind: "slice", num: 2 }, { kind: "slice", num: 3 },
      { kind: "ticket", num: 10 }, { kind: "ticket", num: 11 }, { kind: "dest", num: 1 },
    ]);
  });

  it("starts with what's waiting on you", () => {
    const x = m();
    x.slices[3].state = "human";
    expect(attention(x, NOW).path[0]).toEqual({ kind: "slice", num: 4 });
  });

  it("counts open slices not yet loaded among what's open", () => {
    const x = map([ticket(10, "resolved", { slices: { total: 5, closed: 2 } }), ticket(11, "frontier")], []);
    expect(attention(x, NOW).open).toEqual({ decisions: 1, slices: 3 });
  });
});
