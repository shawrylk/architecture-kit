// I/O only. Every decision is a pure function under src/gates/, each with a test
// beside it. ADR-0032. Where this file names a path, that path came from config.

import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { checkFeatureAnatomy, checkNoEmptyBlock } from "../gates/eight-blocks.mjs";
import { checkCitations, checkDocPaths, checkSelfContained, definedIds } from "../gates/citations.mjs";
import { checkAgreement, declaredValues } from "../gates/registry-agreement.mjs";
import {
  checkSqlIdentifiers,
  declaredColumns,
  sqlStatements,
  tableOwners,
} from "../gates/sql-identifiers.mjs";
import { checkSharedInsertCallSites, checkTenantPredicate, exemptions } from "../gates/tenant-predicate.mjs";
import { checkClaimedRequirements } from "../gates/claimed-requirements.mjs";
import { allowedPublicRoutes, checkPublicRoutes, declaredPublicRoutes } from "../gates/public-routes.mjs";
import { calledInternalRoutes, checkInternalRoutes, declaredInternalRoutes } from "../gates/internal-routes.mjs";
import { checkHeadlessPipelines } from "../gates/headless-sagas.mjs";
import { checkSagaTests, declaredSagas } from "../gates/saga-tests.mjs";
import { checkGatesAreTested } from "../gates/gate-tests.mjs";
import { checkAuditAppendOnly } from "../gates/audit-append-only.mjs";
import { checkEnforcementMap } from "../gates/enforcement-map.mjs";
import { checkFrontendBoundaries } from "../gates/frontend-boundaries.mjs";
import { checkTestMirror } from "../gates/test-mirror.mjs";
import { checkCommentStyle } from "../gates/comment-style.mjs";
import { checkEnglishSource, checkTranslationPairs } from "../gates/english-source.mjs";
import { checkAdrFormat } from "../gates/adr-format.mjs";
import { checkConfigFloor } from "../gates/config-floor.mjs";
import { defaults } from "../config.mjs";
import { rules as lintRules } from "../eslint/index.mjs";
import { enabled } from "../config.mjs";

const SKIP = /node_modules|\/dist\/|\.test\.[cm]?[jt]sx?$/;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_EXTENSION = /\.([cm]?[jt]sx?)$/;
const CITABLE_EXTENSION = /\.(tsx?|mjs|md)$/;
const INFRA_EXTENSIONS = [".tf", ".sh", ".tfvars", ".tfvars.example", ".hcl", ".hcl.example"];
const INFRA_SKIP = [".lock.hcl"];

const read = (file) => readFile(file, "utf8").catch(() => null);
const list = (dir, options) => readdir(dir, options).catch(() => []);

/** A problem names a path a reader can open — forward slashes always, since every gate splits on "/". */
const relativeTo = (root) => (file) => (path.relative(root, file) || file).split(path.sep).join("/");

async function listFeature(dir) {
  const files = [];
  async function walk(current, prefix) {
    for (const entry of await list(current, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(current, entry.name), rel);
      else files.push(rel);
    }
  }
  await walk(dir, "");
  return files;
}

async function readFeature(dir) {
  const files = await listFeature(dir);
  const contents = [];
  for (const file of files) {
    const full = path.join(dir, file);
    const isSource = /\.tsx?$/.test(file) && (await stat(full).catch(() => null))?.isFile();
    if (isSource) contents.push({ path: full, contents: await readFile(full, "utf8") });

  }
  return { feature: { feature: dir, files }, contents };
}

async function featureDirs(root) {
  const entries = await list(root, { withFileTypes: true });
  return entries.filter((entry) => entry.isDirectory()).map((entry) => path.join(root, entry.name));
}

async function collect(roots, only) {
  const features = [];
  const contents = [];
  for (const root of roots) {
    for (const dir of await featureDirs(root)) {
      if (only && !only.startsWith(dir)) continue;
      const found = await readFeature(dir);
      features.push(found.feature);
      contents.push(...found.contents);
    }
  }
  return { features, contents };
}

