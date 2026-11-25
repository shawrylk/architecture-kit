import path from "node:path";
import { randomUUID } from "node:crypto";
import { realpathSync, statSync, constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { spawnCommand } from "./spawn-command.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const roles = ["leader", "implementer", "reviewer"];
const unavailable = () => { throw new Error("Codex invocation unavailable"); };
const settings = Object.freeze({ model_auto_compact_token_limit: 400000, model_post_turn_compact_threshold_percent: 0 });

// commonDirOf reads unbounded metadata; this boundary permits two regular files, 4096 bytes each.
function metadata(file) {
  const fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd), buffer = Buffer.alloc(4097);
    if (!stat.isFile() || stat.size > 4096) unavailable();
    const size = readSync(fd, buffer, 0, buffer.length, 0);
    if (size !== stat.size) unavailable();
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, size)).trim();
  } finally { closeSync(fd); }
}
function repositoryOf(worktree) {
  const root = checkoutRootOf(worktree);
  if (root !== worktree) unavailable();
  let common = path.join(root, ".git");
  if (!statSync(common).isDirectory()) {
    const match = /^gitdir: ([^\r\n]+)$/.exec(metadata(common));
    if (!match) unavailable();
    const gitdir = path.resolve(root, match[1]);
    common = path.resolve(gitdir, metadata(path.join(gitdir, "commondir")));
  }
  if (!statSync(common).isDirectory()) unavailable();
  return realpathSync(common);
}

/** Runner-private, in-memory authority. Never give this factory's result, reservations or hook
 * capabilities to a worker. No CLI, disk credentials, config reload, budget decisions or closure
 * writes. A trusted hook bridge must retain the opaque capability outside the native process.
 * Proof means explicit CLI forwarding, NOT resolved active config (managed layers can win).
 * Source: Codex 0.172.0 / 3d86e43b075adeba2193ec5c22ac92f55afd82e6:
 * cli/src/main.rs:1130-1150,2226-2233; utils/cli/src/config_override.rs:26-40;
 * config/src/overrides.rs:8-12,61; config/src/loader/mod.rs:428-461;
 * core/src/config/mod.rs:640-648; exec/src/event_processor_with_jsonl_output.rs:388-391,588-600;
 * hooks/src/events/session_start.rs:20-47,119-127; exec/src/lib.rs:1787-1819.
 * Native root session is deliberately unknown: neither CLI event exposes it. H/J must bind it
 * from verified native provenance, pin the executable, authenticate hook IPC and wire consumers.
 */
