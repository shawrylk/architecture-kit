# Split work across PCs

Fleet assigns free open issues with a shared node list and an optional node server. Nothing about the PCs is written to GitHub.
Install `architecture-harness` and authenticate `gh` on each PC. Give each PC its own id.
Run this on PC a1, then repeat on b2 and c3 with only `--self` changed:

```sh
npx qc fleet init --self a1 --nodes a1:1:L,b2:1:L,c3:2:L
npx qc fleet status --repo shawrylk/architecture-kit
npx qc fleet next --repo shawrylk/architecture-kit
```

Keep the same `nodes` on all PCs. Weight 2 receives about twice as much work as weight 1.
`maxSize` is S, M or L; a node accepts issues up to that size. `active` defaults to true.
Labels `size:S`, `size:M` and `size:L` ignore case; an issue without one is M.
Ownership depends on the repository, issue number and shared nodes, so the PCs agree.
`next` prints this PC's oldest five free issue numbers; `--all` prints every one.
It exits 3 with `no free issue for <self>` when none remain; errors exit 1.
`status` prints weight, maxSize, active, free count and up to ten numbers per node, then taken and unassigned counts.
It shows up to 14 nodes and reports omitted nodes, then adds `node=running|stopped leader=<id or unknown> peers=<seen in 90 s>/<other nodes>`.

`QC_FLEET_FILE` overrides the settings path; without a file fleet is off. `--repo` defaults to origin. Otherwise Windows uses `%APPDATA%\qc\fleet.json`;
other systems use `$XDG_CONFIG_HOME/qc/fleet.json` or `~/.config/qc/fleet.json`.
The file contains `{ "self": "a1", "nodes": [{ "id": "a1", "weight": 1, "maxSize": "L", "active": true }] }`.
`init` creates parent folders and uses mode 0600 on POSIX; an existing file needs `--force` to replace it.

Optional `secret` is shared hex text of at least 64 characters; `init --secret <hex>` reuses it, otherwise init generates 32 random bytes and prints a line to pass the same secret on the other PCs. Optional `leaders` lists node IDs in preference order (default: node order). Each node may have `address` (a host other than `0.0.0.0` or `::`) and `port` (1024–65535); set these with `--addresses a1@host:8080,b2@[::1]:8081`. Old files remain valid. Signed messages are data; local state stays in `<git common dir>/qc/fleet/`.
`qc fleet start [--leader]` detaches `qc fleet serve`, logging to `<state dir>/node.log`; it needs a secret and this node's address (port defaults to 8080), waits up to 5 seconds for health, and succeeds if already running.
`qc fleet stop` waits up to 5 seconds for exit and removes only `node.json`. Other state survives, including `outbox.json` and `peers.json`. `serve [--leader]` also runs in the foreground.

Free issues exclude `hold`, `merge.holdLabel` and `fleet-skip`. An open PR body naming `#<number>`,
a PR head branch, or an origin branch named `<prefix>/<number>-...` makes an issue taken.
Reads use `gh` and git, bounded to 500 open issues and 200 open PRs. No qualifying active node means unassigned. Only a matching local checkout supplies `merge.holdLabel` from `qc.config.json`.
The server binds only its configured address. `GET /health` returns only `{"ok":true}`; `POST /message` checks signatures and saved replay IDs, accepts up to 64 KB into `queue.json` with 202, and never runs commands. Other routes return 404; bad messages return 400 and oversized bodies 413.

To take over a dead PC, edit the fleet file on **every** PC and set that node's `active` to false.
Only issues owned by that node move, among nodes that accept their size. Keep each PC's `self` unchanged.
Run `status` and `next` again. Set `active` back to true on every PC when it returns.
Push the usual issue branch when starting work so subsequent reads see it as taken.
Every 30 seconds, heartbeats send `{ kit: <kit commit or null>, leader: <boolean> }` to other active addressed nodes; `peers.json` records receipt times. Sends time out after 5 seconds; failures enter `outbox.json` and retry oldest first after 1 second, doubling to 60 seconds.
