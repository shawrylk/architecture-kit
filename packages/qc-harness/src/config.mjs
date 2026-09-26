// One config, read by every gate and by the lint preset. A constant that named this
// repository's shape is a config key here. Defaults reproduce the reference layout, so a
// repo that adopts the reference layout writes no config at all.

import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

export const CONFIG_FILE = "qc.config.json";

export const defaults = {
  // Where features live. Every structural gate walks these.
  featureRoots: ["backend/src/features", "frontend/src/features"],
  // The path segment that marks a feature, and the one file that crosses its boundary.
  featureDir: "features",
  publicFile: "index",

  docs: {
    root: "docs",
    decisions: "docs/decisions.md",
    enforcement: "docs/enforcement.md",
  },

  // Citation ids the repository defines and the gates resolve.
  citations: {
    prefixes: ["ADR", "QC"],
    // Ids recognised inside comments but owned elsewhere: standards, requirement ids.
    external: ["REQ-[A-Z]{3}-\\d+", "T\\d+-\\d+", "D\\d+"],
  },

  decisions: {
    // Content-addressed files: a ledger hashes them, so renumbering a citation inside one reads as tampering.
    immutable: ["(^|/)(drizzle|migrations?)/[^/]*\\.sql$"],
    // Vendored tooling: its citations resolve against its own upstream register, not this repository's.
    exclude: [],
  },

  thresholds: "quality-thresholds.json",

  // A key that makes a retry a resume rather than a second write. docs/guards.md.
  idempotency: {
    keys: ["mutationId", "clientMutationId", "idempotencyKey"],
    volatile: ["Date.now", "Math.random", "crypto.randomUUID", "uuid", "uuidv4", "nanoid", "randomUUID"],
    // A store that outlives nothing has nothing to dedupe, so a disposable key is right.
    ledgerKey: "ledger",
    throwawayLedgers: ["InMemoryPipelineLedger"],
  },

  // The log that is evidence only while nothing can edit it.
  audit: { table: "audit_log" },

  // Everything the I/O layer reads. A gate is pure; these say where its input lives.
  // A path that does not exist disables the check that reads it, rather than failing:
  // a repository without workers has no worker routes to disagree about.
  paths: {
    // The feature root the server-side gates read: schema, routes, SQL.
    serverFeatures: "backend/src/features",
    migrations: "backend/src/drizzle",
    // Requirement id to the tests that prove it.
    traceability: "traceability/requirements.json",
    // The edge that forwards to the api, holding the set it forwards without a session.
    publicRoutes: "bff/src/public-routes.ts",
    // Each worker's entrypoint, relative to its own folder.
    workers: "workers",
    workerEntry: "src/entry.ts",
    // Query shapes shared across features: statements that own no table and answer
    // to no migration, so they join the tenant scan only.
    sharedSql: "backend/src/application/sql/crud.ts",
    // Roots walked for citations, doc paths and foreign references.
    citable: ["backend/src", "frontend/src", "bff/src", "packages", "workers", "docs", "migration"],
    // Files inside a feature that carry SQL.
    resourceFiles: ["resource.ts", "schema.ts"],
    resourceDirs: ["shared", "slices"],
    triggerFile: "trigger.ts",
    // Platform and frontend features paths for boundary checks.
    platform: "frontend/src/platform",
    frontendFeatures: "frontend/src/features",
    // A repository's own gates. The kit's are proven by its suite; these are not.
    checks: "scripts/gate",
    // Terraform/shell roots the comment-style gate scans. Absence is ordinary — not every
    // repository provisions its own infrastructure.
    infra: ["infra"],
  },

  // Where a tool demands a literal the registry already owns, assert agreement rather
  // than forbid the number. QC-007. Each entry names both sides.
  agreements: [],

  // Names that may appear in a comment but are owned elsewhere.
  foreign: [],

  // What a scaffolded feature imports its runtime from. A new repository points this
  // at its own kernel; the kit emits the shape, never a dependency on the kit.
  kernelModule: "@qc/kernel",

  tenant: {
    column: "tenantId",
    sqlColumn: "tenant_id",
    tableFactory: "pgTable",
    indexFactory: "index",
  },

  storage: {
    modules: ["drizzle-orm", "pg", "postgres"],
    // The blocks permitted to import a storage module.
    resourceFiles: ["resource.ts", "schema.ts"],
    // Something must bind the driver for a resource to have a pool. That path is exempt.
    driverBinding: "backend/src/infrastructure/db/",
  },

  // Any third-party service's SDK, same reasoning as storage: one seam, so a second
  // provider or a test double only ever needs one place to differ. Cloud, payment,
  // messaging, search — a repository overriding scopes or modules replaces this list
  // wholesale (merge() does not union an array), so it repeats what it still wants.
  externalServices: {
    scopes: ["@aws-sdk", "@azure", "@google-cloud", "@sendgrid", "@elastic", "@algolia", "@stripe", "@twilio"],
    modules: ["aws-sdk", "stripe", "braintree", "twilio", "nodemailer", "algoliasearch", "amqplib", "kafkajs"],
    // A composition root wires the concrete client; nothing past it may know the provider.
    allowedFiles: ["main.ts", "entry.ts"],
    // A category subfolder, not a bare "adapters/": a feature-local folder named adapters/
    // must not become exempt by accident.
    allowedPaths: ["adapters/cloud/", "adapters/payments/", "adapters/messaging/", "adapters/search/"],
  },

  // The one module permitted to call fetch or build a URL.
  apiClient: "platform/api-client.ts",

  // Files that may only present, never orchestrate.
  presenters: "frontend/src/features/*/trigger",

  // Where the test-mirror gate looks. A test in `src` is misplaced; a test in `tests` mirrors a source
  // file there, unless its root is `testOnly`: a package whose code is test support.
  testMirror: {
    roots: [{ src: "frontend/src", tests: "frontend/tests" }],
  },

  // A workflow is headless-first: declared by one of these, and proven by a test that
  // imports none of the view modules. docs/architecture.md.
  saga: {
    factories: ["definePipeline", "defineSaga"],
    viewModules: ["react", "react-dom"],
    // The block that must stay callable without a view layer. One name, or a list when a
    // repository carries more than one anatomy.
    headlessBlock: "pipeline",
  },

  // A feature is reachable over its routes and from a command line. `cli` names the second
  // entrypoint: the block that drives the same pipeline with no server, which is what makes a
  // feature runnable by a test, a script or a person. `qc run <feature>.<command>` dispatches it
  // through the registry a repository's codegen writes to `registry`.
  cli: {
    block: "cli",
    // Which feature roots must carry one. Empty means every root the structure gate walks.
    roots: [],
    viewModules: ["react", "react-dom"],
    serverModules: ["fastify", "express", "koa", "@nestjs/core"],
    factory: ["defineCommands"],
    // The key a command entry names its workflow with. The gate's real check is that this table
    // and the feature's declared sagas agree both ways, so the name has to be readable statically.
    drives: "saga",
    // Read with saga-tests' own factories by default: both gates must see the same declarations.
    sagaFactories: ["definePipeline", "defineSaga"],
    // Only the publishing block crosses a feature boundary, so the registry reaches commands through it.
    publisher: "index",
    // The composed registry `qc run` imports. A repository writes it; the harness only dispatches.
    registry: "backend/src/features/commands.generated.ts",
    // `node --import` specifiers the registry needs. A TypeScript registry is run under the
    // repository's own loader, so the harness never depends on one.
    loader: ["tsx"],
  },

  // English is the one language in every set. Another language is data, not prose: it lives in a
  // declared path beside its English variant. `scripts` names the ranges a gate looks for.
  language: {
    scripts: ["cjk"],
    // Language is not a property of TypeScript. A migration's column default and a contract's
    // description reach a reader exactly like a comment does.
    extensions: ["tsx?", "[cm]?js", "mjs", "md", "sql", "ya?ml", "json"],
    // The whole repository. A language rule is not scoped to where decisions are cited.
    roots: ["."],
    exclude: ["(^|/)node_modules(/|$)", "(^|/)dist(/|$)", "(^|/)\\.git(/|$)", "(^|/)coverage(/|$)", "pnpm-lock\\.yaml$"],
    allowNonEnglish: [],
    translationPairs: [],
    // What the ledger may still carry. It may be met or lowered, never raised without saying so.
    legacyNonEnglish: {},
    legacyBudget: undefined,
  },

  // A decision record carries its cost and its rejected alternatives, or it is advocacy.
  adr: {
    root: "docs/decisions",
    sections: [
      "Prerequisite",
      "Context",
      "Decision",
      "Why this, specifically",
      "What this buys",
      "What this costs",
      "Alternatives considered and not chosen",
      "Related decisions",
    ],
    minWords: 12,
  },

  // One agent per branch per worktree. Off until a repository opts in: a solo agent is never
  // restricted. `require`: off | branch (refuse the trunk) | worktree (also refuse the primary).
  swarm: {
    isolation: { require: "off", protectedBranches: ["main", "master"], leaseHours: 8, allow: [] },
    // Tool calls per subagent. The hook reminds at seventy percent and denies all but the hand-off at the budget.
    toolCallBudget: 100,
  },

  // Files a generator writes. The generated-file hook refuses a hand edit of one and names `command`.
  generated: { globs: ["**/*.generated.*"], command: "pnpm codegen" },

  // `qc worktree`. `install` runs in each new worktree. `base` is the default `--from`: the ref a
  // branch starts at, and the ref `remove` checks a merge against.
  worktree: { install: "pnpm install --frozen-lockfile", base: "origin/main" },

  // Names that must be registered scoped, never singleton.
  scopedSuffixes: ["Repository", "Saga", "UnitOfWork", "UnitOfWorkFactory"],

  // A comment is one line of why; reasoning that wants a paragraph is a decision with an id.
  comments: { maxLines: 2 },

  // Switching a shipped check off names the decision that says why, or "off-by-design".
  floor: { exemptions: {} },

  // A tool is not an author. These may never appear in a commit's attribution trailer.
  commitMessage: {
    tools: [
      "claude", "anthropic", "copilot", "chatgpt", "openai", "gpt-4", "gpt-5", "gemini",
      "cursor", "codeium", "devin", "aider", "windsurf", "bot@", "noreply@anthropic.com",
    ],
  },

  // A named pattern is a pointer. `patterns` adds a repository's own vocabulary to the defaults.
  patterns: { maxWords: 20, extra: [] },

  // A promise is awaited. `allow` names the modules holding the two shapes await cannot express:
  // racing against a cancellation, and observing a rejection nobody is waiting for any more.
  promise: { allow: [] },

  // Enter and Escape in text entry wait for the IME. `components` are a repository's own text
  // inputs. `guards` name the one guard function; empty accepts an inline isComposing or keyCode check.
  ime: { components: [], guards: [] },

  // Files a person reviewed that may call sql.raw. Each one is a decision, so the list stays short.
  sqlRaw: { allow: [] },

  anatomy: {
    // Bounded vertical slices.
    slice: {
      required: ["index.ts", "schema.ts", "trigger.ts"],
      // Allowed at the root without being owed: `cli` is the headless entrypoint feature-cli reads.
      optional: ["cli.ts"],
      sliceDir: "slices",
      sharedDir: "shared",
      sharedFiles: ["types.ts", "queries.ts", "guards.ts", "runner.ts", "components.ts"],
    },
    // The flat pipeline anatomy.
    block: {
      required: ["index.ts", "trigger.ts", "pipeline.ts", "resource.ts"],
      optional: ["branch.ts", "fragment.ts", "ledger.ts", "record.ts"],
    },
  },

  // Every gate and lint rule is switchable. Ship all; a repo turns off what it lacks.
  // These are the gates `qc check` runs, and a switch here really does turn one off.
  gates: {
    "eight-blocks": true,
    citations: true,
    "registry-agreement": true,
    "registry-readers": true,
    "sql-identifiers": true,
    "migration-numbers": true,
    "tenant-predicate": true,
    "claimed-requirements": true,
    "public-routes": true,
    "internal-routes": true,
    "headless-sagas": true,
    "saga-tests": true,
    "gate-tests": true,
    "audit-append-only": true,
    "frontend-boundaries": true,
    "test-mirror": true,
    "enforcement-map": true,
    "comment-style": true,
    // Policy gates: each needs a repository to say what its policy *is* -- which language, which
    // paths, which ADR sections, which opt-outs are legitimate. Shipping them on would red every
    // repository the moment it upgrades the harness, which is how a gate bends the work it judges.
    "config-floor": false,
    "english-source": false,
    "adr-format": false,
    "feature-cli": false,
  },

  // Gates that produce rather than inspect: a repository's codegen imports these and
  // writes their output. `qc check` does not run them, so they carry no switch — a
  // switch that changed nothing would be a lie about what the config controls.
  generators: ["tenant-tables", "contract-compose"],

  rules: {
    "no-comment-paragraph": true,
    "name-the-pattern": false,
    "no-promise-then": true,
    "no-number-in-comment": true,
    "no-cross-feature-internals": true,
    "no-offset-pagination": true,
    "no-orchestration-in-trigger": true,
    "no-status-literal": true,
    "scoped-repository": true,
    "storage-only-in-resource": true,
    "external-service-only-in-adapter": true,
    "tenant-scoped-table": true,
    "signal-last-param": true,
    "no-raw-fetch": true,
    "no-sql-raw": true,
    "ime-safe-key": true,
    "registry-literal": true,
    "durable-idempotency-key": true,
    "no-supersession-trail": true,
  },

  // Layer names and their legal import direction. The kit ships the reference set;
  // a repo with different layers replaces the whole block.
  layers: {
    include: ["backend/src/**/*.ts", "packages/domain/src/**/*.ts"],
    elements: [
      { type: "domain", pattern: "packages/domain/src/**" },
      { type: "application", pattern: "backend/src/application/**" },
      { type: "adapters", pattern: "backend/src/adapters/**" },
      { type: "infrastructure", pattern: "backend/src/infrastructure/**" },
      { type: "feature", pattern: "backend/src/features/*/**" },
    ],
    allow: {
      domain: ["domain"],
      application: ["domain", "application"],
      adapters: ["domain", "application", "adapters"],
      infrastructure: ["domain", "application", "adapters", "infrastructure"],
      feature: ["domain", "application", "adapters", "feature"],
    },
    external: [
      { from: ["domain"], disallow: ["*"] },
      { from: ["application"], disallow: ["*"], allow: ["zod"] },
    ],
  },

  // Extra pipeline steps a repo composes in. The CLI never hardcodes a project's chain.
  pipeline: [],

  // Files the browser rules apply to.
  clientFiles: ["frontend/src/**/*.{ts,tsx}"],

  // Tooling names the vocabulary it bans, so it trips its own checks.
  toolingFiles: ["scripts/**/*.mjs", "**/*.test.{ts,tsx,mjs}"],

  ignores: ["**/dist/**", "**/node_modules/**", "**/*.tsbuildinfo"],
};

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Later wins. An array replaces; an object merges key by key. */
export function merge(base, override) {
  if (!isPlainObject(base) || !isPlainObject(override)) return override ?? base;
  const out = { ...base };
  for (const [key, value] of Object.entries(override)) {
    out[key] = isPlainObject(value) && isPlainObject(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

/** Read `qc.config.json` from `root`, merged over the defaults. Absent is legal. */
export function load(root = process.cwd()) {
  const file = path.join(root, CONFIG_FILE);
  const user = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : {};
  const config = merge(defaults, user);
  config.root = root;
  return config;
}

/** Thresholds live in their own registry so lint and docs cite one number. */
export function thresholds(config) {
  const file = path.join(config.root ?? process.cwd(), config.thresholds);
  if (!existsSync(file)) return {};
  return createRequire(import.meta.url)(file).gates ?? {};
}

/**
 * Registry entries that say who may hold their number. `names` are identifier patterns, each a
 * regular expression matched against the whole identifier, case-insensitive. `readers` are paths.
 */
export function readerEntries(registry) {
  return Object.entries(registry)
    .filter(([, entry]) => entry.names?.length > 0 || entry.readers?.length > 0)
    .map(([key, entry]) => ({ key, names: entry.names ?? [], readers: entry.readers ?? [] }));
}

export function enabled(map, id) {
  return map[id] !== false;
}
