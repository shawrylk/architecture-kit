import { createOwnedUsageSource, applyOwnedUsageReceipt } from "./codex-usage-source.mjs";

const tasks = new WeakMap();
const freeze = value => {
  if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); }
  return value;
};

// These callbacks remain in trusted runner/dispatch closures; diagnostic copies confer no authority.
export function prepareOwnedTask(inputs, observe = () => {}) {
  const handle = Object.freeze({});
  const record = { inputs: freeze(structuredClone(inputs)), state: "prepared", generation: 1, native: null, exit: null };
  tasks.set(handle, record);
  let child, nativeProof, accepting = false, usageSource;
  const usageBinding = Object.freeze({}), responses = new Map();
  let total = null;
  const read = candidate => {
    if (candidate !== handle || tasks.get(candidate) !== record) throw Error("Logical task capability refused");
    return freeze({ inputs: record.inputs, state: record.state, generation: record.generation, admission: record.admission, native: record.native, exit: record.exit, usage: { total, currentContext: null } });
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
      } catch (error) { reject(); throw error; }
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
    running(proof) {
      check("admitted");
      if (!child || nativeProof || proof.pid !== child.pid) { reject(); throw Error("Logical task native binding refused"); }
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
