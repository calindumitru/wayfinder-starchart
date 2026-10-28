# wayfinder-starchart

A star-map of [wayfinder](https://github.com/mattpocock/skills) maps kept as GitHub issues, with
buttons that start [T3 Code](https://t3.codes) sessions on them. Click a ticket, press **Grill me
on this**, and a new T3 thread opens on `/wayfinder <map> <ticket>`.

![A map's tickets as stars](docs/starmap.png)

The look is [rengwu/wayfinder-maps](https://github.com/rengwu/wayfinder-maps)' star-map, ported
from its vanilla JS. That tool is a read-only viewer of a local `.plan/` folder; this one reads
the map straight from GitHub and can act on it.

## What it does

- **Lists a project's maps** with two bars each: decisions closed, and build slices closed (on
  the map and its tickets'). A map is put away under "finished" only once it's closed *and* its
  slices are all closed; a closed map that's still building stays in view.
- **Reads maps from GitHub.** A map is an issue labelled `wayfinder:map`; its sub-issues are the
  tickets, typed by a `wayfinder:<type>` label and wired with GitHub's native issue dependencies.
  A couple of GraphQL queries (through `gh`, so starchart holds no token) return a map: its
  tickets with their blockers and a count of their slices, and the repo's check issues. A
  ticket's slices are read when you open it. GitHub charges a query for every node it *could*
  return and separately limits reads of sub-issues and dependencies (a limit `gh api
  rate_limit` doesn't show), so reading every ticket's slices with each refresh spent both
  within minutes. Now a map refresh costs about 7 of the 5,000 points an hour, and opening a
  ticket about 3.
- **Derives each ticket's status.** Closed as completed is *resolved*, closed as not planned is
  *out of scope*. An open ticket whose assignee has commented on it is *claimed*. An assignee who
  never commented left an abandoned claim, so the ticket counts as free. A free ticket is on the
  *frontier* when every blocker is closed, blockers off the map included, and *blocked*
  otherwise.
- **Draws each ticket as a body.** Its form says its role and its colour its status. A decision
  is a star with four spikes, bright while open and subdued once resolved; research is a small
  nebula in its status's colour, and once concluded it drifts out past the rings into a belt of
  its own, each one turning slowly in a colour of its own; a prototype is a protostar, a bright core in an accretion disk
  with jets. While the spec is still forming there's a stellar nursery, dusty gas with bright
  knots: a fold-in not yet completed is one, and a map with no fold-in at all has one at its
  centre ("Spec forming"). The map's fold-in holds the centre, its rings stepping out round it.
  A completed fold-in is a golden sun in a corona, clearly larger than
  the planets that orbit it and lighting them from its side, with a thin ring that fills as
  they're built. Nebulae, protostars, nurseries, coronas and planets are painted textures in
  `web/public/bodies` (the clouds greyscale, coloured by status in the browser; the planets
  discs, a world per look: green for ready, ochre for you, magma while blocked, cooled rust
  once stalled, grey once built, and blue ice while being built); each ticket keeps the same
  one, turned and mirrored its own way. The key lists the forms on the map.
- **Shows the build.** A ticket's sub-issues are its build slices (a fold-in's, usually), drawn
  as small planets orbiting it; a ticket on the map with a build label (`ready-for-agent`,
  `ready-for-human`, `size:*`) is a slice with no parent, and these orbit a "Build" hub beside
  the decisions. A slice is green when it's ready, blue while it's being built (claimed, or a PR
  names it as its own, the rule `scripts/frontier.sh` uses), red while blocked, gold when
  it's **waiting on you** (`ready-for-human`, or an owner check on it is open) and
  dull rust once it's **stalled** (being built, but neither it nor its open PR has changed in
  three days). Its size is what it frees: the open slices waiting on it, directly or further
  down. Finished slices (built, nothing open on them) fold into a ring of dust round their
  fold-in, and one built in the last two days leaves a small sparkle there that fades as it
  ages (glowing only in its first twelve hours); hover the ring to list them. Checks are the
  `check:` issues written from a slice ("From slice #613" or a **Slice:** link, with their
  **Due:** line). An open owner check makes its slice gold, and the label names it ("Waiting on
  you: check #826"). Each open check is a satellite of its slice, gold for an owner check and
  blue for an agent's, and stays with it after its PR merges. All of them gather in a
  tray in the bottom bar. A fold-in's ring fills as its slices are built, and from the
  overview a gold or rust pip on it says one of its slices is waiting on you or has stalled.
  When a map opens, the slices of up to six fold-ins with open slices are read, one after
  another, so these show without opening each. **Build this slice** starts `/slice-flow
  <slice>`; a merged PR that already names the slice turns it into a warning and **Build
  anyway**.
- **Keeps the dependencies quiet.** Dependency lines are faint traces by default. The critical
  chain stands out: the longest run of dependencies between open tickets, plus the links the
  suggested path follows. Select a ticket and its own chain stands out instead, everything it
  waits on and everything waiting on it; hover one and its direct links light up. Slice
  dependencies stay faint until a slice in them is hovered or selected.
- **Points the way.** A dashed gold path, a suggestion rather than a dependency, runs from the
  item worth doing first (waiting on you, then whatever frees the most) along what it frees:
  slice to slice, out to its fold-in (ringed in gold as the path passes through) and on through
  the decisions it unblocks. Its last leg, dotted and fainter, reaches the map's destination: a
  bright violet star past the rim, with long cross spikes and faint rings like a navigation
  mark, labelled with the map's goal. While the goal is open it breathes slowly; once the map is
  closed it holds steady and says **Reached**. Hovering it counts what's still open on
  the map, decisions and build slices separately. Hovering a ticket explains its ring ("6 of 6
  build slices built").
- **Hides the labels on request.** View › Show labels, or the L key, turns the map's labels
  off: then only what you hover or select is labelled. The choice is remembered.
  Decisions follow the same colours: green on the frontier, blue claimed, pale once resolved.
- **Reads a closed map as its spec.** A closed map opens as a document: its destination, then
  the sections of `SPEC.md` and `CONTEXT.md` that its merged PRs changed (any merged PR that
  references a ticket on the map and touches either file), as they read on the default branch
  now. A section that has changed since is flagged, with a link to it as merged. Each section
  lists the build slices that cite it (`§3.11` in the slice's body) and whether they're built;
  one with no slice, and not changed together with its code, is flagged as a gap. Alongside:
  the decisions, what was ruled out, slices defined and built, spec coverage, and the open agent
  and owner checks. `--spec` and `--glossary` name other files; View › Read the spec opens it for an open
  map too.
- **Starts sessions.** Each one is a new thread in T3, started through T3's own `t3` CLI:

  | Button | Where | The thread is told |
  |---|---|---|
  | Grill me on this / Work this ticket | an open ticket | `/wayfinder <map> <ticket>`, optionally in a new worktree |
  | Ask | any ticket | to read the ticket and answer your question, changing nothing |
  | Next on the frontier | the map | `/wayfinder <map>` |
  | Start a charting session | the map list, or the bar under a map | `/wayfinder <your idea>` |
  | Build this slice | a ready slice | `/slice-flow <slice>` |

  A note you type goes into the prompt, quoted as yours. A ticket's thread is titled
  `#<n> <title>`, so the map can find it again: a ticket with a live thread carries an orbiting
  moon, which moves faster while the thread runs; a slice with one carries a dashed ring with a
  moon on it. Click the moon, or the thread's row in the panel, to open the thread in the T3
  app (through a `t3code://` link, using the environment id in T3's data directory).

## Run it

You need `gh` (logged in) and T3 Code (its `t3` CLI, at `~/.t3/bin/t3` or on `PATH`).

```sh
(cd web && npm ci && npm run build)   # the static web app, embedded into the binary
cargo build --release
./target/release/wayfinder-starchart --project owner/repo=/path/to/checkout
```

Then open http://127.0.0.1:7788. Repeat `--project` for more repositories; the path is the
checkout T3 starts sessions in. `--help` lists the rest (`--port`, `--worktree-base`, `--gh`,
`--t3`, `--spec`, `--glossary`).

### Develop

```sh
cargo run -- --project owner/repo=/path --allow-host localhost:3000
(cd web && npm run dev)              # http://localhost:3000, proxying /api to :7788
cargo test && (cd web && npm test)
```

A debug build reads `web/out` from disk, so `npm run build` shows up without recompiling.

## Security

The server listens on 127.0.0.1 only. A launch starts an agent on your machine, and any web page
you visit can send requests to loopback, so:

- every request must carry an allowed `Host` header, which defeats DNS rebinding;
- every write must carry the per-run token from `GET /api/session`, which another origin can't
  read because no CORS headers are sent;
- a write's `Origin`, when the browser sends one, must be an allowed host;
- a launch names an action, a map and a ticket, never a prompt. The server reads the map fresh
  from GitHub, checks that the ticket is on it (and still open, for work), and builds the prompt
  from a fixed template.

## Layout

```
server/   Rust (axum): GitHub reader, status model, T3 launcher, HTTP API, embedded web app
web/      Next.js static export: the star-map engine (lib/engine.ts), panel, HUD and map list
```

## License

MIT. The star-map renderer and styles are ported from rengwu/wayfinder-maps (MIT, John Goh).