export function createCodexRuntime({ worktree, executable, workflowId, config = {}, inheritedRole = "leader", capacity = 64 } = {}) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Codex invocation: unsupported platform");
  let repository;
  try {
    if (![worktree, executable].every(value => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value))) unavailable();
    worktree = realpathSync(worktree);
    if (!statSync(worktree).isDirectory()) unavailable();
    repository = repositoryOf(worktree);
    // Absolute executable is runner-selected. No PATH resolution, shell, wrapper argv or profiles.
    executable = path.resolve(executable);
  } catch { unavailable(); }
  if (!id(workflowId) || !roles.includes(inheritedRole) || !Number.isInteger(capacity) || capacity < 1 || capacity > 256) unavailable();
  const budgets = budgetsOf(config), policies = Object.fromEntries(roles.map(role => [role,
    (role === "leader" ? budgets.orchestrator : budgets[role]) === null ? null :
      Object.freeze({ ...(role === "leader" ? budgets.orchestrator : budgets[role]) })]));
  const records = new Map(), sessions = new Set();
  let admitted = 0;
  const get = handle => records.get(handle) ?? unavailable();
  const live = record => record.spawned && record.child.exitCode === null && record.child.signalCode === null;
  const retire = handle => { records.delete(handle); }; // Persistent closure belongs to codex-context.
  const matches = (record, input) => input && id(input.session_id) && typeof input.cwd === "string" && input.cwd.length <= 4096 &&
    input.agent_id === undefined && input.agent_type === undefined && input.role === undefined &&
    realpathSync(input.cwd) === worktree && repositoryOf(worktree) === repository && record.proof?.nativeThreadId === input.session_id;
  return Object.freeze({
    reserve(options) {
      if (!options || Object.keys(options).length > 3 || Object.keys(options).some(key => !["role", "workflowParentId", "parent"].includes(key))) unavailable();
      const { role, workflowParentId, parent } = options;
      if (!roles.includes(role) || !id(workflowParentId) || admitted >= 256 || records.size >= capacity ||
          inheritedRole !== "leader" && role !== inheritedRole) unavailable();
      const ancestor = parent === undefined ? null : get(parent);
      if (ancestor && (!live(ancestor) || !ancestor.proof || ancestor.role !== "leader" && role !== ancestor.role)) unavailable();
      const credential = Object.freeze(Object.create(null));
      const handle = Object.freeze(Object.defineProperty({}, "hookCredential", { value: credential }));
      records.set(handle, { role, workflowParentId, ancestor: ancestor?.proof ?? null, credential, incarnation: randomUUID() });
      admitted++;
      return handle;
    },
    launch(handle) {
      const record = get(handle);
      if (record.child) unavailable();
      // Generated command has no caller-supplied flags; conflicting flags are rejected at reserve.
      const args = ["exec", "-C", worktree, "--json", ...Object.entries(record.role === "leader" ? settings : {})
        .flatMap(([key, value]) => ["-c", `${key}=${value}`]), "-"];
      try {
        const child = spawnCommand(executable, args, { cwd: worktree, stdio: ["pipe", "pipe", "pipe"] });
        record.child = child;
        let pending = "";
        const capture = chunk => {
          try {
            pending += chunk;
            if (Buffer.byteLength(pending) > 8192) unavailable();
            const newline = pending.indexOf("\n");
            if (newline < 0) return;
            const event = JSON.parse(pending.slice(0, newline));
            if (event.type !== "thread.started" || !id(event.thread_id)) unavailable();
            record.threadId = event.thread_id;
          } catch { retire(handle); }
          pending = ""; child.stdout.removeListener("data", capture);
        };
        child.stdout.setEncoding("utf8"); child.stdout.on("data", capture);
        child.once("spawn", () => { record.spawned = true; });
        child.once("error", () => retire(handle));
        child.once("exit", () => retire(handle));
        return child;
      } catch { retire(handle); unavailable(); }
    },
    bind(handle, credential, input) {
      const record = get(handle);
      try {
        if (credential !== record.credential || !live(record) || input?.hook_event_name !== "SessionStart" || input.source !== "startup" ||
            !id(input.session_id) || input.session_id !== record.threadId || input.agent_id !== undefined || input.agent_type !== undefined || input.role !== undefined ||
            typeof input.cwd !== "string" || input.cwd.length > 4096 || realpathSync(input.cwd) !== worktree || repositoryOf(worktree) !== repository) unavailable();
        if (record.proof) { if (!matches(record, input)) unavailable(); return record.proof; }
        if (sessions.has(input.session_id)) unavailable();
        const proof = Object.freeze({ repository, worktree, workflowId, workflowParentId: record.workflowParentId,
          parentNativeRootSessionId: record.ancestor?.nativeRootSessionId ?? null,
          parentNativeThreadId: record.ancestor?.nativeThreadId ?? null,
          role: record.role, nativeRootSessionId: null, nativeThreadId: input.session_id,
          incarnation: record.incarnation, pid: record.child.pid, executable,
          settings: record.role === "leader" ? settings : null, settingsProvenance: "controlled-cli-forwarding",
          budget: policies[record.role] });
        sessions.add(input.session_id); record.proof = proof;
        return proof;
      } catch { unavailable(); }
    },
    validate(handle, input) {
      try { const record = get(handle); return live(record) && matches(record, input) ? record.proof : null; }
      catch { return null; }
    },
    terminal(handle) { get(handle); retire(handle); },
  });
}
