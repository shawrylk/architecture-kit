// I/O only. Every decision is a pure function under src/gates/, each with a test
// beside it. ADR-0032. Where this file names a path, that path came from config.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { checkFeatureAnatomy, checkNoEmptyBlock } from "../gates/eight-blocks.mjs";
import { checkCitations, checkDocPaths, checkSelfContained, definedIds } from "../gates/citations.mjs";
import { checkAgreement, declaredValues } from "../gates/registry-agreement.mjs";
import {
  checkSchemaInMigrations,
  checkSqlIdentifiers,
  declaredColumns,
  migrationNames,
  schemaTables,
  sqlStatements,
  tableOwners,
} from "../gates/sql-identifiers.mjs";
import { checkExemptHelperCalls, checkTenantPredicate, exemptHelperCalls, exemptions } from "../gates/tenant-predicate.mjs";
import { checkClaimedRequirements } from "../gates/claimed-requirements.mjs";
import { allowedPublicRoutes, checkPublicRoutes, declaredPublicRoutes } from "../gates/public-routes.mjs";
import { calledInternalRoutes, checkInternalRoutes, declaredInternalRoutes } from "../gates/internal-routes.mjs";
import { checkHeadlessPipelines } from "../gates/headless-sagas.mjs";
import { checkFeatureCommands, governedFeatures } from "../gates/feature-cli.mjs";
import { checkSagaTests, declaredSagas } from "../gates/saga-tests.mjs";
import { checkGatesAreTested } from "../gates/gate-tests.mjs";
import { checkAuditAppendOnly } from "../gates/audit-append-only.mjs";
import { checkEnforcementMap } from "../gates/enforcement-map.mjs";
import { checkFrontendBoundaries } from "../gates/frontend-boundaries.mjs";
import { checkTestMirror, mirrorFolders } from "../gates/test-mirror.mjs";
import { checkCommentStyle } from "../gates/comment-style.mjs";
import { checkEnglishFiles, checkEnglishSource, checkTranslationPairs } from "../gates/english-source.mjs";
import { checkAdrFormat } from "../gates/adr-format.mjs";
import { checkConfigFloor } from "../gates/config-floor.mjs";
import { defaults } from "../config.mjs";
import { rules as lintRules } from "../eslint/index.mjs";
import { adrLog, enabled, readerEntries, thresholds } from "../config.mjs";
import { checkRegistryReaders } from "../gates/registry-readers.mjs";
import { checkMigrationNumbers } from "../gates/migration-numbers.mjs";
import { checkRegistryLiteral } from "../gates/registry-literal.mjs";
import { checkThresholdRatchet } from "../gates/threshold-ratchet.mjs";
import { checkParity, placeholderSlices } from "../gates/parity.mjs";
import { checkIntegrationImports } from "../gates/integration-imports.mjs";
import { checkClosedSetWriters, matchedKeys } from "../gates/closed-set-writers.mjs";
import { checkDocClaims, parseDocClaims } from "../gates/doc-claims.mjs";
import { ratchetInputs } from "./registry-history.mjs";
import { repoFiles } from "./repo-files.mjs";

// Each skip is tested on "/" + the relative path, so it reads a path the way it read a full one.
const SKIP = /node_modules|\/dist\/|\.test\.[cm]?[jt]sx?$/;
const BUILD_OUTPUT = /node_modules|\/dist\//;
const TEST_FILE = /\.test\.[cm]?[jt]sx?$/;
const SOURCE_EXTENSION = /\.([cm]?[jt]sx?)$/;
const CITABLE_EXTENSION = /\.(tsx?|mjs|md)$/;
const INFRA_EXTENSIONS = [".tf", ".sh", ".tfvars", ".tfvars.example", ".hcl", ".hcl.example"];
const INFRA_SKIP = [".lock.hcl"];
// Windows caps a command line at 32,767 characters. A longer file list is filtered here instead.
const PATHSPEC_BUDGET = 8_000;

const read = (file) => readFile(file, "utf8").catch(() => null);

/** A problem names a path a reader can open — forward slashes always, since every gate splits on "/". */
const relativeTo = (root) => (file) => (path.relative(root, file) || file).split(path.sep).join("/");

