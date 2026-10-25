// What on a map wants attention, and where acting on it leads. Pure, so it's testable without a
// canvas: the engine draws from it.
//
// A slice's look is its state, sharpened: one that needs a person (labelled ready-for-human, or
// with an open owner check) is waiting on you, and one being built that nothing has touched for
// STALL_DAYS is stalled. An item's impact is how many open items are waiting on it, directly or
// further down. The recommended path starts at the item worth doing first (waiting on you, then
// whatever frees the most) and follows what it frees, out through its fold-in, to the
// destination.

import type { BuildSlice, Ticket, WayMap } from "./types";

export type Look = "you" | "stalled" | "ready" | "building" | "blocked" | "built" | "dropped";
export type Step = { kind: "slice" | "ticket" | "dest"; num: number };

export const STALL_DAYS = 3;
export const GLOW_HOURS = 48;
const DAY = 86_400_000;

const done = (s: BuildSlice) => s.state === "built" || s.state === "dropped";
const openTicket = (t: Ticket) => t.status !== "resolved" && t.status !== "out_of_scope";

export function look(s: BuildSlice, now: number): Look {
  if (s.state === "human" || s.checks.some((c) => c.open && c.kind === "owner")) return "you";
  if (s.state === "building" && s.active && now - Date.parse(s.active) > STALL_DAYS * DAY) return "stalled";
  return s.state;
}

// Whole days since anything happened on it.
export const daysQuiet = (s: BuildSlice, now: number) => (s.active ? Math.floor((now - Date.parse(s.active)) / DAY) : 0);

// Built in the last GLOW_HOURS.
export const recent = (s: BuildSlice, now: number) =>
  s.state === "built" && !!s.closedAt && now - Date.parse(s.closedAt) < GLOW_HOURS * 3_600_000;

// Done with, so it folds into its fold-in's ring of finished work: closed, with no open check.
export const collapsed = (s: BuildSlice) => done(s) && !s.checks.some((c) => c.open);

// How many distinct open items sit downstream of each one, given who each waits on.
function downstream(nums: number[], waitsOn: (n: number) => number[], open: (n: number) => boolean) {
  const freed: Record<number, number[]> = {};
  for (const n of nums) for (const b of waitsOn(n)) (freed[b] ??= []).push(n);
  const out: Record<number, number> = {};
  for (const n of nums) {
    const seen = new Set<number>(), stack = [...(freed[n] ?? [])];
    while (stack.length) {
      const m = stack.pop()!;
      if (seen.has(m) || m === n) continue;
      seen.add(m);
      stack.push(...(freed[m] ?? []));
    }
    out[n] = [...seen].filter(open).length;
  }
  return { out, freed };
}

export type Attention = {
  looks: Record<number, Look>;
  // Open items freed, directly or further down, by each slice and each ticket.
  unlocks: Record<number, number>;
  path: Step[];
  // What's still open on the map: decisions (tickets not resolved or ruled out) and build slices
  // (neither built nor dropped; a fold-in's not yet loaded counted from its sub-issue count).
  open: { decisions: number; slices: number };
  // The time it was worked out at.
  now: number;
};

export function attention(m: WayMap, now: number): Attention {
  const slices = m.slices, byNum = new Map(slices.map((s) => [s.num, s]));
  const looks: Record<number, Look> = {};
  for (const s of slices) looks[s.num] = look(s, now);
  const sd = downstream(
    slices.map((s) => s.num),
    (n) => byNum.get(n)!.blockers.filter((b) => byNum.has(b.num)).map((b) => b.num),
    (n) => !done(byNum.get(n)!),
  );
  const tickets = new Map(m.tickets.map((t) => [t.num, t]));
  const into: Record<number, number[]> = {};
  for (const e of m.edges) if (tickets.has(e.from) && tickets.has(e.to)) (into[e.to] ??= []).push(e.from);
  const td = downstream(m.tickets.map((t) => t.num), (n) => into[n] ?? [], (n) => openTicket(tickets.get(n)!));
  const unlocks = { ...td.out, ...sd.out };

  // The first step: waiting on you before anything else, then whatever frees the most, slices
  // before tickets at a tie (they're nearer to shipping).
  const cands: { step: Step; score: number }[] = [
    ...slices.filter((s) => looks[s.num] === "you" || looks[s.num] === "ready")
      .map((s) => ({ step: { kind: "slice", num: s.num } as Step, score: (looks[s.num] === "you" ? 1e6 : 0) + unlocks[s.num] + 0.5 })),
    ...m.tickets.filter((t) => t.status === "frontier").map((t) => ({ step: { kind: "ticket", num: t.num } as Step, score: unlocks[t.num] })),
  ].sort((a, b) => b.score - a.score || a.step.num - b.step.num);
  const path: Step[] = [];
  if (cands.length) {
    const seen = new Set<number>();
    let cur: Step | null = cands[0].step;
    const best = (nums: number[]) => nums.sort((a, b) => unlocks[b] - unlocks[a] || a - b)[0];
    while (cur && cur.kind !== "dest" && !seen.has(cur.num)) {
      seen.add(cur.num);
      path.push(cur);
      if (cur.kind === "slice") {
        const s: BuildSlice = byNum.get(cur.num)!;
        const next: number | undefined = best((sd.freed[cur.num] ?? []).filter((n) => !done(byNum.get(n)!) && !seen.has(n)));
        cur = next != null ? { kind: "slice", num: next }
          : s.parent != null && tickets.has(s.parent) ? { kind: "ticket", num: s.parent } : null;
      } else {
        const next: number | undefined = best((td.freed[cur.num] ?? []).filter((n) => openTicket(tickets.get(n)!) && !seen.has(n)));
        cur = next != null ? { kind: "ticket", num: next } : null;
      }
    }
    path.push({ kind: "dest", num: m.num });
  }

  const loaded = new Set(slices.map((s) => s.parent));
  const openSlices = slices.filter((s) => !done(s)).length
    + m.tickets.filter((t) => t.slices && !loaded.has(t.num)).reduce((a, t) => a + t.slices!.total - t.slices!.closed, 0);
  return { looks, unlocks, path, open: { decisions: m.tickets.filter(openTicket).length, slices: openSlices }, now };
}
