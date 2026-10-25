"use client";

import { useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { daysQuiet, look, type Attention, type Look } from "@/lib/attention";
import type { BuildSlice, LaunchRequest, Status, Thread, Ticket, WayMap } from "@/lib/types";
import * as I from "./Icons";

export type Selection =
  | { kind: "ticket"; num: number }
  | { kind: "slice"; num: number }
  | { kind: "fog"; index: number }
  | { kind: "info" };

type Props = {
  repo: string;
  map: WayMap;
  selection: Selection;
  threads: Thread[];
  onClose: () => void;
  onSelect: (num: number) => void;
  onSelectSlice: (num: number) => void;
  onLaunch: (req: LaunchRequest) => Promise<boolean>;
  att: Attention;
  // The t3code:// link that opens a thread in the T3 app; null when T3's environment isn't known.
  threadLink: (threadId: string) => string | null;
  wide: boolean;
  onWide: (wide: boolean) => void;
};

const STATUS: Record<Status, string> = {
  frontier: "Frontier", claimed: "Claimed", blocked: "Blocked", resolved: "Resolved", out_of_scope: "Out of scope",
};

export const SLICE_LOOK: Record<Look, string> = {
  you: "Waiting on you", stalled: "Stalled", ready: "Ready", building: "Building", blocked: "Blocked", built: "Built", dropped: "Dropped",
};

// A slice's planet, as on the map.
export function SliceMark({ look }: { look: Look }) {
  return <span className={`smark ${look}`} aria-hidden />;
}

// Why a slice looks the way it does, when that needs saying.
export function lookWhy(sl: BuildSlice, att: Attention): string | null {
  const lk = att.looks[sl.num] ?? look(sl, att.now);
  if (lk === "you") return sl.state === "human" ? "A person has to do this (ready-for-human)." : "An owner check on it is open.";
  if (lk === "stalled") return `Nothing has happened on it, or on its PR, for ${daysQuiet(sl, att.now)} days.`;
  return null;
}

// The glyph a status has on the map, for the legend, the panel and the bottom bar; plus a live
// T3 thread's ringed moon and an open question's nebula.
export function Mark({ status }: { status: Status | "thread" | "fog" }) {
  return <span className={`mark ${status}`} aria-hidden />;
}

// `base` resolves relative links, such as a spec's links to other files in its repo.
export function Md({ text, map, onSelect, base }: { text: string; map: WayMap; onSelect: (n: number) => void; base?: string }) {
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
      const to = base && href && !/^[a-z][a-z0-9+.-]*:|^#/i.test(href) ? new URL(href, base).toString() : href;
      return <a href={to} target="_blank" rel="noreferrer">{children}</a>;
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
// A live T3 thread on a ticket or slice: a link that opens it in the T3 app, when the app's
// environment is known.
function LiveThread({ t, link }: { t: Thread; link: string | null }) {
  const body = (
    <>
      <Mark status="thread" /> <span>In T3: {t.title.replace(/^#\d+\s*/, "")}</span> <em>{t.status}</em>
      {link && <b className="open">Open <I.External size={12} /></b>}
    </>
  );
  return link ? (
    <a className="live link" href={link} title="Open this thread in the T3 app">{body}</a>
  ) : (
    <div className="live" title="T3's environment wasn't found, so the thread can't be opened from here">{body}</div>
  );
}

function Notices({ ticket, live, threadLink }: { ticket: Ticket; live: Thread[]; threadLink: Props["threadLink"] }) {
  const open = ticket.status !== "resolved" && ticket.status !== "out_of_scope";
  if (!live.length && !(open && (ticket.status === "claimed" || ticket.staleClaim))) return null;
  return (
    <div className="notices">
      {live.map((t) => <LiveThread key={t.threadId} t={t} link={threadLink(t.threadId)} />)}
      {open && ticket.status === "claimed" && (
        <div className="warn">Claimed by {ticket.assignee}, who has commented on it: someone may be working it.</div>
      )}
      {open && ticket.staleClaim && (
        <div className="warn soft">Assigned to {ticket.assignee} with no comment from them: an abandoned claim, free to take.</div>
      )}
    </div>
  );
}

// The question box, shown once Ask is chosen; ⌘↵ sends, Esc cancels.
function AskBox({ value, onChange, onSend, onCancel, placeholder }: {
  value: string; onChange: (v: string) => void; onSend: () => void; onCancel: () => void; placeholder: string;
}) {
  return (
    <div className="askbox">
      <textarea
        autoFocus
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if (e.key === "Enter" && (e.metaKey || e.ctrlKey) && value.trim()) onSend();
        }}
        placeholder={placeholder}
        rows={3}
      />
      <div className="askrow">
        <span>⌘↵ to send · Esc to cancel</span>
        <button className="link" onClick={onCancel}>Cancel</button>
      </div>
    </div>
  );
}

function AskButton({ asking, disabled, onClick }: { asking: boolean; disabled: boolean; onClick: () => void }) {
  return (
    <button className="cta" disabled={disabled} onClick={onClick}>
      <I.Chat size={22} />
      <span>
        <b>{asking ? "Send question" : "Ask"}</b>
        <small>Get an answer without changing anything</small>
      </span>
    </button>
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
        <AskBox value={question} onChange={setQuestion} onSend={() => go("ask")} onCancel={cancel}
          placeholder={open ? "Your question about this ticket" : "Your question about this decision"} />
      )}
      <AskButton asking={asking} disabled={busy || (asking && !question.trim())} onClick={() => (asking ? go("ask") : setAsking(true))} />
      {open && !asking && (
        <label className="check">
          <input type="checkbox" checked={worktree} onChange={(e) => setWorktree(e.target.checked)} /> Work in a new worktree
        </label>
      )}
    </div>
  );
}

