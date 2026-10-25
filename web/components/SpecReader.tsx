"use client";

import { useEffect, useRef, useState } from "react";
import type { MapSpec, Slice, SpecDoc, SpecSection, WayMap } from "@/lib/types";
import * as I from "./Icons";
import { Mark, Md } from "./Panel";

type Props = {
  repo: string;
  map: WayMap;
  spec: MapSpec | null;
  error: string | null;
  onOpenMap: (ticket?: number) => void;
};

const mapName = (name: string) => name.replace(/^(Wayfinder|Map):\s*/i, "");
const day = (iso: string | null) =>
  iso ? new Date(iso).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" }) : "";

// "3.11 Shared-in links" reads as §3.11 and its name; a heading with no number keeps its name.
function splitTitle(title: string) {
  const m = title.match(/^(\d+(?:\.\d+)*)\.?\s+(.*)$/);
  return m ? { num: `§${m[1]}`, name: m[2] } : { num: "", name: title };
}

const sectionId = (file: string, s: SpecSection) => `sec-${file}-${s.anchor}`;

// A slice covers a section when its body cites it, or a subsection of it: §3.3 covers §3.3 and
// §3.3.2.
const covers = (sl: Slice, num: string) => sl.refs.some((r) => r === num || r.startsWith(`${num}.`));

type SliceState = "built" | "todo" | "human" | "dropped";
const sliceState = (sl: Slice): SliceState =>
  sl.dropped ? "dropped" : !sl.open ? "built" : sl.labels.includes("ready-for-human") ? "human" : "todo";
const STATE_LABEL: Record<SliceState, string> = { built: "built", todo: "to build", human: "needs a human", dropped: "dropped" };
const size = (sl: Slice) => sl.labels.find((l) => l.startsWith("size:"))?.slice(5);

// How a spec section stands against the build: the slices that cite it, or the PR that changed
// it together with code, or nothing at all, which is a gap.
type Coverage = { slices: Slice[]; withCode: number | null };
function coverage(spec: MapSpec, s: SpecSection): Coverage | null {
  if (!s.number) return null;
  const slices = spec.slices.filter((sl) => covers(sl, s.number!));
  const withCode = s.prs.find((n) => spec.prs.find((p) => p.num === n)?.code) ?? null;
  return { slices, withCode };
}

