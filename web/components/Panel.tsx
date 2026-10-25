"use client";

import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { LaunchRequest, Status, Thread, Ticket, WayMap } from "@/lib/types";
import * as I from "./Icons";

export type Selection = { kind: "ticket"; num: number } | { kind: "fog"; index: number } | { kind: "info" };

type Props = {
  repo: string;
  map: WayMap;
  selection: Selection;
  threads: Thread[];
  onClose: () => void;
  onSelect: (num: number) => void;
  onLaunch: (req: LaunchRequest) => Promise<boolean>;
  wide: boolean;
  onWide: (wide: boolean) => void;
};

const STATUS: Record<Status, string> = {
  frontier: "Frontier", claimed: "Claimed", blocked: "Blocked", resolved: "Resolved", out_of_scope: "Out of scope",
};

// The glyph a status has on the map, for the legend, the panel and the bottom bar; plus a live
// T3 thread's ringed moon and an open question's nebula.
export function Mark({ status }: { status: Status | "thread" | "fog" }) {
  return <span className={`mark ${status}`} aria-hidden />;
}

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

// One ticket this one waits on or unblocks, as a row: glyph, number, title, open or done.
function DepRow({ t, onSelect }: { t: Ticket; onSelect: (n: number) => void }) {
  const open = t.status !== "resolved" && t.status !== "out_of_scope";
  return (
    <button className="dep" onClick={() => onSelect(t.num)} title={t.title}>
      <Mark status={t.status} /> <b>{t.num}</b> <span className="dt">{t.title}</span>
      <span className={`ds ${open ? "open" : "done"}`}>{open ? "Open" : STATUS[t.status]}</span>
    </button>
  );
}

function Deps({ map, ticket, onSelect }: { map: WayMap; ticket: Ticket; onSelect: (n: number) => void }) {
  const [shown, setShown] = useState(true);
  const blockers = ticket.blockers.map((n) => map.tickets.find((x) => x.num === n)).filter((x): x is Ticket => !!x);
  const unblocks = map.tickets.filter((o) => o.blockers.includes(ticket.num));
  const openCount =
    blockers.filter((b) => b.status !== "resolved" && b.status !== "out_of_scope").length + ticket.outsideBlockers.filter((b) => b.open).length;
  if (!blockers.length && !unblocks.length && !ticket.outsideBlockers.length) return null;
  return (
    <section className="psec">
      <button className="phead" onClick={() => setShown(!shown)}>
        Dependencies <I.Chevron size={13} className={shown ? "" : "rot"} />
        <span className="pcount">{openCount ? `${openCount} blocker${openCount > 1 ? "s" : ""}` : "unblocked"}</span>
      </button>
      {shown && (
        <>
          {blockers.map((b) => <DepRow key={b.num} t={b} onSelect={onSelect} />)}
          {ticket.outsideBlockers.map((b) => (
            <div key={b.num} className="dep static" title="Off this map">
              <Mark status={b.open ? "blocked" : "resolved"} /> <b>#{b.num}</b> <span className="dt">{b.title}</span>
              <span className={`ds ${b.open ? "open" : "done"}`}>{b.open ? "Open" : "Closed"}</span>
            </div>
          ))}
          {unblocks.length > 0 && <div className="psub">Unblocks</div>}
          {unblocks.map((b) => <DepRow key={b.num} t={b} onSelect={onSelect} />)}
        </>
      )}
    </section>
  );
}

// What's going on with a ticket right now: its live T3 threads and any claim on it.
function Notices({ ticket, live }: { ticket: Ticket; live: Thread[] }) {
  const open = ticket.status !== "resolved" && ticket.status !== "out_of_scope";
  if (!live.length && !(open && (ticket.status === "claimed" || ticket.staleClaim))) return null;
  return (
    <div className="notices">
      {live.map((t) => (
        <div key={t.threadId} className="live">
          <Mark status="thread" /> <span>In T3: {t.title.replace(/^#\d+\s*/, "")}</span> <em>{t.status}</em>
        </div>
      ))}
      {open && ticket.status === "claimed" && (
        <div className="warn">Claimed by {ticket.assignee}, who has commented on it: someone may be working it.</div>
      )}
      {open && ticket.staleClaim && (
        <div className="warn soft">Assigned to {ticket.assignee} with no comment from them: an abandoned claim, free to take.</div>
      )}
    </div>
  );
}

// The ticket's actions. The question box only appears once you choose Ask, so the buttons
// take as little room from the ticket as they can.
function Actions({ repo, map, ticket, onLaunch }: { repo: string; map: WayMap; ticket: Ticket; onLaunch: Props["onLaunch"] }) {
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [worktree, setWorktree] = useState(false);
  const [busy, setBusy] = useState(false);
  const open = ticket.status !== "resolved" && ticket.status !== "out_of_scope";

  const go = async (kind: "work" | "ask") => {
    setBusy(true);
    const note = kind === "ask" ? question : "";
    const ok = await onLaunch({ repo, kind, map: map.num, ticket: ticket.num, note, worktree: kind === "work" && worktree });
    setBusy(false);
    if (ok && kind === "ask") { setQuestion(""); setAsking(false); }
  };
  const cancel = () => { setAsking(false); setQuestion(""); };

  return (
    <div className="actions">
      {open && (
        <button className="cta primary" disabled={busy} onClick={() => go("work")}>
          <I.Play size={22} />
          <span>
            <b>{ticket.type === "grilling" ? "Grill me on this" : "Work this ticket"}</b>
            <small>Start a T3 thread with /wayfinder #{map.num} #{ticket.num}{worktree ? " in a new worktree" : ""}</small>
          </span>
        </button>
      )}
      {asking && (
        <div className="askbox">
          <textarea
            autoFocus
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") cancel();
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && question.trim()) go("ask");
            }}
            placeholder={open ? "Your question about this ticket" : "Your question about this decision"}
            rows={3}
          />
          <div className="askrow">
            <span>⌘↵ to send · Esc to cancel</span>
            <button className="link" onClick={cancel}>Cancel</button>
          </div>
        </div>
      )}
      <button
        className="cta"
        disabled={busy || (asking && !question.trim())}
        onClick={() => (asking ? go("ask") : setAsking(true))}
      >
        <I.Chat size={22} />
        <span>
          <b>{asking ? "Send question" : "Ask"}</b>
          <small>Get an answer without changing anything</small>
        </span>
      </button>
      {open && !asking && (
        <label className="check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Work in a new worktree
        </label>
      )}
    </div>
  );
}

