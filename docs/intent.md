# Intent

The orchestrator owns this file. Every Codex prompt and every review reads it. Change it only with the user's approval.

## Why

Models claim success that is not true, write wrong code, skip tests and write too many tests. The user is the bottleneck when each claim needs a human check. The kit makes the result checkable by code, so the user checks only design and breaking changes.

## Goals

1. A script, not a model, proves "done": the runner reruns the checks and records the proof.
2. One design voice: the orchestrator approves each plan, and implementers follow it.
3. Speed: affected checks for each pull request, parallel implementers on disjoint paths, and two or three milestone merges a day.
4. Low token cost: a rule that a script can check lives in the runner, not in a prompt.
5. The same behaviour on Windows, macOS and Linux, with one PC or several.

## Non-goals

- Product features such as screen tests, local stacks or throwaway databases. Those live in their own repositories.
- A hosted service or an account other than the user's own.

## Anti-goals

The kit fails if one of these happens, even when every test passes:

- A run counts as done on the model's word alone.
- An agent can skip, weaken or bypass a check: a hook, the merge guard, CI, or an assertion.
- The user gets a question that a file in the repository already answers.
- A rule costs tokens on every run but has never caught a fault.
- The plugin runtime imports a package that is not a Node built-in.