/** A config path as the listing spells it: forward slashes, no `./`, no trailing slash. The root is "". */
function posix(dir) {
  const normal = path.posix.normalize(String(dir).split(path.sep).join("/")).replace(/\/+$/, "");
  return normal === "." ? "" : normal;
}

const join = (dir, name) => (dir ? `${dir}/${name}` : name);

/** The one listing of a run, with the names each folder holds, as `readdir` returned them. */
function treeOf(files) {
  const isFile = new Set(files);
  const children = new Map();
  for (const file of files) {
    let folder = "";
    for (const part of file.split("/")) {
      const names = children.get(folder) ?? new Set();
      names.add(part);
      children.set(folder, names);
      folder = join(folder, part);
    }
  }
  return {
    files,
    isFile: (rel) => isFile.has(rel),
    /** The files at or below `dir`. */
    under(dir) {
      const prefix = posix(dir);
      return prefix === "" ? files : files.filter((file) => file.startsWith(`${prefix}/`));
    },
    /** The names directly in `dir`, files and folders both. */
    namesIn: (dir) => [...(children.get(posix(dir)) ?? [])],
    foldersIn(dir) {
      const prefix = posix(dir);
      return [...(children.get(prefix) ?? [])].filter((name) => children.has(join(prefix, name)));
    },
  };
}

/** Read each listed file. One the listing names but the disk no longer holds is skipped. */
async function readEach(root, rels) {
  const files = [];
  for (const rel of rels) {
    const contents = await read(path.join(root, rel));
    if (contents !== null) files.push({ path: rel, contents });
  }
  return files;
}

/** The given files, and the feature folders that hold them: all the fast path reads. */
function scopeOf(config, given) {
  const scope = new Set(given);
  for (const file of given) {
    for (const root of config.featureRoots.map(posix)) {
      const inside = root === "" ? file : file.startsWith(`${root}/`) ? file.slice(root.length + 1) : null;
      if (inside?.includes("/")) scope.add(join(root, inside.split("/")[0]));
    }
  }
  const specs = [...scope];
  return specs.join(" ").length > PATHSPEC_BUDGET ? undefined : specs;
}

async function readFeature(config, tree, dir) {
  const files = tree.under(dir).map((file) => file.slice(dir.length + 1));
  const contents = [];
  for (const file of files) {
    if (!/\.tsx?$/.test(file)) continue;
    const full = path.join(config.root, dir, file);
    const source = await read(full);
    if (source !== null) contents.push({ path: full, contents: source });
  }
  return { feature: { feature: path.join(config.root, dir), files }, contents };
}

async function collect(config, tree, only) {
  const features = [];
  const contents = [];
  for (const root of config.featureRoots.map(posix)) {
    for (const name of tree.foldersIn(root)) {
      const dir = join(root, name);
      if (only && !only.some((file) => file === dir || file.startsWith(`${dir}/`))) continue;
      const found = await readFeature(config, tree, dir);
      features.push(found.feature);
      contents.push(...found.contents);
    }
  }
  return { features, contents };
}

function citableFiles(config, tree, roots) {
  const rels = roots
    .flatMap((root) => tree.under(root))
    .filter((file) => !SKIP.test(`/${file}`) && CITABLE_EXTENSION.test(file));
  return readEach(config.root, rels);
}

/** A regex tested on a file and on each folder above it, as a walk that pruned folders tested it. */
function prunedBy(pattern) {
  const folders = new Map();
  const parentOf = (rel) => rel.slice(0, Math.max(rel.lastIndexOf("/"), 0));
  const skipped = (folder) => {
    if (folder === "") return false;
    if (!folders.has(folder)) folders.set(folder, skipped(parentOf(folder)) || pattern.test(folder));
    return folders.get(folder);
  };
  return (file) => skipped(parentOf(file)) || pattern.test(file);
}

