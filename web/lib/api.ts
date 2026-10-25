import type { BuildSlice, LaunchRequest, MapSpec, MapSummary, Project, Thread, WayMap } from "./types";

// Writes carry the per-run token the server hands out at /api/session; another origin can't
// read it, so it can't start a session.
let token = "";

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `${res.status} ${res.statusText}`);
  return body as T;
}

const q = (repo: string) => `repo=${encodeURIComponent(repo)}`;

// The projects, and this machine's T3 environment id (for links that open a thread in the
// app), when the server could find it.
export async function session(): Promise<{ projects: Project[]; t3Environment: string | null }> {
  const s = await call<{ token: string; projects: Project[]; t3Environment?: string | null }>("/api/session");
  token = s.token;
  return { projects: s.projects, t3Environment: s.t3Environment ?? null };
}

export const maps = (repo: string) => call<MapSummary[]>(`/api/maps?${q(repo)}`);

export const map = (repo: string, num: number, fresh = false) =>
  call<WayMap>(`/api/maps/${num}?${q(repo)}${fresh ? "&fresh=1" : ""}`);

// A ticket's build slices; a map carries only their count.
export const slices = (repo: string, num: number, ticket: number, fresh = false) =>
  call<BuildSlice[]>(`/api/maps/${num}/tickets/${ticket}/slices?${q(repo)}${fresh ? "&fresh=1" : ""}`);

export const spec = (repo: string, num: number, fresh = false) =>
  call<MapSpec>(`/api/maps/${num}/spec?${q(repo)}${fresh ? "&fresh=1" : ""}`);

export const threads = (repo: string) => call<Thread[]>(`/api/threads?${q(repo)}`);

export const launch = (req: LaunchRequest) =>
  call<{ title: string; branch: string | null }>("/api/launch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-starchart-token": token },
    body: JSON.stringify(req),
  });
