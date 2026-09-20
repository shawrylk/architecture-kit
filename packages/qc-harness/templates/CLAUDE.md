# <repository>

<One line: what this system does, and the domain it does it in.>

## Authority

`docs/decisions.md` — every id cited in this repo is defined there. Self-contained: a citation to an
undefined id, a missing doc path, or a reference to another repository fails the build.

| Read | For |
|---|---|
| `docs/architecture.md` | Layers, feature anatomy, unit of work, data, auth |
| `docs/guards.md` | Create / update / offline guards. **Do not reconcile them** |
| `docs/ui.md` | Parity, realtime, presenters |
| `docs/enforcement.md` | Every rule beside the check that enforces it |
| `docs/performance.md` | Budgets. The one home for these numbers |
| `docs/pagination.md` | Keyset, cursors, counting, and the one exemption |
| `docs/glossary.md` | Domain terms |
| `STATE.md` | What is true now |

## Commands

`qc init` added the first three. Add the rest as the repository grows them, and list
every one here — this table is what an agent reads instead of guessing.

```bash
pnpm spec:check            # every structural gate (qc check)
pnpm gen:feature <name>    # scaffold a feature. Full domain name, never a code
npx qc check <file>        # the fast path a post-edit hook takes
npx qc config              # print the configuration in force
```

## Non-negotiable

- Bounded Vertical Slices (ADR-0054) or the flat pipeline anatomy (ADR-0047). An empty block or
  slice is a review finding.
- Zero copy-pasting across files; extract shared logic to utilities, `shared/`, or packages.
- Only a feature's `index` crosses a feature boundary.
- Tenant column on every business table; repositories `scoped`, never `singleton`; row-level
  security; a two-tenant test asserting zero cross-reads.
- Keyset pagination only.
- Throw a domain error; never write an HTTP status by hand.
- The cancellation token is last on anything that can outlive the interaction.
- One module calls `fetch`.
- Never write a number or quantity threshold in a comment (neither digits nor words like "five
  seconds") — cite the registry, config constant, or the doc that owns it.
- A change is rewritten in place. No supersession trail, no deprecation note (QC-008).

## Working with agents

`.claude/rules/swarm.md` is the protocol: exclusive paths, index-first, generated registries,
never two edits to one file.

Hooks run the gates on every edit and refuse to end a red turn.