// A closed map as a document: its destination, then the sections of the spec and glossary its
// merged PRs changed, as they read on the default branch now. The rail carries the page's
// contents, the decisions and what was ruled out, and where the work went (spec PRs, build
// slices, checks).
export function SpecReader({ repo, map, spec, error, onOpenMap }: Props) {
  const [destOpen, setDestOpen] = useState(false);
  const [active, setActive] = useState<string | null>(null);
  const page = useRef<HTMLDivElement>(null);
  const docs = spec?.docs.filter((d) => d.sections.length > 0) ?? [];
  const decisions = map.tickets.filter((t) => t.status === "resolved");
  const ruledOut = map.tickets.filter((t) => t.status === "out_of_scope");

  // The rail's contents follow the section being read: the last one whose top has scrolled
  // past the top of the page. (Sections can be screens long, so visibility alone won't do.)
  useEffect(() => {
    const root = page.current;
    if (!root || !docs.length) return;
    const onScroll = () => {
      const top = root.getBoundingClientRect().top + 90;
      let id: string | null = null;
      root.querySelectorAll<HTMLElement>(".sec").forEach((el) => {
        if (el.getBoundingClientRect().top <= top) id = el.id;
      });
      // At the very bottom the last sections can't reach the top, so the last one wins.
      const all = root.querySelectorAll<HTMLElement>(".sec");
      if (root.scrollTop > 0 && root.scrollTop + root.clientHeight >= root.scrollHeight - 4) id = all[all.length - 1]?.id ?? id;
      setActive(id ?? all[0]?.id ?? null);
    };
    onScroll();
    root.addEventListener("scroll", onScroll, { passive: true });
    return () => root.removeEventListener("scroll", onScroll);
  }, [docs.length, spec]);

  const jump = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });

  return (
    <div id="reader" ref={page}>
      <div className="rgrid">
        <main className="rmain">
          <header className="rcard rhead">
            <div className="rtitle">
              <h1>{mapName(map.name)}</h1>
              <span className={`badge ${map.open ? "open" : "closed"}`}>{map.open ? "Open" : "Closed"}</span>
            </div>
            <div className="rmeta">
              <a href={map.url} target="_blank" rel="noreferrer">Map #{map.num}</a>
              {spec?.createdAt && <> · Opened {day(spec.createdAt)}</>}
              {spec?.closedAt && <> · Closed {day(spec.closedAt)}</>}
            </div>
            <button className="tbtn openmap" onClick={() => onOpenMap()}>
              <I.Constellation size={18} /> Open map view <I.Arrow size={15} />
            </button>
            {map.destination && (
              <section className="rdest">
                <h2>Destination</h2>
                <div className={`md ${destOpen ? "" : "clamp"}`}><Md text={map.destination} map={map} onSelect={onOpenMap} /></div>
                <button className="link" onClick={() => setDestOpen(!destOpen)}>
                  <I.Chevron size={14} className={destOpen ? "flip" : ""} /> {destOpen ? "Show less" : "Show full destination"}
                </button>
              </section>
            )}
          </header>

          {error && <div className="rcard rnote err">Couldn&apos;t read the spec: {error}</div>}
          {!spec && !error && <div className="rcard rnote">Reading the spec from the map&apos;s merged PRs…</div>}

          {docs.map((d) => <DocCard key={d.file} repo={repo} doc={d} map={map} onSelect={onOpenMap} spec={spec!} />)}

          {spec && !docs.length && (
            <div className="rcard rnote">
              <I.External size={16} /> No merged PR from this map changed {spec.specFile} or the glossary.
              The destination above and the decisions alongside are the map&apos;s record.
              {map.notes && (
                <div className="md rnotes"><h2>Notes</h2><Md text={map.notes} map={map} onSelect={onOpenMap} /></div>
              )}
            </div>
          )}
        </main>

        <aside className="rrail">
          {docs.length > 0 && (
            <section className="rcard">
              <h3><I.List size={16} /> On this page</h3>
              <nav className="toc">
                {docs.map((d) => (
                  <div key={d.file}>
                    {docs.length > 1 && <div className="tocfile">{d.file}</div>}
                    {d.sections.map((s) => {
                      const t = splitTitle(s.title), id = sectionId(d.file, s);
                      return (
                        <button key={id} className={active === id ? "on" : ""} onClick={() => jump(id)}>
                          {t.num && <span className="tnum">{t.num}</span>} {t.name}
                        </button>
                      );
                    })}
                  </div>
                ))}
              </nav>
            </section>
          )}

          <RailList title="Decisions so far" icon={<I.Constellation size={16} />} items={decisions.map((t) => ({ num: t.num, text: t.title, hint: t.gist ?? undefined }))} onPick={onOpenMap} empty="No decisions closed on this map." />
          {ruledOut.length > 0 && (
            <RailList title="Out of scope" icon={<Mark status="out_of_scope" />} items={ruledOut.map((t) => ({ num: t.num, text: t.title }))} onPick={onOpenMap} />
          )}

          {spec && (spec.slices.length > 0 || docs.length > 0 || spec.checks.length > 0) && <Build spec={spec} docs={docs} onJump={jump} />}
        </aside>
      </div>
    </div>
  );
}

