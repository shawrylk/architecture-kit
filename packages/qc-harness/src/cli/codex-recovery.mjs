import path from "node:path";
import { checkpointPathOf, readCheckpoint } from "./checkpoint.mjs";

const fields = ["hook_event_name", "source", "cwd", "session_id", "transcript_path", "model", "permission_mode"];
// Pinned 0.172.0 SessionStart wire; no workflow role, proof or checkpoint path in native input.
export const codexSessionStartInput = input => input && typeof input === "object" && !Array.isArray(input) &&
  Object.keys(input).length === fields.length && fields.every(key => key === "transcript_path" && input[key] === null ||
    typeof input[key] === "string" && input[key].length <= 4096) && input.hook_event_name === "SessionStart" &&
  ["startup", "compact", "resume"].includes(input.source);

// Created once from original runner admission. Only the live runtime reservation invokes this closure.
export function createCodexRecovery({ worktree, repository, nativeThreadId, role }, { maxAgeMinutes = 30 } = {}) {
  const fail = () => { throw Error("Codex recovery unavailable"); };
  if (!["leader", "implementer", "reviewer"].includes(role) || !/^[A-Za-z0-9_-]{1,128}$/.test(nativeThreadId) ||
      !Number.isFinite(maxAgeMinutes) || maxAgeMinutes < 0) fail();
  const file = checkpointPathOf(worktree, nativeThreadId);
  if (file !== path.join(repository, "qc", "checkpoints", `${nativeThreadId}.md`)) fail();
  return () => {
    // 8 KiB remains below the 64 KiB transport cap even at JSON's worst-case escaping expansion.
    const checkpoint = readCheckpoint(file, { maxAgeMinutes, maxBytes: 8192 });
    if (checkpoint.problem || checkpoint.text === null) fail();
    return { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: checkpoint.text } };
  };
}
