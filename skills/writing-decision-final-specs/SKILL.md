---
name: writing-decision-final-specs
description: "Use when writing or changing a technical specification, an ADR, a tasks.md, a contract under schemas/ (OpenAPI, AsyncAPI, FlatBuffers, Protobuf, SCXML, CEL), a traceability requirements register, versions.json, or a Docusaurus docs site."
---

# Spec-driven development

Before production code is written, the design is captured as a **decision-final technical specification**. No stubs, no "TBD", no "not yet implemented" — every design choice is explicitly resolved. If a required detail is missing, **ask the minimum necessary questions to reach closure before generating**, exactly one clarification question per missing decision. The author of a spec acts as a **senior architect**: the spec is production-grade and final at the moment it is published.

## Output format

- The spec is a **Docusaurus site rooted at `docs/`**. Pages are Markdown or MDX.
- **Every contract lives in `schemas/`.** The schema file is the source of truth, and the site
  renders it. A page illustrates a contract; it never defines one.
- **One responsibility per file** — one domain overview, one API contract, one ADR.
- **Overview-detail pattern** — each page opens with machine-readable frontmatter, then the human
  detail. An AI reads the frontmatter to judge relevance without reading the whole page.

## Required tree structure

```
docs/                            # Docusaurus root
├── docusaurus.config.js
├── sidebars.js
└── docs/
    ├── 01-architecture/         # ADRs, system overview
    └── 02-contracts/
        ├── rest-api.md          # rendered from schemas/openapi.yaml
        ├── events.md            # rendered from schemas/asyncapi.yaml
        ├── structs.md           # rendered from the FlatBuffers or Protobuf schema
        └── statecharts.md       # SCXML rendered as Mermaid diagrams
schemas/                         # universal single source of truth
├── openapi.yaml                 # OpenAPI 3.1 — REST and HTTP contracts
├── asyncapi.yaml                # AsyncAPI 3.0 — event and WebSocket contracts
├── <name>.fbs                   # FlatBuffers structs (or <name>.proto for Protobuf)
├── <name>.scxml                 # W3C state machine definitions
├── invariants.cel.yaml          # CEL validation rules
├── redocly.yaml                 # lint config; every disabled rule states why
└── CHANGELOG.md                 # per contract version: what changed, why, blast radius, migration
versions.json                    # EVERY library and engine version. The only home for a version number.
traceability/
└── requirements.json            # REQ-<DOMAIN>-nnn register -> spec pages, ADRs, tasks, tests
scripts/                         # the render scripts, and one gate per concern
```

**Map this tree onto the project. Do not copy it.** Most projects have REST and nothing else. A
schema file whose subject the project does not have is a placeholder, and the rule below forbids it.
Create `asyncapi.yaml` when a queue or a WebSocket exists, `.fbs` when a binary struct exists, and
`.scxml` when a real state machine exists. Ask before you scaffold one. The same applies to the page
that renders it: drop `events.md` when the project has no events.

## How each schema kind reaches the site

Only OpenAPI has an off-the-shelf render path. Checked against npm on 2026-08-26. Name the packages
below exactly, because two plausible names do not exist.

| Schema kind | Source | Render mechanism |
| --- | --- | --- |
| OpenAPI | `openapi.yaml` | `docusaurus-plugin-openapi-docs` with `docusaurus-theme-openapi-docs` |
| AsyncAPI | `asyncapi.yaml` | `@asyncapi/react-component` inside an MDX page. **No plugin exists.** |
| FlatBuffers, Protobuf | `*.fbs`, `*.proto` | a local script in `scripts/` |
| SCXML | `*.scxml` | a local script that emits Mermaid, rendered by `@docusaurus/theme-mermaid` |
| CEL | `invariants.cel.yaml` | a local script that emits a table |

Two names that look right and are **not published**: `@docusaurus/plugin-openapi-docs` and
`@asyncapi/docusaurus-plugin`. Do not put either in a `package.json`.

