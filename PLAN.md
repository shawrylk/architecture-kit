# PLAN — architecture-kit

Extract the agent harness + architecture of `quality-control-mono` into a reusable kit.

Source repo: `quality-control-mono` (branch `chore/local-env-single-file`).

## Two artifacts, one repo

| Artifact | Installs how | Holds |
|---|---|---|
| Claude Code plugin `architecture` | `claude plugin install` | hooks wiring, skills (rules), slash commands |
| npm package `architecture-harness` | `pnpm add -D` | gates, eslint rules, CLI, doc templates |

The plugin's hooks shell out to the package's CLI. They cannot merge: different install mechanisms.

## The real work is parameterization, not copying

Every gate hardcodes this repo's shape. Each file is parameterized **as it moves**, reading
`qc.config.json` instead of a constant. Known hardcodes:

- `check.mjs` — `ROOTS = ["backend/src/features","frontend/src/features"]`
- `citations.mjs` — requires `docs/decisions.md` with ADR/QC ids
- `eight-blocks.mjs` — ADR-0047 block filenames + ADR-0054 slice taxonomy
- `no-raw-fetch` — `platform/api-client.ts`; `drizzle-only-in-resource` — Drizzle + `resource.ts`
- `sql-identifiers` / `public-routes` / `internal-routes` / `contract-compose` — backend/bff/workers split
- `eslint.config.mjs` — relative `require("./quality-thresholds.json")`
- both hooks — `cd ../..` + `node scripts/check.mjs`; fixed `/tmp/qc-*.log` (two projects clobber)

Every gate and rule is individually toggleable in config. Ship all, default preset on.
A new project turns off what does not apply.

## Phases

- [x] **P0** repo skeleton, PLAN/STATE
- [x] **P1** `qc.config.json` schema + loader with defaults
- [x] **P2** 11 eslint rules + `rules.test.mjs` → `src/eslint/`, parameterized
- [x] **P3** 14 gates + tests → `src/gates/`, parameterized
- [x] **P4** CLI `qc`: `check`, `gate:test`, `init`, `gen:feature`, `codegen`, `install-hooks`
- [x] **P5** templates: `docs/{decisions,architecture,enforcement,guards,glossary,performance}.md`,
      `CLAUDE.md`, `.githooks/pre-commit`, `ci.yml`, `quality-thresholds.json`, `.jscpd.json`
- [x] **P6** plugin half: `plugin.json`, `marketplace.json`, `hooks/hooks.json`, skills, commands
- [x] **P7** rewire `quality-control-mono` onto the kit — `pnpm check` green, originals still present
- [x] **P8** delete originals there (QC-008: rewritten in place, no shims)

## Acceptance

P7 is the real test: the extracted package reproducing this repo's current green state on this
repo's real code. `node --test` inside the kit is the per-gate regression suite (ADR-0032 means
every gate already ships its own failing case).

## Do not carry

- `scripts/gate/tenant-predicate.mjs.orig` — merge artifact
- `test:headless`, `contracts:lint` — project-specific (redocly, `packages/testing`). The CLI
  composes its pipeline from config; it does not hardcode this repo's `pnpm check` chain.

---

# PLAN — round 2: publish the kit, and hold both repos to it

Status as of 2026-09-20, end of session.

## Done

| Ask | Outcome |
|---|---|
| Identity and SSH, permanently | `~/.gitconfig` rewrites ArentInc and hieuxn URLs onto the `github-company` key and picks the work identity **by remote**, never by directory -- `~/Documents/GitHub` holds personal repositories too. A fresh clone needs no setup |
| Kit pushed and tagged | `v0.2.0`, then `v0.2.1`. Pushed as hieuxn |
| Every comment in `quality-control-mono` is English | 126 lines over 71 files, plus 3 more from a commit that landed mid-session. Generated wire types fixed at their contract source, never edited |
| `config-floor` | A check switched off names a decision id that resolves, or `off-by-design` |
| No AI attribution | `commit-msg` hook; trailers stripped from every unpushed commit in both repos |
| `name-the-pattern` | Tightened to need a definition, not a mention, after it produced nine false positives here |
| CI tiers + merge_group | static / unit / integration, named once as package scripts |

## Blocked, and on whom

| Item | Blocker |
|---|---|
| PR for `chore/english-and-ci-tiers` | `gh` is authenticated as the personal account, which cannot see `ArentInc`. Branch is pushed; the PR needs your account |
| Merge queue enabled | Repository setting, org admin. The workflow already carries `merge_group` |
| `npm publish` | No npm auth here. `npm login`, then `npm publish` from `packages/qc-harness` |
| `adr-format` on | QC-014 records why: twenty-nine one-line decisions cannot have their reasoning reconstructed honestly |

## Next

29 components in `language.legacyNonEnglish` still hold a Japanese string that belongs in the
dictionary. The rule is on, so nothing joins that list, and an entry whose file is clean now fails
-- it can only shrink. Moving those strings into i18n is a product decision, not a lint fix.
