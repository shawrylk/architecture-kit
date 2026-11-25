import path from "node:path";
import { randomUUID, createHash } from "node:crypto";
import { realpathSync, statSync, constants, openSync, fstatSync, readSync, closeSync } from "node:fs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { spawnCommand } from "./spawn-command.mjs";
import { readCodexRolloutIdentity } from "./codex-rollout-identity.mjs";

const id = value => typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value);
const roles = ["leader", "implementer", "reviewer"];
const unavailable = () => { throw new Error("Codex invocation unavailable"); };
const settings = Object.freeze({ model_auto_compact_token_limit: 400000, model_post_turn_compact_threshold_percent: 0 });
const admissions = new WeakMap();
// Runner-owned cooperative worker boundary; these values are not native-event attestation.
export const CODEX_WORKER_FEATURES = Object.freeze(["features.multi_agent=false", "features.multi_agent_v2=false"]);
export const codexWorkerRestricted = env => Boolean(env.QC_CODEX_WORKER) ||
  ["worker", "implement", "implementer", "reviewer", "branch-reviewer", "planner", "scout", "tests", "review"].includes(env.QC_ROLE);
export const codexWorkerEnvironment = (env, role) => ({ ...env, QC_CODEX_WORKER: "1", QC_ROLE: role });
// Only exact runner-held reservations carry authority; serialized proofs cannot enroll themselves.
export function codexAdmissionOf(handle, input) {
  const proof = admissions.get(handle)?.(input);
  return proof ?? unavailable();
}

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

// H supplies a trusted native binary/version/digest pin; this checks drift, not its origin or launch atomicity.
function checkPin(executable, pin) {
  if (pin.version !== "0.172.0" || typeof pin.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(pin.sha256) || realpathSync(executable) !== pin.realpath) unavailable();
  const fd = openSync(pin.realpath, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = fstatSync(fd), hash = createHash("sha256"), buffer = Buffer.alloc(65536);
    if (!before.isFile() || before.size > 512 * 1024 * 1024) unavailable();
    for (let offset = 0; offset < before.size;) {
      const size = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - offset), offset);
      if (!size) unavailable();
      hash.update(buffer.subarray(0, size)); offset += size;
    }
    const after = fstatSync(fd), current = statSync(executable);
    if (hash.digest("hex") !== pin.sha256 || before.dev !== current.dev || before.ino !== current.ino ||
        before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs || realpathSync(executable) !== pin.realpath) unavailable();
    return `${before.dev}:${before.ino}:${before.size}:${before.mtimeMs}:${before.ctimeMs}`;
  } finally { closeSync(fd); }
}

/** Runner-private, in-memory authority. Never give this factory's result, reservations or hook
 * capabilities to a worker. Context delegates to the locked budget consumer without config reload.
 * A trusted hook bridge must retain the opaque capability outside the native process.
 * Proof means explicit CLI forwarding, NOT resolved active config (managed layers can win).
 * Source: Codex 0.172.0 / 3d86e43b075adeba2193ec5c22ac92f55afd82e6:
 * cli/src/main.rs:1130-1150,2226-2233; utils/cli/src/config_override.rs:26-40;
 * config/src/overrides.rs:8-12,61; config/src/loader/mod.rs:428-461;
 * core/src/config/mod.rs:640-648; exec/src/event_processor_with_jsonl_output.rs:388-391,588-600;
 * hooks/src/events/session_start.rs:20-47,119-127; exec/src/lib.rs:1787-1819.
 * Native root comes only from the selected local rollout header, never hook root/settings claims.
 * H/J must supply trusted pins, authenticate hook IPC and wire adoption; active settings stay unknown.
 */
