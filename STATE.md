# STATE

Both halves are built, and `quality-control-mono` now runs on them.

## What exists

| Path | Holds |
|---|---|
| `.claude-plugin/`, `hooks/`, `skills/`, `commands/` | the Claude Code plugin `architecture` |
| `packages/qc-harness/src/gates/` | 21 gates, each with its must-fail case |
| `packages/qc-harness/src/eslint/` | 16 rules, a preset, and the fixture suite |
| `packages/qc-harness/src/cli/` | `qc check｜init｜feature｜install-hooks｜config` |
| `packages/qc-harness/templates/` | decisions, architecture, enforcement, guards, performance, glossary, ui, CLAUDE.md, thresholds, git hook, CI |

`pnpm test` — 168 passing.

## Acceptance, passed

1. **`qc check` reproduces the old checker** on `quality-control-mono`'s real code: 30 feature
   folders, the same two tenant-predicate exemptions, same verdict. Only two wordings differ, both
   deliberate (`bff` → `edge`, a dropped citation the kit cannot make).
2. **The lint preset reproduces the old eslint config byte for byte** across the whole repository,
   compared back to back on one tree.
3. **A fresh empty repository** goes `qc init` → `qc feature` → green `qc check`.
4. **The hooks** no-op without `qc.config.json`, pass a good file, and return exit 2 with the
   finding on a bad one.

## Renames, deliberate

| was | is | why |
|---|---|---|
| `drizzle-only-in-resource` | `storage-only-in-resource` | the ORM is config |
| `headless-pipeline-no-react` | `headless-pipeline-no-view` | the view library is config |
| `disallowed-legacy` | `disallowed-flat-anatomy` | "legacy" is this repo's history |

`checkSelfContained(files, foreign)` takes the foreign-name list; it hardcoded one repository's
predecessor.

## Installed and verified

`claude plugin marketplace add <this repo>` then `claude plugin install architecture` works.
The inventory loads as 7 skills and 2 hooks, ~479 tokens always-on. Verified against a real
repository: the stop gate runs and reports, the post-edit gate passes a clean file, and both
no-op where there is no `qc.config.json`. The installed plugin carries the package, so the
hooks' `${CLAUDE_PLUGIN_ROOT}/packages/qc-harness/src/cli/qc.mjs` path resolves.

A consuming repository therefore keeps no hook scripts of its own. It adds its own extra stop
step through `QC_STOP_EXTRA` in `.claude/settings.json`.

## Open

- **The dependency is a local file link.** `quality-control-mono` has
  `"architecture-harness": "file:../architecture-kit/packages/qc-harness"`, which only resolves on a
  machine with both checkouts side by side. Publish, or point at the git URL, before anyone else
  clones it. The plugin half needs no such step — it installs from this repo directly.
- No git remote yet. `.github/workflows/ci.yml` runs the suite and a from-nothing smoke test
  (`qc init` → `qc feature` → `qc check`) once one exists.


## Gate 12 — saga-tests

Added after the extraction. The two headless rules keep orchestration out of the view and the view
out of the pipeline; neither proves a workflow is ever *run* without one. This asserts every
declared saga is named by a test that imports no view module.

Its first version demanded the pipeline constant's own name and reported 42 of 42 sagas untested in
`quality-control-mono` — a false alarm. Those workflows are called through `run*` helpers that wrap
the pipeline, so the gate now follows that one indirection, the way `tenant-predicate` already
follows a named insert factory. The honest number is **6 of 42**, all in `rebar`.

A CLI gate was considered and rejected here: asserting an entrypoint file exists passes on day one
and never fails again. The condition set then — write it as agreement between a dispatch table and
the set of declared sagas, the shape `public-routes` and `internal-routes` already use — is what
gate 23 now does.


## The pre-push hook skips a delete

Deleting 42 merged branches in `quality-control-mono` ran the full gate suite 42 times, because the
hook did not look at what was being pushed. A delete carries an all-zero local oid and no commits,
so there is nothing to check.

It skips only when refs were named and every one was a delete. Empty stdin runs the gates: an
invocation the hook cannot reason about is a reason to check, not to skip.


## Gate 23 — feature-cli, and `qc run`

A tree can be green and not work. `quality-control-mono` was: 2,216 tests passing, and three tabs
nobody could drive without a browser and a seeded database. Every one of those tests reaches a
feature through a mock; nothing reaches one the way the product does.

