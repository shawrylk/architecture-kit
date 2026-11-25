import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, symlinkSync, truncateSync, mkdirSync, realpathSync, readFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { spawnSync } from "node:child_process";
import { pinCodexNativeExecutable } from "./codex-native-executable.mjs";

const inherited = { QC_ROLE: process.env.QC_ROLE, QC_CODEX_WORKER: process.env.QC_CODEX_WORKER };
delete process.env.QC_ROLE; delete process.env.QC_CODEX_WORKER;
after(() => { for (const [key, value] of Object.entries(inherited)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } });
const supported = ["linux", "darwin"].includes(process.platform);
function fixture(t) {
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "qc-native-")));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const source = path.join(dir, "fixture.c"), executable = path.join(dir, "codex");
  writeFileSync(source, `#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
int main(int argc, char **argv) {
  if (argc > 1 && !strcmp(argv[1], "--version")) {
    if (getenv("FIXTURE_WAIT")) sleep(3);
    if (getenv("FIXTURE_REPLACE")) rename(getenv("FIXTURE_REPLACE"), argv[0]);
    const char *v = getenv("FIXTURE_VERSION"); puts(v ? v : "codex-cli 0.172.0"); return getenv("FIXTURE_FAIL") ? 1 : 0;
  }
  char prompt[128]; if (!fgets(prompt, sizeof(prompt), stdin)) return 1;
  puts("{\\"type\\":\\"thread.started\\",\\"thread_id\\":\\"native-thread\\"}");
  printf("%s%s\\n%s\\n", prompt, getenv("QC_ROLE"), getenv("QC_CODEX_WORKER"));
  for (int i = 1; i < argc; i++) puts(argv[i]);
  puts("QC_FIXTURE_DONE"); fflush(stdout); for (;;) pause();
}
`);
  const built = spawnSync("cc", [source, "-o", executable], { encoding: "utf8" });
  if (built.error?.code === "ENOENT") { t.skip("native subprocess fixture requires cc"); return; }
  assert.equal(built.status, 0, built.stderr);
  return { dir, executable };
}
test("pin selects the canonical native file from the runner PATH and probes that exact file", { skip: !supported }, t => {
  const f = fixture(t); if (!f) return;
  const alias = path.join(f.dir, "alias"); symlinkSync(f.executable, alias);
  const env = { ...process.env, PATH: f.dir };
  const pin = pinCodexNativeExecutable({ command: "alias", cwd: f.dir, env });
  assert.equal(pin.realpath, f.executable); assert.equal(pin.version, "0.172.0");
  assert.match(pin.sha256, /^[a-f0-9]{64}$/); assert.ok(Object.isFrozen(pin));
  assert.deepEqual(pinCodexNativeExecutable({ command: f.executable, cwd: f.dir, env }), pin);
  for (const extra of [{ FIXTURE_VERSION: "codex-cli 0.171.0" }, { FIXTURE_VERSION: "codex-cli 0.172.0 extra" }, { FIXTURE_FAIL: "1" }, { FIXTURE_VERSION: "x".repeat(2048) }, { FIXTURE_WAIT: "1" }])
    assert.throws(() => pinCodexNativeExecutable({ command: f.executable, cwd: f.dir, env: { ...env, ...extra } }), /unavailable/);
});
test("pin refuses wrappers, nonregular, oversized and missing selections before probing", { skip: !supported }, t => {
  const f = fixture(t); if (!f) return;
  const wrapper = path.join(f.dir, "wrapper"), folder = path.join(f.dir, "folder");
  writeFileSync(wrapper, '#!/bin/sh\nprintf "codex-cli 0.172.0\\n"\n', { mode: 0o700 }); mkdirSync(folder);
  for (const command of [wrapper, folder, path.join(f.dir, "missing")])
    assert.throws(() => pinCodexNativeExecutable({ command, cwd: f.dir }), /unavailable/);
  const replacement = path.join(f.dir, "replacement"); writeFileSync(replacement, readFileSync(f.executable), { mode: 0o700 });
  assert.throws(() => pinCodexNativeExecutable({ command: f.executable, cwd: f.dir, env: { ...process.env, FIXTURE_REPLACE: replacement } }), /unavailable/);
  truncateSync(f.executable, 512 * 1024 * 1024 + 1);
  assert.throws(() => pinCodexNativeExecutable({ command: f.executable, cwd: f.dir }), /unavailable/);
});

