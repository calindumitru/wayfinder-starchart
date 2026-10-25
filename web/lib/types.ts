// The shapes the Rust server answers with (server/src/model.rs, github.rs, t3.rs).

export type Status = "resolved" | "out_of_scope" | "claimed" | "frontier" | "blocked";

export type Ticket = {
  num: number;
  title: string;
  type: string;
  status: Status;
  url: string;
  body: string;
  answer: string | null;
  gist: string | null;
  assignee: string | null;
  staleClaim: boolean;
  blockers: number[];
  outsideBlockers: { num: number; title: string; open: boolean }[];
  rank: number;
  // Its build slices, counted; the slices themselves load when it's opened.
  slices: { total: number; closed: number } | null;
};

export type Edge = { from: number; to: number; satisfied: boolean };
export type Fog = { title: string; text: string; clearsWith: number | null };

export type WayMap = {
  num: number;
  name: string;
  url: string;
  open: boolean;
  destination: string;
  notes: string;
  fog: Fog[];
  tickets: Ticket[];
  edges: Edge[];
  counts: { total: number; resolved: number; outOfScope: number; claimed: number; frontier: number; blocked: number };
  // The slices on the map itself, plus (in the app) those of the tickets opened so far.
  slices: BuildSlice[];
  // The open checks written from this map's slices.
  checks: MapCheck[];
};

// A build slice (server/src/model.rs): a sub-issue of a map ticket (a fold-in's, usually), or a
// build-labelled issue on the map itself (no parent).
export type SliceState = "ready" | "blocked" | "building" | "human" | "built" | "dropped";
export type PrRef = { num: number; url: string; merged: boolean };
export type MapCheck = {
  num: number;
  title: string;
  url: string;
  kind: string;
  open: boolean;
  due: string | null;
  // The slice it was written from, and that slice's parent (a ticket, or the map).
  slice: number | null;
  parent: number | null;
};
export type BuildSlice = {
  num: number;
  title: string;
  url: string;
  body: string;
  parent: number | null;
  state: SliceState;
  size: string | null;
  escalate: boolean;
  assignee: string | null;
  blockers: { num: number; title: string; open: boolean }[];
  pr: PrRef | null;
  shipped: PrRef | null;
  checks: MapCheck[];
  // When anything last happened on it (the issue, or the open PR building it), and when it closed.
  active: string;
  closedAt: string | null;
};

export type Progress = { done: number; total: number };
// A map in the list: its decisions closed, and its build slices closed (on the map and its
// tickets').
export type MapSummary = { num: number; name: string; url: string; open: boolean; decisions: Progress; build: Progress };

export type Thread = { threadId: string; title: string; status: string; settled: boolean; ticket: number | null };

export type Project = { repo: string; path: string };

export type LaunchKind = "work" | "next" | "ask" | "chart" | "build";
export type LaunchRequest = {
  repo: string;
  kind: LaunchKind;
  map?: number;
  ticket?: number;
  // For a slice under a ticket, that ticket.
  parent?: number;
  note?: string;
  worktree?: boolean;
};

// A map's spec reader (server/src/spec.rs): the sections its merged PRs changed, and where its
// work went.
export type SpecSection = {
  title: string;
  number: string | null;
  level: number;
  anchor: string;
  text: string;
  changedSince: boolean;
  removed: boolean;
  mergedUrl: string;
  prs: number[];
};
export type SpecDoc = { file: string; found: boolean; sections: SpecSection[]; refs: string };
export type SpecPr = { num: number; title: string; url: string; mergedAt: string; code: boolean };
export type Slice = { num: number; title: string; url: string; open: boolean; dropped: boolean; labels: string[]; refs: string[] };
export type Check = { num: number; title: string; url: string; open: boolean; kind: string };
export type MapSpec = {
  createdAt: string;
  closedAt: string | null;
  specFile: string;
  prs: SpecPr[];
  docs: SpecDoc[];
  slices: Slice[];
  checks: Check[];
};
