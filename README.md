# architecture-kit

An architecture, and everything that enforces it, packaged so a new repository starts with both.

Vertical slices over a thin shared kernel. Tenant isolation at three independent levels. Guards for
create, update and offline replay that are deliberately three different mechanisms. Every rule ships
beside the check that enforces it — and every check ships a case that must fail.

## Two halves

| | Install | Holds |
|---|---|---|
| Plugin `architecture` | `claude plugin install` | agent hooks, 4 subagent types, 4 skills, 3 slash commands |
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
npx qc install-hooks   # binds .githooks/pre-commit, commit-msg and pre-push
```

`qc init` is not a convenience. The citations gate reads `docs/decisions.md`; without that file the
first gate fails on every source file you have.

It writes `qc.config.json`, `quality-thresholds.json`, `.jscpd.json`, `docs/` (decisions,
architecture, enforcement, guards, performance, glossary, ui), `.githooks/pre-commit`,
`.githooks/commit-msg`, `.githooks/pre-push` and `.github/workflows/ci.yml`, skipping anything that
already exists. It also adds `spec:check`, `gen:feature` and `prepare` to `package.json`.

`qc init` skips a workflow you already have. If you copied `ci.yml` before the kit set
`fetch-depth: 0` on its checkout step, add it: the threshold ratchet needs the merge base, and a
depth-1 clone has none, so the ratchet skips in CI.

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

While `commitMessage.conventional` is on, the default `hooks.required` also requires a `commit-msg`
hook that calls `qc commit-msg`. Setting `conventional` to `false` drops that requirement. A
repository upgrading from an earlier kit copies `templates/githooks/commit-msg` into its hooks
folder, or sets `conventional` to `false`.

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

### 9. Hold an orchestrator to the subagent workflow

The plugin ships four subagent types for `superpowers:subagent-driven-development`:

| Type | Model | Effort | Role |
|---|---|---|---|
| `architecture:sdd-planner` | `opus` | `high` | writes one plan and edits nothing else |
| `architecture:sdd-implementer` | `sonnet` | `high` | implements one task from a brief file, and writes a report file |
| `architecture:sdd-reviewer` | `sonnet` | `high` | reviews one task, read-only |
| `architecture:sdd-branch-reviewer` | `opus` | `high` | reviews the whole branch before merge, read-only |

Sonnet runs the implementer and the task reviewer. Opus runs only the planner and the branch
reviewer, whose job a task review cannot do: it judges cross-task interactions, security, and data
migrations against the plan and the spec, over the whole branch's diff.

None of the four can call the `Agent` tool. The two reviewers have no edit tools but keep the shell
for `git`, so their prompts hold them read-only.

A prose rule is lost in a long session or a compaction, so hooks hold the orchestrator to the
workflow. A `swarm.dispatch` section in `qc.config.json` turns them on. An empty section takes every
default:

```json
{ "swarm": { "dispatch": {} } }
```

A repository without the section sees no change.

A `PreToolUse` hook on the `Agent` tool refuses four kinds of dispatch, and each refusal names its
fix:

- A dispatch that names no `model` and no type in `allowedTypes`. An omitted type is
  `general-purpose`. A fork ignores `model`, so a fork passes only when `fork` is in `allowedTypes`.
  The hook cannot see `CLAUDE_CODE_SUBAGENT_MODEL_FORCE`: when it is `1`, Claude Code ignores every
  `model`, in the call and in each definition.
- A dispatch that names a `model` outside its type's families in `models`, or `*`'s families for a
  type with no entry. The refusal names the type, the model, and the allowed families. A model
  string carrying none of `models`' known families is refused the same way. A fork keeps the rule
  above instead, since it ignores `model`.
- A prompt longer than `maxPromptChars`. The brief goes in a file, and the prompt names its path.
- A dispatch of a type in `implementerTypes` while `implementerSlots` of them run in the session. The default is one.

The hook judges the dispatches of the main session only. A subagent's dispatch follows that
subagent's own definition, which is often another plugin's. The hook keeps `implementerSlots` fixed slot files per session under the OS temp folder, `slot-0.claim`
and up. A claim tries each slot in order with an exclusive create and takes the first one it makes, so
no group of dispatches in one parallel block passes the limit. Each file holds its holder's id. The
`Agent` call does not know the new agent's id, so a dispatch holds its own `tool_use_id`. A
`SubagentStart` of an implementer type rewrites one waiting slot to the new agent's id, so a dispatch
and its start count once. A `SubagentStop` removes the slot that holds its own agent's id. A stop
that finds none removes one waiting slot, as the single slot did. A `SubagentStart` with no waiting
slot takes a free one, so an implementer resumed through `SendMessage` holds one too, and it never
takes a slot over the limit. A slot with no stop expires after `slotMinutes`. A dispatch that passes
the hook can still be denied later, and then no stop comes. So the refusal names a slot file to
delete. At a limit of 1 it names the claim's time and file. Above 1 it also names each holder and the
limit.

A limit over 1 fits a repository whose work orders own disjoint paths. Each implementer then runs in
its own worktree.

A `SessionStart` hook adds one short note at each start, resume, clear, compaction, and fork. The note
names the workflow, the four types, the model tiers, and the one-implementer rule. When `implementerSlots` is over 1, the note adds one line that states the limit and replaces that rule.

| Key | Default | Meaning |
|---|---|---|
| `allowedTypes` | the four types, bare and with the `architecture:` prefix | the types that may omit `model` |
| `implementerTypes` | `["sdd-implementer", "architecture:sdd-implementer"]` | the types that share the slots |
| `maxPromptChars` | `12000` | the longest prompt, in characters |
| `slotMinutes` | `60` | when a slot with no stop expires |
| `implementerSlots` | `1` | how many implementers run at once in a session; a positive whole number |
| `models` | opus for the planner and the branch reviewer, sonnet for the implementer and the task reviewer, `["sonnet", "haiku"]` for `*` | the model families each type's named `model` may carry |

The bare names cover a copy of the agents in `~/.claude/agents`. A list replaces its default and
does not extend it. To allow `Explore` with no model, list it beside the eight default names.

`models` merges key by key with its default, so a repository can override one type without
repeating the rest. A family matches a bare alias (`sonnet`) or a full model id
(`claude-sonnet-...`), whichever it appears in, case-insensitive, so a new release under an
existing family needs no kit change. `models` constrains only a dispatch that names a `model`; a
dispatch with no model still runs its type's frontmatter model, which `models` does not touch.

### 10. Send a wide read or search to the repository's own tools

A session spends most of its tokens on whole-file reads and wide searches, when a repository often
has better tools: a semantic index, a call graph, a local summarizer. A `swarm.explore` section in
`qc.config.json` turns on three hooks that hold a session to the repository's own list:

```json
{
  "swarm": {
    "explore": {
      "tools": [
        { "name": "slm-rerank", "use": "find the files for a concept", "how": "slm-rerank -q \"<question>\" --stub -k 5" },
        { "name": "GitNexus", "use": "callers, callees, and blast radius", "how": "the gitnexus MCP tools" }
      ],
      "summarizer": "<command> | lfm-ask \"<question>\"",
      "maxReadLines": 300,
      "maxGrepLines": 80,
      "maxOutputChars": 20000,
      "exempt": []
    }
  }
}
```

A repository without the section sees no change. The kit names no tool; the repository lists its
own.

- **Read budget** — a `PreToolUse` hook on `Read` refuses a whole-file read (neither `offset` nor
  `limit`) of a text file over `maxReadLines` lines, and the refusal names the tools. The guard
  judges only a file in the session's own checkout: a file in no checkout, or in another one,
  images, PDFs, notebooks, and `exempt` globs pass with no change, as does a
  file within the budget. The same file read the same way passes on the very next attempt in the
  session, so a real need for the whole file costs one retry, never a standing exemption.
- **Search hint** — a `PostToolUse` hook on `Grep` adds context naming the tools when the answer
  runs past `maxGrepLines` lines. It never refuses anything.
- **Output hint** — a `PostToolUse` hook on `Bash` and `PowerShell` adds context naming the
  `summarizer` when the output runs past `maxOutputChars` characters. A `summarizer` of `null`
  turns this one hint off; the read budget and the search hint are unaffected.
- **Session note** — the tool list reaches the main session at start (section 9's note, even with
  `swarm.dispatch` off) and each subagent at its own `SubagentStart`, past a compaction included.
  `swarm.explore` with no `tools` adds nothing.

The read budget and the search hint report a bad key in `swarm.explore` as context instead of
stopping the call they are judging; the session note skips the tool line instead.

| Key | Default | Meaning |
|---|---|---|
| `tools` | `[]` | each `{ name, use, how }` the read budget and the search hint name |
| `summarizer` | `null` | the command the output hint names; `null` turns that hint off |
| `maxReadLines` | `300` | the read budget, in lines |
| `maxGrepLines` | `80` | the search hint's threshold, in lines |
| `maxOutputChars` | `20000` | the output hint's threshold, in characters |
| `exempt` | `[]` | globs the read budget never refuses |

### 11. Hold the workflow to its reviews

With `swarm.dispatch` on, more hooks hold the subagent workflow to its conventions. Each one reads or
writes one ledger: JSON lines in `<git common dir>/qc/ledger.jsonl`, shared by every worktree. The
record types are `dispatch`, `stop`, `verdict`, `merge`, and `issue-update`. `qc ledger [branch]`
prints them. Each check does nothing when `swarm.dispatch` is off in the repository it judges. That is the repository of the named worktree, and the repository of the working directory when no worktree is named.

| Check | Hook | What it refuses |
|---|---|---|
| Review record | `PreToolUse` on `SubagentHandback`, and `SubagentStop` | a reviewer report whose first line is not `VERDICT: <APPROVED\|CHANGES_REQUIRED> <sha>`, a sha that git reports as unknown in the repository of the named worktree, and a task review APPROVED with no `RED-CHECKED:` line. The stop records the verdict, the full sha, and the branch at that sha. A git failure or a timeout passes with a note, and the stop records the sha as written, with no branch. A sha with no named worktree that the working directory's repository lacks passes with a note, and the stop records no verdict |
| Test first | the same | an implementer report with no line that starts `RED:`, or none that starts `GREEN:` |
| Task review | `PreToolUse` on `Agent`, inside `dispatch-guard.mjs` | an implementer on a branch whose head holds an implementer commit that no verdict names. A controller commit after a reviewed head needs no review |
| Fix round | the same | a new implementer on a branch whose latest verdict is CHANGES_REQUIRED, unless the prompt has a `NO-RESUME: <reason>` line. The ledger records the reason. A resume through `SendMessage` passes |
| Merge guard | `PreToolUse` on `Bash` and `PowerShell` | a `gh pr merge` with no `--match-head-commit <sha>`, or with a sha that no APPROVED review of the `merge` kind names. A `gh api` call to a merge endpoint is refused outright. So is a `gh api` call that holds the `mergePullRequest` mutation in an argument or in a readable query file, and a query file the guard cannot read fails closed. A `gh api` call to a `repos/` path is not searched for the mutation. A merge that names a repository other than `origin` passes with a note, whether it names it with `-R`, `--repo`, a PR URL, or `GH_REPO`. After the merge, `PostToolUse` and `PostToolUseFailure` record the PR and each issue it names. Only `Refs`, `Closes`, `Fixes`, and `Resolves` lines in the PR body name issues to update |
| Issue update | `Stop` | the end of a turn while a PR this session merged names an open issue with no comment since the merge. A pending `--auto` merge resolves at the stop |
| Controller | `PreToolUse` on `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` | a main-session edit in a checkout of the repository outside `controllerPaths` |
| Plan check | `PreToolUse` on `SubagentHandback` and `SubagentStop` of a planner, and `qc plan-check <plan.md>` | a plan with a task that names no file, has no test step or no commit step, or estimates more than `maxTaskCalls` |

The hooks read these markers:

| Marker | Where | Meaning |
|---|---|---|
| `Worktree: <absolute path>` | one line of an implementer or reviewer prompt | the worktree the task gate judges, in an implementer prompt and in a reviewer prompt, where it sets the branch of the verdict. A prompt without it is no task, and the gate lets it pass. An implementer stop records a head only from the line of its own prompt |
| `NO-RESUME: <reason>` | one line of an implementer prompt | a fresh implementer after CHANGES_REQUIRED. The reason goes in the ledger |
| `PLAN: <absolute path>` | the first line of a planner report | the plan the plan check reads |
| `VERDICT: <APPROVED\|CHANGES_REQUIRED> <sha>` | the first line of a reviewer report | the verdict and the head it judged. A short or upper-case sha resolves to the full one |
| `RED:` and `GREEN:` | one line each of an implementer report | the failing run, then the passing run |
| `RED-CHECKED:` | a line of a task reviewer's APPROVED report | the reviewer saw the test fail before the code |
| `Test: none — <reason>` | a line of a plan task | a task with no test step, such as a docs task. It needs a reason of three words or more, and it does not cover a task that changes a source file |
| `**Estimate:** <n> tool calls` | a line of a plan task | the size the plan check compares with `maxTaskCalls` |

In auto mode, a subagent reports through `SubagentHandback`, and its stop then carries only closing
text. So each report check judges the hand-back first, and the stop reads the hand-back it kept. A
subagent with no hand-back is judged at its stop, on its last message.

A `gh` identity set in the command, such as `GH_CONFIG_DIR=~/.config/gh-personal gh pr merge ...`, applies
to the `gh` calls that the merge record and the issue gate make. They also replay the same `-R` repository
and PR selector. The record keeps only `GH_CONFIG_DIR` and `GH_HOST`, never a token.

| Key | Default | Meaning |
|---|---|---|
| `merge` | `"branch"` | the review kind whose APPROVED verdict lets a merge run; `"task"` fits a one-task PR |
| `maxTaskCalls` | `35` | the largest estimate one plan task may carry |
| `controllerPaths` | `["docs/**", "*.md", "qc.config.json", "**/.claude/**"]` | the globs the main session may edit; a path outside every checkout of the repository always passes |
| `reviewerTypes` | `{ task: [...], branch: [...] }`, the plugin's two reviewers, bare and scoped | the agent types whose stop records a verdict of each kind |
| `plannerTypes` | the plugin's planner, bare and scoped | the agent types whose report runs the plan check |

The keys go under `swarm.review`. A list replaces its default, and `reviewerTypes` merges kind by kind.

Known limits:

- The ledger guards against forgetting, not against forgery. An agent with a shell can append a line.
- Shell writes are reported only. The controller guard sees the edit tools, and the shell edit guard reports a `Bash` or `PowerShell` write outside the controller paths.
- The merge guard reads the command text. It reads through these wrappers: `env`, `sudo`, `doas`, `command`, `builtin`, `exec`, `time`, `nice`, `ionice`, `stdbuf`, `setsid`, `nohup`, and `timeout`. It also reads `bash`, `sh`, `zsh`, `dash`, and `ksh` with `-c` (`-lc` too), `pwsh -Command`, `eval`, a leading `!`, and `if`, `while`, and `until` blocks. It reads a quoted keyword as a keyword. It does not see a merge behind these:
  - `xargs`, and `find -exec`
  - `env -S 'cmd'`
  - a backtick command substitution, `cmd /c`, and `Start-Process`
  - a PowerShell `try { }`, a `% { }` block, and a command after the first `{ }` block of one line, as in `else { }`
  - any other wrapper
- A merge on the web page passes the merge guard.
- The merge guard judges a `gh pr merge` against the repository of its working directory. `cd ../other && gh pr merge` in one command is judged against the ledger of the working directory's repository, not the one it merges in.
- An `--auto` merge that has not merged when the command returns has no record until the issue gate resolves it.

## What it enforces

**Lint** — `no-cross-feature-internals`, `storage-only-in-resource`, `scoped-repository`,
`tenant-scoped-table`, `no-offset-pagination`, `no-status-literal`, `signal-last-param`,
`no-raw-fetch`, `no-orchestration-in-trigger`, `no-number-in-comment`, `ime-safe-key`,
`registry-literal`, `no-sql-raw`, `mutation-control-pending` (off by default).

The preset also refuses an exemption written in a file. `noInlineConfig` makes ESLint ignore an
`eslint-disable` comment and report it as a warning, so a run with `--max-warnings 0` fails on it.
With `tseslint` supplied, `@typescript-eslint/ban-ts-comment` bans `@ts-ignore` and `@ts-nocheck`,
and allows `@ts-expect-error` with a description.

**Gates**, for what lint cannot see — feature anatomy; citations (every cited id resolves, no
dangling doc path, no reference to another repository); the tenant predicate (every statement on a
business table filters on the tenant, including the one nobody wrote a test for); SQL identifiers (a
query names a column a migration declares, every column of a comma list of `add column` included);
migration numbers (unique, with no gap); public and internal route agreement; claimed requirements;
headless pipelines; registry agreement; registry readers; registry literals in the docs; the
threshold ratchet.

Two more are generators your codegen imports rather than checks `qc check` runs: `tenant-tables`
(the row-level-security policy file) and `contract-compose`.

## Configuration

Every constant a gate could hardcode is a key in `qc.config.json`, and every key defaults to the
reference layout — a repository that matches it writes no config at all. Feature roots, layer set,
tenant column, ORM, the one module that may call `fetch`, the anatomy taxonomy, and an on/off switch
per gate and per rule.

A test fails if a switch ever stops reaching the runner, so the config cannot quietly lie about what
it controls.

### Guard IME composition in text entry

`qc/ime-safe-key` reads `onKeyDown` and `onKeyUp` on `input`, `textarea`, a `contentEditable`
element, and each component in `ime.components`. An Enter or Escape branch must return early on
the IME guard first. A row or a button that reacts to Enter is not text entry, so the rule skips it.

```json
{ "ime": { "components": ["Input"], "guards": ["isImeComposing"] } }
```

With `ime.guards` set, only a call to one of them counts, and an inline `isComposing` or
`keyCode === 229` check is reported as a second mechanism. With no guard set, either inline check
counts.

### Show the pending state on a write control

`qc/mutation-control-pending` reads `onClick`, `onSelect`, and `onConfirm`. A handler that calls
`.mutate(` or `.mutateAsync(` must sit on a control that shows the write is pending. Two shapes
pass:

- The element is the configured button and carries the pending prop, such as `loading={m.isPending}`.
- The element has both `disabled` and `aria-busy`.

A handler that returns the `mutateAsync` promise also passes: an arrow with the call as its
expression body, or a direct `return`. A promise stored in a variable does not count. `mutate`
returns nothing, so returning it does not count either.

```json
{
  "rules": { "mutation-control-pending": true },
  "mutationControl": { "button": "Button", "prop": "loading", "handlers": ["onClick", "onSelect", "onConfirm"] }
}
```

The rule ships off. The preset applies it to `clientFiles`.

### Let a reviewed file call `sql.raw`

`qc/no-sql-raw` refuses `sql.raw` everywhere except the paths in `sqlRaw.allow`. Each path is a
file a person reviewed, matched as a path suffix. The tooling files (`toolingFiles`) are exempt,
like every `qc/*` rule.

### Name who may hold a registry number

An entry in `quality-thresholds.json`, or in any registry the `registry-literal` gate reads, can carry two more keys:

| Key | What it holds |
| --- | --- |
| `names` | Regular expressions for identifiers that restate the entry. Each one matches the whole identifier, case-insensitive. |
| `readers` | Repository paths that may hold the number, matched as a path suffix. |

```json
"holdpress": { "value": 400, "names": ["(\\w+_)?HOLD(_\\w+)?_MS"], "readers": ["frontend/src/platform/gesture-thresholds.ts"] }
```

`qc/registry-literal` reports a numeric literal bound to a matching name, in a variable, a property
or a class field, in any file that is not a reader. The `registry-readers` gate fails when a reader
does not exist, or never names the entry key, as a string or through the registry accessor. Both the rule and the gate read every registry the `registry-literal` gate reads, not only the thresholds.

### Keep registry figures out of the docs

The `registry-literal` gate reads every `.md` file under `docs.root`. It reports two kinds of figure:

- A threshold: the number of an entry in `quality-thresholds.json`, within six words of a phrase in the
  entry's `match` list, in the same paragraph. The number carries the entry's unit or none. Another
  number near the phrase passes.
- A version: a library `label` from `versions.json`, followed by a version number.

Write `{{q:<id>}}` for a threshold and `{{ver:<id>}}` or `{{v:<id>}}` for a version. The ADR log may
state a figure, because a decision states the number as of its date. That log is each file under
`adr.root` and the decision register `docs.decisions`. Set `registryLiteral.exempt` to a list of
globs to replace it.

```json
{ "versions": "versions.json", "registryLiteral": { "exempt": ["docs/decisions/**", "docs/history.md"] } }
```

A number may carry its token in an HTML comment: `0 <!-- q:maxwarnings -->`. The comment is invisible
when the page renders. The gate accepts the number when it equals the entry's current figure. A number
that differs fails as `stale-annotated-number`, and it names the entry and the current figure. An id
that no registry holds fails as `unknown-token`. An entry that has no figure under its `valueKey`
fails as `entry-without-value`. Put the comment right after the number, before its unit:
`15 <!-- ttl:accesstoken --> minutes`. The number and its comment share one line.

`registryLiteral.registries` adds registries to the two above, which always apply. Each item has a
`path`, the `key` of the object that holds the entries, and a token `prefix`: a word, or a list of
words. An item may set `valueKey` for the field that holds the figure (default `value`) and `unitKey`
for the field that holds its unit (default `unit`). An entry with a numeric figure and a `match` list
gets the phrase scan. An item with the `path` of `thresholds` or `versions` replaces that registry.
`libraries` from `versions` still feeds the label scan.

An item that is malformed, a listed file that is missing or not JSON, a `key` that is no object, and a
prefix that two registries share each fail as a `registry-literal` problem at `qc.config.json`. Only a
built-in registry whose file is absent is silent.

The ESLint rule `qc/registry-literal` reads the same registries. An entry with `names` restricts the
identifiers, as before. An entry in any registry that lists `readers` and no `names` restricts its
figure: a numeric literal equal to it fails in code outside those readers.

```json
{
  "registryLiteral": {
    "registries": [{ "path": "session-lifetimes.json", "key": "lifetimes", "prefix": "ttl" }]
  }
}
```

### Loosen a threshold only with a decision

The `threshold-ratchet` gate compares each entry of `quality-thresholds.json` with the same entry at
`git merge-base <ratchet.base> HEAD`. A `max` that rises or a `min` that falls fails, unless the
change touches an ADR file (the ADR log above) whose text names the entry key. A new entry passes.
With no git, no commit, no `ratchet.base` ref, or no merge base, as in a shallow clone, the gate
prints an `OK` line that says why it skipped.

```json
{ "ratchet": { "base": "origin/main" } }
```

### Number the migrations without a gap

The `migration-numbers` gate reads the `<number>_<name>.sql` files in `paths.migrations`. Each number
is unique, and the numbers run from the lowest to the highest with no gap.

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

### Pair the two surfaces

The `parity` gate ships off. It compares the features in `paths.serverFeatures` with those in
`paths.frontendFeatures`, and the slice files in each feature's `anatomy.slice.sliceDir`. A route that
`paths.triggerFile` imports from the slice folder needs a slice on both surfaces.

- A feature or a slice on one surface only fails as `one-sided-feature` or `one-sided-slice`.
- The registry at `parity.registry` names each divergence with its reason: `backendOnlyFeatures`,
  `frontendOnlyFeatures`, and `slices` by feature. A reason that starts with `Client-only` or
  `Backend-only` names the side that must hold the slice.
- An entry that stops being true fails as `stale-divergence`.
- A slice file whose every value export is a function that does nothing fails as
  `placeholder-slice`. A no-op body is empty, or holds only `void 0`, `return`, or `return undefined`.

```json
{ "gates": { "parity": true }, "parity": { "registry": "contracts/parity.json" } }
```

### Make an integration test reach the product

The `integration-imports` gate ships off. Each file under `integrationImports.roots` that
`integrationImports.subject` matches must import a product module. A relative import counts inside
a folder of `productRoots`, and outside one only when it names such a folder. An import that matches
a pattern of `productPackages` counts anywhere. A test that imports none fails as
`integration-without-product`, and no matching file at all fails as `no-integration-tests`.

```json
{ "gates": { "integration-imports": true }, "integrationImports": { "productPackages": ["^@app/(?:domain|contracts)(?:/|$)"] } }
```

### Give every key of a closed set a writer

The `closed-set-writers` gate ships off. Each entry of `closedSetWriters.sets` names the `source`
that declares the keys, a `key` pattern and a `writer` pattern whose first group is a key, and the
`roots` that hold the writers. A key with no writer fails as `unwritten-key`, unless `declaredAhead`
names it with the mutation it waits for. A waiting key that is written now, or no longer declared,
fails as `stale-declared-ahead`. A written key outside the set fails as `undeclared-write`.

```json
{
  "gates": { "closed-set-writers": true },
  "closedSetWriters": {
    "sets": [{
      "name": "AUDIT_ACTIONS",
      "source": "backend/src/features/audit-log/shared/types.ts",
      "key": "\\{ key: \"([a-z_.]+)\", category:",
      "roots": ["backend/src/features"],
      "writer": "recordAuditLogEntry\\([\\s\\S]{0,400}?action: \"([a-z_.]+)\"",
      "declaredAhead": { "project.delete": "no delete-project route exists" }
    }]
  }
}
```

### Keep a claim in a document true

The `doc-claims` gate ships off. Each document in `docClaims.files` can hold fenced `state-claim`
blocks. A block names a `file:` and its `lines:` count, and fails as `stale-doc-claim` when the count
changes or the file is gone.

````md
```state-claim
file: src/big-module.ts
lines: 412
```
````

### Require an idempotency key on every write

The `contract-idempotency` gate ships off. It reads the composed contract at `contract`, the one path every contract gate shares. Every
`POST`, `PUT`, `PATCH` and `DELETE` must carry one of `idempotency.keys` as a request-body property or
a parameter. The gate follows a `$ref` body into `components.schemas`, and each `allOf` part, once each.

- The `yaml` package reads the contract. It is an optional peer dependency: run `pnpm add -D yaml`. A
  repository that turns the gate on without it fails as `contract-reader-unavailable`.
- A write without the key fails as `missing-idempotency-field`.
- The ledger at `contractIdempotency.legacy` is a JSON array of operation-id strings. An operation with no
  `operationId` is named `METHOD /path`, as in `POST /v1/boards`. A listed operation passes.
- A ledger entry fails as `legacy-now-declares` when its operation now declares the key, no longer
  exists, or needs no key.
- A ledger id fails as `legacy-grew` unless every operation that carries it matches an operation at the
  merge base with `ratchet.base`: the same id, method and path. An id new to the ledger also needs that
  base operation to have lacked its key. A reused id, a dropped key and a moved path all fail. Renaming
  a path parameter on a ledgered operation changes its path, so it fails as a moved path. An id the base
  ledger already listed fails too. Two operations with one `operationId` fail as
  `duplicate-operation-id`. The ledger cannot absorb a new write. A base contract that does not parse
  fails as `unreadable-base-contract`. With no merge base, as in a shallow clone or with no git, the
  check is skipped and `qc check` prints a `NOTE` line.
- A `DELETE` whose last path segment is a parameter is exempt. Set `exemptDeleteById` to `false` to
  judge it too.
- An absent contract file is ordinary: the gate reports nothing.

```json
{
  "gates": { "contract-idempotency": true },
  "contract": "contracts/openapi.yaml",
  "contractIdempotency": {
    "legacy": "contracts/idempotency-legacy.json",
    "exemptDeleteById": true
  }
}
```

### Serve exactly the operations of the contract

The `contract-routes` gate ships off. It reads the composed contract at `contract`, as
`contract-idempotency` does, and each route in a feature's `trigger.ts`. A route is a
`{ method: "post", path: "/v1/boards" }` object, with `method` before `path`.

- A route with no operation of its method and path fails as `route-not-in-contract`.
- An operation that no trigger serves fails as `operation-not-served`.
- A route's `:id` and a contract's `{id}` are one segment, whatever the name. The method matches in any case.
- `contractRoutes.exempt` lists `{ method, path, why }` entries for a route or an operation that
  has no partner, such as an internal worker route. An entry fails as `stale-route-exemption` when
  it excuses nothing: no route lacks its operation there, and no operation lacks its route.
- Every entry needs a string `method`, a string `path` and a non-empty `why`. An entry without a `why`
  fails as `exemption-without-reason`. An entry that is not an object with a string method and path,
  and an `exempt` that is not an array, fail as `malformed-exemption`. A bad entry excuses nothing.
- A route inside a `//` or `/* */` comment is not served.
  The comment stripper does not read regex literals, so a quote inside one can make a later commented route count.
- The `yaml` package reads the contract, as for `contract-idempotency`. An absent contract file is
  ordinary: the gate reports nothing.
- The gate does not compare a client's request paths with the contract.

```json
{
  "gates": { "contract-routes": true },
  "contract": "contracts/openapi.yaml",
  "contractRoutes": {
    "exempt": [
      { "method": "post", "path": "/v1/internal/photos/:photoId/derivatives", "why": "a worker callback" }
    ]
  }
}
```

### Declare every schema column in a migration

`sql-identifiers` also reads the `paths.schemaFile` of each server feature. Each table that a
`tenant.tableFactory` call declares, and each column under it, must appear in some migration, or
it fails as `schema-without-migration`. Until `paths.migrations` holds its first `.sql` file, there
is nothing to compare with, and the check does not run.

### Check the callers of an exempt helper

A helper that takes its table or its columns from its caller carries a `tenant-predicate: exempt`
comment. `tenant-predicate` then checks each call of the helpers in `tenantPredicate.exemptHelpers`,
in every non-test file that imports the helper from its `module`. The argument at index `argument`
must name the tenant: the `tenant.sqlColumn` as a quoted string or an object key, or the
`tenant.column` identifier. A bare name is followed to its own declaration, and a call to a local
function to that function's body. A call that names no tenant fails as `unscoped-helper-call`.

The gate reads a named import, a namespace import whose member call is the helper
(`crud.insertReturning(`), and a path alias that `tenantPredicate.tsconfig` resolves. Point that
setting at the file that holds `paths`: it defaults to `tsconfig.json` at the root, and a
repository whose `paths` live in `backend/tsconfig.json` must say so. That file is read alone:
`compilerOptions.baseUrl` and `paths` count, and an `extends` chain is not followed. A file with no
such tsconfig has no aliases.

The gate parses each scanned file once into a record of its imports and exports. It then finds
every name that denotes the helper by a fixed point over those records. These forms all map back to
the helper, through any number of barrels and around any cycle:

- `export { insertReturning as insertRow } from "./crud"`
- `export * from "./crud"`, and `export * as crud from "./crud"`, also nested as `db.crud`
- `export const insertRow = insertReturning`, and `export { insertReturning as insertRow }`
- a default export of the helper, and a default import of it

The gate checks the calls `insertRow(`, `crud.insertReturning(`, and `db.crud.insertReturning(`. It
reads `import{x}from"y"` with no whitespace. The work is bounded: after 50,000 worklist steps over
all helpers, the gate stops and reports one `unresolved-helper-import` that names the budget.

A file fails as `unresolved-helper-import` when it reaches the helper in a form the gate cannot
follow:

- It imports the helper's name, or a namespace of its module, by a specifier the gate cannot
  resolve to that module, such as an alias with no matching path.
- It imports any name from an opaque module.
- It imports the helper and uses the local name other than by a call, an import, or an export. That
  covers `const f = insertReturning`, a destructure, and `wrap(insertReturning)`. `typeof` and an
  object key are not uses. This file is opaque too.

A module is opaque when it does the third, or when it has an `export *` from a local-looking
specifier that resolves to nothing. A local-looking specifier is a `paths` prefix, `@/`, `~/`, `#`,
or a relative path outside `paths.citable`. A named re-export from such a specifier makes that name
opaque. Opacity travels through re-exports and cycles. A package specifier such as `zod` is never
opaque. A namespace nested more than four names deep makes its module opaque as well. Import the
helper from its own module, add the folder to `paths.citable`, or map the alias.

The gate passes each of these unseen:

- `require()`
- a dynamic `import()`
- an `import type`
- a `*` that is not at the end of a `paths` pattern: a renamed import through that alias passes
  unseen, and an `export *` through it is opaque
- a renamed name imported from an unscanned local file: `import { put } from "../outside"` passes
  unseen, and `import { insertReturning } from "../outside"` fails

The kit ships these two defaults in `tenantPredicate.exemptHelpers`:

```json
{
  "tenantPredicate": {
    "exemptHelpers": [
      { "module": "backend/src/application/sql/crud.ts", "name": "insertReturning", "argument": 2 },
      { "module": "backend/src/application/sql/crud.ts", "name": "updateVersionedRow", "argument": 3 }
    ]
  }
}
```

Two keys hold the list. A repository adds a helper to the second, and the kit defaults stay:

| Key | Holds | A repository |
|---|---|---|
| `tenantPredicate.exemptHelpers` | The kit defaults | Leaves it alone. A value here replaces the list. |
| `tenantPredicate.extraExemptHelpers` | The repository's own helpers | Appends to the defaults. It ships empty. |

```json
{
  "tenantPredicate": {
    "extraExemptHelpers": [
      { "module": "backend/src/application/sql/bulk.ts", "name": "insertMany", "argument": 1 }
    ]
  }
}
```

`qc check` reads the two lists as one, and checks a helper that both name once. With the
`config-floor` gate on, a kit default that neither list names fails as `dropped-default-helper`. A
default named in either list counts as kept. The detail names the entry by `module` and `name`. To drop a default on purpose, cite a decision id, or `off-by-design`, under
`floor.exemptions` with the key `tenantPredicate.<name>`:

```json
{
  "floor": { "exemptions": { "tenantPredicate.updateVersionedRow": "QC-011" } }
}
```

## Tests

```bash
pnpm test   # 125: every rule, every gate, every knob, each with a case that must fail
```

CI also scaffolds a repository from an empty directory and requires a green `qc check`.
