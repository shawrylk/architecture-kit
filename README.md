# architecture-kit

An architecture, and everything that enforces it, packaged so a new repository starts with both.

Vertical slices over a thin shared kernel. Tenant isolation at three independent levels. Guards for
create, update and offline replay that are deliberately three different mechanisms. Every rule ships
beside the check that enforces it — and every check ships a case that must fail.

## Two halves

| | Install | Holds |
|---|---|---|
| Plugin `architecture` | `claude plugin install` | agent hooks, 4 skills, 3 slash commands |
| Package `architecture-harness` | `pnpm add -D` | 11 gates, 10 lint rules, the `qc` CLI, doc templates |

The plugin's hooks call the package's CLI. Either half works alone: the package is an ordinary dev
dependency, and the plugin no-ops in any repository without a `qc.config.json`.

## Install

This repository is public, so both halves install from it directly — no token, no fork.

**The Claude Code plugin** (agent hooks, skills, slash commands):

```bash
claude plugin marketplace add shawrylk/architecture-kit
claude plugin install architecture@architecture-kit
```

**The npm package** (gates, lint rules, the `qc` CLI) — as a pinned git dependency, since it is not
published to a registry:

```bash
pnpm add -D github:shawrylk/architecture-kit#path:packages/qc-harness --save-exact
```

