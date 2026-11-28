# architecture-kit

Quality gates for a TypeScript repository, and the Claude Code hooks that run them. A person, Claude
Code, and Codex meet the same checks: in the editor, at a commit, at a push, and in CI.

The gates judge the change, never the history. Lint reports only a problem on a line the change
adds, so a repository adopts the kit without a cleanup first.

## Package and plugins

| Half | Install | Holds |
|---|---|---|
| Package `architecture-harness` | `pnpm add -D` | the `qc` CLI, the gates, the ESLint preset, and the templates |
| Plugin `architecture` | `claude plugin install` | core Codex work, fleet control, reviews and four hooks |
| Plugin `architecture-extras` | optional `claude plugin install` | all other skills, agents, commands and hooks |

The core plugin includes its hook code. Extras hooks use the package installed in the project.
The npm package also works alone. Each hook keeps its own scope and opt-in settings.

## Install

The package:

```bash
pnpm add -D architecture-harness --save-exact
```

`npx architecture-harness <command>` runs the kit in a folder that does not install it.

The plugin:

```bash
claude plugin marketplace add shawrylk/architecture-kit#stable
claude plugin install architecture@architecture-kit
```

The `stable` branch moves only at a release, so work on `main` does not reach your PCs. To get each release, turn on auto-update once on each PC: run `/plugin`, open the **Marketplaces** tab, select `architecture-kit`, and turn on auto-update. Claude Code checks after a session starts and loads a new version at the next launch, or after `/reload-plugins`.

Claude Code updates a plugin only when its `version` changes. A release sets the same version in `packages/qc-harness/package.json`, `.claude-plugin/plugin.json`, `plugins/architecture-extras/.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json`.

