import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { prepareOwnedTask } from "./codex-owned-task.mjs";

const inputs = () => ({ deadline: Date.now() + 60000, policy: { budgets: [100, 200] }, boundary: { head: "initial" } });
const childOf = () => Object.assign(new EventEmitter(), { pid: 123, exitCode: null, signalCode: null });
function running() {
  const task = prepareOwnedTask(inputs()), child = childOf();
  task.admit(task.handle, 1); task.watch(child);
  task.running({ pid: child.pid, executablePin: { sha256: "actual" } });
  return { task, child };
}
test("opaque task identity and deep snapshot survive caller mutation without foreign authority", () => {
  const original = inputs(), a = prepareOwnedTask(original), b = prepareOwnedTask(inputs());
  original.policy.budgets[0] = 999; original.boundary.head = "changed";
  assert.deepEqual(a.read(a.handle).inputs.policy.budgets, [100, 200]);
  assert.equal(a.read(a.handle).inputs.boundary.head, "initial");
  assert.throws(() => a.read(a.handle).inputs.policy.budgets.push(300), TypeError);
  for (const handle of [{ ...a.handle }, JSON.parse(JSON.stringify(a.handle)), b.handle, null, undefined]) {
    assert.throws(() => a.read(handle), /capability/);
    const fresh = prepareOwnedTask(inputs());
    assert.throws(() => fresh.admit(handle, 1), /capability/);
    assert.equal(fresh.read(fresh.handle).state, "terminal-rejected");
  }
  assert.equal(b.read(b.handle).state, "prepared");
});
test("generation, duplicate admission and deadline cannot create another attempt", () => {
  for (const generation of [0, 2]) {
    const task = prepareOwnedTask(inputs());
    assert.throws(() => task.admit(task.handle, generation), /generation/);
    assert.equal(task.read(task.handle).state, "terminal-rejected");
  }
  const task = prepareOwnedTask(inputs()); task.admit(task.handle, 1);
  assert.throws(() => task.admit(task.handle, 1), /state/);
  assert.equal(task.read(task.handle).state, "terminal-rejected");
  const expired = prepareOwnedTask({ ...inputs(), deadline: 1 });
  assert.throws(() => expired.admit(expired.handle, 1), /deadline/);
});
test("only the observed child exit permits private acceptance, once", async () => {
  const early = running();
  await assert.rejects(early.task.complete(() => assert.fail("early acceptance")), /state/);
  for (const [code, signal] of [[6, null], [null, "SIGTERM"]]) {
    const { task, child } = running(); child.emit("exit", code, signal);
    await assert.rejects(task.complete(() => assert.fail("bad exit accepted")));
    assert.equal(task.read(task.handle).state, "terminal-rejected");
  }
  const { task, child } = running();
  child.exitCode = 0;
  await assert.rejects(task.complete(() => assert.fail("properties are not an exit witness")));
  const good = running(); good.child.emit("exit", 0, null);
  await good.task.complete(async () => {});
  assert.equal(good.task.read(good.task.handle).state, "completed");
  await assert.rejects(good.task.complete(() => assert.fail("duplicate acceptance")));
  assert.throws(() => good.task.admit(good.task.handle, 1));
  assert.equal(good.task.read(good.task.handle).state, "completed");
  const rejected = running(); rejected.child.emit("exit", 0, null);
  await assert.rejects(rejected.task.complete(async () => { throw Error("original guard"); }), /original guard/);
  assert.equal(rejected.task.read(rejected.task.handle).state, "terminal-rejected");
});
test("native proof binds once, independent tasks and concurrent acceptance stay closed", async () => {
  const a = running(), b = running();
  assert.throws(() => a.task.running({ pid: 123 }), /state/);
  b.child.emit("exit", 0, null); await b.task.complete(async () => {});
  assert.equal(a.task.read(a.task.handle).state, "terminal-rejected");
  assert.equal(b.task.read(b.task.handle).state, "completed");
  const c = running(); c.child.emit("exit", 0, null);
  let release;
  const finishing = c.task.complete(() => new Promise(resolve => { release = resolve; }));
  await assert.rejects(c.task.complete(() => assert.fail("second acceptance")));
  release(); await assert.rejects(finishing);
  assert.equal(c.task.read(c.task.handle).state, "terminal-rejected");
});
test("deadline cannot reject an already committed original acceptance", async t => {
  const { task, child } = running(), deadline = task.read(task.handle).inputs.deadline;
  child.emit("exit", 0, null);
  t.mock.method(Date, "now", () => deadline - 1);
  await task.complete(() => { t.mock.method(Date, "now", () => deadline); });
  assert.equal(task.read(task.handle).state, "completed");
});

test("usage authority is unavailable without an actual native admission", () => {
  const { task } = running();
  assert.throws(() => task.recordUsage({}, { admission: {} }), /usage|Usage/);
  assert.equal(task.read(task.handle).state, "terminal-rejected");
});