// Why a slice can't be built from here, when it can't.
function notBuildable(sl: BuildSlice): string | null {
  switch (sl.state) {
    case "ready": return null;
    case "building": return sl.pr ? `Being built: PR #${sl.pr.num} is open.` : `Claimed by ${sl.assignee}, who has commented on it.`;
    case "blocked": return `Blocked by ${sl.blockers.filter((b) => b.open).map((b) => `#${b.num}`).join(", ")}.`;
    case "human": return "A person has to do this first (ready-for-human).";
    case "built": return "Built.";
    case "dropped": return "Dropped: closed as not planned.";
  }
}

// A slice's actions: build it with the slice flow, or ask about it.
function SliceActions({ repo, map, slice, onLaunch }: { repo: string; map: WayMap; slice: BuildSlice; onLaunch: Props["onLaunch"] }) {
  const [asking, setAsking] = useState(false);
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const why = notBuildable(slice);
  const go = async (kind: "build" | "ask") => {
    setBusy(true);
    const ok = await onLaunch({ repo, kind, map: map.num, ticket: slice.num, parent: slice.parent ?? undefined, note: kind === "ask" ? question : "" });
    setBusy(false);
    if (ok && kind === "ask") { setQuestion(""); setAsking(false); }
  };
  const cancel = () => { setAsking(false); setQuestion(""); };
  return (
    <div className="actions">
      {!why && (
        <button className={`cta ${slice.shipped ? "" : "primary"}`} disabled={busy} onClick={() => go("build")}>
          <I.Play size={22} />
          <span>
            <b>{slice.shipped ? "Build anyway" : "Build this slice"}</b>
            <small>Start a T3 thread with /slice-flow #{slice.num}</small>
          </span>
        </button>
      )}
      {why && slice.state !== "built" && slice.state !== "dropped" && <div className="warn soft">{why}</div>}
      {asking && (
        <AskBox value={question} onChange={setQuestion} onSend={() => go("ask")} onCancel={cancel} placeholder="Your question about this slice" />
      )}
      <AskButton asking={asking} disabled={busy || (asking && !question.trim())} onClick={() => (asking ? go("ask") : setAsking(true))} />
    </div>
  );
}

// One slice in a list: its square, number, title, size and state, and its PR when it has one.
function SliceRow({ sl, att, onSelect }: { sl: BuildSlice; att: Attention; onSelect: (n: number) => void }) {
  const lk = att.looks[sl.num] ?? look(sl, att.now);
  return (
    <button className="dep slicerow" onClick={() => onSelect(sl.num)} title={sl.title}>
      <SliceMark look={lk} /> <b>{sl.num}</b> <span className="dt">{sl.title}</span>
      {sl.size && <span className="size">{sl.size.toUpperCase()}</span>}
      <span className={`sstate ${lk}`}>{SLICE_LOOK[lk]}</span>
    </button>
  );
}

// A fold-in's build: its decisions resolved, its slices built, and the slices themselves.
function Build({ map, ticket, att, onSelectSlice }: { map: WayMap; ticket: Ticket; att: Attention; onSelectSlice: (n: number) => void }) {
  const kids = map.slices.filter((sl) => sl.parent === ticket.num);
  if (!kids.length) {
    if (!ticket.slices) return null;
    return (
      <section className="psec">
        <div className="phead">Build slices <span className="pcount">{ticket.slices.closed} of {ticket.slices.total} closed</span></div>
        <div className="pmute">Reading its slices…</div>
      </section>
    );
  }
  const live = kids.filter((k) => k.state !== "dropped");
  const built = live.filter((k) => k.state === "built").length;
  const blockers = ticket.blockers.map((n) => map.tickets.find((x) => x.num === n)).filter((x): x is Ticket => !!x);
  const decided = blockers.filter((b) => b.status === "resolved" || b.status === "out_of_scope").length;
  const bar = (label: string, done: number, total: number, cls: string) => (
    <div className="pbarrow">
      <span>{label}</span>
      <div className={`pbar ${cls}`}><span style={{ width: `${total ? Math.round((done * 100) / total) : 0}%` }} /></div>
      <span className="pcount">{done} / {total}</span>
    </div>
  );
  return (
    <section className="psec">
      <div className="phead">Build slices <span className="pcount" title="The ring round the ticket on the map">{built} of {live.length} built</span></div>
      {blockers.length > 0 && bar("Decisions", decided, blockers.length, "dec")}
      {bar("Slices built", built, live.length, "bld")}
      <div className="slicelist">{kids.map((sl) => <SliceRow key={sl.num} sl={sl} att={att} onSelect={onSelectSlice} />)}</div>
    </section>
  );
}

