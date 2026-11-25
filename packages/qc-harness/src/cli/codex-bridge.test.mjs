import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createCodexBridge, reportCodexHook } from "./codex-bridge.mjs";

const startup = { hook_event_name: "SessionStart", source: "startup", cwd: process.cwd(), session_id: "thread",
  transcript_path: null, model: "fixture", permission_mode: "default" };
test("subprocess client acknowledges startup without waiting for runner readiness", async t => {
  const reservation = { hookCredential: {} };
  let accepted;
  const runtime = { startup(handle, credential, input) {
    assert.equal(handle, reservation); assert.equal(credential, reservation.hookCredential); accepted = input;
  } };
  const bridge = await createCodexBridge({ runtime, reservation });
  t.after(() => bridge.close());
  const code = `import { reportCodexHook } from ${JSON.stringify(new URL("./codex-bridge.mjs", import.meta.url).href)};
    console.log(JSON.stringify(await reportCodexHook(${JSON.stringify(startup)})));`;
  const child = spawn(process.execPath, ["--input-type=module", "-e", code], { env: { ...process.env, ...bridge.env } });
  let output = ""; child.stdout.on("data", data => { output += data; });
  assert.equal((await once(child, "exit"))[0], 0);
  assert.equal(JSON.parse(output), null);
  assert.deepEqual(accepted, startup);
  assert.equal(JSON.stringify(bridge.env).includes("hookCredential"), false);
});

test("invocation channels reject missing and sibling credentials, unsupported and oversized reports", async t => {
  let calls = 0;
  const options = { runtime: { startup() { calls++; } }, reservation: { hookCredential: {} } };
  const bridge = await createCodexBridge(options), sibling = await createCodexBridge(options);
  t.after(() => Promise.all([bridge.close(), sibling.close()]));
  const send = (input, env = bridge.env) => reportCodexHook(input, { env });
  for (const env of [{}, { ...bridge.env, QC_CODEX_REPORT_TOKEN: "wrong" },
    { ...bridge.env, QC_CODEX_REPORT_TOKEN: sibling.env.QC_CODEX_REPORT_TOKEN }])
    await assert.rejects(send(startup, env), /unavailable/);
  for (const input of [null, [], { ...startup, role: "leader" }, { ...startup, proof: {} },
    { ...startup, hook_event_name: "PreToolUse" }, { ...startup, source: "resume" },
    { ...startup, model: "x".repeat(70000) }]) await assert.rejects(send(input), /unavailable/);
  assert.equal(calls, 0);
  assert.equal(await send(startup), null);
  assert.equal(calls, 1);
  await bridge.close();
  await assert.rejects(send(startup), /unavailable/);
});

test("blocking runtime errors stay secret-free and never become acknowledgments", async t => {
  const bridge = await createCodexBridge({ runtime: { startup() { throw Error("private credential"); } }, reservation: {} });
  t.after(() => bridge.close());
  await assert.rejects(reportCodexHook(startup, { env: bridge.env }), error =>
    /unavailable/.test(error.message) && !/private/.test(error.message));
});

test("raw transport bounds bytes, UTF-8, malformed frames, idle sockets and concurrent connections", async t => {
  const net = await import("node:net");
  let calls = 0;
  const bridge = await createCodexBridge({ runtime: { startup() { calls++; } }, reservation: {}, timeoutMs: 100, maxConnections: 1 });
  t.after(() => bridge.close());
  const connect = async () => {
    const socket = net.createConnection({ host: "127.0.0.1", port: Number(bridge.env.QC_CODEX_REPORT_PORT) });
    socket.on("error", () => {}); await once(socket, "connect"); return socket;
  };
  const frame = JSON.stringify({ token: bridge.env.QC_CODEX_REPORT_TOKEN, input: startup });
  for (const body of ["{", frame + frame, Buffer.from([0xff]), "x".repeat(65537),
    JSON.stringify({ token: bridge.env.QC_CODEX_REPORT_TOKEN, input: { ...startup, model: {} } }),
    JSON.stringify({ token: bridge.env.QC_CODEX_REPORT_TOKEN, input: startup, role: "leader" })]) {
    const socket = await connect(), closed = once(socket, "close");
    socket.resume(); socket.end(body); await closed;
  }
  const idle = await connect(), ended = once(idle, "close"); idle.resume();
  await assert.rejects(reportCodexHook(startup, { env: bridge.env }), /unavailable/);
  await ended;
  idle.end(frame); // Late bytes cannot produce a startup after the absolute receive deadline.
  assert.equal(calls, 0);
  assert.equal(await reportCodexHook(startup, { env: bridge.env }), null);
  assert.equal(calls, 1);
});