Every rendered page is **build output**. Generate it from `schemas/`, and never hand-edit it.

## Page frontmatter for AI readers

Each page carries these four keys, and the spec gate fails when one is missing:

```yaml
---
domain: payments            # the domain, or cross-cutting, or architecture
purpose: API contract for money transfers
depends_on: ["01-architecture/domain-model.md"]
keywords: [transfer, idempotency, webhook]
---
```

Pages are Markdown, so these keys are frontmatter. Do not emit an HTML `<div>` for this.

## Content rules — no placeholders

- Every pattern, technology, and numeric value is **concrete**. Bad: "Use a database like PostgreSQL" → Good: "the pinned engine version with pgvector, 3-node replica set." Bad: "Implement retry logic" → Good: "Exponential backoff: 100ms, 200ms, 400ms, max 3 retries."
- **A version number never appears in a spec page.** Pages carry a `{{ver:<id>}}` token (or `{{v:<id>}}` for the bare number); the build renders it from `versions.json`. To bump a database major, make one edit and rebuild. Never search the repository for a number. The versions gate fails on a literal, on an unknown id, and on a pinned version no page uses. **The ADR log is the one exemption** — an accepted ADR states the version as of its date, and nobody rewrites it.
- **A payload shape never appears twice.** The file in `schemas/` defines it; the page illustrates it. Where they disagree the schema file wins and the page is a defect. Client validation schemas are *generated* from the contract — a hand-written one beside it is two homes for one fact.
- **Every business rule and budget carries an id** (`REQ-<DOMAIN>-nnn`) in `traceability/requirements.json`, linking it to its spec pages, ADRs, tasks and tests. A task no requirement claims is scope creep; a requirement no task builds is a wish. Both fail CI. Requirement ids are permanent, and nobody recycles one.
- **Risks are in scope; open questions are not.** A risk is a known, accepted hazard stated where a reader would otherwise walk into it. An unmade decision gets asked and answered before publishing — a "Risks and open questions" section lets the second kind hide behind the first.
- Every task in a `tasks.md` is **atomic and testable** (for example, "Write unit test for `Transfer::validateBalance()` that throws on negative balance."), and states its criterion as `Test: …`.
- Every ADR contains: **date, status (only `accepted`), decision, consequences, and rejected alternatives with justification.**
- **Definition of Done**: spec updated, contract updated and version-bumped with a changelog entry, requirement ids linked, tests linked, quality gates green, observability in place, task ticked. Not "the code works".
- If user input lacks a detail, ask exactly one clarification question per missing decision, then generate the final spec with **no** placeholders.

## Linking, styling, and validation

- All links are **relative**. Set `onBrokenLinks: "throw"` in `docusaurus.config.js`, so a dead link fails the build.
- `sidebars.js` lists every page. A page the sidebar omits is an orphan, and the spec gate fails on it.
- Docusaurus owns the theme. It ships dark and light mode, and Prism code blocks. Do not hand-roll either, and do not add a stylesheet that overrides it.
- **Before you publish**, run one gate per concern. All are green, and all run in CI. Each one fails loudly and names the file:
  - **spec** — every page carries all four frontmatter keys; no "TBD/TODO/not yet/placeholder/stub/decide later"; every task states a `Test:`; `docusaurus build` succeeds.
  - **versions** — no version literal outside `versions.json` and the ADR log.
  - **contracts** — the pages and the files in `schemas/` describe the same surface, in both directions; every operation carries an `operationId` and its requirement ids.
  - **traceability** — every requirement has a task, every task has a requirement, and every cited ADR and page path resolves.
  - **`redocly lint`** through `@redocly/cli` on any edit to `openapi.yaml` or `asyncapi.yaml`. A gate that matches patterns prints `OK` for YAML no parser accepts, so it is not a substitute.
- If you cannot finalise a decision, **ask the necessary questions first and wait**. Do not produce output with an unresolved decision.