async function citableFiles(roots, root) {
  const rel = relativeTo(root);
  const files = [];
  async function walk(dir) {
    for (const entry of await list(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (SKIP.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (CITABLE_EXTENSION.test(entry.name)) {
        files.push({ path: rel(full), contents: await readFile(full, "utf8") });
      }
    }
  }
  for (const root of roots) await walk(root);
  return files;
}

/** Every source file under the citable roots, tests included. */
async function sourceFiles(config, only) {
  const rel = relativeTo(config.root);
  const roots = only === undefined ? config.paths.citable : [only];
  const files = [];
  async function walk(dir) {
    for (const entry of await list(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (/node_modules|\/dist\//.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (SOURCE_EXTENSION.test(entry.name)) {
        files.push({ path: rel(full), contents: await readFile(full, "utf8") });
      }
    }
  }
  for (const root of roots) await walk(path.join(config.root, root));
  return files;
}

async function registered(file) {
  const source = await read(file);
  if (source === null) return [];
  try {
    return JSON.parse(source).requirements ?? [];
  } catch {
    return [];
  }
}

/** Where a tool demands a literal the registry already owns, assert the two agree. */
async function agreements(config) {
  const problems = [];
  for (const entry of config.agreements) {
    const source = await read(path.join(config.root, entry.source));
    const registryFile = await read(path.join(config.root, entry.registry));
    if (source === null || registryFile === null) continue;
    const registry = JSON.parse(registryFile)[entry.registryKey];
    if (!registry) {
      problems.push({
        path: entry.registry,
        rule: "unknown-registry-key",
        detail: `'${entry.registryKey}' is not a key of ${entry.registry}`,
      });
      continue;
    }
    const declared = declaredValues(source, entry.constant);
    // A constant this config named but the source does not hold means the agreement is
    // checking nothing. Silence there is how a gate stops meaning anything.
    if (Object.keys(declared).length === 0) {
      problems.push({
        path: entry.source,
        rule: "unfound-constant",
        detail: `'${entry.constant}' declares no values here — the agreement checks nothing`,
      });
      continue;
    }
    const toKey = (key) => `${entry.prefix ?? ""}${entry.lowercase === false ? key : key.toLowerCase()}`;
    problems.push(...checkAgreement(declared, registry, toKey, entry.source));
  }
  return problems;
}

/** Every file inside a server feature that carries SQL, with the feature that owns it. */
async function resourceFiles(config) {
  const root = path.join(config.root, config.paths.serverFeatures);
  const rel = relativeTo(config.root);
  const resources = [];
  for (const feature of await list(root)) {
    const dir = path.join(root, feature);
    for (const name of config.paths.resourceFiles) {
      const file = path.join(dir, name);
      const source = await read(file);
      if (source) resources.push({ path: rel(file), source, feature });
    }
    for (const subdir of config.paths.resourceDirs) {
      for (const name of await list(path.join(dir, subdir))) {
        if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue;
        const file = path.join(dir, subdir, name);
        const source = await read(file);
        if (source) resources.push({ path: rel(file), source, feature });
      }
    }
  }
  return resources;
}

/** Nothing runs the schema and the queries together, so this asserts their names agree. */
async function sqlAgreement(config, taken) {
  const migrationDir = path.join(config.root, config.paths.migrations);
  const names = (await list(migrationDir)).filter((name) => name.endsWith(".sql"));
  const migrations = [];
  for (const file of names) {
    migrations.push({ file, sql: await readFile(path.join(migrationDir, file), "utf8") });
  }
  const resources = await resourceFiles(config);
  const features = await list(path.join(config.root, config.paths.serverFeatures));
  const tables = declaredColumns(migrations.map((migration) => migration.sql));
  const owned = new Set(
    [...tables]
      .filter(([, columns]) => columns.has(config.tenant.sqlColumn))
      .map(([table]) => table),
  );

  const sharedSql = await read(path.join(config.root, config.paths.sharedSql));
  const scanned = sharedSql
    ? [...resources, { path: config.paths.sharedSql, source: sharedSql }]
    : resources;
  const scoped = scanned.map(({ path: file, source }) => ({ path: file, statements: sqlStatements(source) }));
  taken.push(...exemptions(scoped));

  const tenantOptions = { column: config.tenant.sqlColumn };
  const problems = [];
  if (enabled(config.gates, "audit-append-only")) {
    problems.push(...checkAuditAppendOnly(scoped, { table: config.audit.table }));
  }
  if (enabled(config.gates, "sql-identifiers")) {
    problems.push(...checkSqlIdentifiers(tables, resources, tableOwners(migrations, features)));
  }
  if (enabled(config.gates, "tenant-predicate")) {
    problems.push(
      ...checkTenantPredicate(scoped, owned, tenantOptions),
      ...checkSharedInsertCallSites(resources, tenantOptions),
    );
  }
  return problems;
}

/** Each server feature's trigger: routes, and the requirements they claim. */
async function triggers(config) {
  const root = path.join(config.root, config.paths.serverFeatures);
  const rel = relativeTo(config.root);
  const found = [];
  for (const feature of await list(root)) {
    const file = path.join(root, feature, config.paths.triggerFile);
    const source = await read(file);
    if (source) found.push({ path: rel(file), source });
  }
  return found;
}

/** Every unit's definition of done ends here: a claim a route makes must be backed. */
async function claimAgreement(config, routes) {
  const entries = await registered(path.join(config.root, config.paths.traceability));
  if (entries.length === 0) return [];
  const tests = new Map(entries.map((entry) => [entry.id, entry.tests ?? []]));
  return checkClaimedRequirements(routes, tests);
}

/** The api opens a route; the edge must let exactly that route through. */
async function publicRouteAgreement(config, routes) {
  const file = path.join(config.root, config.paths.publicRoutes);
  const allowed = await read(file);
  if (allowed === null) return [];
  return checkPublicRoutes(
    declaredPublicRoutes(routes.map((route) => route.source)),
    allowedPublicRoutes(allowed),
    config.paths.publicRoutes,
  );
}

/** A worker builds its path as a string; nothing type-checks it against the route table. */
async function internalRouteAgreement(config, routes) {
  const root = path.join(config.root, config.paths.workers);
  const entries = [];
  for (const worker of await list(root, { withFileTypes: true })) {
    if (!worker.isDirectory() || worker.name === "node_modules") continue;
    const file = path.join(root, worker.name, config.paths.workerEntry);
    const source = await read(file);
    if (source) entries.push({ path: path.relative(config.root, file), source });
  }
  if (entries.length === 0) return [];
  return checkInternalRoutes(
    declaredInternalRoutes(routes.map((route) => route.source)),
    calledInternalRoutes(entries),
  );
}

async function platformFiles(config) {
  const platformDir = path.join(config.root, config.paths.platform ?? "frontend/src/platform");
  const rel = relativeTo(config.root);
  const files = [];
  async function walk(dir) {
    for (const entry of await list(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (/node_modules|\/dist\//.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (SOURCE_EXTENSION.test(entry.name)) {
        files.push({ path: rel(full), contents: await readFile(full, "utf8").catch(() => "") });
      }
    }
  }
  await walk(platformDir);
  return files;
}

function isInfraFile(name) {
  if (INFRA_SKIP.some((suffix) => name.endsWith(suffix))) return false;
  return INFRA_EXTENSIONS.some((suffix) => name.endsWith(suffix));
}

/** Terraform/shell files under the configured infra roots — absent is ordinary, not an error. */
async function infraFiles(config) {
  const rel = relativeTo(config.root);
  const files = [];
  async function walk(dir) {
    for (const entry of await list(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (/node_modules|\.terraform/.test(full)) continue;
      if (entry.isDirectory()) await walk(full);
      else if (isInfraFile(entry.name)) {
        files.push({ path: rel(full), contents: await readFile(full, "utf8").catch(() => "") });
      }
    }
  }
  for (const root of config.paths.infra ?? []) await walk(path.join(config.root, root));
  return files;
}

/**
 * @param {object} config
 * @param {string} [only] one file — the fast path a post-edit hook takes
 * @returns {Promise<{problems: object[], lines: string[]}>}
 */
export async function runCheck(config, only) {
  const roots = config.featureRoots.map((root) => path.join(config.root, root));
  const relativeOnly = only ? path.resolve(config.root, only) : undefined;
  const { features, contents } = await collect(roots, relativeOnly);

  const problems = [];
  const lines = [];
  const taken = [];

  // A config whose roots all point at nothing sweeps nothing and still ends green. This is the
  // silence `unfound-constant` already refuses for an agreement, applied to the roots themselves.
  // One root missing is ordinary — a repository with no frontend is not misconfigured — so only
  // the case where not a single configured root exists is reported.
  const rootExists = await Promise.all(roots.map((root) => stat(root).then(() => true, () => false)));
  const rootless = roots.length > 0 && !rootExists.includes(true);
  if (rootless) {
    problems.push({
      path: "qc.config.json",
      rule: "unfound-root",
      detail: `no configured feature root exists (${config.featureRoots.join(", ")}) — scaffold a feature, or point featureRoots at this repository's layout; \`qc config\` prints what is in force`,
    });
  }

  if (enabled(config.gates, "eight-blocks")) {
    const relative = features.map((feature) => ({
      ...feature,
      feature: path.relative(config.root, feature.feature),
    }));
    problems.push(...checkFeatureAnatomy(relative, config.anatomy), ...checkNoEmptyBlock(contents, config.anatomy));
  }
  if (enabled(config.gates, "headless-sagas")) {
    problems.push(...checkHeadlessPipelines(contents, { block: config.saga.headlessBlock, viewModules: config.saga.viewModules }));
  }
  if (!rootless) lines.push(`OK  structure    ${features.length} feature folder(s)`);

  if (relativeOnly) return { problems, lines };

  if (enabled(config.gates, "citations")) {
    const cited = await citableFiles(
      config.paths.citable.map((root) => path.join(config.root, root)),
      config.root,
    );
    const decisionsFile = await read(path.join(config.root, config.docs.decisions));
    const decisions = definedIds(decisionsFile ?? "", config.citations);
    const requirementIds = new Set(
      (await registered(path.join(config.root, config.paths.traceability))).map((entry) => entry.id),
    );
    const docsDir = path.join(config.root, config.docs.root);
    const docs = new Set(
      (await list(docsDir)).filter((name) => name.endsWith(".md")).map((name) => `${config.docs.root}/${name}`),
    );
    problems.push(
      ...checkCitations(cited, decisions, requirementIds, config.citations),
      ...checkDocPaths(cited, docs, { docsRoot: config.docs.root }),
      ...checkSelfContained(cited, config.foreign),
    );
    lines.push("OK  citations    every cited id and doc path resolves, no foreign reference");
  }

  if (enabled(config.gates, "registry-agreement")) {
    problems.push(...(await agreements(config)));
  }

  if (enabled(config.gates, "sql-identifiers") || enabled(config.gates, "tenant-predicate")) {
    problems.push(...(await sqlAgreement(config, taken)));
    lines.push("OK  sql          every column is declared, every statement and shared insert carries the tenant");
    // An exemption is counted and named, so it stays a decision rather than a habit.
    for (const exemption of taken) lines.push(`  exempt       ${exemption.path}: ${exemption.reason}`);
  }

  if (enabled(config.gates, "saga-tests")) {
    const sources = await sourceFiles(config);
    const sagas = declaredSagas(
      sources.filter((file) => !TEST_FILE.test(file.path)),
      { factories: config.saga.factories },
    );
    problems.push(
      ...checkSagaTests(sagas, sources.filter((file) => TEST_FILE.test(file.path)), {
        viewModules: config.saga.viewModules,
        sources,
      }),
    );
    lines.push(`OK  sagas        ${sagas.length} workflow(s), each named by a test that runs without a view`);
  }

  if (enabled(config.gates, "gate-tests")) {
    const own = await sourceFiles(config, config.paths.checks);
    problems.push(
      ...checkGatesAreTested(
        own.filter((file) => !TEST_FILE.test(file.path)),
        own.filter((file) => TEST_FILE.test(file.path)),
      ),
    );
    if (own.length > 0) lines.push(`OK  gates        ${own.filter((f) => !TEST_FILE.test(f.path)).length} repository gate(s), each with a case that must fail`);
  }

  if (enabled(config.gates, "enforcement-map")) {
    const map = await read(path.join(config.root, config.docs.enforcement));
    if (map !== null) {
      problems.push(
        ...checkEnforcementMap(
          map,
          Object.keys(lintRules).filter((name) => enabled(config.rules, name)),
          Object.keys(config.gates).filter((name) => enabled(config.gates, name)),
        ),
      );
      lines.push("OK  map          every check the kit runs is named in the enforcement map, and every name resolves");
    }
  }

  const routes = await triggers(config);
  if (enabled(config.gates, "claimed-requirements")) {
    problems.push(...(await claimAgreement(config, routes)));
    lines.push("OK  claims       every requirement a route claims names a test that proves it");
  }
  if (enabled(config.gates, "public-routes")) {
    problems.push(...(await publicRouteAgreement(config, routes)));
    lines.push("OK  public       the edge lets through exactly the routes the api serves without a session");
  }
  if (enabled(config.gates, "internal-routes")) {
    problems.push(...(await internalRouteAgreement(config, routes)));
    lines.push("OK  internal     every path a worker posts to is a route the api serves");
  }
  if (enabled(config.gates, "headless-sagas")) {
    lines.push("OK  headless     pipelines are headless and triggers remain thin presenters");
  }
  if (enabled(config.gates, "frontend-boundaries")) {
    const platform = await platformFiles(config);
    if (platform.length > 0) {
      problems.push(...checkFrontendBoundaries(platform, contents));
      lines.push("OK  boundaries   platform remains a thin substrate without domain leaks or junk drawers");
    }
  }
  if (enabled(config.gates, "test-mirror")) {
    const all = await sourceFiles(config);
    const testPaths = all.filter((file) => TEST_FILE.test(file.path)).map((file) => file.path);
    const srcPaths = all.filter((file) => !TEST_FILE.test(file.path)).map((file) => file.path);
    const mirrorProblems = checkTestMirror(testPaths, srcPaths);
    problems.push(...mirrorProblems);
    if (mirrorProblems.length === 0) {
      lines.push("OK  mirror       frontend tests mirror src paths 1:1, no orphaned test");
    }
  }

  if (enabled(config.gates, "comment-style")) {
    const infra = await infraFiles(config);
    if (infra.length > 0) {
      problems.push(...checkCommentStyle(infra, config.comments));
      lines.push("OK  comments     every comment under infra/ is one line of why, never a paragraph");
    }
  }

  if (enabled(config.gates, "config-floor")) {
    problems.push(...checkConfigFloor(defaults, config, { exemptions: config.floor.exemptions }));
    lines.push("OK  floor        every check the kit ships on is in force, or names the decision that switched it off");
  }

  if (enabled(config.gates, "english-source")) {
    // Two sets, because neither alone is right: sourceFiles carries tests, whose comments are
    // prose like any other, but not .md; citableFiles carries the docs and skips tests.
    const docs = (
      await citableFiles(
        config.paths.citable.map((root) => path.join(config.root, root)),
        config.root,
      )
    ).filter((file) => file.path.endsWith(".md"));
    const everything = [...(await sourceFiles(config)), ...docs];
    problems.push(...checkEnglishSource(everything, config.language));
    problems.push(...checkTranslationPairs(everything.map((file) => file.path), config.language.translationPairs));
    lines.push("OK  english      comments, docs and rules are English; another language is declared data");
  }

  if (enabled(config.gates, "adr-format")) {
    const records = await citableFiles([path.join(config.root, config.adr.root)], config.root);
    const docs = records.filter((file) => file.path.endsWith(".md"));
    problems.push(...checkAdrFormat(docs, config.adr));
    if (docs.length > 0) lines.push(`OK  decisions    ${docs.length} record(s), each with its cost and its rejected alternatives`);
  }

  return { problems, lines };
}
