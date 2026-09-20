// A feature is reachable two ways, and only one of them is usually built. Routes need a server,
// a session and a client; that is the path a person exercises by hand and a suite mocks away.
// This names the second one: a command block that drives the same pipeline with no server at all,
// so a test, a script or a person can run the feature and see what it really does.
//
// headless-sagas proves a pipeline *could* run without a view. This proves something *does*.
//
// The check that carries the gate is agreement, not existence: every saga a feature declares is
// named by a command, and every command names a saga the feature declares. A gate asserting only
// that an entrypoint file exists passes on day one and never fails again; this one fails every
// time a workflow is added and left undrivable -- the shape public-routes and internal-routes use.
//
// Off by default in the shipped config: a repository names its own command block and the roots
// that carry one, or the gate would red every tree the moment it upgraded the harness.

import { declaredSagas } from "./saga-tests.mjs";

const DEFAULT_BLOCK = "cli";
const DEFAULT_VIEW_MODULES = ["react", "react-dom"];
const DEFAULT_SERVER_MODULES = ["fastify", "express", "koa", "@nestjs/core"];
const DEFAULT_FACTORY = "defineCommands";
const DEFAULT_PUBLISHER = "index";
// What a command entry names as the workflow it drives. One key, so the table stays readable.
const DEFAULT_DRIVES = "saga";
// Kept beside saga-tests' own default: the two gates must read the same declarations.
const DEFAULT_SAGA_FACTORIES = ["definePipeline", "defineSaga"];

