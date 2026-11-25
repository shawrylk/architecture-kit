import path from "node:path";
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, rmdirSync, statSync } from "node:fs";
import os from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { load } from "../config.mjs";
import { writeState } from "./budget-counter.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { codexBudgetCall } from "./codex-budget-call.mjs";
import { decideCodexBudget } from "./context-watch.mjs";
import { codexAdmissionOf } from "./codex-runtime.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);

/** Legacy roles come from trusted hook configuration; external roles require a private reservation. */
export function normalizeCodexContext(input, { role, admission } = {}) {
  const proof = admission === undefined ? null : codexAdmissionOf(admission, input);
  if (proof) role = proof.role;
  if (!input || !["leader", "implementer", "reviewer"].includes(role) || input.hook_event_name !== "PreToolUse" ||
      ![input.session_id, input.turn_id, input.tool_use_id].every(id) || typeof input.cwd !== "string" || !path.isAbsolute(input.cwd) ||
      (proof || role === "leader" ? input.agent_id !== undefined || input.agent_type !== undefined :
        input.agent_id !== input.session_id || !id(input.agent_type))) throw new Error("unsupported native context identity");
  try { if (!statSync(input.cwd).isDirectory()) throw new Error(); }
  catch { throw new Error("unsupported native context identity"); }
  return { ...input, role };
}

const hash = value => createHash("sha256").update(value).digest("hex");
const digest = value => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const whole = value => Number.isSafeInteger(value) && value >= 0;
const object = value => value && typeof value === "object" && !Array.isArray(value);
const budgetSnapshot = value => value === null || object(value) && Object.keys(value).length === 2 &&
  whole(value.remindAt) && value.remindAt > 0 && whole(value.handoffAt) && value.handoffAt > value.remindAt;
function stored(file) {
  let fd;
  try {
    fd = openSync(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > 8192 || lstatSync(file).isSymbolicLink()) throw new Error();
    const buffer = Buffer.alloc(8193), size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size) throw new Error();
    const data = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)));
    if (!object(data) || data.version !== 1 || !whole(data.count) || !Array.isArray(data.calls) || data.calls.length > 64 ||
        !data.calls.every(digest) || !object(data.policy) || Object.keys(data.policy).some(key => !["budgetClosed", "budgetReminded", "budgetFiredAt"].includes(key)) ||
        ["budgetClosed", "budgetReminded"].some(key => data.policy[key] !== undefined && typeof data.policy[key] !== "boolean") ||
        data.policy.budgetFiredAt !== undefined && (!whole(data.policy.budgetFiredAt) || data.policy.budgetFiredAt > data.count) ||
        data.budget !== undefined && !budgetSnapshot(data.budget) || data.policy.budgetClosed && data.budget === null ||
        data.root !== undefined && !digest(data.root) || data.admission !== undefined && !digest(data.admission) ||
        data.noted !== undefined && typeof data.noted !== "boolean" ||
        data.cursor !== undefined && (!object(data.cursor) || !digest(data.cursor.file) || !whole(data.cursor.bytes) || !whole(data.cursor.timestamp) || !whole(data.cursor.ordinal))) throw new Error();
    return data;
  } catch (cause) {
    if (cause.code === "ENOENT") return { version: 1, count: 0, calls: [], policy: {} };
    throw new Error("unavailable state");
  } finally { if (fd !== undefined) closeSync(fd); }
}

/** Bounded on-demand native worker decisions; active leader settings are unavailable through hook JSON. */
export async function decideCodexContext(input, { role, admission, codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex"), now = Date.now() } = {}) {
  const call = normalizeCodexContext(input, { role, admission });
  role = call.role;
  const proof = admission === undefined ? null : codexAdmissionOf(admission, input);
  const repository = realpathSync(checkoutRootOf(realpathSync(call.cwd)) ?? call.cwd);
  const directory = path.join(codexHome, "qc-role-budgets");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw new Error();
  const file = path.join(directory, `${hash(JSON.stringify([repository, call.session_id, role]))}.json`), lock = `${file}.lock`;
  let locked = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try { mkdirSync(lock); locked = true; break; }
    catch (cause) { if (cause.code !== "EEXIST") throw cause; await delay(10); }
  }
  if (!locked) throw new Error("unavailable state");
  try {
    const { readCodexUsage } = await import("./codex-usage-source.mjs");
    if (proof) codexAdmissionOf(admission, input); // Recheck liveness after waiting for the lock/import.
    const state = stored(file), key = hash(JSON.stringify([call.turn_id, call.tool_use_id]));
    const binding = proof ? hash(JSON.stringify([proof.repository, proof.worktree, proof.nativeThreadId, role, proof.incarnation])) : undefined;
    if (state.admission !== binding) {
      if (state.admission !== undefined || !proof || state.count > 0) throw new Error("unavailable admission state");
      state.admission = binding;
    }
    if (role !== "leader" && state.budget === undefined) {
      // A pre-snapshot worker's initial policy is unknown; never reload a weaker one.
      if (state.count > 0 || state.policy.budgetClosed) throw new Error("unavailable initial policy");
      state.budget = proof ? proof.budget : budgetsOf(load(repository))[role];
      if (!budgetSnapshot(state.budget)) throw new Error("unavailable initial policy");
    }
    if (!state.calls.includes(key)) {
      if (state.count === Number.MAX_SAFE_INTEGER) throw new Error();
      state.count++; state.calls = [...state.calls.slice(-63), key];
    }
    const sample = readCodexUsage(input, { role, admission, codexHome, now, previous: state.cursor });
    if (sample && state.root !== undefined && state.root !== hash(sample.rootSessionId)) throw new Error();
    if (sample) { state.cursor = sample.cursor; state.root = hash(sample.rootSessionId); }
    const verdict = role === "leader" ? null : decideCodexBudget(codexBudgetCall(call), {
      usage: sample?.usage, config: { budgets: { [role]: state.budget } }, count: state.count, state: state.policy,
    });
    let result = verdict;
    if (!result && !state.policy.budgetClosed && !state.noted && (role === "leader" || !sample)) {
      state.noted = true;
      result = { hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: role === "leader"
        ? "Codex context: active native settings unavailable; automatic compaction owns its threshold. Update the checkpoint at the next clean break. Leader threshold decisions remain unsupported."
        : "Codex context: verified current-turn usage unavailable; budget usage stays unknown. External workers require trusted runner registration." } };
    }
    if (JSON.stringify(state).length > 8192) throw new Error();
    writeState(file, state);
    return result;
  } finally { rmdirSync(lock); }
}

export async function runCodexContext(args, { stdin = process.stdin, write = console.log, error = console.error } = {}) {
  try {
    if (args.length !== 2 || args[0] !== "--role" || !["leader", "implementer", "reviewer"].includes(args[1])) throw new Error();
    let data = "";
    for await (const chunk of stdin) {
      data += chunk;
      if (Buffer.byteLength(data) > 65536) throw new Error();
    }
    write(JSON.stringify(await decideCodexContext(JSON.parse(data), { role: args[1] }) ?? {}));
    return 0;
  } catch {
    error("Codex context: unsupported input or unavailable state");
    return 2;
  }
}
