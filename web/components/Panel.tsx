"use client";

import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LaunchRequest, Thread, Ticket, WayMap } from "@/lib/types";

export type Selection = { kind: "ticket"; num: number } | { kind: "fog"; index: number } | { kind: "info" };

type Props = {
  repo: string;
  map: WayMap;
  selection: Selection;
  threads: Thread[];
  onClose: () => void;
  onSelect: (num: number) => void;
  onLaunch: (req: LaunchRequest) => Promise<boolean>;
};

const pad2 = (n: number) => (n < 10 ? "0" : "") + n;
const chip = (status: string) => (status === "out_of_scope" ? "oos" : status);

function Md({ text, map, onSelect }: { text: string; map: WayMap; onSelect: (n: number) => void }) {
  // A link to a ticket on this map jumps the star-map to it; any other link opens on GitHub.
  const components: Components = {
    a: ({ href, children }) => {
      const m = href?.match(/\/issues\/(\d+)(?:$|[#?])/);
      const n = m ? Number(m[1]) : null;
      if (n != null && map.tickets.some((t) => t.num === n)) {
        return (
          <a href={href} onClick={(e) => { e.preventDefault(); onSelect(n); }}>
            {children}
          </a>
        );
      }
      return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
    },
  };
  return <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>{text}</ReactMarkdown>;
}

function EdgeRow({ label, nums, map, onSelect }: { label: string; nums: number[]; map: WayMap; onSelect: (n: number) => void }) {
  if (!nums.length) return null;
  return (
    <div className="erow">
      <span className="elabel">{label}</span>
      {nums.map((n) => {
        const t = map.tickets.find((x) => x.num === n);
        return (
          <span key={n} className={`c ${t ? chip(t.status) : "blocked"} tl`} title={t?.title} onClick={() => t && onSelect(n)}>
            {pad2(n)}
          </span>
        );
      })}
    </div>
  );
}

function Actions({ repo, map, ticket, live, onLaunch }: { repo: string; map: WayMap; ticket: Ticket; live: Thread[]; onLaunch: Props["onLaunch"] }) {
  const [note, setNote] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = ticket.status !== "resolved" && ticket.status !== "out_of_scope";

  const go = async (kind: "work" | "ask") => {
    setBusy(true);
    const ok = await onLaunch({ repo, kind, map: map.num, ticket: ticket.num, note, worktree: kind === "work" && worktree });
    setBusy(false);
    if (ok) setNote("");
  };

  return (
    <div className="actions">
      {live.length > 0 && (
        <div className="live">
          {live.map((t) => (
            <div key={t.threadId}>
              <span className={`dot ${t.status === "running" ? "run" : ""}`} /> In T3: {t.title} <em>{t.status}</em>
            </div>
          ))}
        </div>
      )}
      {open && ticket.status === "claimed" && (
        <div className="warn">Claimed by {ticket.assignee}, who has commented on it: someone may be working it.</div>
      )}
      {open && ticket.staleClaim && (
        <div className="warn soft">Assigned to {ticket.assignee} with no comment from them: an abandoned claim, free to take.</div>
      )}
      <textarea
        value={note}
        onChange={(e) => setNote(e.target.value)}
        placeholder={open ? "A note for the session (optional), or a question to ask" : "Ask about this decision"}
        rows={3}
      />
      <div className="row">
        {open && (
          <button className="primary" disabled={busy} onClick={() => go("work")}>
            {ticket.type === "grilling" ? "Grill me on this" : "Work this ticket"}
          </button>
        )}
        <button disabled={busy || !note.trim()} onClick={() => go("ask")}>Ask</button>
        {open && (
          <label className="check">
            <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> new worktree
          </label>
        )}
      </div>
    </div>
  );
}

export function Panel({ repo, map, selection, threads, onClose, onSelect, onLaunch }: Props) {
  let body: ReactNode = null;

  if (selection.kind === "ticket") {
    const t = map.tickets.find((x) => x.num === selection.num);
    if (!t) return null;
    const blocks = map.tickets.filter((o) => o.blockers.includes(t.num)).map((o) => o.num);
    const live = threads.filter((x) => x.ticket === t.num && !x.settled);
    body = (
      <>
        <h2><span className="num">{pad2(t.num)}</span>{t.title}</h2>
        <div className="meta">
          <span className={`c ${chip(t.status)}`}>{t.status.replace(/_/g, " ")}</span>
          <span className="c type">{t.type}</span>
          <a className="c gh" href={t.url} target="_blank" rel="noreferrer">GitHub ↗</a>
          <EdgeRow label="blocked by" nums={t.blockers} map={map} onSelect={onSelect} />
          <EdgeRow label="blocks" nums={blocks} map={map} onSelect={onSelect} />
          {t.outsideBlockers.length > 0 && (
            <div className="erow">
              <span className="elabel">off the map</span>
              {t.outsideBlockers.map((b) => (
                <span key={b.num} className={`c ${b.open ? "blocked" : "resolved"}`} title={b.title}>#{b.num}</span>
              ))}
            </div>
          )}
        </div>
        <Actions key={t.num} repo={repo} map={map} ticket={t} live={live} onLaunch={onLaunch} />
        <div className="md">
          {t.gist && (<><h4>Gist</h4><Md text={t.gist} map={map} onSelect={onSelect} /></>)}
          <Md text={t.body} map={map} onSelect={onSelect} />
          {t.answer && (
            <>
              <h2>{t.status === "out_of_scope" ? "Ruled out" : "Answer"}</h2>
              <Md text={t.answer} map={map} onSelect={onSelect} />
            </>
          )}
        </div>
      </>
    );
  } else if (selection.kind === "fog") {
    const f = map.fog[selection.index];
    if (!f) return null;
    body = (
      <>
        <h2>{f.title}</h2>
        <div className="meta">
          <span className="c fog">fog</span>
          {f.clearsWith != null && <EdgeRow label="clears with" nums={[f.clearsWith]} map={map} onSelect={onSelect} />}
        </div>
        <div className="md"><Md text={f.text} map={map} onSelect={onSelect} /></div>
      </>
    );
  } else {
    body = (
      <>
        <h2>{map.name}</h2>
        <div className="meta">
          <a className="c gh" href={map.url} target="_blank" rel="noreferrer">GitHub ↗</a>
        </div>
        <div className="md">
          <h2>Destination</h2>
          <Md text={map.destination || "_None yet._"} map={map} onSelect={onSelect} />
          {map.notes && (<><h2>Notes</h2><Md text={map.notes} map={map} onSelect={onSelect} /></>)}
          {map.fog.length > 0 && (
            <>
              <h2>Not yet specified</h2>
              <ul>{map.fog.map((f, i) => <li key={i}><strong>{f.title}.</strong> {f.text}</li>)}</ul>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div id="panel" className="open">
      <span className="x" onClick={onClose}>&times;</span>
      {body}
    </div>
  );
}