To split the open issues across several PCs, read [Split work across PCs](docs/fleet.md).
For Codex jobs, start `qc fleet worker` on each node and send briefs with `qc fleet job` on the leader. See [Codex worker](docs/fleet.md#codex-worker).
`/fleet start` runs the fleet from Claude.

The core plugin has no plugin dependency. The marketplace still offers `ai-chat-assistant` as a separate install.

Core includes agents `codex`, `sdd-reviewer` and `sdd-branch-reviewer`, skill `codex`, and command `fleet`.
Its hooks are `comment-watch` on UserPromptSubmit and PostToolUse, `merge-guard` on PreToolUse, PostToolUse and PostToolUseFailure,
`context-watch` on UserPromptSubmit and PostToolUse, and `bash-command-guard` on PreToolUse. Core has no Stop hook.
On a Codex usage limit (exit 2), stop new starts and tell the owner.

Extras is off by default. It holds agents `sdd-implementer` and `sdd-planner`; commands `adopt`, `check` and `feature`;
and skills `architecture`, `enforcement`, `applying-engineering-standards`, `navigating-source-code`, `registering-work`,
`reviewing-before-merge`, `security`, `swarm`, `writing-decision-final-specs` and `writing-plain-english`.
It also holds all other hooks. Install the npm package in each project before you enable extras:

```bash
pnpm add -D architecture-harness --save-exact
claude plugin install architecture-extras@architecture-kit
```

Extras hooks use that installed package. Their launcher and shell scripts are inside the extras install tree.
The npm package keeps every CLI verb. The file `packages/qc-harness/src/gates/plain-language.mjs` keeps its path.

`qc stack`, `qc screens` and `qc throwaway-db` run from pinned GitHub commits on first use.
The CLI installs them through npm, so the first run needs access to GitHub. Commands and flags stay the same.

| Command | Tool repository |
|---|---|
| `qc stack` | [qc-stack](https://github.com/shawrylk/qc-stack) |
| `qc screens` | [qc-screens](https://github.com/shawrylk/qc-screens) |
| `qc throwaway-db` | [qc-throwaway-db](https://github.com/shawrylk/qc-throwaway-db) |

## Set up a repository

```bash
npx qc init            # config, an empty decision register, git hooks, CI
npx qc install-hooks   # binds the pre-commit, commit-msg, and pre-push hooks
```

`qc init` writes eight files and skips a file that exists:

| File | Holds |
|---|---|
| `qc.config.json` | the feature folders init finds, and an empty list when there are none |
| `docs/decisions.md` | an empty decision register |
| `.githooks/pre-commit`, `commit-msg`, `pre-push` | the commit and push tiers |
| `.github/workflows/ci.yml` | the same checks in CI |
| `package.json` | the `spec:check` and `prepare` scripts |
| `.gitignore` | the `.worktree/` folder |

Replace your ESLint config with the preset:

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

## The three checks

| Command | What it judges |
|---|---|
| `qc lint` | ESLint, on the lines the change adds. `--staged` judges the index, and `--base <ref>` judges the diff from a merge base |
| `qc typecheck` | the `typecheck` script of `package.json`, else `tsc --noEmit`. It writes no build output |
| `qc check` | the structure gates: feature anatomy, citations, and each gate the config turns on |

`qc lint` without ESLint, and `qc typecheck` without a script or `tsc`, print a note and exit 0.

## Where the checks run

| Moment | Runs | A red result |
|---|---|---|
| After an edit by Claude Code with extras | `qc lint` and `qc check` on the edited file | shows the problem to the agent |
| At the end of a Claude Code turn with extras | `qc typecheck`, `qc lint`, and `qc check` | blocks the stop, once per failure |
| `git commit` | `qc lint --staged`, `qc typecheck`, and `qc check` on the staged files | refuses the commit |
| `git push` | `qc check` on the whole repository | refuses the push |
| CI | `qc check`, `qc typecheck`, `qc lint --base`, and the tests | fails the build |

A drift of the kit setup, such as a changed git hook, is a note and never blocks a stop. Codex reaches
the kit through the git hooks and the CI workflow. The Codex runner uses `danger-full-access`,
so Codex commits, pushes, and runs the git hooks.

The runner passes this environment allowlist, plus names in `codex.envAllow` (default `[]`):

| Group | Names or prefixes |
|---|---|
| Paths and folders | `PATH`, `PATHEXT`, `HOME`, `HOMEDRIVE`, `HOMEPATH`, `USERPROFILE`, `APPDATA`, `LOCALAPPDATA`, `PROGRAMDATA`, `ALLUSERSPROFILE`, `TEMP`, `TMP`, `TMPDIR`, `PUBLIC` |
| Locale | `LANG`, `LANGUAGE`, `LC_ALL`, `LC_CTYPE`, `LC_COLLATE`, `LC_MESSAGES`, `LC_MONETARY`, `LC_NUMERIC`, `LC_TIME` |
| Terminal | `TERM`, `COLORTERM`, `TERM_PROGRAM`, `TERM_PROGRAM_VERSION`, `TERMINFO`, `TERMINFO_DIRS`, `NO_COLOR`, `FORCE_COLOR` |
| User | `USER`, `LOGNAME`, `USERNAME`, `USERDOMAIN`, `USERDOMAIN_ROAMINGPROFILE`, `COMPUTERNAME` |
| Windows | `SYSTEMROOT`, `SYSTEMDRIVE`, `WINDIR`, `COMSPEC`, `OS`, `PROGRAMFILES`, `PROGRAMFILES(X86)`, `PROGRAMW6432`, `COMMONPROGRAMFILES`, `COMMONPROGRAMFILES(X86)`, `COMMONPROGRAMW6432`, `PROCESSOR_ARCHITECTURE` |
| SSH agent | `SSH_AUTH_SOCK`, `SSH_AGENT_PID` |
| Proxies and certificates | `HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `SSL_CERT_FILE`, `SSL_CERT_DIR`, `NODE_EXTRA_CA_CERTS` |
| Configuration and session | `GH_CONFIG_DIR`, `XDG_CONFIG_HOME`, `XDG_RUNTIME_DIR`, `XDG_DATA_HOME`, `XDG_CACHE_HOME`, `DBUS_SESSION_BUS_ADDRESS`, `SHELL` |
| Prefixes | `CODEX_`, `GIT_`, `QC_`, `DOCKER_`, `npm_config_` |
| OpenAI API | `OPENAI_API_KEY` |

The four proxy names and the `npm_config_` prefix match in any case on every platform.
Other names and prefixes require exact case except on Windows.
Names allowed only by `DOCKER_` or `npm_config_` stay out when they contain a hold-back word, in any case.
The hold-back words are `TOKEN`, `PASS`, `PWD`, `SECRET`, `AUTH`, `CRED`, and `KEY`.
An entry in `codex.envAllow` can pass such a name in full.
The `GIT_` prefix passes names such as `GIT_ASKPASS` and `GIT_CONFIG_KEY_<n>` for pushes.
Tokens such as `GH_TOKEN`, `GITHUB_TOKEN`, `NPM_TOKEN`, and `NODE_AUTH_TOKEN` require an entry in `codex.envAllow`.
Each `codex.envAllow` entry must be non-empty and have no leading or trailing whitespace.
A brief that needs `gh` reads its token through `gh auth token`.

`codex.pathsTests` defaults to `"warn"`: before launch, the runner warns about covering test files
missing from the brief's `Paths:` and continues. Set it to `"add"` to include those tests in the
owned paths and the prompt Codex reads. Naming a folder also names the tests within it.
Warnings cover the sibling test and suite tests that import the file, directly or through other files; uncertain loaders do not add warnings.
A commented-out import can also count.

## Task and merge gates

The task gate reads CI on the current branch head, including commits after an implementer stops.
Failed or running CI lets the next implementer continue the task when its prompt has no `Fix:` line.

`Fix: ci` needs known-red CI on the current head.
`Fix: review` needs a `CHANGES_REQUIRED` verdict and a review of every implementer stop.
The newest stop needs no review if the prompt continues its `HANDOFF:`.
A merge that requires branch reviews waits for approval of every dispatched scope.
A merge that requires task reviews uses task verdicts.

## Turn on more

Every rule below is off until a repository turns it on.

| Feature | Turn it on with |
|---|---|
| The reference architecture: docs, decisions, quality thresholds, and the PR policy workflow | `qc init --full` |
| Lint rules of the reference stack: `no-offset-pagination`, `no-status-literal`, `no-promise-then`, `signal-last-param`, `ime-safe-key`, `one-component-per-file`, `raw-element-in-primitive`, `no-arbitrary-class-value`, `no-literal-color`, `no-static-inline-style` | `rules` in `qc.config.json` |
| A prose style for docs and PR bodies, through Vale | `qc init --full`, then `qc prose` |
| A tool-call budget for each subagent | `swarm.toolCallBudget` |
| A context budget for each role | `budgets` |
| The subagent workflow: dispatch rules, reviews, and merge checks | `swarm.dispatch` |
| Exclusive paths for agents that share one folder | `.claude/work-order.local.json` |

`npx qc config` prints the configuration in force. The [reference](docs/reference.md) covers every
command, hook, gate, and key.

## Measure it

`evals/agents/` runs Claude Code or Codex on a small fixture, with and without the kit, and grades
each run with tests the agent never sees. The [eval guide](evals/agents/README.md) has the commands.

## Run tests on a throwaway database

`npx qc throwaway-db -- <test command>` creates a fresh database and removes it after the command exits.
Set `throwawayDb.schemaCommand` in `qc.config.json` to prepare its schema before the tests:

```json
{
  "throwawayDb": {
    "schemaCommand": "pnpm exec drizzle-kit push --force"
  }
}
```

The schema command and the test command use the same database environment.
The setting defaults to none.
If the schema command fails, the runner skips the tests, returns its exit code, and removes the database.
Wrap live database tests in `npx qc gate-slot -- npx qc throwaway-db -- <test command>`.
A hook timeout on a fresh database means the schema step is missing.
Never raise a timeout.
Never use port 5432 or another port the local stack owns.

## Shared user configuration

`user-config/` holds the shared settings for Claude Code and Codex.
Run `qc user-config apply` to merge them, or `qc user-config check` to report drift.

| Claude setting | Merge rule |
|---|---|
| `permissions.defaultMode` | Use the kit value. |
| `permissions.allow` and `permissions.deny` | Keep machine entries, then append new kit entries. |
| `autoMode.allow`, `autoMode.soft_deny`, and `autoMode.hard_deny` | Keep machine entries, then append new kit entries. |
| `autoMode.environment` | Replace matching bold labels in place, append new labels, and keep each unlabeled line once. |

Organization lines in `autoMode.environment` stay on each machine when the kit lacks their labels.
`qc user-config capture` copies every environment line into the kit file.
Remove private lines before you commit captured settings.

## Tests

```bash
pnpm test
```

Each rule, gate, and switch has a case that must fail.

### GitHub comments

The harness checks issues and PRs you use in one batch per repository and fetches comments only when an item changes.
After the first full read of an item, it reads only comments changed since the last check, one page at a time.
If a poll stops early, the next prompt continues with the following item, repository, or page.
API commands with a non-GitHub.com `--hostname` neither add watches nor acknowledge comments.
It shows each truncated comment once and keeps it pending until you read it in full.
It stops checking closed or merged items until a command or merge names them again.
Merges wait until your session sees comments on the PR, the issues its body, commits, or Development sidebar link, and the items a command linked to it.
Comments your session posts with `gh issue comment` or `gh pr comment` do not count as unseen.
When the output goes to `/dev/null`, the next read matches your gh login, the same body, and a creation time near the post.
The merge check has 10 seconds; prompt checks have 3.5 seconds.
Set `"commentWatch": false` in `qc.config.json` to disable the watch and merge gate.
Use `github.configDirs` to map repository owners to gh configuration directories; `shawrylk` defaults to `~/.config/gh-personal`. If the mapped folder does not exist after home expansion, the watcher uses the default gh login.
Other owners use the default gh account. Failed prompt checks add a note; failed merge checks require a retry.
