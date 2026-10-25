"use client";

import { useState, type Ref } from "react";
import type { Hover } from "@/lib/engine";
import type { Status, Thread, Ticket, WayMap } from "@/lib/types";
import * as I from "./Icons";
import { Mark } from "./Panel";

type Props = {
  map: WayMap;
  hover: Hover | null;
  live: Map<number, Thread>;
  canOpenThreads: boolean;
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

// The card that explains whatever the pointer is over. The engine positions it and shows or
// hides it (data-show); this fills it. It keeps the last hover's content while fading out.
export function HoverTip({ map, hover, live, canOpenThreads, ref }: Props) {
  const [last, setLast] = useState(hover);
  if (hover && hover !== last) setLast(hover);
  const h = hover ?? last;
  let body: React.ReactNode = null;

  if (h?.kind === "node") {
    const t = map.tickets.find((x) => x.num === h.num);
    if (t) {
      const st = standing(t, map), preview = plain(t.gist || t.body);
      body = (
        <>
          <div className="th"><Mark status={t.status} /> <span><b>#{t.num}</b> · {clip(t.title, 60)}</span></div>
          <div className="tsub"><span className={`ts ${t.status}`}>{st.label}</span> · {st.deps}</div>
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
