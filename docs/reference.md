# Reference

Every command, hook, gate, and key of the kit. The [README](../README.md) covers the core that every
repository gets.

The reference architecture: vertical slices over a thin shared kernel. Tenant isolation at three independent levels. Guards for
create, update and offline replay that are deliberately three different mechanisms. Every rule ships
beside the check that enforces it — and every check ships a case that must fail.

## Two halves

| | Install | Holds |
|---|---|---|
| Plugin `architecture` | `claude plugin install` | agent hooks, subagent types, skills, slash commands |
| Package `architecture-harness` | `pnpm add -D` | gates, lint rules, the `qc` CLI, doc templates |

The plugin's hooks call the package's CLI. Either half works alone: the package is an ordinary dev
dependency. In a repository without a `qc.config.json`, the plugin's hooks do nothing, and each skill
tells the agent that its rules do not apply.

## Install

This repository is public, so both halves install from it directly — no token, no fork.

**The Claude Code plugin** (agent hooks, skills, slash commands):

```bash
claude plugin marketplace add shawrylk/architecture-kit
claude plugin install architecture@architecture-kit
```

The `sdd-*` subagent types and the `codex` skill follow the `subagent-driven-development` skill of the
`superpowers` plugin. Install it if you use them:

```bash
claude plugin install superpowers@claude-plugins-official
```

**The npm package** (gates, lint rules, and the `qc` CLI):

```bash
pnpm add -D architecture-harness --save-exact
```

