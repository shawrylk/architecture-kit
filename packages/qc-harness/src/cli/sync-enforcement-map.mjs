// Refreshes the generated block in an existing docs/enforcement.md, without touching anything
// else `qc init` would — for the day-to-day case of the kit shipping a new rule or gate.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { withEnforcementMap } from "../enforcement-map.mjs";

export async function runSyncEnforcementMap(config) {
  const file = path.join(config.root, config.docs.enforcement);
  const before = await readFile(file, "utf8").catch(() => null);
  if (before === null) {
    console.error(`No ${config.docs.enforcement} here. Run \`qc init\` first.`);
    process.exitCode = 1;
    return;
  }
  const after = withEnforcementMap(before, config);
  if (after === null) {
    console.error(`No generated marker found in ${config.docs.enforcement} — nothing to refresh.`);
    process.exitCode = 1;
    return;
  }
  if (after === before) {
    console.log(`OK  enforcement-map   ${config.docs.enforcement} already current`);
    return;
  }
  await writeFile(file, after);
  console.log(`written     ${config.docs.enforcement}`);
}
