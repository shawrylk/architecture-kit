# NOTES — full-kit test run, 2026-09-14

**Both findings below are now fixed.** See STATE.md for the `unfound-root` check. Final state:
168 unit tests, 28/28 adversarial, `qc check` green on the real repo and on the from-nothing path.

Run against the kit at `2596231`. **Every check the kit ships is live and provably fail-able; no
check was found broken.** One real defect, in the kit's behaviour when its config is absent.

## The probe

`evals/adversarial.sh` restores with `git checkout -- .` plus `git clean -fd`.
`quality-control-mono` had ~50 uncommitted files, so aiming the suite at it would have destroyed them.

A worktree at `HEAD` is also wrong here, for the reason the evals README records once already: the
kit wiring is uncommitted. `qc.config.json` is **untracked**, and `eslint.config.mjs` at HEAD is
still the old 106-line inline config — so the rule layer would have linted through the wrong config
and reported passes it never exercised.

The probe is therefore the **current working tree** copied to a scratch dir, `git init`, committed
as one baseline, each `node_modules` symlinked back. `restore()` then returns to a kit-wired tree.

## Controls, before trusting any verdict

Both failure directions exist — false CAUGHT from stale config, false MISSED from an unresolved
harness — so each was closed first.

| Control | Result |
|---|---|
| clean probe `qc check` | green; 30 features, 42 sagas, same 2 exemptions as the real tree |
| injected `helpers/u.ts` | `disallowed-subfolder` fires |
| injected raw `fetch` | `qc/no-raw-fetch` fires — the lint runs through the kit preset |
| `restore()` | leaves the probe clean |

## Layers

| Layer | Result |
|---|---|
| unit suite (`pnpm test`) | **168 pass, 0 fail** (166 before the fix) |
| fresh repo: `qc init` → `qc feature orders` → `qc check` | green from nothing |
| `qc check` on real code | green, rc 0 (snapshot; the tree is being edited live) |
| `evals/adversarial.sh` | **caught 28, missed 0** (25 before the added cases) |
| single-file `qc check <file>` | fires `disallowed-subfolder`, rc 1 |
| post-edit hook: clean / lint violation / structural violation | rc 0 / rc 2 / rc 2 |
| stop gate on the green probe (tsc + eslint + qc check) | rc 0 |
| stop gate: no config / `QC_STOP_EXTRA` failing | silent rc 0 / rc 2 |
| `qc install-hooks` → pre-commit refuses a bad commit | `core.hooksPath=.githooks`, commit rc 1 |
| `qc feature --flat` into a slice-only root | refused, names the three fixes |
| a gate switched off in config | `enforcement-map` fails: the map still claims it runs |

That last row is the strongest single result: a check cannot be quietly disabled, because the map
that documents it then disagrees with the set that runs.

Both generator fixes recorded in STATE.md are confirmed: the scaffolded saga ships its own headless
test (`slices/create.test.ts`, and `qc check` counts "1 workflow(s), each named by a test"), and
`--flat` now refuses rather than emitting code the anatomy gate rejects.

## Defect (FIXED): the kit's own setup path could produce a green wall on an unchecked repo

`qc init` succeeds on a repo whose layout is not the reference layout, and writes a config with **no
`featureRoots` key** — so the check falls back to the defaults `backend/src/features` and
`frontend/src/features`, neither of which exists there. `qc check` then matches nothing and reports:

```
OK  structure    0 feature folder(s)
...
rc=0
```

Measured, not inferred: a repo with features under `services/api/features/` containing an unscoped
SQL statement, a raw `fetch`, and a disallowed subfolder goes `qc init` → `qc check` → **all green,
rc 0**. All three are violations the kit owns and catches elsewhere. This is the documented setup
path — steps 1–5 of `qc init`'s own output — not user error, because nothing in it fails or warns.

This is the failure the kit already names for agreements — `unfound-constant`, *"declares no values
here — the agreement checks nothing. Silence there is how a gate stops meaning anything."* The same
principle is not applied to the kit's own roots. **A configured root that matches nothing should be
a problem, not an `OK` line**, and `qc init` should not write roots it can see do not exist.

The mitigation exists but is opt-in: `qc config` does print `featureRoots`, and `qc init`'s step 3
says to check it. It relies on the adopter noticing.

Scope, also measured: the defaults happen to match `quality-control-mono`'s layout, so a config-less
clone of *that* repo still finds all 30 features, all 42 sagas, and still catches an injected
violation at rc 1. An earlier draft of this note claimed every gate no-ops without config; that was
wrong, and these measurements replace it.

## Gap (CLOSED): one gate had no adversarial case

`qc check` runs 13 gates; `evals/adversarial.sh` covers 12. **`registry-agreement` has none**, and
it prints no OK line on success, so a passing suite says nothing about it.

Verified by hand on the one agreement this repo declares
(`PRESIGN_LIFETIME_SECONDS` ↔ `session-lifetimes.json`):

- `clientDefault: 600` → `900` fires `registry-disagreement`.
- renaming the constant fires `unfound-constant` — the gate notices it has been left checking
  nothing, which is the failure that matters for an agreement.

The gate is sound. Both cases are now in `adversarial.sh`, along with one for `unfound-root`.
All 12 lint rules already had a case, so the rule layer was fully covered.

Adding the `unfound-root` case immediately earned its keep: the first version rewrote a
`featureRoots` key that `quality-control-mono`'s config does not have — it relies on the defaults —
so the injection was a no-op and the suite reported MISSED. The suite caught a bad test, which is
the same service it performs for a bad check. `restore()` was also hardened: it snapshots
`qc.config.json`, because that path is excluded from the clean for targets that keep it untracked,
so a case editing it could not otherwise be undone.

## STATE.md is stale in two places

- "`pnpm test` — 123 passing" → **166**.
- Gate 12's "honest number is 6 of 42" → **42 of 42** sagas are now named by a headless test.

## Still open, unchanged

`quality-control-mono` depends on `architecture-harness` via
`file:../architecture-kit/packages/qc-harness` — resolves only where both checkouts sit side by side.
Separately, `qc.config.json` is untracked there; given the defect above, a fresh clone silently
falls back to defaults rather than being told it has no config.

## Not covered

- The plugin was **not** reinstalled via `claude plugin marketplace add` — that mutates the user's
  installed plugin set. The hooks were exercised directly with `CLAUDE_PLUGIN_ROOT` set, which is
  the same code path the installed plugin runs.
- `commands/adopt.md` is agent-driven, not a CLI path, so nothing here exercises it.
- Config toggles were spot-checked (one gate off → `enforcement-map` fails), not swept per knob.
