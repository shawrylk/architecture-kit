import { parseArgs } from "node:util";
import { stackAction } from "../stack/stack.mjs";

/** Trigger: a repository plugin owns each stack's lifecycle. */
export async function runStack(argv, { say = console.log } = {}) {
  try {
    const [action, ...rest] = argv;
    const { values, positionals } = parseArgs({ args: rest, allowPositionals: true, options: { timeout: { type: "string", default: "120000" } } });
    const timeout = Number(values.timeout);
    if (!Number.isInteger(timeout) || timeout < 1) throw new Error("--timeout must be a positive integer");
    for (const row of await stackAction(action, positionals, { timeout })) say(JSON.stringify(row));
    return 0;
  } catch (error) { say(`qc stack: ${error.message}`); return 1; }
}
