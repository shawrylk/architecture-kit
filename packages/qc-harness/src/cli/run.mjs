// `qc run <feature>.<command>` — the headless entrypoint the feature-cli gate exists to guarantee.
//
// The harness stays dumb on purpose: it resolves the registry a repository's codegen writes,
// looks up one key and calls it. Every decision about what a command *does* belongs to the
// repository, so the kit can dispatch a tree it knows nothing about.
//
// The registry module exports `commands`: a record keyed `<feature>.<command>`, each entry a
// `{ describe?, run(input) }`. Composing it is codegen's job — a hand-edited registry drifts.

import path from "node:path";
import process from "node:process";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";

const SHIM = fileURLToPath(new URL("./run-dispatch.mjs", import.meta.url));

/** `--json '<payload>'` is the whole input; `--key value` pairs build one. Both, and the pairs win. */
export function parseInput(argv) {
  const flags = {};
  let json;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    const value = inline ?? (argv[index + 1]?.startsWith("--") ? "true" : argv[++index]);
    if (name === "json") json = value;
    else flags[name] = value === undefined ? true : value;
  }
  let parsed = {};
  if (json !== undefined) {
    try {
      parsed = JSON.parse(json);
    } catch (cause) {
      throw new Error(`--json is not valid JSON: ${cause.message}`);
    }
  }
  return { ...parsed, ...flags };
}

/**
 * A TypeScript registry needs the repository's own loader; a JavaScript one is imported here.
 * Spawning rather than registering keeps the harness free of a loader dependency it does not own.
 */
export function needsLoader(registry, loader) {
  return loader.length > 0 && /\.[cm]?tsx?$/.test(registry);
}

export async function runRun(config, argv) {
  const cli = config.cli ?? {};
  const registry = path.resolve(config.root, cli.registry ?? "");
  const loader = cli.loader ?? [];

  if (cli.registry === undefined || cli.registry === "") {
    console.error("qc run: no cli.registry in qc.config.json — nothing to dispatch");
    return 1;
  }
  if (!existsSync(registry)) {
    console.error(`qc run: ${cli.registry} does not exist — run this repository's codegen to compose it`);
    return 1;
  }

  const [name, ...rest] = argv;
  if (needsLoader(registry, loader)) {
    const args = loader.flatMap((specifier) => ["--import", specifier]);
    const child = spawn(process.execPath, [...args, SHIM, registry, ...(name === undefined ? [] : [name]), ...rest], {
      cwd: config.root,
      stdio: "inherit",
    });
    return await new Promise((resolve) => child.on("exit", (code) => resolve(code ?? 1)));
  }

  const { dispatch } = await import(pathToFileURL(SHIM).href);
  return await dispatch(registry, name, rest);
}
