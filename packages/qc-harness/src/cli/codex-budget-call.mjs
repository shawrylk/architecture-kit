import path from "node:path";
import { lstatSync, realpathSync } from "node:fs";
import { isHandoffCall } from "./budget.mjs";
import { parseCodexPatch } from "./codex-edit-hook.mjs";

// Added files can have missing parents. Resolve the nearest existing ancestor, refusing dangling links and read errors.
function actualPath(file) {
  let ancestor = file;
  const missing = [];
  for (;;) {
    try { return path.join(realpathSync(ancestor), ...missing); }
    catch (error) {
      if (error.code !== "ENOENT") throw error;
      try { lstatSync(ancestor); }
      catch (cause) {
        if (cause.code !== "ENOENT") throw cause;
        const parent = path.dirname(ancestor);
        if (parent === ancestor) throw error;
        missing.unshift(path.basename(ancestor)); ancestor = parent;
        continue;
      }
      throw error;
    }
  }
}

// Budget projection only: original native identity and ordinary edit guards remain owned by their existing boundaries.
export function codexBudgetCall(call) {
  if (call.tool_name !== "apply_patch") return call;
  try {
    const paths = parseCodexPatch(call.tool_input?.command, call.cwd)
      .flatMap(op => [op.file, ...(op.destination ? [op.destination] : [])]);
    const note = file_path => ({ ...call, tool_name: "Write", tool_input: { file_path } });
    if (!paths.length) return call;
    const actual = paths.map(actualPath);
    if (path.sep === "/" && [...paths, ...actual].some(file => file.includes("\\"))) return call;
    if (!paths.every(file => isHandoffCall(note(file))) || !actual.every(file => isHandoffCall(note(file)))) return call;
    return note(actual[0]);
  } catch { return call; }
}
