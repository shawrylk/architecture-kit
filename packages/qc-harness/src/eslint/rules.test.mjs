import { RuleTester } from "eslint";
import { rules } from "./index.mjs";

const tester = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module" },
});

// Every rule is proven by a case that must fail. A gate that has never failed
// has never been tested. ADR-0032.

console.log("→", "no-number-in-comment");
tester.run("no-number-in-comment", rules["no-number-in-comment"], {
  valid: [
    { code: "// docs/performance.md owns the budget\nconst a = 1;" },
    { code: "// ADR-0052 — the version check is the guard\nconst a = 1;" },
    { code: "// REQ-PHO-003\nconst a = 1;" },
    { code: "// uuidV7 is time-ordered\nconst a = 1;" },
    { code: "// the one place a caller resolves a name\nconst a = 1;" },
    { code: "// a hand-built `file://${argv[1]}` never matches on Windows\nconst a = 1;" },
  ],
  invalid: [
    { code: "// retry up to 3 times\nconst a = 1;", errors: [{ messageId: "number" }] },
    { code: "/* budget is 16 ms */\nconst a = 1;", errors: [{ messageId: "number" }] },
    { code: "// retry up to three times\nconst a = 1;", errors: [{ messageId: "number" }] },
    { code: "/* budget is sixteen ms */\nconst a = 1;", errors: [{ messageId: "number" }] },
    { code: "// wait five seconds\nconst a = 1;", errors: [{ messageId: "number" }] },
  ],
});

console.log("→", "no-comment-paragraph");
tester.run("no-comment-paragraph", rules["no-comment-paragraph"], {
  valid: [
    { code: "// the one place a caller resolves a name\nconst a = 1;" },
    { code: "/** ADR-0052 — the version check is the guard */\nconst a = 1;" },
    { code: "// first thought\n\n// a second, separated by a blank line\nconst a = 1;" },
    { code: "const a = 1; // why this one\nconst b = 2; // why that one" },
    { code: "const a = 1; // why\n// and an own-line note\nconst b = 2;" },
    { code: "// returns early when the caller supplied no folder\nconst a = 1;" },
    { code: "/**\n * one line of why\n * @param {string} a\n * @returns {number}\n */\nconst a = 1;" },
    { code: "// the one error handler owns that mapping; no status is set here\nconst a = 1;" },
    { code: "// one\n// two\nconst a = 1;" },
    { code: "/**\n * one\n * two\n */\nconst a = 1;" },
    { code: "/**\n * one\n * two\n * @param {string} a\n */\nconst a = 1;" },
  ],
  invalid: [
    { code: "// one\n// two\n// three\nconst a = 1;", errors: [{ messageId: "paragraph" }] },
    { code: "/**\n * one\n * two\n * three\n */\nconst a = 1;", errors: [{ messageId: "paragraph" }] },
    { code: "/**\n * one\n * two\n * three\n * @param {string} a\n */\nconst a = 1;", errors: [{ messageId: "paragraph" }] },
    {
      code: "// a wrapped sentence is two lines, but three lines is a decision\n// rather than a comment\n// and this is line three\nconst a = 1;",
      errors: [{ messageId: "paragraph" }],
      options: [{ decisions: "docs/decisions.md" }],
    },
    { code: "// ==========\nconst a = 1;", errors: [{ messageId: "banner" }] },
    { code: "// const previous = read();\nconst a = 1;", errors: [{ messageId: "code" }] },
    { code: "// if (ready) {\nconst a = 1;", errors: [{ messageId: "code" }] },
  ],
});

console.log("→", "no-cross-feature-internals");
tester.run("no-cross-feature-internals", rules["no-cross-feature-internals"], {
  valid: [
    { code: "import { pins } from '../pins/index.js';", filename: "/a/features/photos/pipeline.ts" },
    { code: "import { pins } from '../../pins/index.js';", filename: "/a/features/photos/slices/create.ts" },
    { code: "import { pins } from '../../pins';", filename: "/a/features/photos/slices/create.ts" },
    { code: "import { x } from './resource.js';", filename: "/a/features/photos/pipeline.ts" },
    { code: "import { y } from '../photos/resource.js';", filename: "/a/features/photos/pipeline.ts" },
  ],
  invalid: [
    {
      code: "import { x } from '../pins/resource.js';",
      filename: "/a/features/photos/pipeline.ts",
      errors: [{ messageId: "internal" }],
    },
    {
      code: "import { x } from '../../pins/shared/index.js';",
      filename: "/a/features/photos/slices/create.ts",
      errors: [{ messageId: "internal" }],
    },
    {
      code: "import { x } from '../../pins/slices/create-pin.js';",
      filename: "/a/features/photos/slices/create.ts",
      errors: [{ messageId: "internal" }],
    },
  ],
});