export function createCodexRuntime({ worktree, executable, workflowId, config = {}, inheritedRole = "leader", capacity = 64, startupTimeoutMs = 5000, codexHome, executablePin } = {}) {
  if (!["linux", "darwin"].includes(process.platform)) throw new Error("Codex invocation: unsupported platform");
  let repository, executableIdentity;
  try {
    if (![worktree, executable].every(value => typeof value === "string" && value.length <= 4096 && path.isAbsolute(value))) unavailable();
    worktree = realpathSync(worktree);
    if (!statSync(worktree).isDirectory()) unavailable();
    repository = repositoryOf(worktree);
    // Absolute executable is runner-selected. No PATH resolution, shell, wrapper argv or profiles.
    executable = path.resolve(executable);
    if (executablePin !== undefined) {
      if (!executablePin || typeof executablePin.realpath !== "string" || executablePin.realpath.length > 4096 || !path.isAbsolute(executablePin.realpath)) unavailable();
      executablePin = Object.freeze({ realpath: executablePin.realpath, version: executablePin.version, sha256: executablePin.sha256 });
      executableIdentity = checkPin(executable, executablePin);
    }
  } catch { unavailable(); }
  if (!id(workflowId) || !roles.includes(inheritedRole) || !Number.isInteger(capacity) || capacity < 1 || capacity > 256 ||
      !Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1 || startupTimeoutMs > 30000) unavailable();
  const budgets = budgetsOf(config), policies = Object.fromEntries(roles.map(role => [role,
    (role === "leader" ? budgets.orchestrator : budgets[role]) === null ? null :
      Object.freeze({ ...(role === "leader" ? budgets.orchestrator : budgets[role]) })]));
  const records = new Map(), sessions = new Set();
  let admitted = 0;
  const get = handle => records.get(handle) ?? unavailable();
  const live = record => record.spawned && record.child.exitCode === null && record.child.signalCode === null;
  const retire = handle => {
    const record = records.get(handle);
    if (!record) return;
    records.delete(handle); admissions.delete(handle); clearTimeout(record.timer); record.cleanup?.();
    record.reject(new Error("Codex invocation unavailable"));
  }; // Persistent closure belongs to codex-context.
  const envelope = (record, credential, input) => {
    if (credential !== record.credential || !input || Object.keys(input).length > 16 ||
        Object.entries(input).some(([key, value]) => key.length > 128 || value !== null &&
          (typeof value !== "string" || value.length > 4096)) || Buffer.byteLength(JSON.stringify(input)) > 8192 ||
        input.hook_event_name !== "SessionStart" || input.source !== "startup" || !id(input.session_id) ||
        input.agent_id !== undefined || input.agent_type !== undefined || input.role !== undefined ||
        typeof input.cwd !== "string" || realpathSync(input.cwd) !== worktree || repositoryOf(worktree) !== repository) unavailable();
    return Object.freeze({ ...input });
  };
  const select = (record, input) => {
    const selected = input.transcript_path;
    if (selected !== undefined) {
      if (typeof selected !== "string" || selected.length > 4096 || !path.isAbsolute(selected) ||
          record.transcriptPath && record.transcriptPath !== selected) unavailable();
      record.transcriptPath = selected;
    }
  };
  const observe = (record, input, allowUnavailable = false) => {
    select(record, input);
    if (!record.transcriptPath) return record.proof;
    const evidence = readCodexRolloutIdentity({ transcriptPath: record.transcriptPath, checkout: worktree, threadId: record.threadId }, { codexHome });
    const previous = record.proof.identityProvenance;
    if (!evidence && allowUnavailable) return record.proof;
    if (previous && (!evidence || evidence.nativeRootSessionId !== record.proof.nativeRootSessionId ||
        evidence.fileIdentity.file !== previous.fileIdentity.file || evidence.source !== previous.source ||
        evidence.fileIdentity.timestamp !== previous.fileIdentity.timestamp || evidence.fileIdentity.ordinal !== previous.fileIdentity.ordinal)) unavailable();
    if (!evidence || evidence.source !== "exec") return record.proof;
    if (!previous) record.proof = Object.freeze({ ...record.proof, nativeRootSessionId: evidence.nativeRootSessionId,
      identityProvenance: Object.freeze({ ...evidence, fileIdentity: Object.freeze(evidence.fileIdentity) }) });
    return record.proof;
  };
  const correlate = (handle, record) => {
    if (record.pending && live(record) && record.threadId) {
      try { bind(handle, record.credential, record.pending); } catch { retire(handle); }
    }
  };
  const matches = (record, input) => input && id(input.session_id) && typeof input.cwd === "string" && input.cwd.length <= 4096 &&
    input.agent_id === undefined && input.agent_type === undefined && input.role === undefined &&
    realpathSync(input.cwd) === worktree && repositoryOf(worktree) === repository && record.proof?.nativeThreadId === input.session_id;
  function bind(handle, credential, input) {
    const record = get(handle);
    try {
      if (credential !== record.credential || !live(record) || input?.hook_event_name !== "SessionStart" || input.source !== "startup" ||
          !id(input.session_id) || input.session_id !== record.threadId || input.agent_id !== undefined || input.agent_type !== undefined || input.role !== undefined ||
          typeof input.cwd !== "string" || input.cwd.length > 4096 || realpathSync(input.cwd) !== worktree || repositoryOf(worktree) !== repository) unavailable();
      if (record.proof) { if (!matches(record, input)) unavailable(); return observe(record, input); }
      if (sessions.has(input.session_id)) unavailable();
      select(record, input);
      const proof = Object.freeze({ repository, worktree, workflowId, workflowParentId: record.workflowParentId,
        parentNativeRootSessionId: record.ancestor?.nativeRootSessionId ?? null,
        parentNativeThreadId: record.ancestor?.nativeThreadId ?? null,
        role: record.role, nativeRootSessionId: null, nativeThreadId: input.session_id,
        incarnation: record.incarnation, pid: record.child.pid, executable, executablePin: executablePin ?? null,
        settings: record.role === "leader" ? settings : null, settingsProvenance: "controlled-cli-forwarding",
        budget: policies[record.role] });
      sessions.add(input.session_id); record.proof = proof;
      observe(record, input); clearTimeout(record.timer); record.pending = null; record.resolve(record.proof);
      return record.proof;
    } catch { unavailable(); }
  }
  return Object.freeze({
    reserve(options) {
      if (!options || Object.keys(options).length > 3 || Object.keys(options).some(key => !["role", "workflowParentId", "parent"].includes(key))) unavailable();
      const { role, workflowParentId, parent } = options;
      if (!roles.includes(role) || !id(workflowParentId) || admitted >= 256 || records.size >= capacity ||
          inheritedRole !== "leader") unavailable();
      const ancestor = parent === undefined ? null : get(parent);
      if (ancestor && (!live(ancestor) || !ancestor.proof || ancestor.role !== "leader")) unavailable();
      const credential = Object.freeze(Object.create(null));
      const handle = Object.freeze(Object.defineProperty({}, "hookCredential", { value: credential }));
      const record = { role, workflowParentId, ancestor: ancestor?.proof ?? null, credential, incarnation: randomUUID() };
      record.ready = new Promise((resolve, reject) => { record.resolve = resolve; record.reject = reject; });
      record.ready.catch(() => {});
      record.timer = setTimeout(() => retire(handle), startupTimeoutMs); record.timer.unref();
      records.set(handle, record);
      admissions.set(handle, input => {
        const current = get(handle);
        return live(current) && matches(current, input) ? observe(current, input, true) : null;
      });
      admitted++;
      return handle;
    },
    launch(handle) {
      const record = get(handle);
      if (record.child) unavailable();
      // Generated command has no caller-supplied flags; conflicting flags are rejected at reserve.
      const args = ["exec", "-C", worktree, "--json", ...Object.entries(record.role === "leader" ? settings : {})
        .flatMap(([key, value]) => ["-c", `${key}=${value}`]),
      ...(record.role === "leader" ? [] : CODEX_WORKER_FEATURES.flatMap(feature => ["-c", feature])), "-"];
      try {
        if (executablePin && checkPin(executable, executablePin) !== executableIdentity) unavailable();
        const child = spawnCommand(executablePin?.realpath ?? executable, args, { cwd: worktree,
          env: record.role === "leader" ? process.env : codexWorkerEnvironment(process.env, record.role), stdio: ["pipe", "pipe", "pipe"] });
        record.child = child;
        let pending = "";
        const capture = chunk => {
          try {
            const newline = chunk.indexOf("\n");
            pending += newline < 0 ? chunk : chunk.slice(0, newline);
            if (Buffer.byteLength(pending) > 8192) unavailable();
            if (newline < 0) return;
            const event = JSON.parse(pending);
            if (event.type !== "thread.started" || !id(event.thread_id)) unavailable();
            record.threadId = event.thread_id; correlate(handle, record);
          } catch { retire(handle); }
          pending = ""; child.stdout.removeListener("data", capture);
        };
        child.stdout.setEncoding("utf8"); child.stdout.on("data", capture);
        const spawned = () => {
          record.spawned = true;
          if (records.has(handle)) correlate(handle, record); else record.cleanup();
        }, ended = () => { record.processEnded = true; retire(handle); record.cleanup(); };
        record.cleanup = () => {
          pending = ""; record.pending = null; child.stdout.off("data", capture);
          child.off("exit", ended);
          // Drain the already queued spawn/error before removing its last error handler on early cancellation.
          if (record.spawned || record.processEnded) { child.off("spawn", spawned); child.off("error", ended); }
        };
        child.once("spawn", spawned); child.once("error", ended); child.once("exit", ended);
        return child;
      } catch { retire(handle); unavailable(); }
    },
    // Acknowledge the hook immediately. Only the runner awaits ready(), after returning the hook response.
    startup(handle, credential, input) {
      const record = get(handle), accepted = envelope(record, credential, input);
      if (record.proof) bind(handle, credential, accepted);
      else {
        if (record.pending && JSON.stringify(record.pending) !== JSON.stringify(accepted)) unavailable();
        record.pending = accepted; correlate(handle, record);
      }
      return true;
    },
    ready(handle) { return get(handle).ready; },
    async context(handle, input) {
      get(handle); // Reject sibling reservations even if another registry recognizes them.
      const { decideCodexContext } = await import("./codex-context.mjs");
      return decideCodexContext(input, { admission: handle, codexHome });
    },
    bind,
    validate(handle, input) {
      try { const record = get(handle); return live(record) && matches(record, input) ? observe(record, input) : null; }
      catch { return null; }
    },
    terminal(handle) { get(handle); retire(handle); },
  });
}