test("owned runtime requires the producer pin and copies runner invocation choices before launch", { skip: !supported }, async t => {
  const { createCodexRuntime, createCodexInvocation } = await import("./codex-runtime.mjs");
  const f = fixture(t); if (!f) return;
  mkdirSync(path.join(f.dir, ".git"));
  const env = { ...process.env, FIXTURE_VERSION: "codex-cli 0.172.0" };
  env.QC_ROLE = "implementer"; env.QC_CODEX_WORKER = "1";
  const pin = pinCodexNativeExecutable({ command: f.executable, cwd: f.dir, env });
  const choices = { env, args: ["exec", "-s", "danger-full-access", "-c", 'model="runner-model"', "-c", "model_reasoning_effort=high", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "--json", "-"], role: "implementer" };
  const invocation = createCodexInvocation(choices);
  const options = { worktree: f.dir, executable: f.executable, workflowId: "owned", invocation };
  assert.throws(() => createCodexRuntime(options), /unavailable/);
  for (const extra of [{ args: ["--profile", "promote"] }, { config: {} }, { role: "leader" }, { env: { ...env, QC_CODEX_WORKER: "1", QC_ROLE: "leader" } }])
    assert.throws(() => createCodexRuntime({ ...options, executablePin: pin, invocation: { ...invocation, ...extra } }), /unavailable/);
  assert.throws(() => createCodexRuntime({ ...options, executablePin: { ...pin } }), /unavailable/);
  assert.throws(() => createCodexInvocation({ ...choices, env: { ...env, QC_CODEX_WORKER: "0" } }), /unavailable/);
  assert.throws(() => createCodexInvocation({ ...choices, args: [...choices.args, "-c", "features.multi_agent=true"] }), /unavailable/);
  const previous = process.env.QC_CODEX_WORKER; process.env.QC_CODEX_WORKER = "1";
  try { assert.throws(() => createCodexRuntime({ ...options, executablePin: pin }), /unavailable/); }
  finally { if (previous === undefined) delete process.env.QC_CODEX_WORKER; else process.env.QC_CODEX_WORKER = previous; }
  assert.throws(() => createCodexInvocation({ ...choices, role: "leader", env: { PATH: env.PATH } }), /unavailable/);
  for (const args of [choices.args.filter(value => value !== "features.multi_agent=false"), [...choices.args, "--enable=multi_agent"]])
    assert.throws(() => createCodexInvocation({ ...choices, args }), /unavailable/);
  const runtime = createCodexRuntime({ ...options, executablePin: pin });
  assert.throws(() => runtime.reserve({ role: "leader", workflowParentId: "parent" }), /unavailable/);
  for (const extra of [{ argv: ["--profile", "promote"] }, { config: { features: { multi_agent: true } } }])
    assert.throws(() => runtime.reserve({ role: "implementer", workflowParentId: "parent", ...extra }), /unavailable/);
  env.QC_ROLE = "leader"; choices.args.push("-c", "features.multi_agent=true");
  const hook = { hook_event_name: "SessionStart", source: "startup", cwd: f.dir, session_id: "native-thread" };
  const r = runtime.reserve({ role: "implementer", workflowParentId: "parent" });
  const ready = runtime.ready(r);
  assert.equal(runtime.startup(r, r.hookCredential, hook), true);
  const child = runtime.launch(r, "runner-prompt\n");
  t.after(() => child.kill());
  let output = ""; child.stdout.on("data", chunk => { output += chunk; });
  const proof = await ready;
  assert.equal(proof.role, "implementer"); assert.equal(proof.nativeThreadId, "native-thread");
  assert.equal(proof.nativeRootSessionId, null); assert.equal(proof.executablePin.sha256, pin.sha256);
  while (!output.includes("QC_FIXTURE_DONE")) await once(child.stdout, "data");
  assert.match(output, /runner-prompt\nimplementer\n1\nexec\n-s\ndanger-full-access/);
  assert.match(output, /model="runner-model"/); assert.match(output, /model_reasoning_effort=high/);
  assert.ok(!output.includes("features.multi_agent=true"));
  for (const feature of ["features.multi_agent=false", "features.multi_agent_v2=false"]) assert.ok(output.includes(feature));
  const closed = once(child, "close"); runtime.terminal(r); await closed;
  assert.equal(child.stdout.listenerCount("data"), 1); assert.equal(child.listenerCount("exit"), 0);
});

for (const mode of ["stdout-first", "timeout", "cancel", "error", "malformed", "drift", "precreate-drift"]) test(`owned child lifecycle: ${mode}`, { skip: !supported }, async t => {
  const { createCodexRuntime, createCodexInvocation } = await import("./codex-runtime.mjs");
  const f = fixture(t); if (!f) return; mkdirSync(path.join(f.dir, ".git"));
  const env = { ...process.env, QC_ROLE: "implementer", QC_CODEX_WORKER: "1" };
  const pin = pinCodexNativeExecutable({ command: f.executable, cwd: f.dir, env });
  const invocation = createCodexInvocation({ role: "implementer", env, args: ["exec", "--json", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false", "-"] });
  const options = { worktree: f.dir, executable: f.executable, workflowId: "lifecycle", executablePin: pin, invocation, capacity: 1, startupTimeoutMs: 200 };
  if (mode === "precreate-drift") {
    writeFileSync(f.executable + ".new", readFileSync(f.executable), { mode: 0o700 }); renameSync(f.executable + ".new", f.executable);
    assert.throws(() => createCodexRuntime(options), /unavailable/); return;
  }
  const runtime = createCodexRuntime(options);
  const reserve = () => runtime.reserve({ role: "implementer", workflowParentId: "parent" }), r = reserve();
  const ready = runtime.ready(r), failed = mode === "stdout-first" ? null : assert.rejects(ready, /unavailable/);
  if (mode === "drift") {
    writeFileSync(f.executable, readFileSync(process.execPath));
    assert.throws(() => runtime.launch(r, "prompt\n"), /unavailable/); await failed; runtime.terminal(reserve()); return;
  }
  const child = runtime.launch(r, "prompt\n"), closed = once(child, "close"); t.after(() => child.kill());
  await once(child.stdout, "data");
  if (mode === "stdout-first") {
    assert.equal(runtime.startup(r, r.hookCredential, { hook_event_name: "SessionStart", source: "startup", cwd: f.dir, session_id: "native-thread" }), true);
    assert.equal((await ready).nativeThreadId, "native-thread"); runtime.terminal(r);
  } else if (mode === "cancel") runtime.terminal(r);
  else if (mode === "error") child.stdin.emit("error", new Error("fixture input failure"));
  else if (mode === "malformed") runtime.startup(r, r.hookCredential, { hook_event_name: "SessionStart", source: "startup", cwd: f.dir, session_id: "mismatch" });
  if (failed) await failed; await closed;
  assert.equal(child.stdout.listenerCount("data"), 0); assert.equal(child.listenerCount("exit"), 0);
  assert.equal(child.stdin.listenerCount("error"), 0); runtime.terminal(reserve());
});
