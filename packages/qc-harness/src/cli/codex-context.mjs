import path from "node:path";
import { statSync } from "node:fs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Identity boundary only; persistent role-budget CLI integration remains unsupported. */
export function normalizeCodexContext(input, { role } = {}) {
  if (!input || !["leader", "implementer", "reviewer"].includes(role) || input.hook_event_name !== "PreToolUse" ||
      ![input.session_id, input.turn_id, input.tool_use_id].every(id) || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) ||
      (role === "leader" ? input.agent_id !== undefined || input.agent_type !== undefined :
        input.agent_id !== input.session_id || !id(input.agent_type))) throw new Error("unsupported native context identity");
  try { if (!statSync(input.cwd).isDirectory()) throw new Error(); }
  catch { throw new Error("unsupported native context identity"); }
  return { ...input, role };
}