console.log("→", "storage-only-in-resource");
tester.run("storage-only-in-resource", rules["storage-only-in-resource"], {
  valid: [{ code: "import { eq } from 'drizzle-orm';", filename: "/a/features/pins/resource.ts" }],
  invalid: [
    {
      code: "import { eq } from 'drizzle-orm';",
      filename: "/a/features/pins/pipeline.ts",
      errors: [{ messageId: "misplaced" }],
    },
  ],
});

console.log("→", "no-raw-fetch");
tester.run("no-raw-fetch", rules["no-raw-fetch"], {
  valid: [
    { code: "await fetch(url);", filename: "/a/platform/api-client.ts" },
    { code: "await client.get(path);", filename: "/a/features/pins/index.ts" },
  ],
  invalid: [
    { code: "await fetch(url);", filename: "/a/features/pins/index.ts", errors: [{ messageId: "raw" }] },
    { code: "new URL(path);", filename: "/a/features/pins/index.ts", errors: [{ messageId: "raw" }] },
  ],
});

console.log("→", "no-status-literal");
tester.run("no-status-literal", rules["no-status-literal"], {
  valid: ["throw new ConflictError();", "reply.status(status);"],
  invalid: [{ code: "reply.status(409);", errors: [{ messageId: "literal" }] }],
});

console.log("→", "storage-only-in-resource path");
tester.run("storage-only-in-resource", rules["storage-only-in-resource"], {
  valid: [
    { code: 'import { Pool } from "pg";', filename: "backend/src/infrastructure/db/pg-pool.ts" },
    { code: 'import { drizzle } from "drizzle-orm";', filename: "backend/src/features/pins/resource.ts" },
  ],
  invalid: [
    {
      code: 'import { Pool } from "pg";',
      filename: "backend/src/features/pins/pipeline.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import { Pool } from "pg";',
      filename: "backend/src/infrastructure/http/router.ts",
      errors: [{ messageId: "misplaced" }],
    },
  ],
});

console.log("→", "external-service-only-in-adapter");
tester.run("external-service-only-in-adapter", rules["external-service-only-in-adapter"], {
  valid: [
    { code: 'import { S3Client } from "@aws-sdk/client-s3";', filename: "backend/src/adapters/cloud/aws/s3-gateway.ts" },
    { code: 'import { S3Client } from "@aws-sdk/client-s3";', filename: "backend/src/main.ts" },
    { code: 'import { SQSClient } from "@aws-sdk/client-sqs";', filename: "workers/media-process/src/entry.ts" },
    { code: 'import Stripe from "stripe";', filename: "backend/src/adapters/payments/stripe/gateway.ts" },
    { code: 'import { readFile } from "node:fs";', filename: "backend/src/features/pins/pipeline.ts" },
  ],
  invalid: [
    {
      code: 'import { S3Client } from "@aws-sdk/client-s3";',
      filename: "backend/src/features/pins/pipeline.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import { S3Client } from "@aws-sdk/client-s3";',
      filename: "workers/media-process/src/handle.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import AWS from "aws-sdk";',
      filename: "backend/src/features/photos/slices/upload.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import Stripe from "stripe";',
      filename: "backend/src/features/billing/pipeline.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import Stripe from "stripe";',
      filename: "backend/src/features/billing/adapters/stripe-client.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import Stripe from "@stripe/stripe-js";',
      filename: "frontend/src/features/billing/pipeline.ts",
      errors: [{ messageId: "misplaced" }],
    },
    {
      code: 'import twilio from "twilio";',
      filename: "backend/src/features/notifications/slices/send-sms.ts",
      errors: [{ messageId: "misplaced" }],
    },
  ],
});

console.log("→", "no-offset-pagination");
tester.run("no-offset-pagination", rules["no-offset-pagination"], {
  valid: ["const q = { limit, cursor };"],
  invalid: [
    { code: "const q = { limit, offset };", errors: [{ messageId: "offset" }] },
    { code: "query.skip;", errors: [{ messageId: "offset" }] },
  ],
});