The exact version and the lockfile keep the installed package fixed until you update it.
Continue with [Tutorial](#tutorial) to set up your repository.

## Tutorial

### 1. Set up a repository

```bash
pnpm add -D architecture-harness --save-exact
npx qc init            # config, an empty decision register, git hooks, CI
npx qc init --full     # also the reference architecture docs, their decisions, and the PR policy
npx qc install-hooks   # binds .githooks/pre-commit, commit-msg and pre-push
```

`qc init` writes `qc.config.json`, `docs/decisions.md` with an empty table, `.githooks/pre-commit`,
`.githooks/commit-msg`, `.githooks/pre-push`, and `.github/workflows/ci.yml`. It skips a file that
exists. `featureRoots` lists each `features` folder that init finds, and an empty list turns the
feature gates off. It adds `spec:check` and `prepare` to `package.json`, and `.worktree/` to `.gitignore`.

`qc init --full` also writes the reference architecture: `quality-thresholds.json`, `.jscpd.json`, the
docs (architecture, enforcement, guards, performance, pagination, glossary, ui) with their decisions,
`.github/workflows/pr-policy.yml`, and the Vale style.

`qc init` skips a workflow you already have. If you copied `ci.yml` before the kit set
`fetch-depth: 0` on its checkout step, add it: the threshold ratchet needs the merge base, and a
depth-1 clone has none, so the ratchet skips in CI.

### 2. Make it yours

- **`docs/decisions.md`** — delete what does not apply, add what you have already decided. Ids are
  stable: never renumber, because every citation points at a number.
- After `--full`, **`docs/glossary.md`** and the per-surface table in **`docs/performance.md`** — replace entirely.
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

The files cite `docs/architecture.md`, so `qc feature` needs `qc init --full` first. It adds its root
to `featureRoots` when the root is missing there.

### 4. Check

```bash
npx qc check                 # every structural gate
npx qc check <file>...       # the fast per-file path a post-edit hook takes
npx qc check --files-from -  # the same path, with NUL-separated files on stdin; no length limit
```

With files given, the check reads only the features that hold them, once each, and reports every
problem before it exits 1. It also runs the per-file English rules on exactly those files.

```bash
npx qc typecheck             # the typecheck script of package.json, else tsc --noEmit
```

`qc typecheck` runs the `typecheck` script when `package.json` has one. Else it runs the installed
`tsc`: `--noEmit`, or `-b` for a tsconfig with project references. It prints a note and exits 0 when
the repository has neither.

The `pre-commit` hook sends the staged files to `qc check --files-from -` on stdin, so a commit of any size
stays under the command-line limit of `npx.cmd` on Windows (8191 characters). `--files-from <path>` reads a file.
An empty list checks nothing.

Every gate reads one file list: `git ls-files --cached --others --exclude-standard`, minus
`ignores`. A path git ignores, such as `.gitnexus/`, is invisible to every gate and to
`qc decisions`. Outside a git work tree, the check walks the tree instead.

### Shared user configuration

The root `user-config/` folder holds the shared Claude status line, Claude settings, and Codex settings.
The plugin includes this folder. The npm package stages the same files during `prepack`.

```bash
npx qc user-config check
npx qc user-config apply --dry-run
npx qc user-config apply
npx qc user-config capture --dry-run
npx qc user-config capture
```

Run `apply` yourself after installing the release. It merges shared keys and copies the status line.
Each changed file gets a `<file>.bak-<yyyymmdd-hhmmss>` backup before the write.
The command prints each changed key. Matching files keep their contents and modification times.
`--dry-run` prints changes without writing files or backups.

`check` exits with `0` when settings match, `1` for drift, and `2` for a configuration or usage error.
`apply` and `capture` exit with `0` on success and `2` on error.
`capture` updates the kit files from your machine and backs up changed kit files.
Review the captured diff before committing it.

Claude shares `cleanupPeriodDays`, `syncClaudeAiPlugins`, `env`, `permissions`, `model`, `skillOverrides`, `statusLine`, `enabledPlugins`, `extraKnownMarketplaces`, `effortLevel`, and `modelSettings`.
It also shares `awaySummaryEnabled`, `autoUpdatesChannel`, `tui`, `skipWorkflowUsageWarning`, `theme`, `autoCompactEnabled`, `autoContinueAtUsageLimit`, `agentPushNotifEnabled`, and `skipAutoPermissionPrompt`.
Only `CLAUDE_CODE_DISABLE_MOUSE` and `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP` are shared under `env`.
Only `defaultMode` is shared under `permissions`.
The `statusLine.command` stays `node "${CLAUDE_CONFIG_DIR:-$HOME/.claude}/statusline.js"`.
The status line needs a Nerd Font for its powerline glyphs.

Codex shares `approval_policy`, `default_permissions`, `model`, `model_reasoning_effort`, `model_auto_compact_token_limit`, `model_post_turn_compact_threshold_percent`, and `service_tier`.
It also shares `enabled` in each listed `[plugins."<name>"]` table.
Register remote Codex marketplaces separately before enabling their plugins.
Codex leaves `notify`, `[desktop]`, marketplace definitions, and other local tables alone.
Capture excludes plugins from local marketplaces.

An omitted shared key keeps its machine value.
Claude plugin and marketplace maps merge by entry. Codex plugin tables merge by field.
Other Claude values replace their listed key. The TOML editor preserves unrelated lines and comments.
Claude capture includes remote Git and GitHub marketplaces and excludes directory marketplaces and their plugins.

The defaults use `os.homedir()`, `CLAUDE_CONFIG_DIR`, and `CODEX_HOME` on Windows and POSIX systems.
Use `--kit-dir`, `--claude-dir`, or `--codex-dir` to select another folder.
The command reads only the settings files and the status line.
It refuses `.claude.json`, `.credentials.json`, and `auth.json`, including symbolic links to those filenames.

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

```bash
npx qc lint                  # the lines changed since the merge base with check.base, untracked files included
npx qc lint --staged         # the lines the index changes
npx qc lint --base <ref>     # the lines changed since the merge base with <ref>
npx qc lint <file>...        # the changed lines of these files only
```

`qc lint` runs the ESLint of the repository and reports only a problem on a changed line. A problem
that the repository already had never blocks a change, so a repository adopts the preset without a
cleanup first. Without a merge base, the diff starts at `HEAD`. Without ESLint, `qc lint` prints a
note and exits 0.

### 6. Hold an agent to the same rules

Install the plugin per [Install](#install) above, if you have not already.

A fast per-file pass runs after every edit: `qc lint` and `qc check` on the edited file. At the end
of a turn, the stop gate runs `qc typecheck`, `qc lint` on the changed lines, and `qc check`. A red
result blocks the stop. A stop on a checkout unchanged since the last green pass skips the gate. If the
next stop shows the same failure, the gate ends the turn with a note that names it. A changed failure
blocks again. A drift of the kit setup, from `qc doctor` or `hook-drift`, is a note and never blocks. Add
your own step to that full pass with `QC_STOP_EXTRA` in `.claude/settings.json`:

```json
{ "env": { "QC_STOP_EXTRA": "node scripts/headless-e2e.mjs" } }
```

A consuming repository keeps no hook scripts of its own.

### 7. Two git hooks, not one

`pre-commit` is the fast tier: `qc lint --staged`, `qc typecheck`, and each touched feature's own
structure. `pre-push` is the full pass — every repository-wide gate (citations, the tenant
predicate, route agreement, sagas) — once per push instead of once per commit. A human and an agent
both go through the same two hooks; neither can commit past the fast tier or push past the full one.

While `commitMessage.conventional` is on, the default `hooks.required` also requires a `commit-msg`
hook that calls `qc commit-msg`. Setting `conventional` to `false` drops that requirement. The
conventional rules are commitlint's. Without commitlint in the repository, they skip, and the hook
prints the install command. A
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
`git -C <dir>`, or a `--work-tree` or `GIT_WORK_TREE` directory, which `checkout` and `restore` write to). It names a `--git-dir` or `GIT_DIR` with no work tree as unresolved. It reports each changed path outside the declared paths, and each change on a
protected branch that git does not ignore. It warns and never reverts. A command that only reads
skips the check. For PowerShell, only known read verbs (`Get-*`, `Test-Path`, `Select-String`,
`Format-*`, and so on) and git reads skip it. An unknown command or a script block never does.

A generated file changes only through its generator. A `PreToolUse` hook denies a Write, Edit, or
MultiEdit of a path that matches `generated.globs` in `qc.config.json`, and names
`generated.command` when it is set. The default glob is `["**/*.generated.*"]`. The glob `**/`
needs a folder, so a generated file at the top level needs its own glob. The hook also denies an
Edit whose `old_string` touches a `<!-- generated: ... -->` … `<!-- /generated -->` region of a
Markdown file, such as the rule-to-check table in `enforcement.md`.

A `PreToolUse` hook on Bash refuses a command that skips the gates: `git commit`, `git push`,
`git merge`, `git rebase` or `git am` with `--no-verify`, and `git commit -n`. It also refuses a change
of `core.hooksPath` through `git -c`, `git --config-env`, `git config`, `GIT_CONFIG_PARAMETERS` or
`GIT_CONFIG_KEY_<n>`. It also refuses a hand run of a hook script, such as
`node .../work-order-guard.mjs`, because a hand run writes a lease that blocks later edits. A command
that runs `node --test` or vitest can run a hook script.

The guard reads the command and never runs it, so it cannot see through a variable, a decoded string, a
config file that `GIT_CONFIG_GLOBAL` names, or a deleted hook file. For example,
`f=--no-verify; git commit $f` passes it. Two checks catch what it
misses: `qc doctor` in the stop gate reports a changed or missing git hook, and CI runs the gates again.

A subagent does not count its own tool calls, so a `PreToolUse` hook can count them for it.
`swarm.toolCallBudget` in `qc.config.json` sets the budget, and the budget is off by default. At 70% of the
budget, the agent gets a reminder to commit, push, and plan the hand-off, and again every 10 calls.
At the budget, only the hand-off runs: Read, read-only and `git add`, `commit`, and `push` commands,
and a Write to a path under `/handoffs/`. The hand-off note goes in a `handoffs/` folder beside the
report file, outside every checkout, with lines `Brief:`, `Worktree:`, `Branch:`, and `Head:`, and
sections `## Done`, `## Left`, and `## Next step`. The report names it on a line
`HANDOFF: <note path>`. The main session is never counted.

The same hook reads each subagent's context from its transcript: the tokens its latest request sent,
against its first. It never refuses a call. It checks once every `every` calls, and each level of note
fires once. At `summarizeRatio` times the first call, the note says that new output adds to every
later call. At `handoffRatio` times, an agent of a `handoffTypes` type with `minCallsLeft` calls of
work left gets the hand-off steps, and again after every `repeatEvery` calls. The work left runs to an
`Estimate: <n>` line of the dispatch prompt, or to the budget. When an agent hands back at `summarizeRatio` times or more, its report gains a `CONTEXT:`
line, so the controller can weigh a resume against a fresh agent. `"context": false` in the `swarm`
section turns the signal off. When the hook finds no transcript for an agent, it adds one note that the context signal is off for that agent.

| Key | Default | Meaning |
|---|---|---|
| `every` | `5` | check once every this many calls |
| `summarizeRatio` | `3` | the ratio for the note that keeps new output small |
| `handoffRatio` | `5` | the ratio for the hand-off note |
| `minCallsLeft` | `15` | the calls of work the hand-off note needs left |
| `repeatEvery` | `20` | the hand-off note repeats after this many calls |
| `handoffTypes` | `["sdd-implementer", "architecture:sdd-implementer", "general-purpose"]` | the types that get the hand-off note |

Give each agent its own worktree under `.worktree/` in the main checkout (QC-015):

```bash
npx qc worktree add fix-login fix/login          # fetch, add .worktree/fix-login from origin/main, install, print the path
npx qc worktree remove fix-login                 # refuse a dirty tree; delete it, then the branch once safe
```

`add` makes git ignore the folder. When no rule ignores it, `add` writes `.worktree/` to
`info/exclude` in the git common dir, so `git status` in the main checkout stays clean. `qc init`
adds `.worktree/` to `.gitignore`. The file list of `qc check`, the eslint preset, and the jscpd
template skip the folder too.

`remove` deletes the branch when one of these holds:

- `--from` holds the branch.
- Its upstream holds every commit.
- A merged pull request has the branch as its head at its local tip, from `gh pr list --head`. A squash merge counts.

When such a pull request exists, `remove` also deletes the branch on `origin` while it is still at that tip. A
missing or failing `gh` proves nothing. `remove` looks in `.worktree/<name>` first, then at
`../<name>` beside the main checkout. It deletes the folder through Node, so a path past 260
characters on Windows does not stop it. Run it from the main checkout, because Windows cannot
delete the current folder of a shell. Both commands are idempotent.

Two hooks hold an agent to the folder. Each is on wherever `qc.config.json` is:

| Hook | What it refuses |
|---|---|
| `PreToolUse` on `Bash` and `PowerShell` | a `git worktree add` whose path is not one folder directly under `.worktree/` of the main checkout. It resolves the path from the working directory, each `cd`, `Set-Location`, and `git -C`, and skips the options before the path. The reason names `npx qc worktree add <name> <branch>` |
| `PreToolUse` on `Bash` and `PowerShell` | a `git worktree add` whose command text holds `GIT_DIR`, `GIT_COMMON_DIR`, `GIT_WORK_TREE`, `core.worktree`, or `core.bare` anywhere, in any segment and any order: `export`, `env`, `set`, `$env:`, or `git -c`. Git then reads the repository from a path the guard cannot resolve. Run `git worktree add` from inside the target repository, with `-C`, `cd`, or `Set-Location` |
| `PreToolUse` on `Bash` and `PowerShell` | a `git worktree add` after a `-C`, `cd`, or `Set-Location` path that holds an unexpanded variable (`$K`, `${K}`, `$env:K`, `%K%`, a command substitution, or a PowerShell subexpression such as `Set-Location (Join-Path ...)`). The guard cannot know the repository, so write the path literally. A repository with no `qc.config.json` stays unguarded |
| `Stop` | nothing. It adds a note at the end of a turn while a pull request this session merged leaves a worktree on its head branch, a local branch with that name, or that branch on `origin`. The note names `npx qc worktree remove <name>`, `git branch -D <branch>`, or `git push origin --delete <branch>`. A head that `protectedBranches` or `branches.allow` names is skipped. The note names one set of leftovers once |

The stop check reads the merge record that the merge guard of section 11 writes. With
`swarm.dispatch` off, the merge guard still writes the record and judges nothing.

| Key | Default | Meaning |
|---|---|---|
| `install` | `null` | the command `add` runs in each new worktree. `null` picks it from the lockfile: `pnpm install --frozen-lockfile`, `yarn install --frozen-lockfile`, `npm ci`, or `npm install` |
| `base` | `"origin/main"` | the default `--from`: the ref a branch starts at, and the ref `remove` checks a merge against |
| `dir` | `".worktree"` | the folder in the main checkout that holds each worktree |
| `enforce` | `true` | `false` turns off both hooks and the merge record of a repository with `swarm.dispatch` off |

The keys go under `worktree`.

Known limits:

- A test run inside `.worktree/<name>/` can resolve a missing dependency from the `node_modules` of the main checkout. The run then hides the gap, and CI in a clean checkout finds it.
- An `--auto` merge that has not merged when the command returns gets no settled record while `swarm.dispatch` is off, so the stop check does not see it.
- The command guard reads the command text, with the same wrappers and the same blind spots as the merge guard.
- The command guard sees only `Bash` and `PowerShell` calls. A worktree that another tool makes, such as `EnterWorktree` or an `Agent` call with `isolation: "worktree"`, passes it. When such a worktree holds the head of a merged pull request, the stop check names it with `git worktree remove <path>`.

### 9. Hold an orchestrator to the subagent workflow

The plugin ships four subagent types for `superpowers:subagent-driven-development`, and one watcher for a Codex job:

| Type | Model | Effort | Tools | Role |
|---|---|---|---|---|
| `architecture:sdd-planner` | `inherit` | `high` | `Read`, `Grep`, `Glob`, `Bash`, `PowerShell`, `Skill`, `Edit`, `Write` | writes one plan and edits nothing else |
| `architecture:sdd-implementer` | `inherit` | `high` | `Read`, `Grep`, `Glob`, `Bash`, `PowerShell`, `Skill`, `Edit`, `Write` | implements one task from a brief file, and writes a report file |
| `architecture:sdd-reviewer` | `inherit` | `high` | `Read`, `Grep`, `Glob`, `Bash`, `PowerShell` | reviews one task, read-only |
| `architecture:sdd-branch-reviewer` | `inherit` | `high` | `Read`, `Grep`, `Glob`, `Bash`, `PowerShell` | reviews the whole branch before merge, read-only |
| `architecture:codex` | `haiku` | none | `Bash` | starts one `qc codex-implement` job in the background and waits on it in bounded steps, so the job shows in the agent panel |

The watcher is not a role: it writes no code and reads no source. Dispatch it with `model: haiku` (or `sonnet`); the guard accepts both for `architecture:codex`. Its wait step polls the wrapper file with `until grep -q`, because `tail -f | grep -m1` holds the pipe open and makes every step last the full timeout.

Every role says `model: inherit` and `effort: high`, so a subagent runs on the model family of
the session that dispatches it. The dispatch guard picks each role's models from the runtime:

| Runtime | Signal | Planner and branch reviewer | Implementer and task reviewer | Other types |
|---|---|---|---|---|
| `claude` | `CLAUDECODE=1` or `CLAUDE_PROJECT_DIR` | `opus` | `sonnet` | `sonnet`, `haiku` |
| `codex` | any `CODEX_` variable | `gpt-6.1-sol` | `gpt-6.1-sol` | `gpt-6.1-sol` |

Claude Code sets `CLAUDECODE` in its shells, and a hook process gets `CLAUDE_PROJECT_DIR`.
`QC_RUNTIME=claude` or `QC_RUNTIME=codex` overrides the signal. Under Claude Code, the guard
refuses a role dispatch with no model, so a role never inherits the orchestrator's Opus by
accident. Under Codex, a role dispatch with no model inherits the session's GPT model. With no
signal, the runtime is unknown: a dispatch that names a model is refused unless the repository lists
that type, or `*`, in `models`. The branch reviewer judges cross-task interactions, security, and data migrations against
the plan and the spec, over the whole branch's diff.

Each type lists its tools in a `tools:` allow-list. A subagent then starts without the tool schemas
that no type uses: `Artifact`, the web tools, `Monitor`, `SendMessage`, the worktree tools, and every
MCP tool of every connector. A repository's explore tools reach the agents through the shell, as
section 10 says. None of the four has the `Agent` tool. The two reviewers have no edit tools but keep
the shell for `git`, so their prompts hold them read-only. The planner writes and edits only its plan.
The reviewer types carry no `Skill` tool, because it brings the whole skill listing, so a review
brief states the criteria it needs.

Claude Code drops a listed tool that the session lacks, such as `PowerShell` on Linux, and launches
the agent with the rest. In auto mode it adds `SubagentHandback` to each type, listed or not. Each
type loads the CLAUDE.md files and the project rules, so a repository's own rules reach every
implementer and reviewer.

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
names the workflow, the four types, each role's models for the session's runtime, and the one-implementer rule, and makes Codex the first choice through `qc codex-implement`. When `implementerSlots` is over 1, the note adds one line that states the limit and replaces that rule. With `QC_ROLE=implementer` in the environment, the note is the worker note instead, as the next section says.

Load `architecture:codex` before the first implementer dispatch; the skill covers the brief, the runner, the results, CI, the review, and the merge.

| Key | Default | Meaning |
|---|---|---|
| `allowedTypes` | the four types, bare and with the `architecture:` prefix | the types that may omit `model` |
| `implementerTypes` | `["sdd-implementer", "architecture:sdd-implementer"]` | the types that share the slots |
| `maxPromptChars` | `12000` | the longest prompt, in characters |
| `slotMinutes` | `60` | when a slot with no stop expires |
| `implementerSlots` | `1` | how many implementers run at once in a session; a positive whole number |
| `models` | the runtime's table above | the model families each type's named `model` may carry |

`gpt-6.1-sol` is an exact model id; other GPT model ids are refused.

The bare names cover a copy of the agents in `~/.claude/agents`. A list replaces its default and
does not extend it. To allow `Explore` with no model, list it beside the eight default names.

`models` merges key by key with the runtime's default, so a repository can override one type
without repeating the rest. An override applies under every runtime. GPT model ids match exactly, case-insensitive. A Claude family matches a bare
alias (`sonnet`) or a full model id (`claude-sonnet-...`), case-insensitive, so a new release under an
existing Claude family needs no kit change.

A dispatch of an allowed type that names a full Claude model id, such as `claude-sonnet-5`, gets a note:
requests to different models share no prompt cache, so it pays the type's shared first-call prefix
again. The note never refuses the dispatch. Naming a bare family, such as `sonnet` or `gpt-6.1-sol`, adds no cache note.

#### Measure a session's tokens

`qc tokens` reads the transcripts Claude Code keeps for one session and prints, per agent type, the
tokens read and written, the cache hit rate, the average and largest context per call, and the
median first call. It counts a request once, though Claude Code writes one line per content block.
It needs no hook and no config.

```bash
npx qc tokens                         # the newest session of this folder
npx qc tokens --session <id> --json   # one session, as JSON, for a before-and-after comparison
```

The `1h` column prices the same requests at the one-hour cache lifetime. A negative value means
`subagentPromptCacheTtl: "1h"` in your settings would have cost less. The plugin's agents set no
`experimental.cacheTtl`: in the measured sessions the one-hour lifetime cost more for all four types,
and a frontmatter value would outrank `ENABLE_PROMPT_CACHING_1H`. The rates are API list prices.

#### Share the machine between agents

Several agents on one machine can each start a heavy run at once and stall it. Wrap each heavy
command in `npx qc gate-slot -- <command>`: the local check, a test run of more than one file, a
browser test, a live database test, a commit, and a push. At most `QC_GATE_SLOTS` (3 by default)
such commands run at once. Each claim records its process id, so a claim whose process is gone is
freed on the next claim. `npx qc gate-slot --status` lists the holders.

`npx qc throwaway-db -- <command>` runs a command on a database of its own: a postgres container
on a free port, never 5432, removed once the command exits. `throwawayDb.env` in `qc.config.json`
names each variable the command reads, such as `{ "DATABASE_URL": "{url}" }`.

`npx qc retry-failed --report <json> --rerun "<command>" -- <command>` reruns only the failed test
files once when a run fails under load. It reads the Jest or Vitest JSON report the run wrote, and
reruns nothing when the failure is no test failure or more than five files failed.

#### Run an implementer on Codex

`qc codex-implement` runs one brief through `codex exec` as an implementer. Claude stays the one
controller, and the controller workflow does not change for it.

```bash
npx qc codex-implement --brief <file> --worktree <path> --progress <file> [--log <file>] [--max-runs <n>]
```

The runner runs `codex exec -s danger-full-access -C <worktree> -c features.multi_agent=false -c features.multi_agent_v2=false <plugin and limit overrides> "<prompt>"`
with `QC_ROLE=implementer` in the environment and stdin closed, and appends the output to the log
(`<progress>.log` by default). It reads the brief file again before each run, so an edit reaches the
next session. The prompt is the brief, a note to read `git log -n 5 --oneline`, `git status --short`, and the
progress file and to continue from the first unfinished task, and the lean rules: a progress file of at
most 40 lines, no re-verifying, only the needed line ranges, no skill or plugin file, read caps, no helper agents, no broad audit or full
gate, one item per session, and a report under 15 lines. A lean rule never drops a security, tenant,
data, or correctness check that the brief asks for. It spawns `codex` with no shell, so the binary must be
a real executable on `PATH`. After each run it restarts a fresh session until the progress file holds
`ALL TASKS DONE`. It never calls Claude.

The overrides apply to the runner's `codex exec` call only, so your interactive Codex sessions keep their plugins and skills:

- `-c plugins."<name>".enabled=false` for every plugin that `$CODEX_HOME/config.toml` (default `~/.codex/config.toml`) enables, read at launch, and for `superpowers@claude-plugins-official` by name. The lean rules tell the run to load no skill.
- `-c model_auto_compact_token_limit=<n>` with `n` from `codex.compactTokens` in the worktree's `qc.config.json` (default `300000`). It is a backstop for a runaway item: each item runs in a fresh session and should finish under 200K.
- `-c tool_output_token_limit=4000`, so one command output never carries more than 4,000 tokens.

| Exit | Meaning |
|---|---|
| `0` | the progress file says `ALL TASKS DONE` |
| `1` | a bad argument, a bad `codex.compactTokens`, or `codex` did not start |
| `2` | the tail of a run matches `usage limit`, `spend cap`, `rate limit`, or `hit your limit`: dispatch the same brief to an `architecture:sdd-implementer` (sonnet) |
| `3` | `--max-runs` (default 12) runs ended and the progress file is not done |

With `QC_ROLE=implementer`, the `SessionStart` hook gives the session a worker note in place of the
controller note: work inline, never use subagent-driven development, helper agents, task reviews, or
fix-review rounds, and per task write the failing test, run only that test file, run typecheck and
lint on what you touched, and commit at once. It runs no full local gate and no e2e, since CI runs
them. When every task is pushed, it appends `ALL TASKS DONE` to the progress file. A session whose
context gets large writes notes and ends its turn, and the runner starts a fresh one. Without
`QC_ROLE=implementer`, every hook behaves as before.

#### Wait on CI with bounds

`npx qc watch --pr <n>` waits on the checks of a pull request and prints one `EVENT` line on the
first thing worth acting on. It also waits on Codex jobs (`--codex`) and workflow runs (`--run`).
Its exit code says which:

| Exit | Meaning |
|---|---|
| 0 | Every check is done, with no failure |
| 1 | A bad argument |
| 4 | `--max` minutes passed (55 by default) |
| 5 | A check failed or was cancelled |
| 6 | A check stayed queued for 15 minutes, as on a runner that is offline |

A new head starts the queued timers over. Run it as one background command for each head.

The session note tells the orchestrator to arm one watch for each pending item and create an hourly dead-man check.
The context watch speaks from 150K tokens in steps of 50K tokens.
It shows the user a line from 300K tokens.

A `TaskStop` frees the implementer slot of the agent it stopped, since that agent sends no
`SubagentStop`. A session `startup` or `resume` frees every slot of the session. A subagent may not
touch a slot folder: the slot guard refuses the command or the edit.

### 10. Choose optional tools for code exploration

GitNexus and CocoIndex are optional tools. You can use `Read`, `Grep`, or shell searches without either tool.
A `swarm.explore` section in `qc.config.json` adds advice about long reads and searches.
You can omit the section or leave `tools` empty. The kit requires no index, tool installation, or tool invocation.

```json
{
  "swarm": {
    "explore": {
      "tools": [
        { "name": "CocoIndex", "use": "find the files for a concept", "how": "ccc search \"<question>\"" },
        { "name": "GitNexus", "use": "callers, callees, and blast radius", "how": "gitnexus context <symbol> -r <repo>" }
      ],
      "summarizer": "<command> | lfm-ask \"<question>\"",
      "maxReadLines": 300,
      "maxGrepLines": 80,
      "maxOutputChars": 10000,
      "exempt": [],
      "longOutput": "excerpt",
      "excerptChars": 4000
    }
  }
}
```

A repository without the section sees no change. The kit names no tool; the repository lists its
own.

Write each `how` as a shell command. The plugin's four agent types carry no MCP tool, so a subagent
of those types runs an optional tool such as `gitnexus` or `ccc` through `Bash`.

- **Read hint**: a `PreToolUse` hook adds advice for a whole-file read over `maxReadLines` lines.
  The read proceeds on the first attempt. The hint names configured tools as optional choices and suggests `offset` and `limit`.
  Ranged reads, binary files, `exempt` globs, and files outside the session's checkout receive no hint.
- **Search hint**: a `PostToolUse` hook suggests optional tools when a `Grep` answer exceeds `maxGrepLines` lines.
  The search proceeds with its output unchanged. An empty tool list adds no search hint.
- **Output excerpt** — a `PostToolUse` hook on `Bash` and `PowerShell` acts on a successful output
  over `maxOutputChars` characters. With `longOutput` at `"excerpt"`, and an output over twice
  `excerptChars`, it saves the whole output to `<scratchpad>/outputs/<tool use id>.txt` and shows
  Claude the head, up to 20 lines between that name a failure or an error, the tail, and a line that
  names the file and the `summarizer`. The whole output never enters the context, so no later call
  re-sends it. A failed command reaches `PostToolUseFailure` instead, and Claude Code already cuts it
  to a head-and-tail excerpt. An image, or an output shape the hook does not know, gets the hint.
  With `"hint"`, the hook only adds context naming the `summarizer`, and a `summarizer` of `null`
  turns that hint off.
- **Session note** — the tool names reach the main session at start (section 9's note, even with
  `swarm.dispatch` off). Each subagent gets each tool's `use` and `how` at its own `SubagentStart`,
  past a compaction included. `swarm.explore` with no `tools` adds nothing.

The read hint and the search hint report a bad key in `swarm.explore` as context instead of
stopping the call they are judging; the session note skips the tool line instead.

| Key | Default | Meaning |
|---|---|---|
| `tools` | `[]` | optional `{ name, use, how }` entries for hints and session notes |
| `summarizer` | `null` | the command the output hint names; `null` turns that hint off |
| `maxReadLines` | `300` | the read hint threshold, in lines |
| `maxGrepLines` | `80` | the search hint's threshold, in lines |
| `maxOutputChars` | `10000` | the output excerpt's and the output hint's threshold, in characters |
| `exempt` | `[]` | globs that skip the read hint |
| `longOutput` | `"excerpt"` | `"excerpt"` saves a long output and shows an excerpt; `"hint"` only names the `summarizer` |
| `excerptChars` | `4000`, or half of `maxOutputChars` when that is under 8000 | the excerpt's size: a quarter head, three quarters tail. One you set must be smaller than `maxOutputChars`; a config that breaks this switches the explore hooks off and names the key |

### 11. Hold the workflow to its reviews

With `swarm.dispatch` on, more hooks hold the subagent workflow to its conventions. Each one reads or
writes one ledger: JSON lines in `<git common dir>/qc/ledger.jsonl`, shared by every worktree. The
record types are `dispatch`, `stop`, `verdict`, `merge`, `issue-update`, and `cost`. `qc ledger [--cost] [branch]`
prints them. Each check does nothing when `swarm.dispatch` is off in the repository it judges. That is the repository of the named worktree, and the repository of the working directory when no worktree is named. The exceptions are the denial for mixed GraphQL input and fields, and the merge record that the worktree check of section 8 reads.

| Check | Hook | What it refuses |
|---|---|---|
| Review record | `PreToolUse` on `SubagentHandback`, and `SubagentStop` | a reviewer report whose first line is not `VERDICT: <APPROVED\|CHANGES_REQUIRED> <sha>`, a sha that git reports as unknown in the repository of the named worktree, and a task review APPROVED with no `RED-CHECKED:` line. The stop records the verdict, the full sha, and the branch at that sha. A git failure or a timeout passes with a note, and the stop records the sha as written, with no branch. A sha with no named worktree that the working directory's repository lacks passes with a note, and the stop records no verdict. When the hook finds no transcript for the agent, it judges against the repository of the working directory and adds a line that says so |
| Test first | the same | an implementer report with no line that starts `RED:`, or none that starts `GREEN:`. A report with a `HANDOFF: <path>` line needs neither; it needs a note at that path with `Brief:`, `Worktree:`, `Branch:`, and `Head:` lines and non-empty `## Done`, `## Left`, and `## Next step` sections. The stop records the note's path |
| Task review | `PreToolUse` on `Agent`, inside `dispatch-guard.mjs` | an implementer on a branch whose head holds an implementer commit that no verdict names. A controller commit after a reviewed head needs no review. An implementer whose prompt has the `HANDOFF: <path>` line of the newest implementer stop on the branch continues that task and passes; the next implementer after it needs a review, and a review of the later head covers both stops. A stop head whose check runs on GitHub include a failed, cancelled, timed-out, or action-required run, or a run that has not completed, needs no review first: the next implementer continues the task and passes, and the ledger records the sha and the reason in the dispatch record. A head with all runs green, with no runs, or with no readable answer from `gh` keeps the refusal, which says the review runs once CI on the head is green |
| Fix round | the same | a new implementer on a branch whose latest verdict is CHANGES_REQUIRED, unless the prompt has a `NO-RESUME: <reason>` line or continues the newest stop's hand-off. The ledger records the reason or the note. A resume through `SendMessage` passes |
| Merge guard | `PreToolUse` on `Bash` and `PowerShell` | a `gh pr merge` with no `--match-head-commit <sha>`, or with a sha that no APPROVED review of the `merge` kind names and that the direct lane does not cover. A raw API merge, REST or GraphQL, reads the base policy of its PR. It passes with `swarm.dispatch` off at the base. It denies with dispatch on, or when the guard cannot read the PR or its base. Any `gh api graphql` call that mixes `--input` with a field denies, whether it reads or writes. This applies in every checkout, with `swarm.dispatch` on or off. A query file the guard cannot read fails closed. A `gh api` call to a `repos/` path is not searched for the mutation. A `gh pr merge` that names a repository other than `origin` passes with a note. It can name the repository with `-R`, `--repo`, a PR URL, or `GH_REPO`. After the merge, `PostToolUse` and `PostToolUseFailure` record the PR and each issue it names. Only `Refs`, `Closes`, `Fixes`, and `Resolves` lines in the PR body name issues to update |
| Issue update | `Stop` | the end of a turn while a PR this session merged names an open issue with no comment since the merge. A pending `--auto` merge resolves at the stop |
| Controller | `PreToolUse` on `Write`, `Edit`, `MultiEdit`, and `NotebookEdit` | a main-session edit in a checkout of the repository outside `controllerPaths`, unless the direct lane covers it |
| Plan check | `PreToolUse` on `SubagentHandback` and `SubagentStop` of a planner, and `qc plan-check <plan.md>` | a plan with a task that names no file, has no test step or no commit step, or estimates more than `maxTaskCalls` |
| One branch review | `PreToolUse` on `Agent`, inside `dispatch-guard.mjs` | an `sdd-branch-reviewer` dispatch with no `Reviewed: <sha>` line once the ledger holds a branch verdict on the branch, or one whose sha no branch verdict on that branch names. Write the last head a branch review named, so the review reads only the increment. Key `oneBranchReview` |
| Code-review skill | `PreToolUse` on `Skill`, `skill-guard.mjs` | a model call to a skill that `codeReviewSkills` names, bare or after a `plugin:` prefix. Dispatch `sdd-branch-reviewer`, or ask the user to type `/code-review`, which never reaches this hook |
| Green head | `PreToolUse` on `Agent` | a reviewer dispatch, task or branch kind, while CI on the head is red or running, by default. With `requireGreen: "not-red"`, unfinished checks pass with a note that names the check. A head with no check runs passes with a note, and so does a `gh` failure. Key `requireGreen` |
| Current head | the same | a reviewer dispatch when the head lacks the tip of `worktree.base`. Merge the base into the branch first: Step 0 of a fix round. Key `requireBase` |
| Product decisions | the same | an implementer dispatch with no `Brief: <path>` line, or one whose file is missing or unreadable, and a brief whose `## Product decisions` heading is absent or has no text under it. Ask the user in one question, then write the rulings, or the word `none`. Key `productDecisions` |
| Round size | the same | nothing: it warns on an implementer brief with more numbered findings (lines that start `1. `) than `roundFindings`, or more distinct file paths than `roundFiles`. Split the round in parallel on disjoint paths, with sub-branches in separate worktrees. `0` turns a limit off |
| Cost record | `SubagentStop`, `cost-stop.mjs` | nothing: it appends a `cost` record with the agent's tokens by kind, its tool calls, its role, and the branch and head of its dispatch. A transcript that does not read records nothing. `qc ledger --cost [branch]` totals them per branch and per role |
| Typecheck retry | `Stop`, `hooks/stop-gate.sh` | nothing: the gate exits at once when the checkout matches the fingerprint stored after the last fully green run (the `HEAD` sha, the status, and the content of every changed or untracked file, kept per checkout root in the temp folder; any difference or error runs the full gate). Otherwise the gate runs the root `typecheck` script when `package.json` has one, else `tsc -b --pretty false`, and runs ESLint with a cache in `node_modules/.cache/eslint-stop-gate`. When the typecheck fails and every `error TS` line is `TS2307`, the gate runs it once more and judges the second run, because a concurrent `pnpm install` causes that error |

The `swarm.review` keys that these rows name:

| Key | Default | Meaning |
|---|---|---|
| `oneBranchReview` | `true` | refuse a branch review with no `Reviewed: <sha>` line once a branch verdict exists |
| `codeReviewSkills` | `["code-review"]` | skill names the model may not call; `[]` turns the check off |
| `requireGreen` | `true` | `true` waits for green CI on the head. `false` skips the CI check. `"not-red"` refuses red CI and allows unfinished checks. |
| `requireBase` | `true` | refuse a reviewer dispatch when the head lacks the tip of `worktree.base` |
| `productDecisions` | `true` | refuse an implementer brief with no `## Product decisions` heading |
| `roundFindings` | `8` | warn on a brief with more numbered findings; `0` turns it off |
| `roundFiles` | `10` | warn on a brief that names more distinct file paths; `0` turns it off |

With `requireGreen: "not-red"`, a failed, cancelled, timed-out, or action-required check refuses the review.
A queued or running check allows the review with a note that names the check.

The hooks read these markers:

| Marker | Where | Meaning |
|---|---|---|
| `Worktree: <absolute path>` | one line of an implementer or reviewer prompt | the worktree the task gate judges, in an implementer prompt and in a reviewer prompt, where it sets the branch of the verdict. A reviewer prompt whose line is missing, names no checkout, or names a checkout with a detached head or an unreadable head is refused, since the green-CI, base, and one-review checks cannot run. An implementer prompt without it is no task, and the gate lets it pass. An implementer stop records a head only from the line of its own prompt |
| `NO-RESUME: <reason>` | one line of an implementer prompt | a fresh implementer after CHANGES_REQUIRED. The reason goes in the ledger |
| `Reviewed: <sha>` | one line of a reviewer prompt | the last head a branch review named; the gate refuses a sha that no branch verdict on the branch names. The reviewer then reviews only `<sha>..<head>` and how that increment interacts with the rest, so a fix round costs the size of the fix. The verdict still names the head, so the merge guard reads it unchanged. No hook reads the line |
| `PLAN: <absolute path>` | the first line of a planner report | the plan the plan check reads |
| `VERDICT: <APPROVED\|CHANGES_REQUIRED> <sha>` | the first line of a reviewer report | the verdict and the head it judged. A short or upper-case sha resolves to the full one |
| `RED:` and `GREEN:` | one line each of an implementer report | the failing run, then the passing run |
| `HANDOFF: <absolute path>` | one line of an implementer report, or of an implementer prompt | the hand-off note: in a report, the note the stop checks and records; in a prompt, the note a fresh implementer continues from |
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

#### A fix on a red head, and reviews in parallel

A CI fix or a review fix may start on a red or unreviewed head. Its implementer prompt carries a
line `Fix: ci` or `Fix: review`, and the ledger records the purpose. A `Fix: ci` on a head whose CI
is green is refused, since that head waits for a review.

Several branch reviewers may review one head at once, each with its own prompt line
`Scope: <name>`. The one-review rule then counts each scope on its own, and the merge guard waits
until the newest review of every scope on the head approves.

#### The direct lane for a small fix

A small fix skips the subagent workflow. The main session edits it on a branch, and merges it with
`--match-head-commit <sha>` and no review, unless a changed path matches `reviewPaths`. Then the merge needs
one APPROVED review of its head. The lane is on while `swarm.dispatch` is on, and `"direct": false` under
`swarm` turns it off.

The lane reads its limits from `qc.config.json` at the base, never from the checkout. A branch cannot
loosen the limits it merges under. The checkout's `"direct": false` still turns the lane off, and a missing,
unreadable, or wrong `swarm.direct` at the base closes it. A base config whose `swarm` is not an object closes it too.

The base is not the same for each guard. The merge guard asks `gh pr view` for the commit the PR merges into
(`baseRefOid`) and judges against that commit, so a local `worktree.base` ref that is stale or edited decides
nothing. When the local repository lacks that commit, the lane closes and the refusal says to run `git fetch`.
The controller guard has no PR, so it reads the local `worktree.base` ref. The session note reads the limits
at `worktree.base` too, and the checkout's file when that read fails.

The hooks measure the branch against its merge base with that base, so a large change cannot pass as
several small edits:

| Hook | The lane covers |
|---|---|
| Controller guard | an edit on a branch that is not protected, where the branch diff, the untracked files, and the pending edit fit the limits. An `Edit` counts its old and its new lines, and a `Write` counts the lines it writes and the lines it replaces |
| Merge guard | a head that fits the limits, on a PR into the branch of `worktree.base`, judged against the PR's base commit, where no implementer worked on the branch, and the newest review on the branch did not ask for changes. A record belongs to the branch when it names a commit of the branch, or the name of a local branch at the head, so an amend or a rebase keeps it |

These cases close the lane, so the subagent workflow runs:

- A detached head, a missing base ref, a git error, or a head that no local branch points at.
- A head with no commit past the base, or the head of a protected branch.
- A PR into another base, a PR whose base `gh` cannot read, a `gh` answer with no `baseRefOid`, or a base commit that the local repository lacks.
- A binary file, a text file over 1 MB, or a submodule, because the lane cannot judge its size.
- A lane check that runs past its budget of 6 seconds. The budget keeps each hook call inside the timeout of the hook.
- A wrong value under `swarm.direct`, in the checkout or at the base. The other guards keep their checks, and each refusal names the wrong key.
- A base with no `qc.config.json`, a base file that is not JSON, or `"direct": false` at the base.
- A change to `qc.config.json` at the repository root in the PR. The file also sets `worktree.base` and `protectedBranches`, so the branch that edits it runs the subagent workflow. The edit lane checks a pending edit of the file only when `controllerPaths` leave the file out. The default `controllerPaths` include it, so the controller guard allows that edit and the merge lane closes on the change.

Each refusal names the reason the lane does not apply.

| Key | Default | Meaning |
|---|---|---|
| `maxLines` | `20` | the most changed lines, added plus deleted |
| `maxFiles` | `2` | the most changed files |
| `excludes` | `["schemas/**", "**/migrations/**"]` | globs a direct fix may not touch |
| `reviewPaths` | `[]` | globs a direct fix may touch only with one APPROVED review of its head, of either kind. The merge guard names that review in its note |

The keys go under `swarm.direct`. A list replaces its default.

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

**Lint** — the preset sets each rule to one of three levels:

| Level | Rules |
|---|---|
| Error | `no-cross-feature-internals`, `storage-only-in-resource`, `external-service-only-in-adapter`, `scoped-repository`, `tenant-scoped-table`, `no-raw-fetch`, `no-orchestration-in-trigger`, `no-sql-raw`, `registry-literal`, `durable-idempotency-key` |
| Warning | `no-comment-paragraph`, `no-number-in-comment`, `no-supersession-trail`: each judges the style of a comment |
| Off until `rules` turns it on | `no-offset-pagination`, `no-status-literal`, `no-promise-then`, `signal-last-param`, `ime-safe-key`, `mutation-control-pending`, `one-component-per-file`, `raw-element-in-primitive`, `no-arbitrary-class-value`, `no-literal-color`, `no-static-inline-style`, `name-the-pattern` |

An `eslint-disable` comment silences its rule, and a disable comment that silences nothing is an
error. `qc lint` judges only the changed lines, so a new disable comment is part of the change a
reviewer reads.
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

### Find a component before writing one

`qc ui` keeps a catalog of the exported React components and finds the one a new file would duplicate.
Every path comes from the `ui` block of `qc.config.json`; the defaults are `componentRoots`
(`frontend/src/platform/ui` and `frontend/src/features/*/components`), `layers` (a `primitive` and a
`pattern` folder), `catalog` (`docs/ui-catalog.md`), `classCallees` (`cn`, `clsx`, `cva`, `twMerge`) and
`dupes` (`minClassLength` 60, `minFiles` 3, a baseline file). A repository with no files under the roots
gets no catalog and no failure. The tools read TSX with the `typescript` package of the repository, an
optional peer dependency.

```bash
npx qc ui catalog [--json] [--check] [--baseline]  # write docs/ui-catalog.md, one table per layer
npx qc ui find <words...>                          # the top 8 entries, as name — path — description
npx qc ui dupes [--json] [--baseline]              # repeated class strings, names and near-equal JSX trees
npx qc ui codemod --map '{"text-[11px]":"text-2xs"}' [--write]
npx qc ui codemod --suggest                        # arbitrary-value tokens, with the @theme variable that holds the value
```

- The catalog lists each exported component with its layer, props and the first sentence of its JSDoc. It is
  generated: a generated marker covers it, so the generated-file guard refuses a hand edit. A repository's
  codegen writes it by calling `writeCatalog(config)` from `architecture-harness/ui/scan`.
- `find` ranks entries by the tokens they share with the words: the camel-case parts of the name weigh most,
  then the description and the prop names.
- The `ui-catalog` gate (off by default) fails an exported component with no JSDoc sentence, naming `path:line`,
  and a stale catalog. `qc ui catalog --baseline` writes `ui-catalog.baseline.json` with the components that
  predate the gate. A baseline entry that no longer fails is an error, so the baseline only shrinks.
- The `ui-dupes` gate (off by default) fails a finding the baseline does not hold, and a baseline entry that no
  longer occurs. The findings are: the same class string of `minClassLength` characters in `minFiles` files, two
  exported components of one name in different files, and JSX trees of four elements or more with one
  element skeleton and a Jaccard index of 0.8 or more over their class tokens, in different files.
  Class strings compare by their sorted tokens.
- The `PreToolUse` hook `ui-reuse-hint` runs on a `Write` of a new `.tsx` file under the roots. It ranks the
  catalog by the words of the file name and its exported names, and adds the top 5 as context. It never blocks.
- `codemod` rewrites whole class tokens, keeping variant prefixes and the `!` modifier. It touches only string
  literals in `className`, in calls to `classCallees`, and in `cva` variant objects, with the static parts of
  template literals, and it edits by source range, so formatting stays. It is a dry run until `--write`.

### Compare screen pairs

`qc screens` captures two applications with Playwright and compares their pixels with `pixelmatch`.
The screen packages are optional peer dependencies, so install them with the package. Install Google
Chrome before the first capture.

```sh
pnpm add -D playwright pixelmatch pngjs
```

```sh
npx qc screens --map screens.json --targets legacy,mono --out captures
npx qc screens --map screens.json --targets legacy,mono --out captures --only projects
npx qc screens --map screens.json --targets legacy,mono --out captures --changed mono
```

The map names each target's origin, authentication mode, and selector for a signed-in page.
Each screen names a path and optional selectors for navigation, masks, and readiness.

```json
{
  "widths": [2514, 390],
  "targets": {
    "legacy": {
      "baseUrl": "https://legacy.example.com",
      "auth": {
        "mode": "browser-session",
        "domain": "tenant.auth0.com",
        "path": "/login",
        "signedIn": "[data-testid=account-menu]"
      }
    },
    "mono": {
      "baseUrl": "https://mono.example.com",
      "auth": {
        "mode": "browser-session",
        "domain": "tenant.auth0.com",
        "path": "/bff/login",
        "signedIn": "[data-testid=account-menu]"
      }
    }
  },
  "screens": [{
    "name": "projects",
    "targets": {
      "legacy": { "path": "/projects", "ready": "main", "masks": [".timestamp"] },
      "mono": { "path": "/projects", "ready": "main", "masks": [".timestamp"] }
    }
  }]
}
```

For each screen target, `clicks` is an ordered list of selectors for navigation controls.
Use `{ "selector": "[data-guide-skip]", "optional": true }` for an onboarding control that can be absent.
Capture navigation refuses mutation controls.
Capture, discovery, and `open` block write requests unless you pass `--allow-writes`, which permits writes to localhost only.
The guard also permits the Auth0 requests needed for sign-in. Service workers stay blocked in every browser context.
Use `ready` to identify loaded content, and `masks` to cover data that differs between environments.
A page that polls never reaches network idle. Set `"idle": false` on its target, or `idle: { legacy: false }` on a catalog entry, and the capture waits for `ready` only.
Captures use a fixed viewport, disabled animations, and a hidden caret.
The default height is 900 pixels; `--height` changes it.

`qc screens auth <target> --map screens.json --headed` tries saved state, a copy of Chrome's active profile, and a headed sign-in.
Unattended commands use saved state and silent refresh.
Chrome decrypts its own cookies. The tool excludes the password store from the copy.
State lives at `~/.qc/screens/state/<auth0-domain>.json`.
The copied profile lives at `~/.qc/screens/profile-<pid>-<time>/profile`. The tool deletes the copy on close.
Saved state contains cookies and origins for the target host and `auth.domain` only. It drops a parent-domain cookie, such as one for `.auth0.com`, because it reaches every tenant on that domain.
These files stay outside repositories. Targets on one tenant share the state file.
The tool leaves password entry on hosted sites to you.
Use `--timeout` for page operations and `--sign-in-timeout` for the headed sign-in, both in milliseconds.

For localhost, `seed-login` reads the fields named by `userField` and `passwordField` from `seedFile`.
JSON supports dotted field paths. A source file supports named fields with literal string values, without evaluating code.
The file path is relative to the map. Credentials stay in memory.
This mode also requires `userSelector`, `passwordSelector`, `submitSelector`, and `signedIn`.
It refuses other hosts and blocks requests that leave localhost during sign-in.

The output contains `<screen>/<target>@<width>.png`, red differences in `<screen>/pair@<width>.png`, and a static `index.html` gallery.
`report.json` sorts the percentage of changed pixels from greatest to smallest.
`--only` preserves other report rows. `--changed <target>` reuses the other target's captures.
The cache refuses images whose origin, navigation, masks, or viewport differ from the map.

#### Use the screen commands

Each command accepts `--map <json>`. Use `--timeout <milliseconds>` for page operations.

| Command | What it does | Main flags |
| --- | --- | --- |
| `open <name>` | Opens a mapped screen in Chrome and waits until you close the window. | `--target <name>`, `--height <pixels>`, `--out <dir>`, `--allow-writes` |
| `discover` | Explores routes and navigation states, and saves inventories and screenshots. | `--target <name>`, `--out <dir>`, `--depth <levels>`, `--max-states <count>`, `--allow-writes` |
| `pair` | Matches states from two saved discoveries and writes `pairs.json`. | `--targets <left,right>`, `--out <dir>` |
| `coverage` | Checks discovered states against catalog entries and exclusions, and writes `coverage.json`. | `--target <name>` (optional), `--out <dir>` |
| `scaffold` | Writes catalog modules for discovered states and preserves existing files. | `--target <name>` (optional), `--out <dir>`, `--catalog-out <dir>` |

`--out` selects the directory for discovery artifacts and the input directory for `pair`, `coverage`, and `scaffold`.
For `open`, it selects the directory for screenshots of failed catalog steps.
`scaffold` uses `<out>/catalog` unless you set `--catalog-out`.
`coverage` checks all discoveries unless you set `--target`.
`scaffold` reads all discoveries unless you set `--target`.

Run `npm run test:browser` in `packages/qc-harness` for the browser tests. They need Google Chrome.

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

### Keep components separate and raw controls in primitives

`qc/one-component-per-file` permits at most one React component declaration in each `.tsx` file.
It counts capitalized functions and arrows that return JSX, plus components declared with `forwardRef` or `memo`.
Each finding names both components, including declarations inside another component.

`qc/raw-element-in-primitive` permits raw `form`, `dialog`, `input`, `select`, `textarea`, and `button` elements only under `ui.layers.primitive`.
Use primitive components elsewhere. The `elements` rule option replaces the element list.
The preset passes `ui.layers.primitive` as the `primitive` rule option, which accepts one folder or an array of folders.

`qc/no-arbitrary-class-value` refuses Tailwind arbitrary values, including `text-[11px]` and `md:hover:bg-[#123456]`.
`qc/no-literal-color` refuses hex, `rgb()`, `rgba()`, `hsl()`, and `hsla()` literals in JSX presentation attributes, class strings, and style objects.
Both read class strings through the shared UI parser, including `className`, `class`, `ui.classCallees`, and `cva` variants.
The preset passes `ui.classCallees` as the `classCallees` rule option. Use theme tokens and CSS variables for presentation values.

`qc/no-static-inline-style` rejects a JSX `style` object whose values are all literals, such as `style={{ display: "flex", width: 12 }}`.
Move those values to classes or theme tokens.
A runtime value, such as `style={{ width: size }}`, permits the object, including mixed literal and runtime values.
Spreads and runtime property names also pass. Empty objects pass because they hold no presentation values.

These rules ship off. Enable them under `rules` in `qc.config.json`; the preset applies them to `clientFiles`.

```json
{ "rules": { "one-component-per-file": true, "raw-element-in-primitive": true, "no-arbitrary-class-value": true, "no-literal-color": true, "no-static-inline-style": true } }
```

### Adopt the UI rules with a baseline that only shrinks

The five UI rules in #144 share ESLint's bulk suppressions mechanism:

- `qc/one-component-per-file`
- `qc/raw-element-in-primitive`
- `qc/no-arbitrary-class-value`
- `qc/no-literal-color`
- `qc/no-static-inline-style`

Use ESLint 9.24 or later; the kit uses ESLint 9.39.
For an existing frontend, `eslint --suppress-rule <rule>` writes `eslint-suppressions.json` for the selected rule.
Create the initial baseline for all five rules, then commit the file:

```sh
npx eslint frontend/src --suppress-rule qc/one-component-per-file --suppress-rule qc/raw-element-in-primitive --suppress-rule qc/no-arbitrary-class-value --suppress-rule qc/no-literal-color --suppress-rule qc/no-static-inline-style
```

After adoption, run `npx eslint frontend/src` without suppression-generation flags. Findings beyond the recorded counts fail.
ESLint fails on unused suppressions by default, so a stale entry fails after you remove its violation.
Run `npx eslint frontend/src --prune-suppressions` to remove stale entries, then commit the smaller file.
Keep the default unused-suppression check enabled. Accept only baseline changes that remove entries or reduce counts.
Use this file as the sole lint baseline; it may only shrink after adoption.

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

Two open branches can take the same number. `qc migrations renumber --onto <ref>` renames the
migrations that this branch added to follow the last migration of `<ref>`, in order, and rewrites
each reference to an old name. A second run changes nothing.

`qc integrate --issue <n> <branch>...` builds one branch, `feat/<n>-integration`, for a batch of
related branches. It merges each branch in order, renumbers its migrations, and commits. A conflict
in files that `generated.globs` matches is settled by `generated.command`. Any other conflict stops
the run with the file list; resolve it, commit, and run the same command again. The batch then runs
one CI and merges once.

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

### Keep a minted key out of a saga runner

The `saga-key` gate ships off. A saga resumes on its key, so a key minted at the call starts a second
saga on every retry. The gate reads each call of a function in `sagaKey.runners`, in the feature
files and not in a test, and fails a call as `minted-saga-key` when the `sagaKey.key` property of its
object argument is minted.

- A value fails when it holds a call of a volatile name, matched at its tail: `crypto.randomUUID()`,
  `randomUUID()`, `nanoid()`, `uuid.v4()` and `new Date()` all count. The names are `idempotency.volatile`
  and `uuid.v4`. `uuid.v4` counts even when `volatile` is `[]`.
- The value is read whole. Parentheses, `await`, `as T` and `!` come off. Each arm of `a ?? b`, `a || b`,
  `a && b` and `c ? a : b` counts, except a ternary's condition and the guard before `&&`. A mint inside a
  wrapping call's arguments counts too: `String(Date.now())`, `useRef(randomUUID())`, `useMemo(() => randomUUID(), [])`.
  A volatile call nested in a callback inside those arguments counts as well, so `lookup(list.filter((x) => x.at < Date.now()))` fails, a loud false positive that a stored key avoids. A function parameter that shadows a minted const is reported the same way: `const id = randomUUID(); function f(id) { return runPipeline({ mutationId: id }); }` fails.
- A bare name, and the shorthand `{ mutationId }`, follow to the nearest `const` in scope that declares
  it, and a const that names another const is followed the same way. A `const id = crypto.randomUUID()`
  there fails, and a `const id = state.clientMutationId` passes.
- Comments, strings, regular expressions and the text of a template are blanked first, so a call
  written inside one is not a call.
- A runner call whose `idempotency.ledgerKey` property (default `ledger`) builds one of
  `idempotency.throwawayLedgers` is exempt, as the `durable-idempotency-key` lint rule exempts it. The
  ledger is read directly, or through a const.
- The finding names the file and the line of the call.
- A runner is a name, or a dotted name such as `sagas.runPipeline` for a member call.
- An empty `runners` list, or a blank name, throws when the gate is on, so the gate never matches nothing.

The gate reads text, not a syntax tree, so these forms pass unseen:

- A runner that takes the key as a positional argument, or an options object held in a variable.
- A runner imported under another name (`import { runPipeline as run }`): list the alias in `runners`.
- A `let` that is assigned again after its declaration: only its first value is read.
- A key read from a property of an object built elsewhere, such as `mutationId: base.mutationId`.
- A key built inside a helper the call names.
- A name passed through a wrapping call, such as `hash(id)` where `id` is a minted const.
- A parameter with a default value, such as `(mutationId = randomUUID()) =>`, and a key set by a spread.
- A runner call outside a feature folder, or outside a `.ts` or `.tsx` file.

```json
{
  "gates": { "saga-key": true },
  "sagaKey": { "runners": ["runPipeline"], "key": "mutationId" }
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
- a default export of the helper, and a default import of it. The forms are
  `export default insertReturning` and `export { insertReturning as default }`. In the helper's
  own module they are also `export default function insertReturning` and its `async` form.
- a local alias in the helper's own module: `const alias = insertReturning; export { alias as put }`.
  Any other use of the helper there, such as `wrap(insertReturning)`, makes that module opaque.

The gate checks the calls `insertRow(`, `crud.insertReturning(`, and `db.crud.insertReturning(`. It
reads `import{x}from"y"` with no whitespace, and a comment or a byte-order mark anywhere in a
statement. It reads no statement in a comment, a template, or a regular expression.

The work is bounded. After 50,000 worklist steps over all helpers, the gate stops and reports one
`unresolved-helper-import` that names the budget. A module that holds more than 64 member paths for
one helper, as a set of namespaces that alias each other does, is opaque.

A file fails as `unresolved-helper-import` when it reaches the helper in a form the gate cannot
follow:

- It imports the helper's name, or a namespace of its module, by a specifier the gate cannot
  resolve to that module, such as an alias with no matching path. A default import by such a
  specifier, `import put from "@/sql/crud"`, fails the same way.
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
- `import x = require("./crud")`
- a backtick inside a regular expression that the lexer misreads, which starts a template that can
  hide a later `const f = insertReturning` from the use check. The lexer reads comments, strings,
  templates with `${}`, and regular expressions. It takes a `/` after `)`, `]`, `}`, or a name as a
  division, so ``if (x) /`/.test(y)`` and a regular expression at the start of a line after an
  expression with no semicolon are not seen. A quote in JSX text can do the same.
- an `import` after a `}` on the same line

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

### Hold new prose to a style

`qc prose` runs [Vale](https://vale.sh) on the lines a change adds to the docs, and on a pull request body. A
line that is already in the repository is never judged, so a repository adopts the style without a rewrite.
Vale is an external binary. Without it, `qc prose` prints a note and exits 0 outside CI, and fails in CI.
An alert lands on the line where the sentence or phrase starts, so an edit to a later line of it is not judged.

```bash
qc prose                                  # the lines added since the merge base with prose.base
qc prose --base origin/develop            # another base
qc prose --pr-body <file>                 # also the body in <file>
qc prose --pr-body-event                  # also the body of the pull request in $GITHUB_EVENT_PATH
```

`qc init --full` copies the style to `.vale/`, and its `pr-policy.yml` workflow installs a pinned Vale release and runs
`qc prose --pr-body-event` on a pull request. `qc check` does not run it, because a diff needs a base.

| Severity | Rule |
|---|---|
| Error | `utilize`, `in order to`, `e.g.`, `i.e.`, `etc.`, `please`, `and/or`, and the progress phrases `not yet`, `for now`, `the next phase`, `for the time being` |
| Warning | A sentence of more than 25 words, and the passive voice. A warning never fails. |

```json
{
  "prose": {
    "paths": ["docs/**", "README.md"],
    "exempt": ["**/CHANGELOG*", "**/reports/**"],
    "base": "origin/main"
  }
}
```

`paths` and `exempt` are globs over markdown files. The ADR log, `adr.root` and `docs.decisions`, is always
exempt. `valeConfig` names the repository's Vale config and defaults to `.vale/.vale.ini`.

## Prepare local screen fixtures

`qc screens setup --map screens.json --target legacy-local` prepares matching content through the application's own UI.
The command accepts only localhost targets and stops when the application does not answer.

Set the target's `setup` property to a TypeScript or JavaScript module path relative to the map.
The module's default export supplies `find(page, ctx)` and `create(page, ctx)` for each fixture kind.
The kinds are `project`, `folder`, `photo`, `drawing`, `document`, `blackboard`, `inspection`, and `delivery`.

Each function returns the resource id visible in the UI, or `find` returns `null` when the resource is absent.
The command checks the UI again on each run and saves each confirmed id under `~/.qc/screens/fixtures-<target>.json`.

`ctx.baseUrl` identifies the target, and `ctx.fixtures` contains the confirmed ids.
`ctx.item` supplies the shared name, beginning with project `QC-PARITY-TEST`.
`ctx.assets` supplies deterministic photo, drawing PDF, and document paths for upload controls.
Use `ctx.step(name, action)` to name each UI action and capture failures.

Form login reads `QC_TEST_EMAIL` and `QC_TEST_PASSWORD` from `~/.qc/accounts.env`.
Auth0 login uses the real `/bff/login` flow and the saved session.
The tool types credentials only into localhost forms.

## Tests

```bash
pnpm test   # every rule, every gate, every knob, each with a case that must fail
```

The screen tests that launch Google Chrome skip when it is not installed. Set `QC_REQUIRE_CHROME=1`
to make them fail instead, as CI does. CI also scaffolds a repository from an empty directory and requires a green `qc check`.
