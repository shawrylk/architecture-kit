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
It shows up to 14 nodes and reports omitted nodes, then adds `node=running|stopped|stale leader=<id or unknown> peers=<seen in 90 s>/<other nodes>`.

`QC_FLEET_FILE` overrides the settings path; without a file fleet is off. `--repo` defaults to origin. Otherwise Windows uses `%APPDATA%\qc\fleet.json`;
other systems use `$XDG_CONFIG_HOME/qc/fleet.json` or `~/.config/qc/fleet.json`.
The file contains `{ "self": "a1", "nodes": [{ "id": "a1", "weight": 1, "maxSize": "L", "active": true }] }`.
`init` creates parent folders and uses mode 0600 on POSIX; an existing file needs `--force` to replace it.

Optional `secret` is shared hex text of at least 64 characters; `init --secret <hex>` reuses it, otherwise init generates 32 random bytes and prints a line to pass the same secret on the other PCs. Optional `leaders` lists node IDs in preference order (default: node order). Each node may have `address` (a host other than `0.0.0.0` or `::`) and `port` (1024–65535); set these with `--addresses a1@host:8080,b2@[::1]:8081`. Old files remain valid. Signed messages are data; local state stays in `<git common dir>/qc/fleet/`.
`qc fleet start [--leader]` detaches `qc fleet serve`, logging to `<state dir>/node.log`; it needs a secret and this node's address (port defaults to 8080), passes a random instance token to the child, saves it with the PID in `node.json`, waits up to 5 seconds for matching health, and succeeds if that instance is already running. `status` and `stop` require health to match the saved instance; a mismatch reports `stale` and leaves the process alone.
`qc fleet stop` waits up to 5 seconds for exit and removes only `node.json`. Other state survives, including `outbox.json` and `peers.json`. `serve [--leader]` also runs in the foreground.

Free issues exclude `hold`, `merge.holdLabel` and `fleet-skip`. An open PR body naming `#<number>`,
a PR head branch, or an origin branch named `<prefix>/<number>-...` makes an issue taken.
Reads use `gh` and git, bounded to 500 open issues and 200 open PRs. No qualifying active node means unassigned. Only a matching local checkout supplies `merge.holdLabel` from `qc.config.json`.
The server binds only its configured address. `GET /health` returns `{"ok":true,"instance":"<token>"}`; `POST /message` checks signatures and saved replay IDs, accepts up to 64 KB with 202, puts work messages into `queue.json`, and never runs commands. Requests time out after 10 seconds; shutdown stops accepting requests and force-closes open connections after 1 second. Other routes return 404; bad messages return 400 and oversized bodies 413.

For free-issue suggestions without a Leader, set `active: false` on every PC to redistribute that node's suggestions. Saved Leader assignments remain until their issues close; automatic takeover is outside this flow. Push the usual issue branch when starting work so subsequent free-issue reads see it as taken.
Every 30 seconds, heartbeats send `{ kit: <kit commit or null>, leader: <boolean> }` to other active addressed nodes; `peers.json` records receipt times; heartbeats never enter `queue.json`. State files are `assignments.json`, `questions.json`, `seen.json`, `queue.json`, `outbox.json`, `dead.json`, `peers.json` and `node.json`. Sends time out after 5 seconds; network errors and 5xx replies enter `outbox.json` and retry oldest first after 1 second, doubling to 60 seconds. The outbox stores unsigned fields and a fixed ID; every send signs again with the current time. A 4xx reply removes the entry: `seen-id` counts as delivered; other refusals enter `dead.json`, which keeps only the last 100.

With `serve --leader`, an assignment tick runs every 60 seconds. It reads `freeIssues` and open issue numbers through `gh`; a failed read skips that tick. The Leader saves `{repo, issue, node, epoch: 1, time}` records keyed by `repo#issue` in `assignments.json`, retaining each until its issue closes. GitHub labels stay unchanged. It considers `ci-red` issues first, then the lowest issue number, using `ownerOf(repo, issue, size, idle live nodes)` and skipping issues with no owner. Each node gets one issue at a time. Other nodes must be active, addressed, and have a heartbeat at most 90 seconds old; the Leader itself is always live. A different heartbeat kit blocks new work and warns `node <id> runs kit <k>, leader runs <k>`.
The Leader writes every new remote `assign` message with `{issue, epoch}` to `outbox.json` before sending any of them, then flushes the outbox. Stopping during a send leaves unconfirmed assignments queued for retry. Every node tick accepts only positive integer issues and epochs from a peer whose latest heartbeat says `leader: true`; a higher epoch replaces a lower one. An assign arriving before that peer has a Leader claim stays in `queue.json` until a heartbeat claims leadership. With no claim it expires after 10 minutes from its message time; a `leader: false` heartbeat drops it at once on the next node tick. Other queued message kinds remain. Every 60 seconds, a follower reads `gh issue list --state open` for each repository where it holds assignments and removes its own assignments whose issues have closed. A failed or unreadable gh response preserves that repository's assignments. `qc fleet next` makes the same open-issue check, preserves assignments on a gh error, and prints remaining saved assignments for this node and repository first as `#<issue> epoch=<n>`; with none, its usual free-issue output applies. Plan approval, takeover, and a special ci-red owner rule are outside this assignment flow.