export function Panel({ repo, map, selection, threads, onClose, onSelect, onLaunch, wide, onWide }: Props) {
  let head: ReactNode = null;
  let body: ReactNode = null;
  let foot: ReactNode = null;

  if (selection.kind === "ticket") {
    const t = map.tickets.find((x) => x.num === selection.num);
    if (!t) return null;
    const live = threads.filter((x) => x.ticket === t.num && !x.settled);
    head = (
      <>
        <div className="ptop">
          <Mark status={t.status} /> <span className="pnum">{t.num}</span>
          <span className="ptype">{t.type}</span>
          <span className={`badge ${t.status}`}>{STATUS[t.status]}</span>
        </div>
        <h2>{t.title}</h2>
      </>
    );
    body = (
      <>
        <Notices ticket={t} live={live} />
        {t.gist && <div className="lead"><Md text={t.gist} map={map} onSelect={onSelect} /></div>}
        <Deps map={map} ticket={t} onSelect={onSelect} />
        {t.answer && (
          <section className="psec">
            <div className="phead">{t.status === "out_of_scope" ? "Ruled out" : "Decisions so far"}</div>
            <div className="box md"><Md text={t.answer} map={map} onSelect={onSelect} /></div>
          </section>
        )}
        {t.body.trim() && (
          <section className="psec md"><Md text={t.body} map={map} onSelect={onSelect} /></section>
        )}
        <a className="ghlink" href={t.url} target="_blank" rel="noreferrer"><I.GitHub size={14} /> Open #{t.num} on GitHub <I.External size={12} /></a>
      </>
    );
    foot = <Actions key={t.num} repo={repo} map={map} ticket={t} onLaunch={onLaunch} />;
  } else if (selection.kind === "fog") {
    const f = map.fog[selection.index];
    if (!f) return null;
    const anchor = f.clearsWith != null ? map.tickets.find((x) => x.num === f.clearsWith) : undefined;
    head = (
      <>
        <div className="ptop"><Mark status="fog" /> <span className="badge fog">Open question</span></div>
        <h2>{f.title}</h2>
      </>
    );
    body = (
      <>
        <div className="md"><Md text={f.text} map={map} onSelect={onSelect} /></div>
        {anchor && (
          <section className="psec">
            <div className="phead">Clears with</div>
            <DepRow t={anchor} onSelect={onSelect} />
          </section>
        )}
      </>
    );
  } else {
    head = (
      <>
        <div className="ptop"><span className="badge">Map #{map.num}</span></div>
        <h2>{map.name}</h2>
      </>
    );
    body = (
      <>
        <section className="psec">
          <div className="phead">Destination</div>
          <div className="md"><Md text={map.destination || "_None yet._"} map={map} onSelect={onSelect} /></div>
        </section>
        {map.notes && (
          <section className="psec">
            <div className="phead">Notes</div>
            <div className="md"><Md text={map.notes} map={map} onSelect={onSelect} /></div>
          </section>
        )}
        {map.fog.length > 0 && (
          <section className="psec">
            <div className="phead">Not yet specified</div>
            <ul className="md">{map.fog.map((f, i) => <li key={i}><strong>{f.title}.</strong> {f.text}</li>)}</ul>
          </section>
        )}
        <a className="ghlink" href={map.url} target="_blank" rel="noreferrer"><I.GitHub size={14} /> Open the map on GitHub <I.External size={12} /></a>
      </>
    );
  }

  return (
    <aside id="panel" className={wide ? "wide" : ""}>
      <div className="pctl">
        <button onClick={() => onWide(!wide)} aria-label={wide ? "Narrow the panel" : "Widen the panel for reading"} title={wide ? "Narrow" : "Widen for reading"}>
          {wide ? <I.Collapse size={15} /> : <I.Expand size={15} />}
        </button>
        <button onClick={onClose} aria-label="Close" title="Close"><I.Close size={16} /></button>
      </div>
      <div className="phd">{head}</div>
      <div className="pbody">{body}</div>
      {foot && <div className="pfoot">{foot}</div>}
    </aside>
  );
}
