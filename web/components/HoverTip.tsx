"use client";

import { useState, type Ref } from "react";
import type { Hover } from "@/lib/engine";
import type { Status, Thread, Ticket, WayMap } from "@/lib/types";
import * as I from "./Icons";
import { look, type Attention } from "@/lib/attention";
import { Mark, SLICE_LOOK, SliceMark, lookWhy } from "./Panel";

type Props = {
  map: WayMap;
  hover: Hover | null;
  live: Map<number, Thread>;
  canOpenThreads: boolean;
  att: Attention;
  ref: Ref<HTMLDivElement>;
};

const clip = (s: string, n: number) => (s.length > n ? s.slice(0, n - 1).trimEnd() + "…" : s);

// Markdown to a plain sentence or two, for a preview.
const plain = (md: string) =>
  md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/^#+\s.*$/gm, " ")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/[*_`>#|]/g, "")
    .replace(/\s+/g, " ")
    .trim();

const open = (t: Ticket) => t.status !== "resolved" && t.status !== "out_of_scope";

// What a ticket's status means for picking it up.
function standing(t: Ticket, map: WayMap) {
  const waiting = t.blockers.filter((b) => { const o = map.tickets.find((x) => x.num === b); return o ? open(o) : false; }).length
    + t.outsideBlockers.filter((b) => b.open).length;
  const label: Record<Status, string> = {
    frontier: "Ready to work",
    claimed: t.assignee ? `Claimed by ${t.assignee}` : "Claimed",
    blocked: `Waiting on ${waiting}`,
    resolved: "Resolved",
    out_of_scope: "Out of scope",
  };
  const total = t.blockers.length + t.outsideBlockers.length;
  const deps = total === 0 ? "no dependencies" : `${total - waiting} of ${total} dependencies resolved`;
  return { label: label[t.status], deps: total && waiting === 0 ? `${total === 1 ? "1 dependency" : `${total} dependencies`} resolved` : deps };
}

// A ticket's build slices: built of those not dropped, from its slices once they're loaded, else
// from its count (where a dropped slice counts as closed). Null when it has none.
function buildOf(t: Ticket, map: WayMap) {
  const kids = map.slices.filter((sl) => sl.parent === t.num && sl.state !== "dropped");
  if (kids.length) return { built: kids.filter((sl) => sl.state === "built").length, total: kids.length };
  return t.slices ? { built: t.slices.closed, total: t.slices.total } : null;
}

