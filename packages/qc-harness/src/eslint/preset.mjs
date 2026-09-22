// The lint rule is the architecture. docs/enforcement.md.
// Thresholds are imported, never restated — quality-thresholds.json is their one home.

import qc from "./index.mjs";
import { enabled, load, thresholds } from "../config.mjs";

/** Options each rule needs, derived from one config so a name is written once. */
function ruleOptions(config) {
  return {
    "no-comment-paragraph": {
      doc: config.enforcement ?? "docs/enforcement.md",
      decisions: config.docs.decisions,
      maxLines: config.comments.maxLines,
    },
    "name-the-pattern": { maxWords: config.patterns.maxWords, extra: config.patterns.extra },
    "no-number-in-comment": { prefixes: config.citations.prefixes, external: config.citations.external, registry: config.thresholds },
    "no-cross-feature-internals": { featureDir: config.featureDir, publicFile: config.publicFile },
    "no-raw-fetch": { client: config.apiClient },
    "no-promise-then": { allow: config.promise.allow },
    "no-orchestration-in-trigger": { presenters: config.presenters },
    "scoped-repository": { suffixes: config.scopedSuffixes },
    "storage-only-in-resource": {
      modules: config.storage.modules,
      resourceFiles: config.storage.resourceFiles,
      driverBinding: config.storage.driverBinding,
    },
    "external-service-only-in-adapter": {
      scopes: config.externalServices.scopes,
      modules: config.externalServices.modules,
      allowedFiles: config.externalServices.allowedFiles,
      allowedPaths: config.externalServices.allowedPaths,
    },
    "tenant-scoped-table": {
      column: config.tenant.column,
      tableFactory: config.tenant.tableFactory,
      indexFactory: config.tenant.indexFactory,
    },
    "durable-idempotency-key": {
      keys: config.idempotency.keys,
      volatile: config.idempotency.volatile,
      ledgerKey: config.idempotency.ledgerKey,
      throwawayLedgers: config.idempotency.throwawayLedgers,
    },
    "no-supersession-trail": {},
    "timeless-comment": timelessVocabulary(config),
    "signal-last-param": {},
    "no-offset-pagination": {},
    "no-status-literal": {},
  };
}

/** A list a repository states replaces the rule's own; an empty one leaves the rule's defaults. */
function timelessVocabulary(config) {
  const stated = config.comments?.timeless ?? {};
  const out = {};
  for (const key of ["promises", "moments"]) {
    if (Array.isArray(stated[key]) && stated[key].length > 0) out[key] = stated[key];
  }
  return out;
}

function entries(config, names) {
  const options = ruleOptions(config);
  const out = {};
  for (const name of names) {
    if (!enabled(config.rules, name)) continue;
    const given = options[name];
    out[`qc/${name}`] = given && Object.keys(given).length > 0 ? ["error", given] : "error";
  }
  return out;
}

/** Rules that apply to every file, on both surfaces. */
const UNIVERSAL = [
  "durable-idempotency-key",
  "no-supersession-trail",
  "timeless-comment",
  "no-comment-paragraph",
  "name-the-pattern",
  "no-number-in-comment",
  "no-promise-then",
  "no-cross-feature-internals",
  "no-offset-pagination",
  "no-orchestration-in-trigger",
  "no-status-literal",
  "scoped-repository",
  // Not a layered-architecture concern like the SERVER rules below — a worker or a
  // composition root outside backend/src needs this exactly as much as backend/src does.
  "external-service-only-in-adapter",
];

/** Rules that only make sense where the server's storage and ports live. */
const SERVER = ["storage-only-in-resource", "tenant-scoped-table", "signal-last-param"];

/** Rules that only make sense in the browser. */
const CLIENT = ["no-raw-fetch", "storage-only-in-resource"];

/**
 * The architecture as a flat config. Spread it, then append your own blocks.
 *
 * @param {object} [options]
 * @param {string} [options.root] repository root; defaults to the working directory
 * @param {object} [options.plugins] tseslint, boundaries and sonarjs, when you want those blocks
 */
export function preset(options = {}) {
  const config = options.config ?? load(options.root);
  const gates = thresholds(config);
  const max = (id) => gates[id]?.value;
  const { tseslint, boundaries, sonarjs } = options.plugins ?? {};

  const blocks = [{ ignores: config.ignores }];

  const base = {
    files: ["**/*.{ts,tsx,mjs}"],
    plugins: { qc, ...(tseslint ? { "@typescript-eslint": tseslint } : {}), ...(sonarjs ? { sonarjs } : {}) },
    rules: {
      ...(tseslint ? { "@typescript-eslint/no-explicit-any": "error" } : {}),
      ...(sonarjs
        ? {
            "sonarjs/no-identical-functions": "error",
            "sonarjs/no-duplicated-branches": "error",
            "sonarjs/no-identical-conditions": "error",
            "sonarjs/no-all-duplicated-branches": "error",
          }
        : {}),
      ...(max("filelength") ? { "max-lines": ["error", { max: max("filelength"), skipBlankLines: true, skipComments: true }] } : {}),
      ...(max("funclength")
        ? { "max-lines-per-function": ["error", { max: max("funclength"), skipBlankLines: true, skipComments: true }] }
        : {}),
      ...(max("nesting") ? { "max-depth": ["error", max("nesting")] } : {}),
      ...entries(config, UNIVERSAL),
    },
  };
  if (options.languageOptions) base.languageOptions = options.languageOptions;
  blocks.push(base);

  if (config.layers && boundaries) {
    blocks.push({
      files: config.layers.include,
      plugins: { boundaries },
      settings: {
        "boundaries/elements": config.layers.elements,
        "boundaries/include": config.layers.include,
      },
      rules: {
        "boundaries/element-types": [
          "error",
          {
            default: "disallow",
            rules: Object.entries(config.layers.allow).map(([from, allow]) => ({ from, allow })),
          },
        ],
        "boundaries/external": ["error", { default: "allow", rules: config.layers.external }],
        ...entries(config, SERVER),
      },
    });
  } else if (config.layers) {
    blocks.push({ files: config.layers.include, rules: entries(config, SERVER) });
  }

  if (config.clientFiles) {
    blocks.push({ files: config.clientFiles, rules: entries(config, CLIENT) });
  }

  if (config.frontendLayers && boundaries) {
    blocks.push({
      files: config.frontendLayers.include,
      plugins: { boundaries },
      settings: {
        "boundaries/elements": config.frontendLayers.elements,
        "boundaries/include": config.frontendLayers.include,
      },
      rules: {
        "boundaries/element-types": [
          "error",
          {
            default: "disallow",
            rules: Object.entries(config.frontendLayers.allow).map(([from, allow]) => ({ from, allow })),
          },
        ],
        ...(config.frontendLayers.external
          ? { "boundaries/external": ["error", { default: "allow", rules: config.frontendLayers.external }] }
          : {}),
      },
    });
  }

  // Gates and rules are tooling: they name the vocabulary they ban, so they trip
  // their own checks. Fixtures still prove each rule fails on real code.
  blocks.push({
    files: config.toolingFiles ?? ["scripts/**/*.mjs", "**/*.test.{ts,tsx,mjs}"],
    rules: {
      ...Object.fromEntries(Object.keys(qc.rules).map((name) => [`qc/${name}`, "off"])),
      ...(sonarjs ? { "sonarjs/no-identical-functions": "off" } : {}),
      "max-lines": "off",
      "max-lines-per-function": "off",
      ...(boundaries ? { "boundaries/external": "off", "boundaries/element-types": "off" } : {}),
    },
  });

  return blocks;
}

export default preset;