console.log("→", "scoped-repository");
tester.run("scoped-repository", rules["scoped-repository"], {
  valid: ["register({ pinRepository: asClass(PinRepository).scoped() });"],
  invalid: [
    {
      code: "register({ pinRepository: asClass(PinRepository).singleton() });",
      errors: [{ messageId: "singleton" }],
    },
    {
      code: "register({ analyzeSaga: asClass(AnalyzePhotoSaga).singleton() });",
      errors: [{ messageId: "singleton" }],
    },
    {
      code: "register({ unitOfWorkFactory: asClass(PostgresUnitOfWorkFactory).singleton() });",
      errors: [{ messageId: "singleton" }],
    },
  ],
});

console.log("→", "signal-last-param");
tester.run("signal-last-param", rules["signal-last-param"], {
  valid: [
    "export async function load(id, signal) {}",
    "export const load = async (id, signal) => {};",
    "export function pure(id) {}",
  ],
  invalid: [
    { code: "export async function load(id) {}", errors: [{ messageId: "missing" }] },
    { code: "export const load = async (id) => {};", errors: [{ messageId: "missing" }] },
  ],
});

console.log("→", "tenant-scoped-table");
tester.run("tenant-scoped-table", rules["tenant-scoped-table"], {
  valid: [
    "pgTable('pins', { id: uuid('id'), tenantId: uuid('tenant_id') });",
    "index('pins_partition_idx').on(t.capturedAt, t.id)",
  ],
  invalid: [
    { code: "pgTable('pins', { id: uuid('id') });", errors: [{ messageId: "missing" }] },
    { code: "index('pins_project_idx').on(t.projectId, t.id)", errors: [{ messageId: "indexOrder" }] },
  ],
});

console.log("→", "no-orchestration-in-trigger");
tester.run("no-orchestration-in-trigger", rules["no-orchestration-in-trigger"], {
  valid: [
    { code: "async function handle() { await runJacicExportSaga(); }", filename: "/repo/frontend/src/features/pins/trigger.tsx" },
    { code: "function handle() { mutate(); }", filename: "/repo/frontend/src/features/pins/trigger.tsx" },
    { code: "async function a() { await f1(); }\nasync function b() { await f2(); }", filename: "/repo/frontend/src/features/pins/trigger.tsx" },
    { code: "async function saga() { await f1(); await f2(); }", filename: "/repo/frontend/src/features/pins/pipeline.ts" },
    { code: "it('works', async () => { await s1(); await s2(); });", filename: "/repo/frontend/src/features/pins/trigger.test.tsx" },
  ],
  invalid: [
    {
      code: "async function handle() { await stepA(); await stepB(); }",
      filename: "/repo/frontend/src/features/pins/trigger.tsx",
      errors: [{ messageId: "orchestration" }],
    },
    {
      code: "const handle = async () => { await stepA(); await stepB(); await stepC(); };",
      filename: "/repo/frontend/src/features/pins/trigger.tsx",
      errors: [{ messageId: "orchestration" }, { messageId: "orchestration" }],
    },
  ],
});

console.log("all rule fixtures asserted");

tester.run("no-number-in-comment (layer names)", rules["no-number-in-comment"], {
  valid: [
    { code: "// domain imports nothing\nconst a = 1;" },
    { code: "// adapters never imports Fastify\nconst a = 1;" },
    { code: "// WCAG 2.2 AA\nconst a = 1;" },
    { code: "// D8 — the renderer deviation\nconst a = 1;" },
  ],
  invalid: [{ code: "// wait 500 ms\nconst a = 1;", errors: [{ messageId: "number" }] }],
});
console.log("layer-name fixtures asserted");

tester.run("no-number-in-comment (local decision ids)", rules["no-number-in-comment"], {
  valid: [
    { code: "// QC-004 — the renderer\nconst a = 1;" },
    { code: "// QC-005 applies to this loop\nconst a = 1;" },
  ],
  invalid: [{ code: "// budget is 16 ms\nconst a = 1;", errors: [{ messageId: "number" }] }],
});
console.log("local decision id fixtures asserted");

// --- Options ---
// A knob that is never exercised is a knob that does not work. Each case below
// proves the rule follows the config rather than the reference layout. ADR-0032.

console.log("→", "options: no-raw-fetch client");
tester.run("no-raw-fetch", rules["no-raw-fetch"], {
  valid: [{ code: "fetch('/x');", filename: "/a/net/http.ts", options: [{ client: "net/http.ts" }] }],
  invalid: [
    {
      code: "fetch('/x');",
      filename: "/a/platform/api-client.ts",
      options: [{ client: "net/http.ts" }],
      errors: [{ messageId: "raw" }],
    },
  ],
});

