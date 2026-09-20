// Runs inside the repository's loader, so it may import a TypeScript registry. Kept separate from
// run.mjs for exactly that reason: the parent process must not need the loader to decide anything.

import process from "node:process";
import { pathToFileURL } from "node:url";
import { parseInput } from "./run.mjs";

/** Every command the registry publishes, sorted, one per line — what `qc run` with no name prints. */
export function listing(commands) {
  return Object.keys(commands)
    .sort()
    .map((key) => {
      const describe = commands[key]?.describe;
      return describe === undefined ? `  ${key}` : `  ${key.padEnd(38)}${describe}`;
    });
}

export async function dispatch(registry, name, argv) {
  const module = await import(pathToFileURL(registry).href);
  const commands = module.commands ?? module.default;
  if (commands === undefined || typeof commands !== "object") {
    console.error(`qc run: ${registry} exports no \`commands\` record`);
    return 1;
  }

  if (name === undefined) {
    console.log("qc run <feature>.<command> [--json '<payload>'] [--key value]\n");
    for (const line of listing(commands)) console.log(line);
    return 0;
  }

  const command = commands[name];
  if (command === undefined) {
    console.error(`qc run: no command \`${name}\`. Known commands:\n${listing(commands).join("\n")}`);
    return 1;
  }

  const result = await command.run(parseInput(argv));
  if (result !== undefined) console.log(JSON.stringify(result, null, 2));
  return 0;
}

// Spawned by run.mjs under the repository's loader: argv is [registry, name?, ...rest].
if (process.argv[1] === new URL(import.meta.url).pathname) {
  const [registry, name, ...rest] = process.argv.slice(2);
  try {
    process.exit(await dispatch(registry, name, rest));
  } catch (cause) {
    console.error(`qc run: ${cause instanceof Error ? cause.message : String(cause)}`);
    process.exit(1);
  }
}