So the feature gets a second entrypoint beside its routes. `cli` declares a command table, `index`
republishes it, a repository's codegen composes the registry, and `qc run <feature>.<command>`
dispatches through the loader the repository names. The harness stays ignorant of the tree: it
resolves one key and calls it.

The gate is the agreement, both ways:

| Rule | Fails when |
|---|---|
| `feature-cli-undrivable-saga` | a feature declares a workflow no command drives |
| `feature-cli-unknown-saga` | a command names a workflow the feature does not declare |
| `feature-cli-missing` | a feature under the configured roots carries no command block |
| `feature-cli-unpublished` | `index` does not re-export it, so the registry cannot reach it |
| `feature-cli-no-view`, `feature-cli-no-server` | the block imports a view layer or an HTTP framework |
| `feature-cli-undeclared`, `feature-cli-untested` | the table is not declared through the factory, or nothing imports it |

The first two are the gate. The rest are hygiene that would pass forever on their own.

Off by default, like the other policy gates: a repository names its own block, roots, factory and
registry, or every tree would go red on upgrade — the failure mode `config-floor` and
`english-source` are already off for.


## Gates 13–15 and rules 11–12

Derived by applying QC-007 to the kit itself: which decisions it ships had no check.

| Check | Enforces |
|---|---|
| `gate-tests` | a repository's own gates each ship a case that must fail |
| `audit-append-only` | no update, delete or truncate names the audit table |
| `enforcement-map` | every check the kit runs is named in the map, and every name in the map resolves |
| `qc/no-supersession-trail` | no deprecation note or "what this replaces" in a comment |
| `qc/durable-idempotency-key` | an idempotency key is not minted inline where a retry cannot reuse it |

`enforcement-map` found real staleness on its first run, including two rows written during the
extraction claiming `qc check` runs `contract-compose` and `tenant-tables` — both generators, not
gates. That is the bug class it exists for.

### durable-idempotency-key took three attempts

1. **Ban minting.** 44 findings. Wrong: the client is *supposed* to mint one per operation, and a
   correct persisted queue was flagged.
2. **Ban minting inline in a call argument** — a value built there cannot be re-sent. 42 findings,
   dominated by one backend idiom.
3. **Exempt a throwaway dedupe store.** `ledger: new InMemoryPipelineLedger()` in the same object
   says the key is disposable by design, because nothing will ever recognise a repeat. 20 findings,
   all frontend, all the same real shape: an id minted inside a click handler's call argument, so a
   failed save retried by the user writes a second row.

The lesson is the one `tenant-predicate` already carries: the exemption has to be local evidence in
the same expression, or the rule cries wolf and someone disables it.

### Not built: a no-second-datastore rule

Banning a cache or search server would manufacture a decision a new repository has not made. A gate
enforces a decision that exists; it does not create one.


## ADR-0048 amended, ADR-0055 added, docs/pagination.md shipped

ADR-0048 was "a socket carrying notifications, not data". It now reads as a **sequenced stream**:
every frame carries a sequence number and names a row; a client holding the complete set applies
it as a delta, a client holding a *window* onto a set invalidates and refetches, and a gap is
closed by refetching rather than guessing.

The line is not list-versus-detail. It is **complete set versus window** — a new row has no
placement in a page nobody has fetched, which is why paginated lists resist deltas no matter how
small the payload.

ADR-0055 carries pagination, and `docs/pagination.md` owns the query, the index, the cursor, the
count and the one exemption. Both public standards back the opaque cursor: Relay says a cursor
"should be considered opaque by the client"; AIP-158 says page tokens **must** be opaque and
**must not** be user-parseable, and that base-64 alone is insufficient. AIP-158 also permits a
`total_size` that "may be an estimate" if documented as one, which is where the bounded count and
the documented estimate come from.

## Two places the generator was fighting the gates

Both found by running `qc init` then `qc feature` then `qc check` on an empty directory — which is
the CI smoke test, and the reason it exists.

- `qc feature` emitted a saga with no test, so scaffolded code failed `saga-tests` immediately. It
  now emits a headless test beside the slice.
- `qc feature --flat` wrote into a root the default config marks slice-only, so the output failed
  `eight-blocks`. It now refuses and says which of the three fixes applies.

The right thing has to be the cheapest thing; a generator that emits rejected code inverts that.