console.log("→", "options: no-cross-feature-internals featureDir");
tester.run("no-cross-feature-internals", rules["no-cross-feature-internals"], {
  valid: [
    {
      code: "import { x } from '../pins/public.js';",
      filename: "/a/modules/photos/flow.ts",
      options: [{ featureDir: "modules", publicFile: "public" }],
    },
  ],
  invalid: [
    {
      code: "import { x } from '../pins/store.js';",
      filename: "/a/modules/photos/flow.ts",
      options: [{ featureDir: "modules", publicFile: "public" }],
      errors: [{ messageId: "internal" }],
    },
  ],
});

console.log("→", "options: storage-only-in-resource modules and files");
tester.run("storage-only-in-resource", rules["storage-only-in-resource"], {
  valid: [
    {
      code: "import { x } from 'kysely';",
      filename: "/a/features/pins/store.ts",
      options: [{ modules: ["kysely"], resourceFiles: ["store.ts"], driverBinding: "" }],
    },
  ],
  invalid: [
    {
      code: "import { x } from 'kysely';",
      filename: "/a/features/pins/resource.ts",
      options: [{ modules: ["kysely"], resourceFiles: ["store.ts"], driverBinding: "" }],
      errors: [{ messageId: "misplaced" }],
    },
  ],
});

console.log("→", "options: external-service-only-in-adapter scopes, files and paths");
tester.run("external-service-only-in-adapter", rules["external-service-only-in-adapter"], {
  valid: [
    {
      code: "import { Storage } from '@google-cloud/storage';",
      filename: "/a/adapters/cloud/gcp/bucket.ts",
      options: [{ scopes: ["@google-cloud"], allowedFiles: [], allowedPaths: ["adapters/cloud/"] }],
    },
    {
      code: "import { Storage } from '@google-cloud/storage';",
      filename: "/a/worker.ts",
      options: [{ scopes: ["@google-cloud"], allowedFiles: ["worker.ts"], allowedPaths: [] }],
    },
  ],
  invalid: [
    {
      code: "import { Storage } from '@google-cloud/storage';",
      filename: "/a/features/photos/pipeline.ts",
      options: [{ scopes: ["@google-cloud"], allowedFiles: [], allowedPaths: ["adapters/cloud/"] }],
      errors: [{ messageId: "misplaced" }],
    },
  ],
});

console.log("→", "options: tenant-scoped-table column and factory");
tester.run("tenant-scoped-table", rules["tenant-scoped-table"], {
  valid: [
    {
      code: "const t = table('pins', { orgId: uuid(), name: text() });",
      options: [{ column: "orgId", tableFactory: "table" }],
    },
  ],
  invalid: [
    {
      code: "const t = table('pins', { tenantId: uuid(), name: text() });",
      options: [{ column: "orgId", tableFactory: "table" }],
      errors: [{ messageId: "missing" }],
    },
  ],
});

console.log("→", "options: scoped-repository suffixes");
tester.run("scoped-repository", rules["scoped-repository"], {
  valid: [{ code: "c.register(asClass(PinRepository).singleton());", options: [{ suffixes: ["Store"] }] }],
  invalid: [
    {
      code: "c.register(asClass(PinStore).singleton());",
      options: [{ suffixes: ["Store"] }],
      errors: [{ messageId: "singleton" }],
    },
  ],
});

console.log("→", "options: signal-last-param name");
tester.run("signal-last-param", rules["signal-last-param"], {
  valid: [{ code: "export async function load(id, token) {}", options: [{ name: "token" }] }],
  invalid: [
    {
      code: "export async function load(id, signal) {}",
      options: [{ name: "token" }],
      errors: [{ messageId: "missing" }],
    },
  ],
});

console.log("→", "options: no-number-in-comment prefixes");
tester.run("no-number-in-comment", rules["no-number-in-comment"], {
  valid: [{ code: "// RFC-0012 decided it\nconst a = 1;", options: [{ prefixes: ["RFC"] }] }],
  invalid: [
    { code: "// ADR-0052 decided it\nconst a = 1;", options: [{ prefixes: ["RFC"], external: [] }], errors: [{ messageId: "number" }] },
  ],
});

console.log("→", "options: no-orchestration-in-trigger presenters");
tester.run("no-orchestration-in-trigger", rules["no-orchestration-in-trigger"], {
  valid: [
    {
      code: "async function go() { await a(); await b(); }",
      filename: "/a/frontend/src/features/pins/trigger.tsx",
      options: [{ presenters: "ui/*/view" }],
    },
  ],
  invalid: [
    {
      code: "async function go() { await a(); await b(); }",
      filename: "/a/ui/pins/view.tsx",
      options: [{ presenters: "ui/*/view" }],
      errors: [{ messageId: "orchestration" }],
    },
  ],
});