// The card that explains whatever the pointer is over. The engine positions it and shows or
// hides it (data-show); this fills it. It keeps the last hover's content while fading out.
export function HoverTip({ map, hover, live, canOpenThreads, att, ref }: Props) {
  const [last, setLast] = useState(hover);
  if (hover && hover !== last) setLast(hover);
  const h = hover ?? last;
  let body: React.ReactNode = null;

  if (h?.kind === "node") {
    const t = map.tickets.find((x) => x.num === h.num);
    if (t) {
      const st = standing(t, map), preview = plain(t.gist || t.body), build = buildOf(t, map);
      body = (
        <>
          <div className="th"><Mark status={t.status} /> <span><b>#{t.num}</b> · {clip(t.title, 60)}</span></div>
          <div className="tsub"><span className={`ts ${t.status}`}>{st.label}</span> · {st.deps}</div>
          {build && <div className="tbuild">Ring: <b>{build.built} of {build.total}</b> build slices built</div>}
          {preview && <p>{clip(preview, 160)}</p>}
          <div className="tfoot"><I.Pointer size={14} /> Click to inspect ticket</div>
        </>
      );
    }
  } else if (h?.kind === "edge") {
    body = (
      <div className="th small">
        <b>#{h.from}</b> blocks <b>#{h.to}</b>
        <span className={`sat ${h.satisfied ? "yes" : "no"}`}><i />{h.satisfied ? "Satisfied" : "Unsatisfied"}</span>
      </div>
    );
  } else if (h?.kind === "moon") {
    const th = live.get(h.num);
    if (th) {
      const running = th.status === "running" || th.status === "starting";
      body = (
        <>
          <div className="th"><Mark status="thread" /> Live T3 thread</div>
          <dl>
            <dt>Title</dt><dd>{clip(th.title.replace(/^#\d+\s*/, ""), 48)}</dd>
            <dt>Status</dt><dd><span className={`live-dot ${running ? "on" : ""}`} />{th.status}</dd>
          </dl>
          <div className="tfoot">
            {canOpenThreads ? <><I.External size={13} /> Click to open thread</> : "T3's environment wasn't found, so the thread can't be opened from here"}
          </div>
        </>
      );
    }
  } else if (h?.kind === "fog") {
    const f = map.fog[h.index];
    if (f) {
      body = (
        <>
          <div className="tkind fog"><Mark status="fog" /> Open question</div>
          <div className="ttitle">{f.title}</div>
          {f.text && <p>{clip(plain(f.text), 320)}</p>}
        </>
      );
    }
  } else if (h?.kind === "slice") {
    const sl = map.slices.find((x) => x.num === h.num);
    if (sl) {
      const parent = sl.parent != null ? map.tickets.find((x) => x.num === sl.parent) : undefined;
      const open = sl.checks.filter((c) => c.open);
      const waiting = sl.blockers.filter((b) => b.open).map((b) => `#${b.num}`);
      const lk = att.looks[sl.num] ?? look(sl, att.now), why = lookWhy(sl, att), frees = att.unlocks[sl.num] ?? 0;
      body = (
        <>
          <div className="th"><SliceMark look={lk} /> <span><b>#{sl.num}</b> · {clip(sl.title, 60)}</span></div>
          <div className="tsub">
            <span className={`ss ${lk}`}>{SLICE_LOOK[lk]}</span>
            {frees > 0 && <> · unlocks {frees}</>}
            {sl.size && <> · size {sl.size.toUpperCase()}</>}
            {sl.escalate && <> · escalate</>}
            {sl.pr && <> · PR #{sl.pr.num} {sl.pr.merged ? "merged" : "open"}</>}
            {waiting.length > 0 && <> · waits on {waiting.join(", ")}</>}
          </div>
          {why && <p className={`twhy ${lk}`}>{why}</p>}
          {parent && <p>Part of {clip(parent.title, 70)}</p>}
          {sl.shipped && <p className="twarn">A merged PR (#{sl.shipped.num}) names it as its own.</p>}
          {open.length > 0 && (
            <div className="tchecks">
              {open.map((c) => <span key={c.num}><span className={`flag ${c.kind}`} /> {c.kind} check{c.due ? `, due ${clip(c.due, 40)}` : ""}</span>)}
            </div>
          )}
          <div className="tfoot"><I.Pointer size={14} /> Click to inspect slice</div>
        </>
      );
    }
  } else if (h?.kind === "dust") {
    const kids = map.slices.filter((sl) => (h.anchor < 0 ? sl.parent == null : sl.parent === h.anchor) && sl.state === "built");
    const t = map.tickets.find((x) => x.num === h.anchor);
    const count = kids.length || t?.slices?.closed || 0;
    body = (
      <>
        <div className="th"><span className="smark built" /> {count} built slice{count === 1 ? "" : "s"}{t ? <> of #{t.num}</> : " on the map"}</div>
        {kids.length > 0 ? (
          <ul className="tdust">
            {kids.slice(0, 8).map((sl) => <li key={sl.num}><b>#{sl.num}</b> {clip(sl.title, 46)}</li>)}
            {kids.length > 8 && <li className="more">and {kids.length - 8} more</li>}
          </ul>
        ) : <p>Open the ticket to read them.</p>}
      </>
    );
  } else if (h?.kind === "dest") {
    body = (
      <>
        <div className="tkind dest">Destination</div>
        <div className="ttitle">{map.name}</div>
        {map.destination && <p>{clip(plain(map.destination), 300)}</p>}
        <div className="tsub">
          Still open on this map: {att.open.decisions} decision{att.open.decisions === 1 ? "" : "s"} and {att.open.slices} build slice{att.open.slices === 1 ? "" : "s"}.
          The gold path is a suggested route here, not a dependency.
        </div>
      </>
    );
  } else if (h?.kind === "nursery") {
    body = (
      <>
        <div className="tkind nursery">Spec forming</div>
        <div className="ttitle">No fold-in yet</div>
        <p>This map has no fold-in ticket, so its decisions haven&apos;t been folded into the spec. Once one is written and completed, a sun forms here and build slices can orbit it.</p>
      </>
    );
  } else if (h?.kind === "cluster") {
    const hub = map.tickets.find((x) => x.num === h.hub);
    const members = map.tickets.filter((x) => h.members.includes(x.num));
    const count = (s: Status) => members.filter((x) => x.status === s).length;
    const parts = (["frontier", "claimed", "blocked", "resolved"] as const).filter((s) => count(s) > 0);
    body = (
      <>
        <div className="th"><I.Constellation size={18} /> {hub ? clip(hub.title, 44) : `#${h.hub}`}</div>
        <div className="tcounts">
          {parts.map((s) => <span key={s}><Mark status={s} /> {count(s)} {s}</span>)}
        </div>
      </>
    );
  }

  return (
    <div className={`hovertip ${h?.kind ?? ""}`} ref={ref} aria-hidden>
      {body}
    </div>
  );
}