function DocCard({ repo, doc, map, spec, onSelect }: { repo: string; doc: SpecDoc; map: WayMap; spec: MapSpec; onSelect: (n: number) => void }) {
  const isSpec = doc.file === spec.specFile;
  return (
    <section className="rcard rdoc">
      <div className="rdochead">
        <I.Doc size={18} /> <b>{doc.file}</b>
        <span className="rdocsub">{isSpec ? "Sections this map changed, as they read now" : "Glossary sections this map changed"}</span>
        <span className="spacer" />
        <span className="rflag">via <code>{isSpec ? `--spec ${doc.file}` : `--glossary ${doc.file}`}</code></span>
      </div>
      {doc.sections.map((s) => {
        const t = splitTitle(s.title);
        const last = s.prs[s.prs.length - 1];
        // The heading line is drawn above; the body is the rest of the section.
        const body = s.text.split("\n").slice(1).join("\n").trim();
        // The file's link definitions go along, so `[text][name]` resolves in a section alone.
        const md = body && doc.refs ? `${body}\n\n${doc.refs}` : body;
        return (
          <article key={s.anchor} id={sectionId(doc.file, s)} className="sec">
            <div className="sechead">
              <h2>{t.num && <span className="tnum">{t.num}</span>} {t.name}</h2>
              <a className="anchor" href={`https://github.com/${repo}/blob/HEAD/${doc.file}#${s.anchor}`} target="_blank" rel="noreferrer" title="This section on GitHub">
                <I.Link size={14} />
              </a>
              <span className="spacer" />
              {s.changedSince && <span className="drift">Changed since #{last}</span>}
              {s.removed && <span className="drift">Gone from {doc.file} since #{last}</span>}
              <a className="asmerged" href={s.mergedUrl} target="_blank" rel="noreferrer">
                View as merged <I.External size={12} />
              </a>
            </div>
            {isSpec && <CoverageRow cov={coverage(spec, s)} num={t.num} />}
            {body ? <div className="md"><Md text={md} map={map} onSelect={onSelect} base={`https://github.com/${repo}/blob/HEAD/${doc.file}`} /></div> : !s.removed && <p className="muted">Only the heading changed.</p>}
          </article>
        );
      })}
    </section>
  );
}

// Under a spec section's heading: the slices that build it, or why there are none.
function CoverageRow({ cov, num }: { cov: Coverage | null; num: string }) {
  if (!cov) return null;
  if (cov.slices.length) {
    return (
      <div className="cov">
        {cov.slices.map((sl) => {
          const st = sliceState(sl);
          return (
            <a key={sl.num} className={`slice ${st}`} href={sl.url} target="_blank" rel="noreferrer" title={sl.title}>
              <i /> <span className="tnum">#{sl.num}</span> <span className="rtext">{sl.title}</span>
              {size(sl) && <span className="slab">{size(sl)}</span>}
              <span className="sst">{STATE_LABEL[st]}</span>
            </a>
          );
        })}
      </div>
    );
  }
  if (cov.withCode != null) return <div className="cov note">Changed with its code in #{cov.withCode}, no slice needed.</div>;
  return <div className="cov gap">No slice cites {num}.</div>;
}

function RailList({ title, icon, items, onPick, empty }: {
  title: string;
  icon: React.ReactNode;
  items: { num: number; text: string; hint?: string }[];
  onPick: (n: number) => void;
  empty?: string;
}) {
  const [all, setAll] = useState(false);
  const shown = all ? items : items.slice(0, 5);
  return (
    <section className="rcard">
      <h3>{icon} {title} <span className="count">{items.length}</span></h3>
      {!items.length && empty && <p className="muted">{empty}</p>}
      <ul className="rlist">
        {shown.map((i) => (
          <li key={i.num}>
            <button onClick={() => onPick(i.num)} title={i.hint ?? i.text}>
              <span className="tnum">#{i.num}</span> <span className="rtext">{i.text}</span>
            </button>
          </li>
        ))}
      </ul>
      {items.length > 5 && (
        <button className="link" onClick={() => setAll(!all)}>
          <I.Chevron size={14} className={all ? "flip" : ""} /> {all ? "Show fewer" : `Show all ${items.length}`}
        </button>
      )}
    </section>
  );
}

// Where the map's work went: the slices defined and built, whether they cover the spec, and the
// agent and owner checks still open on them.
function Build({ spec, docs, onJump }: { spec: MapSpec; docs: SpecDoc[]; onJump: (id: string) => void }) {
  const [allTodo, setAllTodo] = useState(false);
  const live = spec.slices.filter((s) => !s.dropped);
  const built = live.filter((s) => !s.open).length;
  const human = live.filter((s) => sliceState(s) === "human").length;
  const dropped = spec.slices.length - live.length;
  const todo = live.filter((s) => s.open);
  const specDoc = docs.find((d) => d.file === spec.specFile);
  const numbered = specDoc?.sections.filter((s) => s.number) ?? [];
  const gaps = numbered.filter((s) => { const c = coverage(spec, s)!; return !c.slices.length && c.withCode == null; });
  const uncited = live.filter((s) => s.refs.length === 0);
  const openChecks = spec.checks.filter((c) => c.open);
  const owner = openChecks.filter((c) => c.kind === "owner"), agent = openChecks.filter((c) => c.kind === "agent");
  return (
    <section className="rcard">
      <h3><I.Branch size={16} /> Build</h3>
      <div className="prov">
        <div className="provhead">
          {live.length ? `${live.length} slice${live.length === 1 ? "" : "s"} defined · ${built} built` : "No build slices defined"}
        </div>
        {live.length > 0 && <div className="pbar"><span style={{ width: `${Math.round((built * 100) / live.length)}%` }} /></div>}
        {(human > 0 || dropped > 0) && (
          <div className="provsub">{[human && `${human} need${human === 1 ? "s" : ""} a human first`, dropped && `${dropped} dropped`].filter(Boolean).join(" · ")}</div>
        )}
        {(allTodo ? todo : todo.slice(0, 5)).map((s) => (
          <a key={s.num} className={`provrow slice ${sliceState(s)}`} href={s.url} target="_blank" rel="noreferrer" title={s.title}>
            <i /> <span className="tnum">#{s.num}</span> <span className="rtext">{s.title}</span> <span className="slab">{size(s) ?? ""}</span>
          </a>
        ))}
        {todo.length > 5 && (
          <button className="link" onClick={() => setAllTodo(!allTodo)}>
            <I.Chevron size={14} className={allTodo ? "flip" : ""} /> {allTodo ? "Show fewer" : `All ${todo.length} to build`}
          </button>
        )}
      </div>
      {numbered.length > 0 && (
        <div className="prov">
          <div className="provhead">
            Spec coverage: {numbered.length - gaps.length} of {numbered.length} section{numbered.length === 1 ? "" : "s"}
          </div>
          {gaps.length === 0 ? (
            <div className="provsub ok">Every section this map changed is cited by a slice or shipped with code.</div>
          ) : (
            <>
              <div className="provsub">No slice cites:</div>
              {gaps.map((g) => {
                const t = splitTitle(g.title);
                return (
                  <button key={g.anchor} className="provrow gap" onClick={() => onJump(sectionId(spec.specFile, g))}>
                    <span className="tnum">{t.num}</span> <span className="rtext">{t.name}</span>
                  </button>
                );
              })}
            </>
          )}
          {uncited.length > 0 && (
            <div className="provsub">{uncited.length} slice{uncited.length === 1 ? " cites" : "s cite"} no spec section.</div>
          )}
        </div>
      )}
      {spec.checks.length > 0 && (
        <div className="prov">
          <div className="provhead">
            Checks: {openChecks.length ? `${owner.length} owner open · ${agent.length} agent open` : `all ${spec.checks.length} passed`}
          </div>
          {[...owner, ...agent].map((c) => (
            <a key={c.num} className="provrow" href={c.url} target="_blank" rel="noreferrer" title={c.title}>
              <span className={`ck ${c.kind}`} /> <span className="tnum">#{c.num}</span> <span className="rtext">{c.title.replace(/^Check:\s*/i, "")}</span>
            </a>
          ))}
        </div>
      )}
    </section>
  );
}