console.log("→", "options: no-offset-pagination banned");
tester.run("no-offset-pagination", rules["no-offset-pagination"], {
  valid: [{ code: "const q = { offset: 1 };", options: [{ banned: ["page"] }] }],
  invalid: [{ code: "const q = { page: 1 };", options: [{ banned: ["page"] }], errors: [{ messageId: "offset" }] }],
});

console.log("→", "options: no-status-literal setters");
tester.run("no-status-literal", rules["no-status-literal"], {
  valid: [{ code: "reply.status(404);", options: [{ setters: ["httpCode"] }] }],
  invalid: [{ code: "reply.httpCode(404);", options: [{ setters: ["httpCode"] }], errors: [{ messageId: "literal" }] }],
});

console.log("every option asserted");

console.log("→", "durable-idempotency-key");
tester.run("durable-idempotency-key", rules["durable-idempotency-key"], {
  valid: [
    { code: "const mutationId = row.id;" },
    { code: "const body = { mutationId: attempt.storedId };" },
    { code: "const other = Date.now();" },
    { code: "send({ requestedAt: Date.now() });" },
    // Minted, bound, and persisted before it is ever sent — ADR-0050 done right.
    { code: "const operation = { mutationId: crypto.randomUUID() };\nqueue.push(operation);" },
    { code: "send({ mutationId: operation.mutationId });" },
  ],
  invalid: [
    { code: "send({ mutationId: crypto.randomUUID() });", errors: [{ messageId: "volatile" }] },
    { code: "post(url, { clientMutationId: Date.now() });", errors: [{ messageId: "volatile" }] },
    { code: "api.create({ idempotencyKey: nanoid() });", errors: [{ messageId: "volatile" }] },
    { code: "send({ mutationId: stored ?? uuid() });", errors: [{ messageId: "volatile" }] },
    { code: "send({ mutationId: new Date().toISOString() });", errors: [{ messageId: "volatile" }] },
  ],
});

console.log("→", "no-supersession-trail");
tester.run("no-supersession-trail", rules["no-supersession-trail"], {
  valid: [
    { code: "// the one place a caller resolves a name\nconst a = 1;" },
    { code: 'const label = "deprecated";' },
  ],
  invalid: [
    { code: "// deprecated, use the new one\nconst a = 1;", errors: [{ messageId: "trail" }] },
    { code: "/* superseded by the slice anatomy */\nconst a = 1;", errors: [{ messageId: "trail" }] },
    { code: "// legacy path, kept for now\nconst a = 1;", errors: [{ messageId: "trail" }] },
    { code: "// this replaces the old runner\nconst a = 1;", errors: [{ messageId: "trail" }] },
    { code: "// formerly known as the ledger block\nconst a = 1;", errors: [{ messageId: "trail" }] },
  ],
});

console.log("→", "options: the new rules take their vocabulary from config");
tester.run("durable-idempotency-key", rules["durable-idempotency-key"], {
  valid: [{ code: "send({ mutationId: ulid() });", options: [{ volatile: ["nanoid"] }] }],
  invalid: [{ code: "send({ traceKey: ulid() });", options: [{ keys: ["traceKey"], volatile: ["ulid"] }], errors: [{ messageId: "volatile" }] }],
});
tester.run("no-supersession-trail", rules["no-supersession-trail"], {
  valid: [{ code: "// deprecated\nconst a = 1;", options: [{ phrases: ["obsolete"] }] }],
  invalid: [{ code: "// obsolete now\nconst a = 1;", options: [{ phrases: ["obsolete"] }], errors: [{ messageId: "trail" }] }],
});

// The exemption that made this rule usable: a store thrown away at the end of the call
// has nothing to recognise a repeat in, so the key is disposable by design.
tester.run("durable-idempotency-key", rules["durable-idempotency-key"], {
  valid: [
    { code: "runPipeline({ pipeline, mutationId: crypto.randomUUID(), ledger: new InMemoryPipelineLedger() });" },
  ],
  invalid: [
    {
      code: "runPipeline({ pipeline, mutationId: crypto.randomUUID(), ledger: durableLedger });",
      errors: [{ messageId: "volatile" }],
    },
    {
      code: "runPipeline({ pipeline, mutationId: crypto.randomUUID(), ledger: new PostgresLedger() });",
      errors: [{ messageId: "volatile" }],
    },
  ],
});