/** Every listed file under the language roots whose extension matches, minus `language.exclude`. */
function languageFiles(config, files) {
  const { language } = config;
  const pattern = new RegExp(`\\.(${language.extensions.join("|")})$`);
  const skip = prunedBy(new RegExp(language.exclude.join("|")));
  // The whole repository, not the citable roots: those name where decisions are cited, which has
  // nothing to do with where a language rule applies. Contracts and infrastructure are not citable
  // and were invisible because of it.
  const roots = language.roots.map(posix);
  const inRoot = (file) => roots.some((root) => root === "" || file.startsWith(`${root}/`));
  return files.filter((file) => inRoot(file) && pattern.test(file) && !skip(file));
}

/** Every source file under the citable roots, tests included. */
function sourceFiles(config, tree, only) {
  const roots = only === undefined ? config.paths.citable : [only];
  const rels = roots
    .flatMap((root) => tree.under(root))
    .filter((file) => !BUILD_OUTPUT.test(`/${file}`) && SOURCE_EXTENSION.test(file));
  return readEach(config.root, rels);
}

function parsedJson(source) {
  if (source === null) return null;
  try {
    return JSON.parse(source);
  } catch {
    return null;
  }
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
async function resourceFiles(config, tree) {
  const root = posix(config.paths.serverFeatures);
  const resources = [];
  const take = async (rel, feature) => {
    const source = tree.isFile(rel) ? await read(path.join(config.root, rel)) : null;
    if (source) resources.push({ path: rel, source, feature });
  };
  for (const feature of tree.namesIn(root)) {
    const dir = join(root, feature);
    for (const name of config.paths.resourceFiles) await take(`${dir}/${name}`, feature);
    for (const subdir of config.paths.resourceDirs) {
      for (const name of tree.namesIn(`${dir}/${subdir}`)) {
        if (!/\.tsx?$/.test(name) || name.includes(".test.")) continue;
        await take(`${dir}/${subdir}/${name}`, feature);
      }
    }
  }
  return resources;
}

/** Nothing runs the schema and the queries together, so this asserts their names agree. */
async function sqlAgreement(config, tree, taken, lines) {
  const migrationDir = posix(config.paths.migrations);
  const migrations = await readEach(
    config.root,
    tree.namesIn(migrationDir).filter((name) => name.endsWith(".sql")).map((name) => join(migrationDir, name)),
  );
  const resources = await resourceFiles(config, tree);
  const features = tree.namesIn(config.paths.serverFeatures);
  const tables = declaredColumns(migrations.map((migration) => migration.contents));
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
    const byName = migrations.map((migration) => ({ file: path.posix.basename(migration.path), sql: migration.contents }));
    problems.push(...checkSqlIdentifiers(tables, resources, tableOwners(byName, features)));
    const declared = [];
    for (const feature of features) {
      const rel = `${join(posix(config.paths.serverFeatures), feature)}/${config.paths.schemaFile}`;
      const source = tree.isFile(rel) ? await read(path.join(config.root, rel)) : null;
      if (source === null) continue;
      for (const entry of schemaTables(source, { tableFactory: config.tenant.tableFactory })) declared.push({ path: rel, ...entry });
    }
    problems.push(...checkSchemaInMigrations(declared, migrationNames(migrations.map((migration) => migration.contents))));
    const columns = declared.reduce((sum, entry) => sum + entry.columns.length, 0);
    if (declared.length > 0) lines.push(`OK  schema       ${declared.length} table(s), ${columns} column(s) in schema files, each named by a migration`);
  }
  if (enabled(config.gates, "tenant-predicate")) {
    const helpers = config.tenantPredicate.exemptHelpers;
    const callers = (await sourceFiles(config, tree)).filter(
      (file) => !TEST_FILE.test(file.path) && helpers.some((helper) => file.contents.includes(helper.name)),
    );
    const helperOptions = { column: config.tenant.sqlColumn, identifier: config.tenant.column };
    problems.push(
      ...checkTenantPredicate(scoped, owned, tenantOptions),
      ...checkExemptHelperCalls(callers, helpers, helperOptions),
    );
    const calls = exemptHelperCalls(callers, helpers, helperOptions).length;
    if (calls > 0) lines.push(`OK  helpers      ${calls} call(s) of ${helpers.length} exempt helper(s), each naming the tenant`);
  }
  return problems;
}

