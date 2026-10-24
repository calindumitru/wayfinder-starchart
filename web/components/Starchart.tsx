"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import * as api from "@/lib/api";
import { COL } from "@/lib/engine";
import type { LaunchRequest, MapSummary, Project, Thread, WayMap } from "@/lib/types";
import { Panel, type Selection } from "./Panel";
import { StarMap } from "./StarMap";

type Toast = { id: number; text: string; error?: boolean };

const THREAD_POLL_MS = 8000;
const MAP_POLL_MS = 60000;

// The URL carries the project and the map (?repo=owner/name&map=781), so a reload or the back
// button lands where you were.
function readUrl() {
  const p = new URLSearchParams(location.search);
  const map = Number(p.get("map"));
  return { repo: p.get("repo"), map: Number.isFinite(map) && map > 0 ? map : null };
}
function writeUrl(repo: string, map: number | null) {
  const p = new URLSearchParams({ repo });
  if (map != null) p.set("map", String(map));
  const next = `?${p}`;
  if (location.search !== next) history.pushState(null, "", next);
}

export function Starchart() {
  const [projects, setProjects] = useState<Project[]>([]);
  const [repo, setRepo] = useState<string | null>(null);
  const [mapNum, setMapNum] = useState<number | null>(null);
  const [summaries, setSummaries] = useState<MapSummary[] | null>(null);
  const [map, setMap] = useState<WayMap | null>(null);
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);

  const toast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 5000);
  }, []);

  useEffect(() => {
    api.session().then(
      (ps) => {
        setProjects(ps);
        const u = readUrl();
        setRepo(ps.find((p) => p.repo === u.repo)?.repo ?? ps[0]?.repo ?? null);
        setMapNum(u.map);
      },
      (e) => setFatal(String(e.message ?? e)),
    );
    const onPop = () => { const u = readUrl(); if (u.repo) setRepo(u.repo); setMapNum(u.map); setMap(null); setSelection(null); };
    addEventListener("popstate", onPop);
    return () => removeEventListener("popstate", onPop);
  }, []);

  useEffect(() => {
    if (repo) writeUrl(repo, mapNum);
  }, [repo, mapNum]);

  useEffect(() => {
    if (!repo || mapNum != null) return;
    api.maps(repo).then(setSummaries, (e) => toast(e.message, true));
  }, [repo, mapNum, toast]);

  const loadMap = useCallback(
    (fresh: boolean) => {
      if (!repo || mapNum == null) return Promise.resolve();
      return api.map(repo, mapNum, fresh).then(setMap, (e) => toast(e.message, true));
    },
    [repo, mapNum, toast],
  );
  const loadThreads = useCallback(() => {
    if (!repo) return Promise.resolve();
    return api.threads(repo).then(setThreads, () => setThreads([]));
  }, [repo]);

  useEffect(() => {
    if (mapNum == null) return;
    loadMap(false);
    loadThreads();
    const a = setInterval(() => loadMap(false), MAP_POLL_MS);
    const b = setInterval(loadThreads, THREAD_POLL_MS);
    return () => { clearInterval(a); clearInterval(b); };
  }, [mapNum, loadMap, loadThreads]);

  const live = useMemo(() => {
    const m = new Map<number, string>();
    for (const t of threads) if (t.ticket != null && !t.settled && !m.has(t.ticket)) m.set(t.ticket, t.status);
    return m;
  }, [threads]);

  const launch = useCallback(
    async (req: LaunchRequest) => {
      try {
        const r = await api.launch(req);
        toast(`Started in T3: ${r.title}${r.branch ? ` (worktree ${r.branch})` : ""}`);
        setTimeout(loadThreads, 1500);
        return true;
      } catch (e) {
        toast((e as Error).message, true);
        return false;
      }
    },
    [toast, loadThreads],
  );

  const selectedNum = selection?.kind === "ticket" ? selection.num : null;
  const openMap = (n: number | null) => { setSelection(null); setMap(null); setMapNum(n); };

  return (
    <>
      <StarMap
        map={mapNum != null ? map : null}
        threads={live}
        selected={selectedNum}
        panelOpen={selection != null}
        onSelect={(n) => setSelection(n == null ? null : { kind: "ticket", num: n })}
        onFog={(i) => setSelection({ kind: "fog", index: i })}
      />

      {fatal && <div className="fatal">Can&apos;t reach the starchart server: {fatal}</div>}

      {mapNum != null && (
        <>
          <div id="topleft">
            <button id="backbtn" onClick={() => openMap(null)}>&larr; Maps</button>
            <span id="projtag">{repo}</span>
          </div>
          <div id="hint">drag to pan &middot; scroll to zoom &middot; click a star</div>
        </>
      )}

      {map && mapNum != null && repo && (
        <div id="hud" className={selection ? "hidden" : ""}>
          <div className="htitle">
            <h1>{map.name}</h1>
            {map.destination && <div className="dest">{map.destination.replace(/[*_`]/g, "")}</div>}
          </div>
          <div className="hbtns">
            <button
              className="primary"
              disabled={map.counts.frontier === 0}
              onClick={() => launch({ repo, kind: "next", map: map.num })}
              title="Start a session that takes the first ticket on the frontier"
            >
              Next on the frontier
            </button>
            <button onClick={() => setSelection({ kind: "info" })}>Map</button>
            <button onClick={() => { loadMap(true); loadThreads(); toast("Reloaded from GitHub"); }}>Refresh</button>
          </div>
          <div className="spacer" />
          <div className="counts">
            <span className="c resolved">{map.counts.resolved} resolved</span>
            <span className="c frontier">{map.counts.frontier} frontier</span>
            {map.counts.claimed > 0 && <span className="c claimed">{map.counts.claimed} claimed</span>}
            <span className="c blocked">{map.counts.blocked} blocked</span>
            {map.counts.outOfScope > 0 && <span className="c oos">{map.counts.outOfScope} out of scope</span>}
            {live.size > 0 && <span className="c t3">{live.size} in T3</span>}
          </div>
          <div className="bar"><span style={{ width: `${map.counts.total ? Math.round((map.counts.resolved * 100) / map.counts.total) : 0}%` }} /></div>
          <div className="legend">
            {(["frontier", "claimed", "blocked", "resolved"] as const).map((s) => (
              <b key={s}><span className="dot" style={{ background: COL[s].core }} />{s}</b>
            ))}
          </div>
        </div>
      )}

      {map && selection && repo && (
        <Panel
          repo={repo}
          map={map}
          selection={selection}
          threads={threads}
          onClose={() => setSelection(null)}
          onSelect={(n) => setSelection({ kind: "ticket", num: n })}
          onLaunch={launch}
        />
      )}

      {mapNum == null && repo && (
        <MapList
          repo={repo}
          projects={projects}
          summaries={summaries}
          onRepo={(r) => { setSummaries(null); setRepo(r); }}
          onOpen={openMap}
          onChart={(idea) => launch({ repo, kind: "chart", note: idea })}
        />
      )}

      <div className="toasts">
        {toasts.map((t) => <div key={t.id} className={`toast ${t.error ? "err" : ""}`}>{t.text}</div>)}
      </div>
    </>
  );
}

function MapList({
  repo, projects, summaries, onRepo, onOpen, onChart,
}: {
  repo: string;
  projects: Project[];
  summaries: MapSummary[] | null;
  onRepo: (r: string) => void;
  onOpen: (n: number) => void;
  onChart: (idea: string) => Promise<boolean>;
}) {
  const [idea, setIdea] = useState("");
  const [showClosed, setShowClosed] = useState(false);
  const card = (m: MapSummary) => (
    <div key={m.num} className={`card ${m.open ? "" : "closed"}`} onClick={() => onOpen(m.num)}>
      <div className="cname">{m.name.replace(/^Wayfinder:\s*/, "")}</div>
      <div className="cmeta">
        <span>#{m.num}</span>
        <span>{m.completed}/{m.total} closed</span>
        {!m.open && <span>map closed</span>}
      </div>
      <div className="cbar"><span style={{ width: `${m.total ? Math.round((m.completed * 100) / m.total) : 0}%` }} /></div>
    </div>
  );
  const open = summaries?.filter((m) => m.open) ?? [];
  const closed = summaries?.filter((m) => !m.open) ?? [];
  return (
    <div id="maplist">
      <div className="listtop">
        <div id="projname">{repo}</div>
        {projects.length > 1 && (
          <select value={repo} onChange={(e) => onRepo(e.target.value)}>
            {projects.map((p) => <option key={p.repo}>{p.repo}</option>)}
          </select>
        )}
      </div>
      {!summaries && <div className="loading">Reading maps from GitHub…</div>}
      <div className="cards">
        {open.map(card)}
        <div className="card chart" onClick={(e) => e.stopPropagation()}>
          <div className="cname">Chart a new map</div>
          <textarea value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="The loose idea, in a sentence or two" />
          <button className="primary" disabled={!idea.trim()} onClick={async () => { if (await onChart(idea)) setIdea(""); }}>
            Start a charting session
          </button>
        </div>
      </div>
      {closed.length > 0 && (
        <>
          <button className="closedtoggle" onClick={() => setShowClosed(!showClosed)}>
            {showClosed ? "Hide" : "Show"} {closed.length} closed maps
          </button>
          {showClosed && <div className="cards">{closed.map(card)}</div>}
        </>
      )}
    </div>
  );
}