## `unfound-root` — the roots themselves

Found by testing the kit against a repository whose layout is not the reference one. `qc init`
writes concrete `featureRoots`, and nothing required them to exist. A repository with features under
`services/api/features/` went `qc init` → `qc check` → **green at rc 0** while holding an unscoped
SQL statement, a raw `fetch` and a disallowed subfolder. The sweep matched nothing, so every gate
downstream of it passed on an empty set, and `OK  structure    0 feature folder(s)` read as a pass.

This is the silence `unfound-constant` already refuses for an agreement, applied to the roots. A
configured root that matches nothing is now a problem, and the structure line is withheld when it
fires.

**One root missing is deliberately not a finding.** The kit's own from-nothing smoke test proves
why: `qc feature orders` scaffolds under `backend/src/features` and creates no frontend, so
demanding every configured root exist would fail the kit's own documented setup path — and would
cry wolf at every backend-only adopter, which is how a rule gets switched off. Only the case where
not a single configured root exists is reported.

It is a pre-flight check inside `runCheck`, not a gate in `config.gates`. Two reasons: a repository
should not be able to switch off the check that says its configuration points at nothing, and the
gate roster is what `enforcement-map` validates `docs/enforcement.md` against, so a new gate name
would demand a new row in every consuming repository at once.

Consequence, handled: `qc init` on an empty repository now has no root yet, so init's printed step
list ends with `qc feature <domain-name>` before `qc check` — the path CI already smoke-tests.

`featureRoots: []` is left alone deliberately. An empty list is an adopter saying this repository
has no feature roots, which is coherent for one that wants the citation and audit checks and no
anatomy; flagging it would manufacture a decision nobody made. The check fires on roots that were
named and are not there, which is the mismatch, not the opt-out.


## Gate 21: plain-language

The gate reads prose against Simplified Technical English (ASD-STE100) and the Google developer
documentation style. It reads a Markdown document as prose, and a source file through its comments.

| Rule it reports | What fails |
|---|---|
| `sentence-too-long` | over 20 words in a list item, or over 25 words in a paragraph |
| `paragraph-too-long` | over 6 sentences in one paragraph |
| `unapproved-word` | a word or a phrase in `plainLanguage.replace`, with the word that replaces it |
| `passive-voice` | a form of "to be" and a past participle |
| `heading-case` | a heading in title case |
| `link-text` | link text that names the click, not the page |
| `em-dash` | an em dash, or a spaced double hyphen, holding two sentences in one |
| `semicolon` | a semicolon joining two sentences |

A hard-wrapped paragraph counts as one block, so a sentence a writer broke over two lines stays one
sentence. A fence, a table, a quote, an indented block and a front matter block are not prose.

The rest of the standard stays a review rule. Approved meaning, approved part of speech and noun
clusters all need a part-of-speech tagger, and the approved dictionary carries a licence, so the
kit cannot ship it.

Off by default, like every other policy gate. A repository states its own vocabulary under
`plainLanguage.replace` first, and drops a word the kit ships by setting its value to null.

The kit does not pass its own gate yet. Over its own Markdown files the gate reports about 180
findings, most of them long sentences and passives. Turning the gate on means rewriting `README.md`,
`STATE.md`, `NOTES.md` and the shipped templates first. That rewrite is the open decision, not the
gate.


The same gate runs as a Claude Code Stop hook, at `~/.claude/hooks/plain-language/check-output.mjs`.
It reads the last message Claude wrote, runs the gate over it, and blocks the turn when the prose
fails. `stop_hook_active` stops the block repeating, so one turn costs at most one rewrite.


## Rule 17: timeless-comment

A comment states what is true, never when it became true. `no-supersession-trail` already owned the
past tense. This rule owns the other two halves.

| Group | Catches | Message |
|---|---|---|
| `promises` | todo, fixme, for now, coming soon, revisit, stopgap, will be removed | put the promise in an issue or a decision record |
| `moments` | currently, as of, recently, previously, originally, we now, renamed from | state what is true, not when it became true |

Comments only, like its sibling. The same word inside a string is data.

A phrase that carries an ordinary second meaning stays out of the defaults: `eventually` reads as
eventual consistency, `so far` reads as the rows read so far, `moved from` reads as a state change,
and a bare `temporary` reads as a temporary file. A repository adds what it wants under
`comments.timeless`, and a list stated there replaces the rule's own.