function escape(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// An empty list would silently match nothing, disabling the check instead of failing it.
function names(value, label) {
  const list = [value].flat();
  if (list.length === 0 || list.some((name) => typeof name !== "string" || name === "")) {
    throw new Error(`cli.${label} must be a name or a non-empty list of them, got ${JSON.stringify(value)}`);
  }
  return list;
}

function blockPattern(block) {
  return new RegExp(`(?:^|/)${escape(block)}\\.[cm]?[jt]sx?$`);
}

function importPattern(modules) {
  return new RegExp(`\\bfrom\\s+["'](?:${modules.map(escape).join("|")})["']`);
}

/** Every feature directory the roots cover, with the block file it carries and that file's text. */
function blocksOf(features, contents, block, roots) {
  const matches = blockPattern(block);
  const byPath = new Map(contents.map((file) => [file.path, file.contents]));
  const found = [];
  for (const { feature, files } of features) {
    if (roots.length > 0 && !roots.some((root) => feature.includes(root))) continue;
    const file = files.find((name) => matches.test(name));
    found.push({
      feature,
      files,
      path: file === undefined ? undefined : `${feature}/${file}`,
      contents: file === undefined ? undefined : (byPath.get(`${feature}/${file}`) ?? ""),
    });
  }
  return found;
}


/** Every workflow the command table names, read from the `drives` key of each entry. */
export function commandedSagas(contents, options = {}) {
  const factories = names(options.factory ?? DEFAULT_FACTORY, "factory");
  const drives = options.drives ?? DEFAULT_DRIVES;
  const table = new RegExp(`\\b(?:${factories.map(escape).join("|")})\\s*[<(]`);
  const opens = table.exec(contents);
  if (opens === null) return [];
  const body = contents.slice(opens.index);
  const entry = new RegExp(`\\b${escape(drives)}\\s*:\\s*([A-Za-z_$][\\w$]*)`, "g");
  const found = [];
  for (const hit of body.matchAll(entry)) found.push(hit[1]);
  return found;
}

/**
 * @param {{feature: string, files: string[]}[]} features Feature folders, relative to the root.
 * @param {{path: string, contents: string}[]} contents Every source file, relative to the root.
 * @param {{block?: string, roots?: string[], viewModules?: string[], serverModules?: string[], factory?: string | string[], publisher?: string, tests?: {path: string, contents: string}[]}} [options]
 * @returns {{path?: string, feature?: string, rule: string, detail: string}[]}
 */
export function checkFeatureCommands(features, contents, options = {}) {
  const block = names(options.block ?? DEFAULT_BLOCK, "block")[0];
  const roots = options.roots ?? [];
  const viewModules = options.viewModules ?? DEFAULT_VIEW_MODULES;
  const serverModules = options.serverModules ?? DEFAULT_SERVER_MODULES;
  const factories = names(options.factory ?? DEFAULT_FACTORY, "factory");
  const publisher = options.publisher ?? DEFAULT_PUBLISHER;
  const tests = options.tests ?? [];
  const drives = options.drives ?? DEFAULT_DRIVES;
  const sagaFactories = names(options.sagaFactories ?? DEFAULT_SAGA_FACTORIES, "sagaFactories");

  const view = importPattern(viewModules);
  const server = importPattern(serverModules);
  const declares = new RegExp(`\\b(?:${factories.map(escape).join("|")})\\s*[<(]`);
  const publishes = new RegExp(`\\bfrom\\s+["']\\.\\/${escape(block)}\\.(?:[cm]?[jt]sx?)["']`);

  const problems = [];
  for (const found of blocksOf(features, contents, block, roots)) {
    if (found.path === undefined) {
      problems.push({
        feature: found.feature,
        rule: "feature-cli-missing",
        detail: `${found.feature} declares no ${block} block: a feature that can only be driven over its routes cannot be run without a server`,
      });
      continue;
    }
    if (view.test(found.contents)) {
      problems.push({
        path: found.path,
        rule: "feature-cli-no-view",
        detail: `${block} is the headless entrypoint and cannot import ${viewModules.join(" or ")}`,
      });
    }
    if (server.test(found.contents)) {
      problems.push({
        path: found.path,
        rule: "feature-cli-no-server",
        detail: `${block} drives the pipeline directly and cannot import ${serverModules.join(" or ")} — a command that needs a running server is a route, not a command`,
      });
    }
    if (!declares.test(found.contents)) {
      problems.push({
        path: found.path,
        rule: "feature-cli-undeclared",
        detail: `${block} declares no command through ${factories.join(" or ")}, so nothing can dispatch it`,
      });
    }
    const index = `${found.feature}/${publisher}`;
    const republished = contents.find((file) => file.path.replace(/\.[cm]?[jt]sx?$/, "") === index);
    if (republished === undefined || !publishes.test(republished.contents)) {
      problems.push({
        path: found.path,
        rule: "feature-cli-unpublished",
        detail: `${publisher} does not re-export ${block}: only ${publisher} crosses a feature boundary, so the registry cannot reach these commands`,
      });
    }
    // The command block is the test seam. A block nothing imports is a claim, exactly as an
    // untested saga is -- saga-tests makes the same demand of a workflow.
    const named = tests.some((file) => publishes.test(file.contents) && file.path.startsWith(`${found.feature}/`));
    if (tests.length > 0 && !named) {
      problems.push({
        path: found.path,
        rule: "feature-cli-untested",
        detail: `no test under ${found.feature} imports ${block}: the command block is what makes the feature testable without a server, and nothing runs it`,
      });
    }

    // The gate's real work: the dispatch table and the feature's declared workflows agree, both
    // ways. Existence alone would pass forever; this fails the next time a saga is added.
    const owned = found.files
      .filter((file) => /\.[cm]?tsx?$/.test(file) && !/\.test\.[cm]?tsx?$/.test(file))
      .map((file) => `${found.feature}/${file}`);
    const declared = new Set(
      declaredSagas(
        contents.filter((file) => owned.includes(file.path)),
        { factories: sagaFactories },
      ).map((saga) => saga.name),
    );
    const commanded = new Set(commandedSagas(found.contents, { factory: factories, drives }));
    for (const saga of declared) {
      if (!commanded.has(saga)) {
        problems.push({
          path: found.path,
          rule: "feature-cli-undrivable-saga",
          detail: `${saga} is declared in ${found.feature} but no command drives it: a workflow reachable only over a route cannot be run without a server`,
        });
      }
    }
    for (const saga of commanded) {
      if (!declared.has(saga)) {
        problems.push({
          path: found.path,
          rule: "feature-cli-unknown-saga",
          detail: `a command names ${saga}, which ${found.feature} does not declare through ${sagaFactories.join(" or ")}`,
        });
      }
    }
  }
  return problems;
}