export function Panel({ repo, map, selection, threads, onClose, onSelect, onSelectSlice, onLaunch, att, threadLink, wide, onWide }: Props) {
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
        <Notices ticket={t} live={live} threadLink={threadLink} />
        {t.gist && <div className="lead"><Md text={t.gist} map={map} onSelect={onSelect} /></div>}
        <Deps map={map} ticket={t} onSelect={onSelect} />
        <Build map={map} ticket={t} att={att} onSelectSlice={onSelectSlice} />
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
  } else if (selection.kind === "slice") {
    const sl = map.slices.find((x) => x.num === selection.num);
    if (!sl) return null;
    const parent = sl.parent != null ? map.tickets.find((x) => x.num === sl.parent) : undefined;
    const live = threads.filter((x) => x.ticket === sl.num && !x.settled);
    const lk = att.looks[sl.num] ?? look(sl, att.now), why = lookWhy(sl, att), frees = att.unlocks[sl.num] ?? 0;
    head = (
      <>
        <div className="ptop">
          <SliceMark look={lk} /> <span className="pnum">{sl.num}</span>
          <span className="ptype">slice</span>
          {sl.size && <span className="size">{sl.size.toUpperCase()}</span>}
          {sl.escalate && <span className="esc" title="A mistake is costly: built by the escalated builder">escalate</span>}
          <span className={`badge s-${lk}`}>{SLICE_LOOK[lk]}</span>
        </div>
        <h2>{sl.title}</h2>
      </>
    );
    body = (
      <>
        {live.length > 0 && (
          <div className="notices">
            {live.map((th) => (
              <LiveThread key={th.threadId} t={th} link={threadLink(th.threadId)} />
            ))}
          </div>
        )}
        {sl.shipped && (
          <div className="shipped">
            <b>A merged PR already names this slice as its own.</b> <a href={sl.shipped.url} target="_blank" rel="noreferrer">PR #{sl.shipped.num}</a> may have built it:
            check before building it again, and close the slice if it&apos;s done.
          </div>
        )}
        {why && <div className={`lookwhy ${lk}`}>{why}</div>}
        <section className="psec facts">
          <div className="fact">
            <span>Unblocks</span>
            {frees ? <span>{frees} open slice{frees === 1 ? "" : "s"}</span> : <span className="none">Nothing waits on it</span>}
          </div>
          {parent && (
            <div className="fact"><span>Part of</span> <DepRow t={parent} onSelect={onSelect} /></div>
          )}
          <div className="fact">
            <span>Blockers</span>
            <div>
              {sl.blockers.length ? sl.blockers.map((b) => {
                const other = map.slices.find((x) => x.num === b.num);
                return other ? <SliceRow key={b.num} sl={other} att={att} onSelect={onSelectSlice} /> : (
                  <div key={b.num} className="dep static"><b>#{b.num}</b> <span className="dt">{b.title}</span><span className={`ds ${b.open ? "open" : "done"}`}>{b.open ? "Open" : "Closed"}</span></div>
                );
              }) : <span className="none">None</span>}
            </div>
          </div>
          <div className="fact">
            <span>PR</span>
            {sl.pr ? <a href={sl.pr.url} target="_blank" rel="noreferrer">#{sl.pr.num} {sl.pr.merged ? "merged" : "open"}</a> : <span className="none">None yet</span>}
          </div>
          <div className="fact">
            <span>Checks</span>
            <div>
              {sl.checks.length ? sl.checks.map((c) => (
                <a key={c.num} className="checkrow" href={c.url} target="_blank" rel="noreferrer" title={c.title}>
                  <span className={`flag ${c.kind}`} /> <b>#{c.num}</b> <span className="dt">{c.title.replace(/^Check:\s*/i, "")}</span>
                  <span className={`ds ${c.open ? "open" : "done"}`}>{c.open ? (c.due ? `Due ${c.due}` : "Open") : "Passed"}</span>
                </a>
              )) : <span className="none">None</span>}
            </div>
          </div>
        </section>
        {sl.body.trim() && <section className="psec md"><Md text={sl.body} map={map} onSelect={onSelect} /></section>}
        <a className="ghlink" href={sl.url} target="_blank" rel="noreferrer"><I.GitHub size={14} /> Open #{sl.num} on GitHub <I.External size={12} /></a>
      </>
    );
    foot = <SliceActions key={sl.num} repo={repo} map={map} slice={sl} onLaunch={onLaunch} />;
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
