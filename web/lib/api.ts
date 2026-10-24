import type { LaunchRequest, MapSummary, Project, Thread, WayMap } from "./types";

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

export async function session(): Promise<Project[]> {
  const s = await call<{ token: string; projects: Project[] }>("/api/session");
  token = s.token;
  return s.projects;
}

export const maps = (repo: string) => call<MapSummary[]>(`/api/maps?${q(repo)}`);

export const map = (repo: string, num: number, fresh = false) =>
  call<WayMap>(`/api/maps/${num}?${q(repo)}${fresh ? "&fresh=1" : ""}`);

export const threads = (repo: string) => call<Thread[]>(`/api/threads?${q(repo)}`);

export const launch = (req: LaunchRequest) =>
  call<{ title: string; branch: string | null }>("/api/launch", {
    method: "POST",
    headers: { "content-type": "application/json", "x-console-token": token },
    body: JSON.stringify(req),
  });
