"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as api from "@/lib/api";
import type { Hover } from "@/lib/engine";
import type { BuildSlice, LaunchRequest, MapCheck, MapSpec, MapSummary, Progress, Project, Status, Thread, Ticket, WayMap } from "@/lib/types";
import * as I from "./Icons";
import { HoverTip } from "./HoverTip";
import { Mark, Panel, SLICE_LOOK, SliceMark, type Selection } from "./Panel";
import { attention, bodyOf, nursery, type Attention, type Body, type Look } from "@/lib/attention";
import { SpecReader } from "./SpecReader";
import { StarMap } from "./StarMap";

type Toast = { id: number; text: string; error?: boolean };

const THREAD_POLL_MS = 8000;
const MAP_POLL_MS = 60000;

const mapName = (name: string) => name.replace(/^(Wayfinder|Map):\s*/i, "");

function ago(t: number | null, now: number) {
  if (t == null) return "";
  const m = Math.floor((now - t) / 60000);
  return m < 1 ? "just now" : m < 60 ? `${m}m ago` : `${Math.floor(m / 60)}h ago`;
}

// The next ticket a "Next on the frontier" session will likely take: the frontier ticket
// nearest the map's root.
const nextUp = (m: WayMap): Ticket | undefined =>
  m.tickets.filter((t) => t.status === "frontier").sort((a, b) => a.rank - b.rank || a.num - b.num)[0];

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
  // The map as read, and the slices of the tickets opened so far: a map carries only its own.
  const [raw, setMap] = useState<WayMap | null>(null);
  const [kids, setKids] = useState<Record<number, BuildSlice[]>>({});
  const [threads, setThreads] = useState<Thread[]>([]);
  const [selection, setSelection] = useState<Selection | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [fatal, setFatal] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [only, setOnly] = useState<Status | null>(null);
  const [loadedAt, setLoadedAt] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [minimap, setMinimap] = useState<HTMLCanvasElement | null>(null);
  const [fitSignal, setFitSignal] = useState(0);
  const [hover, setHover] = useState<Hover | null>(null);
  const [wide, setWide] = useState(false);
  // Labels on the map, or only for what's hovered or selected. Remembered between visits.
  const [labels, setLabels] = useState(() => typeof localStorage === "undefined" || localStorage.getItem("starchart.labels") !== "off");
  const [tip, setTip] = useState<HTMLDivElement | null>(null);
  const [t3Env, setT3Env] = useState<string | null>(null);
  // Reading the spec rather than looking at the stars. Null until the map loads: a closed map
  // opens as its spec, an open one as its stars.
  const [reading, setReading] = useState<boolean | null>(null);
  const [spec, setSpec] = useState<MapSpec | null>(null);
  const [specError, setSpecError] = useState<string | null>(null);

  const toast = useCallback((text: string, error = false) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, text, error }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), error ? 9000 : 5000);
  }, []);

  useEffect(() => {
    api.session().then(
      ({ projects: ps, t3Environment }) => {
        setProjects(ps);
        setT3Env(t3Environment);
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
      return api.map(repo, mapNum, fresh).then(
        (m) => { setMap(m); setLoadedAt(Date.now()); setReading((r) => r ?? !m.open); },
        (e) => toast(e.message, true),
      );
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

  const map = useMemo(
    () => raw && { ...raw, slices: [...raw.slices, ...Object.values(kids).flat()] },
    [raw, kids],
  );

  // The ticket whose slices to read: the one open in the panel, or the parent of the open slice
  // (known from its check when the slice isn't loaded yet). Read again with every map reload.
  const parentOf = (n: number) =>
    map?.slices.find((sl) => sl.num === n)?.parent ?? map?.checks.find((c) => c.slice === n)?.parent ?? null;
  const want =
    selection?.kind === "ticket" ? selection.num : selection?.kind === "slice" ? parentOf(selection.num) : null;
  const wantSlices = want != null && raw?.tickets.find((t) => t.num === want)?.slices ? want : null;
  useEffect(() => {
    if (!repo || mapNum == null || wantSlices == null) return;
    api.slices(repo, mapNum, wantSlices).then(
      (list) => setKids((k) => ({ ...k, [wantSlices]: list })),
      (e) => toast(e.message, true),
    );
  }, [repo, mapNum, wantSlices, loadedAt, toast]);

  // The fold-ins with slices still open, or with an open check written from one of their slices,
  // are read once when the map opens, one after another, so what's waiting on you and the
  // suggested path show without opening each. A few at most: each read spends from GitHub's
  // limit on sub-issues.
  const checked = new Set((raw?.checks ?? []).filter((c) => c.open).map((c) => c.parent));
  const unfinished = (raw?.tickets ?? [])
    .filter((t) => t.slices && (t.slices.closed < t.slices.total || checked.has(t.num)))
    .slice(0, 6)
    .map((t) => t.num)
    .join(",");
  useEffect(() => {
    if (!repo || mapNum == null || !unfinished) return;
    let stop = false;
    (async () => {
      for (const n of unfinished.split(",").map(Number)) {
        if (stop) return;
        try {
          const list = await api.slices(repo, mapNum, n);
          if (!stop) setKids((k) => (k[n] ? k : { ...k, [n]: list }));
        } catch {
          return;
        }
      }
    })();
    return () => { stop = true; };
  }, [repo, mapNum, unfinished]);

  const toggleLabels = useCallback(() => {
    setLabels((on) => {
      localStorage.setItem("starchart.labels", on ? "off" : "on");
      return !on;
    });
  }, []);
  // L toggles the labels, unless you're typing.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "l" || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.target instanceof Element && e.target.closest("input, textarea, select, [contenteditable]")) return;
      toggleLabels();
    };
    addEventListener("keydown", onKey);
    return () => removeEventListener("keydown", onKey);
  }, [toggleLabels]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 20000);
    return () => clearInterval(t);
  }, []);

  // What stays lit: tickets matching the search (number or title) and the legend's status.
  // What wants attention on the map, worked out again as the clock moves on.
  const att = useMemo(() => (map ? attention(map, now) : null), [map, now]);
  const match = useMemo(() => {
    const q = query.trim().toLowerCase().replace(/^#/, "");
    if (!map || (!q && !only)) return null;
    const hit = (num: number, title: string) => !q || String(num).startsWith(q) || title.toLowerCase().includes(q);
    return new Set([
      ...map.tickets.filter((t) => (!only || t.status === only) && hit(t.num, t.title)).map((t) => t.num),
      // A status filter is about decisions; slices only answer the search.
      ...(only ? [] : map.slices.filter((sl) => hit(sl.num, sl.title)).map((sl) => sl.num)),
    ]);
  }, [map, query, only]);

  // Each ticket's live T3 thread (the newest unsettled one), which its moon stands for.
  const liveThreads = useMemo(() => {
    const m = new Map<number, Thread>();
    for (const t of threads) if (t.ticket != null && !t.settled && !m.has(t.ticket)) m.set(t.ticket, t);
    return m;
  }, [threads]);
  const live = useMemo(() => new Map([...liveThreads].map(([n, t]) => [n, t.status])), [liveThreads]);

  // A moon opens its thread in the T3 app, through the app's own link scheme.
  const openThread = (num: number) => {
    const t = liveThreads.get(num);
    if (!t) return;
    if (!t3Env) { toast("Can't open the thread: the server didn't find T3's environment id", true); return; }
    location.href = `t3code://threads/${t3Env}/${t.threadId}`;
  };

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

  const loadSpec = useCallback(
    (fresh: boolean) => {
      if (!repo || mapNum == null) return;
      api.spec(repo, mapNum, fresh).then(setSpec, (e) => setSpecError(e.message));
    },
    [repo, mapNum],
  );
  useEffect(() => {
    if (reading && !spec && !specError) loadSpec(false);
  }, [reading, spec, specError, loadSpec]);

  const selectedNum = selection?.kind === "ticket" ? selection.num : null;
  const selectedSlice = selection?.kind === "slice" ? selection.num : null;
  const openMap = (n: number | null) => {
    setSelection(null); setMap(null); setKids({}); setMapNum(n); setQuery(""); setOnly(null);
    setReading(null); setSpec(null); setSpecError(null);
  };
  const refresh = () => {
    if (mapNum == null) { if (repo) { setSummaries(null); api.maps(repo).then(setSummaries, (e) => toast(e.message, true)); } return; }
    loadMap(true); loadThreads(); toast("Reloaded from GitHub");
    if (reading) { setSpecError(null); loadSpec(true); }
  };
  const stars = !reading;
  const next = map ? nextUp(map) : undefined;

  return (
    <>
      <StarMap
        map={mapNum != null ? map : null}
        threads={live}
        selected={selectedNum}
        selectedSlice={selectedSlice}
        onSlice={(n) => setSelection({ kind: "slice", num: n })}
        panelOpen={selection != null}
        panelWide={wide}
        match={match}
        labels={labels}
        minimap={minimap}
        fitSignal={fitSignal}
        tip={tip}
        onSelect={(n) => setSelection(n == null ? null : { kind: "ticket", num: n })}
        onFog={(i) => setSelection({ kind: "fog", index: i })}
        onMoon={openThread}
        onHover={setHover}
      />

      {map && att && mapNum != null && stars && <HoverTip ref={setTip} map={map} att={att} hover={hover} live={liveThreads} canOpenThreads={!!t3Env} />}

      {fatal && <div className="fatal">Can&apos;t reach the starchart server: {fatal}</div>}

      {repo && (
        <header id="topbar">
          <button className="brand" onClick={() => openMap(null)} title="All maps">
            <I.Sparkle size={22} /> Wayfinder
          </button>
          <nav className="crumbs">
            <I.GitHub size={17} />
            <button className="crumb" onClick={() => openMap(null)}>{repo.split("/")[1] ?? repo}</button>
            {mapNum != null && (
              <>
                <span className="sep">›</span>
                <span className="crumb here" title={map?.name}>{map ? mapName(map.name) : `#${mapNum}`}</span>
              </>
            )}
          </nav>
          <div className="spacer" />
          {mapNum != null && map && stars && (
            <SearchBox
              value={query}
              onChange={setQuery}
              onPick={() => { const first = match && map.tickets.find((t) => match.has(t.num)); if (first) setSelection({ kind: "ticket", num: first.num }); }}
            />
          )}
          <button className="tbtn" onClick={refresh}><I.Refresh size={15} /> Refresh</button>
          {mapNum != null && loadedAt && <span className="ago"><I.Clock size={12} /> {ago(loadedAt, now)}</span>}
        </header>
      )}

      {map && mapNum != null && reading && repo && (
        <SpecReader
          repo={repo}
          map={map}
          spec={spec}
          error={specError}
          onOpenMap={(ticket) => { setReading(false); if (ticket != null) setSelection({ kind: "ticket", num: ticket }); }}
        />
      )}

      {map && att && mapNum != null && stars && (
        <Legend map={map} att={att} live={live.size} only={only} onOnly={(s) => setOnly(only === s ? null : s)} />
      )}

      {map && mapNum != null && repo && stars && (
        <footer id="hud">
          <button
            className="primary next"
            disabled={map.counts.frontier === 0}
            onClick={() => launch({ repo, kind: "next", map: map.num })}
            title="Start a session that takes a ticket on the frontier"
          >
            <I.Constellation size={20} /> Next on the frontier <I.Arrow size={16} />
          </button>
          {next && (
            <button className="upnext" onClick={() => setSelection({ kind: "ticket", num: next.num })} title="The frontier ticket nearest the map's root">
              <Mark status="frontier" /> <b>{next.num}</b> <span>{next.title}</span>
            </button>
          )}
          <div className="spacer" />
          <ChecksButton checks={map.checks} onSlice={(n) => setSelection({ kind: "slice", num: n })} />
          <ChartButton onChart={(idea) => launch({ repo, kind: "chart", note: idea })} />
          <ViewMenu
            onInfo={() => setSelection({ kind: "info" })}
            onRead={() => { setSelection(null); setReading(true); }}
            onFit={() => { setSelection(null); setFitSignal((n) => n + 1); }}
            onMaps={() => openMap(null)}
            labels={labels}
            onLabels={toggleLabels}
          />
          <canvas className="minimap" ref={setMinimap} title="Click to move there" />
        </footer>
      )}

      {map && att && selection && repo && stars && (
        <Panel
          repo={repo}
          map={map}
          selection={selection}
          threads={threads}
          onClose={() => setSelection(null)}
          onSelect={(n) => setSelection({ kind: "ticket", num: n })}
          onSelectSlice={(n) => setSelection({ kind: "slice", num: n })}
          onLaunch={launch}
          att={att}
          threadLink={(id) => (t3Env ? `t3code://threads/${t3Env}/${id}` : null)}
          wide={wide}
          onWide={setWide}
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

function SearchBox({ value, onChange, onPick }: { value: string; onChange: (v: string) => void; onPick: () => void }) {
  return (
    <label className="search">
      <I.Search size={16} />
      <input
        value={value}
        placeholder="Search tickets…"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") onPick();
          if (e.key === "Escape") { onChange(""); e.currentTarget.blur(); }
        }}
      />
    </label>
  );
}

const LEGEND: { status: Status; label: string; hint: string }[] = [
  { status: "frontier", label: "Frontier", hint: "ready to take" },
  { status: "claimed", label: "Claimed", hint: "in progress" },
  { status: "blocked", label: "Blocked", hint: "waiting on" },
  { status: "resolved", label: "Resolved", hint: "done" },
  { status: "out_of_scope", label: "Out of scope", hint: "ruled out" },
];

// The key to the map, with each status's count; click a status to light only those tickets.
function Legend({ map, att, live, only, onOnly }: { map: WayMap; att: Attention; live: number; only: Status | null; onOnly: (s: Status) => void }) {
  const count: Record<Status, number> = {
    frontier: map.counts.frontier, claimed: map.counts.claimed, blocked: map.counts.blocked,
    resolved: map.counts.resolved, out_of_scope: map.counts.outOfScope,
  };
  const done = map.counts.total ? Math.round(((map.counts.resolved + map.counts.outOfScope) * 100) / map.counts.total) : 0;
  return (
    <aside id="legend">
      {LEGEND.filter((l) => l.status !== "out_of_scope" || count.out_of_scope > 0).map((l) => (
        <button key={l.status} className={`lrow ${only === l.status ? "on" : ""} ${only && only !== l.status ? "off" : ""}`} onClick={() => onOnly(l.status)}>
          <Mark status={l.status} /> <span className="ll">{l.label}</span> <span className="lh">({l.hint})</span>
          <span className="lc">{count[l.status]}</span>
        </button>
      ))}
      <BodyLegend map={map} />
      {(map.slices.length > 0 || map.tickets.some((t) => t.slices)) && <SliceLegend map={map} att={att} />}
      <div className="lrow static"><Mark status="thread" /> <span className="ll">Active T3 thread</span><span className="lc">{live || ""}</span></div>
      <div className="lrow static"><Mark status="fog" /> <span className="ll">Open question</span><span className="lc">{map.fog.length || ""}</span></div>
      <div className="lbar" title={`${done}% resolved or ruled out`}><span style={{ width: `${done}%` }} /></div>
      <div className="lhint">drag to pan · scroll to zoom · click a star · L for labels</div>
    </aside>
  );
}

const BODIES: { body: Body; label: string; hint: string }[] = [
  { body: "star", label: "Decision", hint: "star" },
  { body: "nebula", label: "Research", hint: "nebula" },
  { body: "protostar", label: "Prototype", hint: "protostar" },
  { body: "nursery", label: "Spec forming", hint: "nursery" },
  { body: "sun", label: "Fold-in, done", hint: "sun" },
];

// The forms in the key, for those on this map: a ticket's form says its role, its colour (above)
// its status.
function BodyLegend({ map }: { map: WayMap }) {
  const here = new Set(map.tickets.map(bodyOf));
  if (nursery(map) && map.tickets.length) here.add("nursery");
  return (
    <>
      <div className="lsep">Forms</div>
      {BODIES.filter((b) => here.has(b.body)).map((b) => (
        <div key={b.body} className="lrow static"><span className={`bmark ${b.body}`} /> <span className="ll">{b.label}</span> <span className="lh">({b.hint})</span></div>
      ))}
    </>
  );
}

const SLICE_ORDER: Look[] = ["ready", "building", "you", "stalled", "blocked"];

// The build half of the key: slices are planets, sized by what they free, and finished ones fold
// into a ring of dust round their fold-in. A ticket's slices are only counted until it's opened,
// so the looks are counted only once every ticket's are loaded.
function SliceLegend({ map, att }: { map: WayMap; att: Attention }) {
  const loose = map.slices.filter((sl) => sl.parent == null);
  const counted = map.tickets.reduce((a, t) => a + (t.slices?.total ?? 0), 0);
  const total = loose.length + counted;
  const closed = loose.filter((sl) => sl.state === "built" || sl.state === "dropped").length
    + map.tickets.reduce((a, t) => a + (t.slices?.closed ?? 0), 0);
  const all = map.slices.length >= total;
  const n = (lk: Look) => map.slices.filter((sl) => att.looks[sl.num] === lk).length;
  return (
    <>
      <div className="lsep">Build slices <span className="lsepc">{closed}/{total} closed</span></div>
      {SLICE_ORDER.filter((lk) => (lk !== "you" && lk !== "stalled") || n(lk) > 0).map((lk) => (
        <div key={lk} className="lrow static"><SliceMark look={lk} /> <span className="ll">{SLICE_LOOK[lk]}</span><span className="lc">{all || lk === "you" || lk === "stalled" ? n(lk) || "" : ""}</span></div>
      ))}
      <div className="lrow static"><span className="lmark dust" /> <span className="ll">Built</span> <span className="lh">(in the ring)</span></div>
      <div className="lrow static"><span className="lmark sat owner" /> <span className="ll">Owner check</span> <span className="lh">(satellite)</span></div>
      <div className="lrow static"><span className="lmark sat agent" /> <span className="ll">Agent check</span> <span className="lh">(satellite)</span></div>
      <div className="lrow static"><span className="lmark path" /> <span className="ll">Suggested path</span> <span className="lh">(not a dependency)</span></div>
      {!all && <div className="lhint">open a ticket to see its slices</div>}
    </>
  );
}

// The open agent and owner checks across the map's slices, in a tray: what's waiting on you,
// and what an agent can check, each with its due line.
function ChecksButton({ checks, onSlice }: { checks: MapCheck[]; onSlice: (n: number) => void }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, close);
  const list = checks.filter((c) => c.open).sort((a, b) => (a.kind === b.kind ? a.num - b.num : a.kind === "owner" ? -1 : 1));
  if (!list.length) return null;
  const owner = list.filter((c) => c.kind === "owner").length, agent = list.length - owner;
  return (
    <div className="pop" ref={ref}>
      <button className="tbtn big checksbtn" onClick={() => setOpen(!open)}>
        {owner > 0 && <><span className="flag owner" /> {owner} owner check{owner === 1 ? "" : "s"}</>}
        {owner > 0 && agent > 0 && <span className="sepdot">·</span>}
        {agent > 0 && <><span className="flag agent" /> {agent} agent check{agent === 1 ? "" : "s"}</>}
      </button>
      {open && (
        <div className="popover checkspop">
          <div className="ptitle">Open checks</div>
          {list.map((c) => (
            <div key={c.num} className="checkitem">
              <span className={`flag ${c.kind}`} />
              <div>
                <a href={c.url} target="_blank" rel="noreferrer"><b>#{c.num}</b> {c.title.replace(/^Check:\s*/i, "")}</a>
                <div className="cmeta">
                  {c.kind === "owner" ? "You" : "An agent"} · {c.due ? `due ${c.due}` : "no due line"}
                  {c.slice != null && (
                    <>
                      {" "}· from <button className="link" onClick={() => { setOpen(false); onSlice(c.slice!); }}>#{c.slice}</button>
                    </>
                  )}
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// Close a popover on a click anywhere outside it.
function useOutside(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const f = (e: MouseEvent) => { if (!ref.current?.contains(e.target as Node)) close(); };
    addEventListener("mousedown", f);
    return () => removeEventListener("mousedown", f);
  }, [open, close]);
  return ref;
}

function ChartButton({ onChart }: { onChart: (idea: string) => Promise<boolean> }) {
  const [open, setOpen] = useState(false);
  const [idea, setIdea] = useState("");
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, close);
  return (
    <div className="pop" ref={ref}>
      <button className="tbtn big" onClick={() => setOpen(!open)}><I.Plus size={18} /> Start a charting session</button>
      {open && (
        <div className="popover chartpop">
          <div className="ptitle">Chart a new map</div>
          <textarea autoFocus value={idea} onChange={(e) => setIdea(e.target.value)} rows={3} placeholder="The loose idea, in a sentence or two" />
          <button className="primary" disabled={!idea.trim()} onClick={async () => { if (await onChart(idea)) { setIdea(""); setOpen(false); } }}>
            Start a charting session
          </button>
        </div>
      )}
    </div>
  );
}

function ViewMenu({ onInfo, onRead, onFit, onMaps, labels, onLabels }: {
  onInfo: () => void; onRead: () => void; onFit: () => void; onMaps: () => void; labels: boolean; onLabels: () => void;
}) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  const ref = useOutside(open, close);
  const item = (label: string, f: () => void) => <button className="mitem" onClick={() => { setOpen(false); f(); }}>{label}</button>;
  return (
    <div className="pop" ref={ref}>
      <button className="tbtn big" onClick={() => setOpen(!open)}><I.List size={18} /> View <I.Chevron size={15} /></button>
      {open && (
        <div className="popover menu">
          {item("Read the spec", onRead)}
          {item("Map details", onInfo)}
          {item("Fit to screen", onFit)}
          <button className="mitem toggle" role="menuitemcheckbox" aria-checked={labels} onClick={onLabels}>
            <span className={`tick ${labels ? "on" : ""}`} aria-hidden /> Show labels <kbd>L</kbd>
          </button>
          {item("All maps", onMaps)}
        </div>
      )}
    </div>
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
  const bar = (label: string, p: Progress, cls: string, none: string) => (
    <div className={`crow ${cls}`}>
      <span>{label}</span>
      {p.total ? (
        <>
          <div className="cbar"><span style={{ width: `${Math.round((p.done * 100) / p.total)}%` }} /></div>
          <span className="cn">{p.done} / {p.total}</span>
        </>
      ) : (
        <span className="cnone">{none}</span>
      )}
    </div>
  );
  const card = (m: MapSummary) => (
    <div key={m.num} className={`card ${finished(m) ? "closed" : ""}`} onClick={() => onOpen(m.num)}>
      <div className="cname">{mapName(m.name)}</div>
      <div className="cmeta">
        <span>#{m.num}</span>
        {!m.open && <span className="ctag">{finished(m) ? "Finished" : "Map closed · still building"}</span>}
      </div>
      {bar("Decisions", m.decisions, "dec", "No tickets yet")}
      {bar("Building", m.build, "bld", "No slices yet")}
    </div>
  );
  // A map is put away only once it's closed and every slice of it is closed too.
  const finished = (m: MapSummary) => !m.open && m.build.done >= m.build.total;
  const open = summaries?.filter((m) => !finished(m)) ?? [];
  const closed = summaries?.filter(finished) ?? [];
  return (
    <div id="maplist">
      <div className="listtop">
        <div id="projname">Maps in {repo}</div>
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
            {showClosed ? "Hide" : "Show"} {closed.length} finished map{closed.length === 1 ? "" : "s"}
          </button>
          {showClosed && <div className="cards">{closed.map(card)}</div>}
        </>
      )}
    </div>
  );
}