// `context.filename` is the OS separator — "\\" on Windows. Every rule that reads it must
// normalize before matching a forward-slash pattern, or every path-based exemption below
// silently never fires there. filenameOf() in options.mjs is the one place that normalizes.
console.log("→", "windows-style backslash filenames");

tester.run("no-cross-feature-internals (backslash path)", rules["no-cross-feature-internals"], {
  valid: [{ code: "import { x } from '../pins/index.js';", filename: "a\\features\\pins\\index.ts" }],
  invalid: [
    {
      code: "import { x } from '../pins/store.js';",
      filename: "a\\features\\photos\\flow.ts",
      errors: [{ messageId: "internal" }],
    },
  ],
});

tester.run("no-orchestration-in-trigger (backslash path)", rules["no-orchestration-in-trigger"], {
  valid: [{ code: "async function onClick() { await a(); }", filename: "frontend\\src\\features\\pins\\trigger.ts" }],
  invalid: [
    {
      code: "async function onClick() { await a(); await b(); }",
      filename: "frontend\\src\\features\\pins\\trigger.ts",
      errors: [{ messageId: "orchestration" }],
    },
  ],
});

tester.run("no-promise-then (backslash path)", rules["no-promise-then"], {
  valid: [
    {
      code: "p.then(x);",
      filename: "packages\\kernel\\src\\abortable.ts",
      options: [{ allow: ["packages/kernel/src/abortable.ts"] }],
    },
  ],
  invalid: [
    {
      code: "p.then(x);",
      filename: "backend\\src\\main.ts",
      options: [{ allow: ["packages/kernel/src/abortable.ts"] }],
      errors: [{ messageId: "chained" }],
    },
  ],
});

tester.run("no-raw-fetch (backslash path)", rules["no-raw-fetch"], {
  valid: [{ code: "fetch(url);", filename: "frontend\\src\\platform\\api-client.ts" }],
  invalid: [{ code: "fetch(url);", filename: "frontend\\src\\features\\pins\\index.ts", errors: [{ messageId: "raw" }] }],
});

tester.run("storage-only-in-resource (backslash path)", rules["storage-only-in-resource"], {
  valid: [{ code: "import { Pool } from 'pg';", filename: "backend\\src\\infrastructure\\db\\pg-pool.ts" }],
  invalid: [
    { code: "import { Pool } from 'pg';", filename: "backend\\src\\features\\pins\\pipeline.ts", errors: [{ messageId: "misplaced" }] },
  ],
});

tester.run("external-service-only-in-adapter (backslash path)", rules["external-service-only-in-adapter"], {
  valid: [
    { code: "import { S3Client } from '@aws-sdk/client-s3';", filename: "backend\\src\\main.ts" },
    { code: "import { S3Client } from '@aws-sdk/client-s3';", filename: "workers\\media-process\\src\\entry.ts" },
  ],
  invalid: [
    {
      code: "import { S3Client } from '@aws-sdk/client-s3';",
      filename: "backend\\src\\features\\photos\\pipeline.ts",
      errors: [{ messageId: "misplaced" }],
    },
  ],
});

console.log("→", "name-the-pattern");
tester.run("name-the-pattern", rules["name-the-pattern"], {
  valid: [
    { code: "// Outbox: the ledger row and the write share one transaction.\nconst a = 1;" },
    { code: "// Keyset pagination — docs/pagination.md owns the cursor.\nconst a = 1;" },
    { code: "// Exponential backoff, capped.\nconst a = 1;" },
    {
      code:
        "// The public surface, the only file another feature may import -- replayValues is " +
        "published for the offline outbox to replay a queued write after reconnect.\nconst a = 1;",
    },
    {
      code:
        "// The client unit of work: a mutation and the keys its success invalidates. Headless, " +
        "so a workflow runs without a view layer at all -- QC-010.\nconst a = 1;",
    },
    {
      code:
        "// This walks every folder in the tree and rebuilds the index from scratch, which is " +
        "slow but correct, and nothing here is a named pattern anyone can look up.\nconst a = 1;",
    },
    {
      code: "// Saga, explained at length for a human reader who has never met one before now.\nconst a = 1;",
      options: [{ maxWords: 40 }],
    },
  ],
  invalid: [
    {
      code:
        "// The outbox pattern works by writing the message into a table in the same " +
        "transaction as the business row, then a relay polls that table and publishes each " +
        "row, which guarantees at-least-once delivery.\nconst a = 1;",
      errors: [{ messageId: "explained" }],
    },
    {
      code:
        "/* A circuit breaker is a proxy that counts failures, and once the count passes a " +
        "threshold it opens and fails fast for a cooldown window before a trial request. */\nconst a = 1;",
      errors: [{ messageId: "explained" }],
    },
    {
      code:
        "// We use a CRDT here. A CRDT is a data structure whose merge operation is " +
        "commutative, associative and idempotent, so replicas converge without coordination " +
        "between them at all.\nconst a = 1;",
      errors: [{ messageId: "explained" }],
    },
  ],
});

