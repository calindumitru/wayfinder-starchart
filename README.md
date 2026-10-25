# wayfinder-starchart

A star-map of [wayfinder](https://github.com/mattpocock/skills) maps kept as GitHub issues, with
buttons that start [T3 Code](https://t3.codes) sessions on them. Click a ticket, press **Grill me
on this**, and a new T3 thread opens on `/wayfinder <map> <ticket>`.

![A map's tickets as stars](docs/starmap.png)

The look is [rengwu/wayfinder-maps](https://github.com/rengwu/wayfinder-maps)' star-map, ported
from its vanilla JS. That tool is a read-only viewer of a local `.plan/` folder; this one reads
the map straight from GitHub and can act on it.

## What it does

- **Reads maps from GitHub.** A map is an issue labelled `wayfinder:map`; its sub-issues are the
  tickets, typed by a `wayfinder:<type>` label and wired with GitHub's native issue dependencies.
  One GraphQL query (through `gh`, so starchart holds no token) returns a whole map.
- **Derives each ticket's status.** Closed as completed is *resolved*, closed as not planned is
  *out of scope*. An open ticket whose assignee has commented on it is *claimed*. An assignee who
  never commented left an abandoned claim, so the ticket counts as free. A free ticket is on the
  *frontier* when every blocker is closed, blockers off the map included, and *blocked*
  otherwise.
- **Starts sessions.** Each one is a new thread in T3, started through T3's own `t3` CLI:

  | Button | Where | The thread is told |
  |---|---|---|
  | Grill me on this / Work this ticket | an open ticket | `/wayfinder <map> <ticket>`, optionally in a new worktree |
  | Ask | any ticket | to read the ticket and answer your question, changing nothing |
  | Next on the frontier | the map | `/wayfinder <map>` |
  | Start a charting session | the map list, or the bar under a map | `/wayfinder <your idea>` |

  A note you type goes into the prompt, quoted as yours. A ticket's thread is titled
  `#<n> <title>`, so the map can find it again: a ticket with a live thread carries an orbiting
  moon, which moves faster while the thread runs. Click the moon to open its thread in the T3
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
`--t3`).

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