test("runner cancellation closes idle endpoints and removes abort listeners", async t => {
  const { getEventListeners } = await import("node:events"), net = await import("node:net");
  const controller = new AbortController();
  const bridge = await createCodexBridge({ runtime: {}, reservation: {}, signal: controller.signal });
  t.after(() => bridge.close());
  const socket = net.createConnection({ host: "127.0.0.1", port: Number(bridge.env.QC_CODEX_REPORT_PORT) });
  socket.on("error", () => {}); socket.resume(); await once(socket, "connect");
  const closed = once(socket, "close"); controller.abort(); await closed; await bridge.close();
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  assert.throws(() => bridge.ready(), /unavailable/);
  await assert.rejects(reportCodexHook(startup, { env: bridge.env }), /unavailable/);
  await assert.rejects(createCodexBridge({ runtime: {}, reservation: {}, signal: controller.signal }), /unavailable/);
});

test("client deadlines, cancellation, response bounds and late replies fail closed and clean up", async t => {
  const net = await import("node:net"), { getEventListeners } = await import("node:events");
  const sockets = new Set();
  let mode = "idle";
  const server = net.createServer({ allowHalfOpen: true }, socket => {
    sockets.add(socket); socket.on("error", () => {}); socket.once("close", () => sockets.delete(socket));
    socket.on("data", () => {});
    socket.once("end", () => {
      if (mode === "large") socket.end("x".repeat(65537));
      if (mode === "bad") socket.end('{"ok":true,"role":"leader"}');
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise(resolve => server.close(resolve)); });
  const env = { QC_CODEX_REPORT_PORT: String(server.address().port), QC_CODEX_REPORT_TOKEN: "a".repeat(64) };
  await assert.rejects(reportCodexHook(startup, { env, timeoutMs: 25 }), /unavailable/);
  const controller = new AbortController();
  const pending = reportCodexHook(startup, { env, signal: controller.signal }); controller.abort();
  await assert.rejects(pending, /unavailable/);
  assert.equal(getEventListeners(controller.signal, "abort").length, 0);
  for (const socket of sockets) socket.end('{"ok":true}');
  for (mode of ["large", "bad"]) await assert.rejects(reportCodexHook(startup, { env }), /unavailable/);
  await assert.rejects(reportCodexHook(startup, { env, signal: controller.signal }), /unavailable/);
  for (const timeoutMs of [0, 30001, NaN]) await assert.rejects(reportCodexHook(startup, { env, timeoutMs }), /unavailable/);
  for (const maxConnections of [0, 17, NaN]) await assert.rejects(createCodexBridge({ runtime: {}, reservation: {}, maxConnections }), /unavailable/);
});

test("async routing is exclusive; cancellation rejects and the deadline retires before late allow", { timeout: 3000 }, async t => {
  let release, entered, observed, completed;
  const done = new Promise(resolve => { completed = resolve; });
  const started = new Promise(resolve => { entered = resolve; });
  const controller = new AbortController();
  const runtime = { startup() {}, ready: () => null, async hook(handle, input, active) {
    entered(); await new Promise(resolve => { release = resolve; });
    observed = active(); completed(); return { hookSpecificOutput: { permissionDecision: "allow" } };
  } };
  const bridge = await createCodexBridge({ runtime, reservation: {}, timeoutMs: 100 }); t.after(() => bridge.close());
  const input = { ...startup, hook_event_name: "PreToolUse" };
  const pending = reportCodexHook(input, { env: bridge.env, signal: controller.signal });
  const rejected = assert.rejects(pending, /unavailable/); await started;
  await assert.rejects(reportCodexHook(input, { env: bridge.env }), /unavailable/);
  controller.abort(); await rejected;
  // The absolute routing deadline retires an abandoned decision and its endpoint.
  await bridge.closed;
  release(); await done;
  assert.equal(observed, false);
  assert.throws(() => bridge.ready(), /unavailable/);
  await assert.rejects(reportCodexHook(startup, { env: bridge.env }), /unavailable/);
});

test("absolute decision deadline refuses completion even when synchronous work delays timers", async t => {
  const runtime = { hook() {
    const until = performance.now() + 30;
    while (performance.now() < until) { /* Exercise a delayed timer, not a cooperative async wait. */ }
    return null;
  } };
  const bridge = await createCodexBridge({ runtime, reservation: {}, timeoutMs: 10 }); t.after(() => bridge.close());
  await assert.rejects(reportCodexHook({ ...startup, hook_event_name: "PreToolUse" }, { env: bridge.env }), /unavailable/);
});