const MIGRATE = "backend/src/infrastructure/db/migrate.ts";

console.log("→", "no-sql-raw");
tester.run("no-sql-raw", rules["no-sql-raw"], {
  valid: [
    { code: "await db.execute(sql`select 1 where id = ${id}`);", filename: "backend/src/features/pins/resource.ts" },
    { code: "await db.execute(sql.raw(ddl));", filename: MIGRATE, options: [{ allow: [MIGRATE] }] },
    { code: "await db.execute(sql.raw(ddl));", filename: "C:\\repo\\backend\\src\\infrastructure\\db\\migrate.ts", options: [{ allow: [MIGRATE] }] },
    { code: "const text = other.raw(value);", filename: "backend/src/features/pins/resource.ts" },
  ],
  invalid: [
    { code: "await db.execute(sql.raw(text));", filename: "backend/src/features/pins/resource.ts", errors: [{ messageId: "raw" }] },
    { code: "const splice = sql.raw;", filename: "backend/src/features/pins/resource.ts", errors: [{ messageId: "raw" }] },
    { code: 'sql["raw"](text);', filename: "backend/src/features/pins/resource.ts", errors: [{ messageId: "raw" }] },
    {
      code: "await db.execute(sql.raw(ddl));",
      filename: "backend/src/features/pins/resource.ts",
      options: [{ allow: [MIGRATE] }],
      errors: [{ messageId: "raw" }],
    },
  ],
});

const jsx = new RuleTester({
  languageOptions: { ecmaVersion: 2023, sourceType: "module", parserOptions: { ecmaFeatures: { jsx: true } } },
});
const GUARDED = [{ guards: ["isImeComposing"] }];
const unguarded = { messageId: "unguarded" };
const inline = { messageId: "inline" };

console.log("→", "ime-safe-key");
jsx.run("ime-safe-key", rules["ime-safe-key"], {
  valid: [
    {
      code: '<textarea onKeyDown={(e) => { if (isImeComposing(e.nativeEvent)) return; if (e.key === "Enter") submit(); }} />;',
      options: GUARDED,
    },
    { code: '<input onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") submit(); }} />;' },
    { code: '<input onKeyDown={(e) => { if (e.keyCode === 229) return; if (e.key === "Escape") close(); }} />;' },
    {
      code: '<input onKeyDown={(e) => { if (e.key === "Enter") { if (isImeComposing(e.nativeEvent)) return; submit(); } }} />;',
      options: GUARDED,
    },
    {
      code:
        'const onKey = useCallback((e) => { if (isImeComposing(e.nativeEvent)) return; if (e.key === "Enter") send(); }, []);\n' +
        "const field = <input onKeyDown={onKey} />;",
      options: GUARDED,
    },
    // A row, a button or a list item reacts to Enter or Space; it is not text entry.
    { code: '<div role="row" tabIndex={0} onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") open(); }} />;' },
    { code: '<li onKeyDown={(e) => { if (e.key === "Enter") open(); }} />;' },
    { code: '<FolderRow onKeyDown={(e) => { if (e.key === "Enter") open(); }} />;', options: [{ components: ["Input"] }] },
    { code: 'const onKey = (e) => { if (e.key === "Enter") open(); };\nconst row = <div onKeyDown={onKey} />;' },
    { code: '<div contentEditable={false} onKeyDown={(e) => { if (e.key === "Enter") open(); }} />;' },
    { code: '<input type="checkbox" onKeyDown={(e) => { if (e.key === "Enter") toggle(); }} />;' },
    { code: '<input onKeyDown={(e) => { if (e.key === "Tab") next(); }} />;' },
  ],
  invalid: [
    {
      // The drawing-comment-dialog case: Enter submits a half-typed kana conversion.
      code: '<textarea onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }} />;',
      errors: [unguarded],
    },
    { code: '<input onKeyUp={(e) => { if (e.key === "Escape") cancel(); }} />;', errors: [unguarded] },
    { code: '<div contentEditable onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />;', errors: [unguarded] },
    {
      code: '<Input onKeyDown={(e) => { if (e.key === "Enter") commit(); }} />;',
      options: [{ components: ["Input"] }],
      errors: [unguarded],
    },
    {
      // The drawing-grid-calibration case: a handler defined outside the JSX, with an inline check.
      code:
        'const onKeyDown = (e) => { if (e.key === "Enter" && !e.nativeEvent.isComposing) confirm(); };\n' +
        "const field = <Input onKeyDown={onKeyDown} />;",
      options: [{ components: ["Input"], guards: ["isImeComposing"] }],
      errors: [unguarded, inline],
    },
    {
      code: 'function onKey(e) { if (e.key === "Escape") close(); }\nconst field = <textarea onKeyDown={onKey} />;',
      errors: [unguarded],
    },
    {
      code: '<input onKeyDown={(e) => { if (e.keyCode === 229) return; if (e.key === "Enter") send(); }} />;',
      options: GUARDED,
      errors: [inline, unguarded],
    },
    {
      code: '<input onKeyDown={(e) => { if (e.nativeEvent.isComposing) return; if (e.key === "Enter") send(); }} />;',
      options: GUARDED,
      errors: [inline, unguarded],
    },
    { code: '<input onKeyDown={(e) => { switch (e.key) { case "Enter": send(); break; } }} />;', errors: [unguarded] },
    {
      code: '<input onKeyDown={(e) => { if (e.key === "Enter") send(); if (isImeComposing(e)) return; }} />;',
      options: GUARDED,
      errors: [unguarded],
    },
    {
      // The guard must return early; a conjoined check is a second shape for one job.
      code: '<input onKeyDown={(e) => { if (e.key === "Escape" && !isImeComposing(e.nativeEvent)) close(); }} />;',
      options: GUARDED,
      errors: [unguarded],
    },
    { code: '<input onKeyDown={({ key }) => { if (key === "Enter") send(); }} />;', errors: [unguarded] },
  ],
});

