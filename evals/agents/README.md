# Agent eval

The eval runs Claude Code or Codex on a small TypeScript fixture, with and without the kit. Hidden
tests that the agent never sees grade each run. The question it answers: does the kit make an agent
better, or only slower?

## Run it

```bash
node evals/agents/run.mjs --agent claude --model sonnet --label none --reps 2 --out <dir>
node evals/agents/run.mjs --agent claude --model sonnet --arm kit --kit . --label kit --reps 2 --out <dir>
node evals/agents/report.mjs <dir>/results.jsonl
```

`--arm kit` adopts the kit the way a flat repository does: `qc init`, the ESLint preset, and the git
hooks. With `--agent claude`, the run also loads the plugin from `--kit`.

| Option | Default | Meaning |
|---|---|---|
| `--agent` | `claude` | `claude`, `codex`, `noop`, or `reference` |
| `--arm` | `none` | `none` runs the bare fixture, and `kit` adopts the kit at `--kit` |
| `--tasks` | every task | a comma list of folders under `tasks/` |
| `--reps` | `1` | the runs of each task |
| `--parallel` | `3` | the runs at one time |
| `--model` | the default of the agent | the model of the agent |
| `--budget` | `3` | the cost limit of a Claude run, in US dollars |
| `--timeout-min` | `25` | the time limit of a run |
| `--work` | a folder in the OS temp folder | the run folders and the shared dependencies |
| `--out` | `<work>/results` | the folder of `results.jsonl` |

`noop` changes nothing, and `reference` applies the known solution of each task. Together they prove
the grader: `noop` solves no task, and `reference` solves every task.

## Read the report

| Column | Meaning |
|---|---|
| solved | the hidden tests pass |
| tsc, lint | the typecheck and ESLint pass on the result |
| committed | the run ends with a commit |
| clean tree | `git status` is empty after the run |
| in scope | the run changes only the files of the reference solution, and tests |
| hook blocks | the blocks from a kit hook in each run |
| git fails | the git commands that fail in each run |

A Codex run cannot commit inside its `workspace-write` sandbox, because `.git` is read-only. The
runner commits after the run, through the git hooks, and records the result as `hookCommit`.

## Add a task

A task is a folder under `tasks/` with three parts:

- `prompt.md`: the request the agent gets.
- `hidden.test.ts`: the tests that grade the run.
- `solution/`: the files of the known solution, which also set the scope of the task.