pnpm resolves and lockfiles this to an exact commit, so a later `pnpm update architecture-harness`
is the only thing that moves it. Continue with [Tutorial](#tutorial) below to wire it into a
repository.

## Tutorial

### 1. Set up a repository

```bash
pnpm add -D github:shawrylk/architecture-kit#path:packages/qc-harness --save-exact
npx qc init            # decisions, architecture & enforcement docs, config, git hooks, CI
npx qc install-hooks   # binds .githooks/pre-commit and .githooks/pre-push
```

`qc init` is not a convenience. The citations gate reads `docs/decisions.md`; without that file the
first gate fails on every source file you have.

It writes `qc.config.json`, `quality-thresholds.json`, `.jscpd.json`, `docs/` (decisions,
architecture, enforcement, guards, performance, glossary, ui), `.githooks/pre-commit`,
`.githooks/pre-push` and `.github/workflows/ci.yml`, skipping anything that already exists. It also
adds `spec:check`,
`gen:feature` and `prepare` to `package.json`.

### 2. Make it yours

- **`docs/decisions.md`** — delete what does not apply, add what you have already decided. Ids are
  stable: never renumber, because every citation points at a number.
- **`docs/glossary.md`** and the per-surface table in **`docs/performance.md`** — replace entirely.
- **`qc.config.json`** — point it at your layout where it differs. `npx qc config` prints what is in
  force after defaults merge.

Turn off, under `gates` and `rules`, whatever this repository genuinely lacks — workers, an edge
service, a contract directory. Do not weaken a gate that applies.

### 3. Scaffold a feature

```bash
npx qc feature orders          # bounded vertical slices
npx qc feature orders --flat   # the flat pipeline anatomy, for a single-operation feature
```

Never hand-build the folder. The generator is what makes a wrong anatomy impossible. An empty block
or slice is a review finding, so fill each file or delete the ones the feature does not need.

### 4. Check

```bash
npx qc check                 # every structural gate
npx qc check <file>...       # the fast per-file path a post-edit hook or a pre-commit hook takes
```

With files given, the check reads only the features that hold them, once each, and reports every
problem before it exits 1. It also runs the per-file English rules on exactly those files.

Every gate reads one file list: `git ls-files --cached --others --exclude-standard`, minus
`ignores`. A path git ignores, such as `.gitnexus/`, is invisible to every gate and to
`qc decisions`. Outside a git work tree, the check walks the tree instead.

### 5. Lint

Replace your eslint config with the preset, so rules and thresholds are imported, never restated:

```js
import { preset } from "architecture-harness/preset";
import tseslint from "@typescript-eslint/eslint-plugin";
import tsparser from "@typescript-eslint/parser";
import boundaries from "eslint-plugin-boundaries";
import sonarjs from "eslint-plugin-sonarjs";

export default preset({
  plugins: { tseslint, boundaries, sonarjs },
  languageOptions: { parser: tsparser, ecmaVersion: 2023, sourceType: "module" },
});
```

### 6. Hold an agent to the same rules

Install the plugin per [Install](#install) above, if you have not already.

A fast per-file pass runs after every edit; a full pass refuses to end a turn while the repository is
red. Add your own step to that full pass with `QC_STOP_EXTRA` in `.claude/settings.json`:

```json
{ "env": { "QC_STOP_EXTRA": "node scripts/headless-e2e.mjs" } }
```

A consuming repository keeps no hook scripts of its own.

### 7. Two git hooks, not one

`pre-commit` is the fast tier: staged-file lint, incremental types, and each touched feature's own
structure. `pre-push` is the full pass — every repository-wide gate (citations, the tenant
predicate, route agreement, sagas) — once per push instead of once per commit. A human and an agent
both go through the same two hooks; neither can commit past the fast tier or push past the full one.

### 8. Hold a swarm to its own scope

When one work order runs several agents against the same working directory, declare its exclusive
paths once, in a gitignored manifest:

```json
// .claude/work-order.local.json
{ "paths": ["frontend/src/platform/**", ".github/workflows/**"], "branch": "platform/rewrite" }
```

A `PreToolUse` hook then refuses any Write or Edit outside those globs, for every agent sharing that
directory — not just the one told to stay in scope. The optional `branch` field covers a different
failure: the shared directory's checked-out branch changing between one command and the next. The
edit-time hook only warns about it; the installed `pre-commit` hook is what actually refuses the
commit, since a branch violation is a fact about the commit, not about any one edit. Delete the
file, or narrow it, as the next work order starts. Absent the file, or absent `branch` within it,
nothing is restricted — the same opt-in rule every hook here follows.

This covers one working directory shared by several agents. An agent given its own git worktree
needs nothing further — it already cannot reach another work order's files.

A shell write does not reach the edit guard, so a `PostToolUse` hook on Bash and PowerShell runs
`git status` in each checkout the command named (its directory, `cd <dir>`, `Set-Location <dir>`,
`git -C <dir>`). It reports each changed path outside the declared paths, and each change on a
protected branch that git does not ignore. It warns and never reverts. A command that only reads
skips the check. For PowerShell, only known read verbs (`Get-*`, `Test-Path`, `Select-String`,
`Format-*`, and so on) and git reads skip it. An unknown command or a script block never does.

Two edits of one file in one parallel block race, and all but the last one are lost. A `PreToolUse`
hook claims each file that a Write, Edit, or MultiEdit names, per session and per agent, and denies
a second claim in the same block. The `PostToolBatch` event ends the block. Until an agent receives
its first `PostToolBatch` event, the result of the edit ends the claim instead. A claim expires after
60 seconds in any case.

A generated file changes only through its generator. A `PreToolUse` hook denies a Write, Edit, or
MultiEdit of a path that matches `generated.globs` in `qc.config.json`, and names
`generated.command`. The defaults are `["**/*.generated.*"]` and `pnpm codegen`. The glob `**/`
needs a folder, so a generated file at the top level needs its own glob. The hook also denies an
Edit whose `old_string` touches a `<!-- generated: ... -->` … `<!-- /generated -->` region of a
Markdown file, such as the rule-to-check table in `enforcement.md`.

A `PreToolUse` hook on Bash refuses a command that skips the gates: `git commit` or `git push` with
`--no-verify`, `git commit -n`, and `git -c core.hooksPath=...`. It also refuses a hand run of a hook
script, such as `node .../work-order-guard.mjs`, because a hand run writes a lease that blocks later
edits. A command that runs `node --test` or vitest is exempt from the second rule.

A subagent does not count its own tool calls, so a `PreToolUse` hook counts them for it.
`swarm.toolCallBudget` in `qc.config.json` sets the budget, and the default is 100. At 70% of the
budget, the agent gets a reminder to commit, push, and plan the hand-off, and again every 10 calls.
At the budget, only the hand-off runs: Read, read-only and `git add`, `commit`, and `push` commands,
and a Write to a path under `/handoffs/`. The main session is never counted.

Give each agent its own worktree beside the main checkout:

```bash
npx qc worktree add fix-login fix/login          # fetch, add ../fix-login from origin/main, install, print the path
npx qc worktree remove fix-login                 # refuse a dirty tree; delete it, then the branch once safe
```

`worktree.install` in `qc.config.json` is the install command, and the default is
`pnpm install --frozen-lockfile`. `worktree.base` is the default `--from`, and the default is
`origin/main`. `remove` deletes the branch only when `--from` holds it, or its upstream holds every
commit. It deletes the folder through Node, so a path past 260 characters on Windows does not stop
it. Both commands are idempotent.

## What it enforces

**Lint** — `no-cross-feature-internals`, `storage-only-in-resource`, `scoped-repository`,
`tenant-scoped-table`, `no-offset-pagination`, `no-status-literal`, `signal-last-param`,
`no-raw-fetch`, `no-orchestration-in-trigger`, `no-number-in-comment`.

**Gates**, for what lint cannot see — feature anatomy; citations (every cited id resolves, no
dangling doc path, no reference to another repository); the tenant predicate (every statement on a
business table filters on the tenant, including the one nobody wrote a test for); SQL identifiers (a
query names a column a migration declares); public and internal route agreement; claimed
requirements; headless pipelines; registry agreement.

Two more are generators your codegen imports rather than checks `qc check` runs: `tenant-tables`
(the row-level-security policy file) and `contract-compose`.

## Configuration

Every constant a gate could hardcode is a key in `qc.config.json`, and every key defaults to the
reference layout — a repository that matches it writes no config at all. Feature roots, layer set,
tenant column, ORM, the one module that may call `fetch`, the anatomy taxonomy, and an on/off switch
per gate and per rule.

A test fails if a switch ever stops reaching the runner, so the config cannot quietly lie about what
it controls.

### Mirror the tests of more than one root

The `test-mirror` gate judges every root in `testMirror.roots`. The default is one root:
`frontend/src` with `frontend/tests`.

- A test inside `src` fails as `unmirrored-test`.
- A test inside `tests` fails as `orphaned-test` when `src` has no file at its path, and no folder
  with an `index` there.
- A root with `match: "folder"` matches a test to its source **folder** instead of a file. Use it
  where a test covers a block that spans several files, such as a feature's `pipeline` or
  `resource`. Such a test passes when `src` holds a folder at its path. The default is
  `match: "file"`.
- A root with `testOnly: true` holds test support, such as a shared interop-test package. Its tests
  need no source file.

```json
{
  "testMirror": {
    "roots": [
      { "src": "frontend/src", "tests": "frontend/tests" },
      { "src": "backend/src", "tests": "backend/tests", "match": "folder" },
      { "src": "packages/testing/src", "tests": "packages/testing/tests", "testOnly": true }
    ]
  }
}
```

The list replaces the default, so name the frontend root again to keep it. The gate walks these
folders itself, so they need no entry in `paths.citable`. A test belongs to the first root whose
`tests` folder holds it, and otherwise to the first root whose `src` folder holds it.

## Tests

```bash
pnpm test   # 125: every rule, every gate, every knob, each with a case that must fail
```

CI also scaffolds a repository from an empty directory and requires a green `qc check`.