const READER = "frontend/src/platform/gesture-thresholds.ts";
const HOLD = [{ entries: [{ key: "holdpress", names: ["HOLD_\\w*MS", "\\w*_HOLD_MS"], readers: [READER] }] }];

console.log("→", "registry-literal");
tester.run("registry-literal", rules["registry-literal"], {
  valid: [
    { code: "export const HOLD_DURATION_MS = 400;", filename: READER, options: HOLD },
    { code: "export const HOLD_DURATION_MS = 400;", filename: "C:\\repo\\frontend\\src\\platform\\gesture-thresholds.ts", options: HOLD },
    { code: "const SEARCH_SETTLE_MS = 250;", filename: "frontend/src/features/search/box.ts", options: HOLD },
    { code: "const HOLD_DURATION_MS = registry.gates.holdpress.value;", filename: "frontend/src/features/pins/drag.ts", options: HOLD },
    // A pattern matches the whole identifier: THRESHOLD_MS holds "HOLD_MS" but is not a hold.
    { code: "const THRESHOLD_MS = 4;", filename: "frontend/src/features/pins/drag.ts", options: HOLD },
    { code: "const HOLD_DURATION_MS = 400;", filename: "frontend/src/features/pins/drag.ts" },
  ],
  invalid: [
    {
      code: "const HOLD_DURATION_MS = 400;",
      filename: "frontend/src/features/pins/drag.ts",
      options: HOLD,
      errors: [{ messageId: "restated", data: { name: "HOLD_DURATION_MS", key: "holdpress", readers: READER } }],
    },
    { code: "const NAME_HOLD_MS = 900;", filename: "frontend/src/features/pins/drag.ts", options: HOLD, errors: [{ messageId: "restated" }] },
    { code: "const GESTURE = { HOLD_DURATION_MS: 400 };", filename: "frontend/src/features/pins/drag.ts", options: HOLD, errors: [{ messageId: "restated" }] },
    { code: "class Grip { static HOLD_DURATION_MS = 400; }", filename: "frontend/src/features/pins/drag.ts", options: HOLD, errors: [{ messageId: "restated" }] },
    {
      code: "const PIN_DRAG_THRESHOLD_PX = 4;",
      filename: "frontend/src/features/pins/drag.ts",
      options: [{ entries: [{ key: "dragslop", names: ["\\w*DRAG\\w*_PX"], readers: [] }] }],
      errors: [{ messageId: "unread", data: { name: "PIN_DRAG_THRESHOLD_PX", key: "dragslop" } }],
    },
  ],
});
