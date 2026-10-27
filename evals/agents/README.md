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

## Measure skill activation

The `skill-activation` task asks for a cart guide without naming a skill in the prompt.
Run both arms with Claude Code to measure whether the kit's skill description triggers a load:

```bash
node evals/agents/run.mjs --agent claude --tasks skill-activation --arm none --label none --out <dir>
node evals/agents/run.mjs --agent claude --tasks skill-activation --arm kit --kit . --label kit --out <dir>
```

The grader reads `transcript.jsonl` for an assistant `Skill` tool call with the exact expected skill name.
The task expects `architecture:writing-plain-english` and records `expectedSkill` and `skillActivated` in `results.jsonl`.
`solved` requires both the hidden guide tests and activation.
A mention in text, a `Read` call, or a different skill earns no activation credit.
Codex runs receive no activation credit because this grader requires the Claude `Skill` tool format.

The controls prove the grader without a model call:

```bash
node evals/agents/run.mjs --agent noop --tasks skill-activation --out <dir>
node evals/agents/run.mjs --agent reference --tasks skill-activation --out <dir>
```

`noop` has no transcript and fails activation.
`reference` writes a small synthetic `Skill` call and applies the known guide.
The eval runs manually and never runs in CI.

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

An activation task also has `expected-skill.json` with a `skill` field that names the expected kit skill.
