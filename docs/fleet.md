# Split work across PCs

Fleet assigns free open issues with a shared node list and no server. Nothing about the PCs is written to GitHub.
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
It shows up to 14 nodes and reports any omitted nodes in its final line, staying within 15 lines.

`QC_FLEET_FILE` overrides the settings path. Otherwise Windows uses `%APPDATA%\qc\fleet.json`;
other systems use `$XDG_CONFIG_HOME/qc/fleet.json` or `~/.config/qc/fleet.json`.
The file contains `{ "self": "a1", "nodes": [{ "id": "a1", "weight": 1, "maxSize": "L", "active": true }] }`.
`init` creates parent folders and uses mode 0600 on POSIX; an existing file needs `--force` to replace it.
Without a file, fleet mode is off. `--repo` defaults to origin; supply it when outside a checkout.
Only a local matching checkout supplies `merge.holdLabel` from its root `qc.config.json`.

Free issues exclude `hold`, `merge.holdLabel` and `fleet-skip`. An open PR body naming `#<number>`,
a PR head branch, or an origin branch named `<prefix>/<number>-...` makes an issue taken.
Reads are bounded to 500 open issues and 200 open PRs. No qualifying active node means unassigned.
Fleet reads GitHub through `gh` and branches through git. It writes no labels, assignments or comments.

To take over a dead PC, edit the fleet file on **every** PC and set that node's `active` to false.
Only issues owned by that node move, among nodes that accept their size. Keep each PC's `self` unchanged.
Run `status` and `next` again. Set `active` back to true on every PC when it returns.
Push the usual issue branch when starting work so subsequent reads see it as taken.
Fleet is a static split, not a lock: coordinate node changes before starting more work.
