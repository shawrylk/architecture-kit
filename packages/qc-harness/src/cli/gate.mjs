// Manual workflow decisions for Codex. Only the shared guards' inspection commands run.
import { statSync } from "node:fs";
import path from "node:path";
import { decide as decideCommand } from "./bash-command-guard.mjs";
import { decide as decideMerge } from "./merge-guard.mjs";
import { decidePr } from "./pr-guard.mjs";

const ROLES = new Set(["leader", "worker", "implementer", "reviewer"]);
const VERBS = { "pr-create": "create", "pr-ready": "ready", merge: "merge" };
const USAGE = "usage: qc gate <pr-create|pr-ready|merge|command> [--cwd <dir>] --session <id> --role <leader|worker|implementer|reviewer> -- <gh arguments... | single shell command>";
const quote = (word) => `'${word.replaceAll("'", "'\\''")}'`;

/** Shared-policy workflow identity, never evidence of a native subagent. Callers validate authority. */
export function sharedWorkflowIdentity(session, role) {
  return { session_id: session, agent_type: role, ...(role === "leader" ? {} : { agent_id: session }) };
}

/** Evaluate the same pre-action decisions as Claude, without running the supplied command. */
export async function decideGate({ cwd, session, role, command }, dependencies = {}) {
  if (![cwd, session, command].every((value) => typeof value === "string" && value.trim()) || !ROLES.has(role) || !statSync(cwd).isDirectory()) {
    throw new Error(USAGE);
  }
  const call = {
    cwd: path.resolve(cwd), ...sharedWorkflowIdentity(session, role),
    hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command },
  };
  const notes = [];
  for (const decide of [decideCommand, decidePr, decideMerge]) {
    const output = (await decide(call, dependencies))?.hookSpecificOutput;
    if (output?.permissionDecision === "deny") return { decision: "deny", reason: output.permissionDecisionReason };
    if (output?.additionalContext) notes.push(output.additionalContext);
  }
  return { decision: "allow", reason: null, ...(notes.length ? { context: notes.join(" ") } : {}) };
}

/** Exit 0 allows, 2 refuses, and 1 reports invalid input or an evaluation error. */
export async function runGate(args) {
  try {
    const [action, ...rest] = args;
    if (action !== "command" && !Object.hasOwn(VERBS, action)) throw new Error(USAGE);
    const options = { cwd: process.cwd() };
    const seen = new Set();
    let at = 0;
    while (at < rest.length && rest[at] !== "--") {
      const key = rest[at++];
      if (!["--cwd", "--session", "--role"].includes(key) || seen.has(key) || at === rest.length || rest[at].startsWith("--")) throw new Error(USAGE);
      seen.add(key);
      options[key.slice(2)] = rest[at++];
    }
    if (rest[at] !== "--") throw new Error(USAGE);
    const words = rest.slice(at + 1);
    if (action === "command" && words.length !== 1) throw new Error(USAGE);
    options.command = action === "command" ? words[0] : ["gh", "pr", VERBS[action], ...words].map(quote).join(" ");
    const result = await decideGate(options);
    console.log(JSON.stringify(result));
    return result.decision === "deny" ? 2 : 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}
