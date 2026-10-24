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
};

export type MapSummary = { num: number; name: string; url: string; open: boolean; total: number; completed: number };

export type Thread = { threadId: string; title: string; status: string; settled: boolean; ticket: number | null };

export type Project = { repo: string; path: string };

export type LaunchKind = "work" | "next" | "ask" | "chart";
export type LaunchRequest = {
  repo: string;
  kind: LaunchKind;
  map?: number;
  ticket?: number;
  note?: string;
  worktree?: boolean;
};