/** Each server feature's trigger: routes, and the requirements they claim. */
async function triggers(config, tree) {
  const root = posix(config.paths.serverFeatures);
  const rels = tree
    .namesIn(root)
    .map((feature) => `${join(root, feature)}/${config.paths.triggerFile}`)
    .filter((rel) => tree.isFile(rel));
  return (await readEach(config.root, rels)).map(({ path: file, contents }) => ({ path: file, source: contents }));
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
async function internalRouteAgreement(config, tree, routes) {
  const root = posix(config.paths.workers);
  const rels = tree
    .foldersIn(root)
    .filter((worker) => worker !== "node_modules")
    .map((worker) => `${join(root, worker)}/${config.paths.workerEntry}`)
    .filter((rel) => tree.isFile(rel));
  const entries = (await readEach(config.root, rels)).map(({ path: file, contents }) => ({ path: file, source: contents }));
  if (entries.length === 0) return [];
  return checkInternalRoutes(
    declaredInternalRoutes(routes.map((route) => route.source)),
    calledInternalRoutes(entries),
  );
}

function platformFiles(config, tree) {
  const rels = tree
    .under(config.paths.platform ?? "frontend/src/platform")
    .filter((file) => !BUILD_OUTPUT.test(`/${file}`) && SOURCE_EXTENSION.test(file));
  return readEach(config.root, rels);
}

function isInfraFile(name) {
  if (INFRA_SKIP.some((suffix) => name.endsWith(suffix))) return false;
  return INFRA_EXTENSIONS.some((suffix) => name.endsWith(suffix));
}

/** Terraform/shell files under the configured infra roots — absent is ordinary, not an error. */
function infraFiles(config, tree) {
  const rels = (config.paths.infra ?? [])
    .flatMap((root) => tree.under(root))
    .filter((file) => !/node_modules|\.terraform/.test(file) && isInfraFile(file));
  return readEach(config.root, rels);
}

const SLICE_FILE = /\.[jt]sx?$/;
const escapeRegex = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Both surfaces, feature by feature, and every slice file either one holds. */
async function parityAgreement(config, tree) {
  const { sliceDir } = config.anatomy.slice;
  const server = posix(config.paths.serverFeatures);
  const client = posix(config.paths.frontendFeatures);
  const sliceFiles = [];
  const slicesOf = (dir) => {
    const folder = `${dir}/${sliceDir}`;
    const names = tree
      .namesIn(folder)
      .filter((name) => SLICE_FILE.test(name) && !TEST_FILE.test(name) && tree.isFile(`${folder}/${name}`));
    sliceFiles.push(...names.map((name) => `${folder}/${name}`));
    return [...new Set(names.map((name) => name.replace(SLICE_FILE, "")))];
  };
  const routeImport = new RegExp(`from\\s+["']\\./${escapeRegex(sliceDir)}/([^"']+)\\.[cm]?[jt]sx?["']`, "g");
  const serverSide = [];
  for (const name of tree.foldersIn(server).sort()) {
    const dir = join(server, name);
    const trigger = (await read(path.join(config.root, dir, config.paths.triggerFile))) ?? "";
    serverSide.push({ name, slices: slicesOf(dir), routes: [...trigger.matchAll(routeImport)].map((match) => match[1]) });
  }
  const clientSide = tree.foldersIn(client).sort().map((name) => ({ name, slices: slicesOf(join(client, name)) }));
  const registry = parsedJson(await read(path.join(config.root, config.parity.registry))) ?? {};
  const roots = { server, client, registry: config.parity.registry, trigger: config.paths.triggerFile };
  return {
    problems: [
      ...checkParity({ server: serverSide, client: clientSide, registry }, roots),
      ...placeholderSlices(await readEach(config.root, sliceFiles)),
    ],
    paired: serverSide.filter(({ name }) => clientSide.some((feature) => feature.name === name)).length,
  };
}

/** Every file under the configured roots that the integration subject pattern matches. */
function integrationSubjects(config, tree) {
  const { roots, subject } = config.integrationImports;
  const pattern = new RegExp(subject);
  const skip = prunedBy(/(?:^|\/)(?:node_modules|dist|\.[^/]+)$/);
  const rels = new Set(roots.flatMap((root) => tree.under(root)).filter((file) => pattern.test(file) && !skip(file)));
  return readEach(config.root, [...rels].sort());
}

/** Each closed set against the keys its writers write. */
async function closedSets(config, tree, lines) {
  const problems = [];
  for (const set of config.closedSetWriters.sets) {
    const declared = matchedKeys((await read(path.join(config.root, set.source))) ?? "", set.key);
    const rels = (set.roots ?? []).flatMap((root) => tree.under(root)).filter((file) => SOURCE_EXTENSION.test(file) && !SKIP.test(`/${file}`));
    const written = new Set();
    for (const file of await readEach(config.root, rels)) {
      for (const key of matchedKeys(file.contents, set.writer)) written.add(key);
    }
    problems.push(...checkClosedSetWriters(declared, written, set));
    const waiting = Object.keys(set.declaredAhead ?? {}).length;
    lines.push(`OK  closed set   ${set.name}: ${written.size} of ${declared.length} key(s) written, ${waiting} waiting for a mutation`);
  }
  return problems;
}

/** Every state-claim block in the configured documents, against the file it counts. */
async function docClaims(config, lines) {
  const problems = [];
  for (const doc of config.docClaims.files) {
    const contents = await read(path.join(config.root, doc));
    if (contents === null) continue;
    const claims = parseDocClaims(contents);
    const targets = new Map();
    for (const claim of claims) targets.set(claim.file, await read(path.join(config.root, claim.file)));
    problems.push(...checkDocClaims(doc, claims, targets));
    lines.push(`OK  doc claims   ${claims.length} claim(s) in ${doc}, each still true`);
  }
  return problems;
}

/**
 * @param {object} config
 * @param {string | string[]} [only] files to check on the fast path a hook takes; none is the full check
 * @param {{lister?: typeof repoFiles}} [io] the file lister, which a test replaces to count its calls
 * @returns {Promise<{problems: object[], lines: string[]}>}
 */
export async function runCheck(config, only = [], { lister = repoFiles } = {}) {
  const requested = [only].flat().filter(Boolean);
  const perFile = requested.length > 0;
  // A file outside the repository is in no listing and in no feature.
  const given = requested
    .map((file) => relativeTo(config.root)(path.resolve(config.root, file)))
    .filter((rel) => !rel.startsWith("../") && !path.isAbsolute(rel));
  const pathspecs = perFile ? scopeOf(config, given) : undefined;
  const tree = treeOf(await lister(config.root, { ignores: config.ignores, pathspecs }));

  const roots = config.featureRoots.map((root) => path.join(config.root, root));
  const { features, contents } = await collect(config, tree, perFile ? given : undefined);

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
  if (enabled(config.gates, "feature-cli") && !perFile) {
    const rel = relativeTo(config.root);
    const relativeFeatures = features.map((feature) => ({ ...feature, feature: rel(feature.feature) }));
    const relativeContents = contents.map((file) => ({ ...file, path: rel(file.path) }));
    problems.push(
      ...checkFeatureCommands(relativeFeatures, relativeContents, {
        block: config.cli.block,
        roots: config.cli.roots,
        viewModules: config.cli.viewModules,
        serverModules: config.cli.serverModules,
        factory: config.cli.factory,
        publisher: config.cli.publisher,
        drives: config.cli.drives,
        sagaFactories: config.cli.sagaFactories,
        tests: relativeContents.filter((file) => TEST_FILE.test(file.path)),
      }),
    );
    lines.push(`OK  commands     ${governedFeatures(relativeFeatures, { roots: config.cli.roots })} feature(s) drivable headless through \`qc run\``);
  }
  if (!rootless) lines.push(`OK  structure    ${features.length} feature folder(s)`);

  if (perFile) {
    // The English rules that judge one file alone, on exactly the files given. The ledger-wide
    // rules need every file, so only the full check runs them.
    if (enabled(config.gates, "english-source")) {
      const judged = languageFiles(config, tree.files.filter((file) => given.some((g) => file === g || file.startsWith(`${g}/`))));
      problems.push(...checkEnglishFiles(await readEach(config.root, judged), config.language));
      lines.push(`OK  english      ${judged.length} given file(s): comments and prose are English`);
    }
    return { problems, lines };
  }

  if (enabled(config.gates, "citations")) {
    const cited = await citableFiles(config, tree, config.paths.citable);
    const decisionsFile = await read(path.join(config.root, config.docs.decisions));
    const decisions = definedIds(decisionsFile ?? "", config.citations);
    const requirementIds = new Set(
      (await registered(path.join(config.root, config.paths.traceability))).map((entry) => entry.id),
    );
    const docsRoot = posix(config.docs.root);
    const docs = new Set(
      tree
        .namesIn(docsRoot)
        .filter((name) => name.endsWith(".md") && tree.isFile(join(docsRoot, name)))
        .map((name) => `${config.docs.root}/${name}`),
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

  if (enabled(config.gates, "registry-readers")) {
    const entries = readerEntries(thresholds(config));
    const readers = [...new Set(entries.flatMap((entry) => entry.readers))];
    const sources = new Map(await Promise.all(readers.map(async (reader) => [reader, await read(path.join(config.root, reader))])));
    problems.push(...checkRegistryReaders(entries, sources));
    if (readers.length > 0) lines.push(`OK  readers      ${readers.length} registry reader(s), each present and naming its entry`);
  }

  if (enabled(config.gates, "registry-literal")) {
    const docs = await readEach(config.root, tree.under(config.docs.root).filter((file) => file.endsWith(".md")));
    const libraries = parsedJson(await read(path.join(config.root, config.versions)))?.libraries ?? {};
    const exempt = config.registryLiteral.exempt ?? adrLog(config);
    problems.push(...checkRegistryLiteral(docs, { thresholds: thresholds(config), libraries, exempt }));
    if (docs.length > 0) lines.push(`OK  literals     ${docs.length} doc(s) carry a token, never a figure a registry owns`);
  }

  if (enabled(config.gates, "threshold-ratchet")) {
    const { base } = config.ratchet;
    const inputs = await ratchetInputs(config.root, { base, registry: config.thresholds, adrGlobs: adrLog(config) });
    if (inputs.skip) {
      lines.push(`OK  ratchet      skipped: ${inputs.skip}`);
    } else {
      problems.push(...checkThresholdRatchet(inputs.before, inputs.after, inputs.adrs, { registry: config.thresholds }));
      const count = Object.keys(inputs.after).length;
      if (count > 0) lines.push(`OK  ratchet      ${count} threshold(s) against the merge base with ${base}; a loosening names its ADR`);
    }
  }

  if (enabled(config.gates, "sql-identifiers") || enabled(config.gates, "tenant-predicate")) {
    lines.push("OK  sql          every column is declared, every statement and every exempt helper's caller carries the tenant");
    problems.push(...(await sqlAgreement(config, tree, taken, lines)));
    // An exemption is counted and named, so it stays a decision rather than a habit.
    for (const exemption of taken) lines.push(`  exempt       ${exemption.path}: ${exemption.reason}`);
  }

  if (enabled(config.gates, "migration-numbers")) {
    const migrationDir = posix(config.paths.migrations);
    const names = tree.namesIn(migrationDir).filter((name) => tree.isFile(join(migrationDir, name)));
    problems.push(...checkMigrationNumbers(names, migrationDir));
    if (names.length > 0) lines.push(`OK  migrations   ${names.filter((name) => name.endsWith(".sql")).length} migration(s), each number unique, with no gap`);
  }

  if (enabled(config.gates, "saga-tests")) {
    const sources = await sourceFiles(config, tree);
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
    const own = await sourceFiles(config, tree, config.paths.checks);
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

  const routes = await triggers(config, tree);
  if (enabled(config.gates, "claimed-requirements")) {
    problems.push(...(await claimAgreement(config, routes)));
    lines.push("OK  claims       every requirement a route claims names a test that proves it");
  }
  if (enabled(config.gates, "public-routes")) {
    problems.push(...(await publicRouteAgreement(config, routes)));
    lines.push("OK  public       the edge lets through exactly the routes the api serves without a session");
  }
  if (enabled(config.gates, "internal-routes")) {
    problems.push(...(await internalRouteAgreement(config, tree, routes)));
    lines.push("OK  internal     every path a worker posts to is a route the api serves");
  }
  if (enabled(config.gates, "headless-sagas")) {
    lines.push("OK  headless     pipelines are headless and triggers remain thin presenters");
  }
  if (enabled(config.gates, "frontend-boundaries")) {
    const platform = await platformFiles(config, tree);
    if (platform.length > 0) {
      problems.push(...checkFrontendBoundaries(platform, contents));
      lines.push("OK  boundaries   platform remains a thin substrate without domain leaks or junk drawers");
    }
  }
  if (enabled(config.gates, "test-mirror")) {
    const { roots: mirrorRoots } = config.testMirror;
    const walked = new Set();
    for (const dir of mirrorFolders(mirrorRoots)) {
      for (const file of await sourceFiles(config, tree, dir)) walked.add(file.path);
    }
    const all = [...walked];
    const testPaths = all.filter((file) => TEST_FILE.test(file));
    const srcPaths = all.filter((file) => !TEST_FILE.test(file));
    const mirrorProblems = checkTestMirror(testPaths, srcPaths, mirrorRoots);
    problems.push(...mirrorProblems);
    if (mirrorProblems.length === 0) {
      const judged = mirrorRoots.map((root) => root.tests).join(", ") || "no configured root";
      lines.push(`OK  mirror       tests mirror src paths 1:1, no orphaned test, in ${judged}`);
    }
  }

  if (enabled(config.gates, "comment-style")) {
    const infra = await infraFiles(config, tree);
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
    // Its own file set. The citation and source walkers were built for other questions and each
    // skips something this one needs -- tests, documents, migrations, contracts. Language is not
    // a property of TypeScript: a Japanese column default in .sql reaches a reader just the same.
    const everything = await readEach(config.root, languageFiles(config, tree.files));
    problems.push(...checkEnglishSource(everything, config.language));
    problems.push(...checkTranslationPairs(everything.map((file) => file.path), config.language.translationPairs));
    // The ledger is printed on every run, not only when it fails: a file listed once and never
    // mentioned again is how a document stays untranslated without anyone deciding that.
    const ledger = config.language.legacyNonEnglish ?? {};
    const owed = Object.values(ledger).reduce((sum, n) => sum + (Number(n) || 0), 0);
    lines.push("OK  english      comments, docs and rules are English; another language is declared data");
    if (owed > 0) {
      lines.push(
        `    owing      ${Object.keys(ledger).length} file(s), ${owed} occurrence(s) still to translate — language.legacyNonEnglish`,
      );
    }
  }

  if (enabled(config.gates, "adr-format")) {
    const records = await citableFiles(config, tree, [config.adr.root]);
    const docs = records.filter((file) => file.path.endsWith(".md"));
    problems.push(...checkAdrFormat(docs, config.adr));
    if (docs.length > 0) lines.push(`OK  decisions    ${docs.length} record(s), each with its cost and its rejected alternatives`);
  }

  if (enabled(config.gates, "parity")) {
    const parity = await parityAgreement(config, tree);
    problems.push(...parity.problems);
    lines.push(`OK  parity       ${parity.paired} feature(s) on both surfaces, every divergence named, no no-op slice`);
  }

  if (enabled(config.gates, "integration-imports")) {
    const subjects = await integrationSubjects(config, tree);
    problems.push(...checkIntegrationImports(subjects, config.integrationImports));
    lines.push(`OK  integration  ${subjects.length} integration test(s), each importing the product it integrates with`);
  }

  if (enabled(config.gates, "closed-set-writers")) {
    problems.push(...(await closedSets(config, tree, lines)));
  }

  if (enabled(config.gates, "doc-claims")) {
    problems.push(...(await docClaims(config, lines)));
  }

  return { problems, lines };
}
