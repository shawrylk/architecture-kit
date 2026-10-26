# architecture-kit

Quality gates for a TypeScript repository, and the Claude Code hooks that run them. A person, Claude
Code, and Codex meet the same checks: in the editor, at a commit, at a push, and in CI.

The gates judge the change, never the history. Lint reports only a problem on a line the change
adds, so a repository adopts the kit without a cleanup first.

## Two halves

| Half | Install | Holds |
|---|---|---|
| Package `architecture-harness` | `pnpm add -D` | the `qc` CLI, the gates, the ESLint preset, and the templates |
| Plugin `architecture` | `claude plugin install` | the Claude Code hooks, skills, and subagent types |

The plugin calls the CLI of the package. Each half works alone. In a repository without
`qc.config.json`, every hook of the plugin does nothing.

## Install

The package:

```bash
pnpm add -D architecture-harness --save-exact
```

The plugin:

```bash
claude plugin marketplace add shawrylk/architecture-kit
claude plugin install architecture@architecture-kit
```

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
| After an edit by Claude Code | `qc lint` and `qc check` on the edited file | shows the problem to the agent |
| At the end of a Claude Code turn | `qc typecheck`, `qc lint`, and `qc check` | blocks the stop, once per failure |
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

## Tests

```bash
pnpm test
```

Each rule, gate, and switch has a case that must fail.
