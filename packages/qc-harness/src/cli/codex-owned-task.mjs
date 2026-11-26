import { createOwnedUsageSource, applyOwnedUsageReceipt } from "./codex-usage-source.mjs";

import { normalizeCodexContext } from "./codex-context.mjs";
import { codexAdmissionOf, codexTerminationOf } from "./codex-runtime.mjs";
import { codexChannelRetirementOf } from "./codex-bridge.mjs";
import { budgetsOf } from "./context-budgets.mjs";
import { createHash } from "node:crypto";

// Whole logical-task capacity: never evict/recharge. Successor mapping remains unsupported.
const MAX_CALLS = 128, MAX_CALL_BYTES = 8192;
const digest = value => createHash("sha256").update(value).digest("hex");
const tasks = new WeakMap(), boundAdmissions = new WeakSet();
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// These callbacks remain in trusted runner/dispatch closures; diagnostic copies confer no authority.
export function prepareOwnedTask(inputs, observe = () => {}) {
  const handle = Object.freeze({});
  const record = { inputs: freeze(structuredClone(inputs)), state: "prepared", generation: 1, native: null, exit: null };
  tasks.set(handle, record);
  let child, nativeProof, accepting = false, usageSource, retirement;
  const usageBinding = Object.freeze({}), responses = new Map();
  let total = null, refusalReason = null, nativeAdmission;
  const originalBudgets = record.inputs.config === undefined ? null : freeze(budgetsOf(record.inputs.config));
  let policy = freeze({ status: "unknown", role: null, budget: null });
  const calls = new Map();
  const read = candidate => {
    if (candidate !== handle || tasks.get(candidate) !== record) throw Error("Logical task capability refused");
    return freeze({ inputs: record.inputs, state: record.state, generation: record.generation, admission: record.admission, native: record.native, exit: record.exit, counter: { count: calls.size, calls: [...calls.keys()], capacity: MAX_CALLS, policy }, usage: { total, consumptionComplete: null, currentContext: null, refusalReason } });
  };
  const publish = () => observe(read(handle));
  const reject = () => {
    if (!["completed", "terminal-rejected"].includes(record.state)) { record.state = "terminal-rejected"; publish(); }
  };
  const check = (state, candidate = handle, generation = 1) => {
    try {
      read(candidate);
      if (generation !== record.generation) throw Error("Logical task generation refused");
      if (record.state !== state) throw Error("Logical task state refused");
      if (!Number.isFinite(record.inputs.deadline) || Date.now() >= record.inputs.deadline) throw Error("Logical task deadline refused");
    } catch (error) { reject(); throw error; }
  };
  const move = state => { record.state = state; publish(); };
  const exited = () => {
    if (record.exit.code !== 0 || record.exit.signal) reject();
    else if (record.state === "running") move("observed-exit");
  };
  publish();
  return Object.freeze({ handle, read, reject,
    bindRetirement(reservation, bridge) {
      if (retirement) throw Error("Logical task retirement already bound");
      if (!child || !nativeProof || !nativeAdmission || reservation !== nativeAdmission)
        throw Error("Logical task original retirement binding refused");
      // Both accessors verify private original identities, even after live admission revocation.
      const process = codexTerminationOf(reservation, nativeProof, child);
      const channel = codexChannelRetirementOf(bridge, reservation, nativeProof, child);
      retirement = Object.freeze({ process, channel });
    },
    readRetirement(candidate) {
      read(candidate); // Capability only: safety observation never checks acceptance state/deadline.
      const process = retirement?.process() ?? null, channel = retirement?.channel() ?? null;
      const state = !process || !channel || process.processError && (!process.exit || !process.close) ? "unknown" :
        process.exit && process.close && channel.state === "confirmed" ? "confirmed" : "pending";
      return freeze({ scope: "original-child-process-and-stdio+original-launched-report-channel", state, process, channel });
    },
    recordCall(input, admission = nativeAdmission) {
      try {
        check("running");
        if (!nativeAdmission || admission !== nativeAdmission || codexAdmissionOf(admission, input) !== nativeProof)
          throw Error("Logical task native call binding refused");
        const call = normalizeCodexContext(input, { admission });
        if (policy.status === "unknown") throw Error("Logical task policy UNKNOWN/refused");
        if (typeof call.tool_name !== "string" || !/^[A-Za-z0-9_-]{1,128}$/.test(call.tool_name))
          throw Error("Logical task native call data refused");
        // Canonical bounded JSON; retain digests only, never tool payloads or caller diagnostics.
        const encoded = JSON.stringify(call.tool_input ?? null);
        if (Buffer.byteLength(encoded) > MAX_CALL_BYTES) throw Error("Logical task native call data capacity refused");
        const canonical = value => value && typeof value === "object" ? Array.isArray(value) ? value.map(canonical) :
          Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
        const key = digest(call.tool_use_id), data = digest(JSON.stringify([
          call.session_id, call.turn_id, call.tool_name, canonical(JSON.parse(encoded)),
        ]));
        if (calls.has(key)) {
          if (calls.get(key) !== data) throw Error("Logical task native call identity conflict");
          return calls.size;
        }
        if (calls.size >= MAX_CALLS) throw Error("Logical task native call capacity exhausted");
        calls.set(key, data); publish(); return calls.size;
      } catch (error) { reject(); throw error; }
    },
    recordUsage(input, options) {
      try {
        check("running");
        usageSource ??= createOwnedUsageSource(input, { ...options, proof: nativeProof }, usageBinding);
        return applyOwnedUsageReceipt(usageSource(input, options), usageBinding, deltas => {
          const pending = new Map(responses), sum = { ...total };
          for (const { identity, usage } of deltas) {
            const encoded = JSON.stringify(usage);
            if (pending.has(identity)) {
              if (pending.get(identity) !== encoded) throw Error("Owned usage response conflict");
              continue;
            }
            if (pending.size >= 128) throw Error("Owned usage capacity exhausted");
            for (const [key, value] of Object.entries(usage)) {
              const next = (sum[key] ?? 0) + value;
              if (!Number.isSafeInteger(next)) throw Error("Owned usage overflow");
              sum[key] = next;
            }
            pending.set(identity, encoded);
          }
          responses.clear(); for (const [key, value] of pending) responses.set(key, value);
          total = freeze(sum); return total;
        });
      } catch (error) {
        if (!["completed", "terminal-rejected"].includes(record.state)) refusalReason = error.message;
        reject(); throw error;
      }
    },
    admit(candidate, generation, admission) {
      if (candidate !== handle || generation !== record.generation) { reject(); throw Error("Logical task capability/generation refused"); }
      check("prepared", candidate, generation);
      record.admission = freeze(structuredClone(admission)); move("admitted");
    },
    checkExit: () => check("observed-exit"),
    watch(ownedChild) {
      check("admitted");
      if (child) { reject(); throw Error("Logical task child already bound"); }
      child = ownedChild;
      child.once("exit", (code, signal) => {
        record.exit = freeze({ code, signal });
        exited();
      });
    },
    running(proof, admission) {
      check("admitted");
      if (!child || nativeProof || proof.pid !== child.pid) { reject(); throw Error("Logical task native binding refused"); }
      if (admission !== undefined) {
        try {
          let actual;
          try { actual = codexAdmissionOf(admission, { cwd: proof.worktree, session_id: proof.nativeThreadId }); }
          catch { throw Error("Logical task native binding refused"); }
          if (actual !== proof ||
              !["leader", "implementer", "reviewer"].includes(proof.role)) throw Error("Logical task native binding refused");
          if (boundAdmissions.has(admission)) throw Error("Logical task native admission already owned");
          if (originalBudgets) {
            const budget = originalBudgets[proof.role === "leader" ? "orchestrator" : proof.role];
            if (JSON.stringify(budget) !== JSON.stringify(proof.budget)) throw Error("Logical task original policy mismatch");
            policy = freeze({ status: budget === null ? "disabled" : "configured", role: proof.role, budget });
          }
          boundAdmissions.add(admission); nativeAdmission = admission;
        } catch (error) { reject(); throw error; }
      }
      nativeProof = proof;
      record.native = freeze(structuredClone(nativeProof));
      move("running");
      if (record.exit) exited();
    },
    async complete(acceptOriginal) {
      try {
        check("observed-exit");
        if (accepting) throw Error("Logical task acceptance already pending");
        accepting = true;
        await acceptOriginal();
        // Dispatch checks the deadline before publishing its authoritative stop.
        if (record.state !== "observed-exit") throw Error("Logical task state refused");
        move("completed");
      } catch (error) { reject(); throw error; }
    },
  });
}
