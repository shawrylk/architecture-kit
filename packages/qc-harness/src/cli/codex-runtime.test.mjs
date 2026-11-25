import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, statSync, symlinkSync, readFileSync, renameSync, readdirSync } from "node:fs";
import os from "node:os";
import { createHash } from "node:crypto";
import path from "node:path";
import { once, EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createCodexRuntime, createCodexInvocation } from "./codex-runtime.mjs";
import { decideCodexContext } from "./codex-context.mjs";
import { readCodexUsage } from "./codex-usage-source.mjs";

const workerOverrides = ["features.multi_agent=false", "features.multi_agent_v2=false"];
const leaderOverrides = [...workerOverrides, "model_auto_compact_token_limit=400000", "model_post_turn_compact_threshold_percent=0"];
const invocationChoices = role => ({ role, env: role === "leader" ? {} : { QC_ROLE: role, QC_CODEX_WORKER: "1" },
  args: ["exec", ...((role === "leader" ? leaderOverrides : workerOverrides).flatMap(value => ["-c", value])), "--json", "-"] });

for (const role of ["leader", "implementer", "reviewer", "scout", "tests"]) {
  test(`${role} invocation rejects normalized helper overrides and feature-table replacement`, () => {
    const choices = invocationChoices(role);
    for (const value of [" features.multi_agent=true", "\tfeatures.multi_agent_v2 = true ",
      "features = { multi_agent = true }", " features={multi_agent_v2=true}", "features={}",
      "features.multi_agent.child=true"]) {
      for (const suffix of [["-c", value], ["--config", value], [`--config=${value}`], [`-c${value}`], [`-c=${value}`]])
        assert.throws(() => createCodexInvocation({ ...choices, args: [...choices.args, ...suffix] }), /unavailable/, JSON.stringify(suffix));
    }
    for (const suffix of [["--enable", "multi_agent"], ["--enable=other,multi_agent_v2"]])
      assert.throws(() => createCodexInvocation({ ...choices, args: [...choices.args, ...suffix] }), /unavailable/);
  });
}
test("leader invocation rejects padded compaction overrides before minting authority", () => {
  const choices = invocationChoices("leader");
  for (const value of [" model_auto_compact_token_limit=1", "\tmodel_post_turn_compact_threshold_percent = 99 ",
    "model_auto_compact_token_limit.child=1"]) {
    for (const suffix of [["-c", value], ["--config", value], [`--config=${value}`], [`-c${value}`], [`-c=${value}`]])
      assert.throws(() => createCodexInvocation({ ...choices, args: [...choices.args, ...suffix] }), /unavailable/, JSON.stringify(suffix));
  }
});
test("invocation accepts normalized required scalars and unrelated overrides", () => {
  for (const role of ["leader", "implementer"]) {
    const choices = invocationChoices(role);
    const args = choices.args.map(value => value.includes("=") ? ` \t${value.replace("=", " = ")} ` : value);
    args.push("--config=model=\"runner-model\"", "-c", "model_reasoning_effort=high");
    assert.deepEqual(createCodexInvocation({ ...choices, args }).args, args);
  }
});
test("positional text after the option terminator cannot satisfy required overrides", () => {
  const choices = invocationChoices("leader");
  assert.throws(() => createCodexInvocation({ ...choices, args: ["exec", "--", ...choices.args.slice(1)] }), /unavailable/);
});

// Rust Unicode White_Space, including NEL and excluding BOM (unlike JS trim).
const nativeWhitespace = [..."\u0009\u000a\u000b\u000c\u000d\u0020\u0085\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000"];
for (const role of ["leader", "implementer", "reviewer", "scout", "tests"]) {
  test(`${role} invocation rejects Unicode-normalized protected replacements`, () => {
    const choices = invocationChoices(role);
    const protectedOverrides = role === "leader" ? leaderOverrides : workerOverrides;
    const conflicts = protectedOverrides.map(raw => `${raw.split("=")[0]}=${raw.endsWith("false") ? "true" : "1"}`);
    conflicts.push("features={}", ...protectedOverrides.map(raw => `${raw.split("=")[0]}.child=true`));
    for (const ws of nativeWhitespace) for (const raw of conflicts) {
      const [key, value] = raw.split("=");
      for (const override of [`${ws}${key}=${value}`, `${key}${ws}=${value}`])
        assert.throws(() => createCodexInvocation({ ...choices, args: [...choices.args, "-c", override] }),
          /unavailable/, JSON.stringify(override));
    }
  });
  test(`${role} invocation refuses Unicode-padded helper enable requests`, () => {
    const choices = invocationChoices(role);
    for (const ws of nativeWhitespace) for (const feature of ["multi_agent", "multi_agent_v2"]) {
      for (const enabled of [`${ws}${feature}`, `${feature}${ws}`]) {
        for (const suffix of [["--enable", enabled], [`--enable=other,${enabled}`]])
          assert.throws(() => createCodexInvocation({ ...choices, args: [...choices.args, ...suffix] }), /unavailable/);
      }
    }
  });
  test(`${role} invocation accepts genuine Unicode-normalized required scalars`, () => {
    const choices = invocationChoices(role);
    for (const ws of nativeWhitespace) {
      const args = choices.args.map(raw => {
        if (!raw.includes("=")) return raw;
        const [key, value] = raw.split("=");
        return `${ws}${key}${ws}=${ws}${value}${ws}`;
      });
      assert.deepEqual(createCodexInvocation({ ...choices, args }).args, args, JSON.stringify(ws));
    }
  });
  test(`${role} invocation recognizes only genuine native required keys and scalar values`, () => {
    const choices = invocationChoices(role);
    // Changing even one required key/value to contain a literal BOM cannot satisfy it.
    for (const raw of role === "leader" ? leaderOverrides : workerOverrides) {
      const [key, value] = raw.split("=");
      for (const override of [`\ufeff${key}=${value}`, `${key}\ufeff=${value}`,
        `${key}=\ufeff${value}`, `${key}=${value}\ufeff`]) {
        assert.throws(() => createCodexInvocation({ ...choices,
          args: choices.args.map(arg => arg === raw ? override : arg) }), /unavailable/, JSON.stringify(override));
      }
    }
    const args = [...choices.args, "-c", "\ufefffeatures.multi_agent=true", "-c", "features.multi_agent\ufeff=true",
      "-c", "model=\ufeffliteral\ufeff", "-c", "model=\"contains=equals\""];
    assert.deepEqual(createCodexInvocation({ ...choices, args }).args, args);
  });
}

function fixture(t, options = {}) {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-runtime-"));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  mkdirSync(path.join(dir, ".git"));
  const bin = path.join(dir, "native");
  writeFileSync(bin, `#!/bin/sh\nread -r thread\nprintf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"\nprintf "%s\\n" "$@"\nprintf "QC_FIXTURE_DONE\\n"\ncat >/dev/null\n`, { mode: 0o700 });
  const runtime = createCodexRuntime({ worktree: dir, executable: bin, workflowId: "workflow", codexHome: dir, ...options });
  const reserve = (role = "leader", extra = {}) => runtime.reserve({ role, workflowParentId: "parent", ...extra });
  const hook = { hook_event_name: "SessionStart", source: "startup", cwd: dir, session_id: "native-thread" };
  return { dir, runtime, reserve, hook };
}
async function start(t, f, reservation, session = "native-thread") {
  const child = f.runtime.launch(reservation);
  t.after(() => { child.stdin.end(); child.kill(); });
  child.output = new Promise((resolve, reject) => {
    let output = "";
    const cleanup = () => { child.stdout.off("data", collect); child.stdout.off("end", incomplete); };
    const incomplete = () => { cleanup(); reject(new Error("Incomplete fixture output")); };
    const collect = data => {
      output += data.toString();
      const end = output.indexOf("\nQC_FIXTURE_DONE\n");
      if (end < 0) return;
      cleanup(); resolve(output.slice(0, end + 1));
    };
    child.stdout.on("data", collect); child.stdout.once("end", incomplete);
  });
  await once(child, "spawn");
  child.stdin.write(session + "\n");
  await child.output;
  return child;
}
test("startup fixture collects fragmented output through its completion delimiter", async t => {
  const child = new EventEmitter();
  child.stdout = new PassThrough(); child.stdin = new PassThrough(); child.kill = () => {};
  child.stdin.once("data", () => {
    child.stdout.write('{"type":"thread.started","thread_id":"native-thread"}\n');
    setImmediate(() => {
      child.stdout.write("exec\nmodel_auto_compact_token_limit=400000\nQC_FIX");
      setImmediate(() => child.stdout.write("TURE_DONE\n"));
    });
  });
  const f = { runtime: { launch() { process.nextTick(() => child.emit("spawn")); return child; } } };
  const started = await start(t, f, {});
  assert.equal(await started.output,
    '{"type":"thread.started","thread_id":"native-thread"}\nexec\nmodel_auto_compact_token_limit=400000\n');
});
const supported = ["linux", "darwin"].includes(process.platform);
for (const role of ["implementer", "reviewer"]) {
  test(`controlled ${role} process inherits the worker boundary and cannot dispatch any child role`, { skip: !supported }, async t => {
    const f = fixture(t, { capacity: 2 }), r = f.reserve(role);
    writeFileSync(path.join(f.dir, "native"), `#!/bin/sh
read -r thread
printf '{"type":"thread.started","thread_id":"%s"}\\n' "$thread"
printf '%s\\n' "$QC_CODEX_WORKER" "$QC_ROLE" "$@"
printf 'QC_FIXTURE_DONE\\n'
cat >/dev/null
`, { mode: 0o700 });
    const child = await start(t, f, r);
    const lines = (await child.output).trim().split("\n").slice(1);
    assert.deepEqual(lines.slice(0, 2), ["1", role]);
    for (const feature of ["features.multi_agent=false", "features.multi_agent_v2=false"]) {
      assert.equal(lines[lines.indexOf(feature) - 1], "-c");
    }
    f.runtime.bind(r, r.hookCredential, f.hook);
    for (const childRole of ["leader", "implementer", "reviewer"]) {
      assert.throws(() => f.reserve(childRole, { parent: r }), /unavailable/);
      const restricted = fixture(t, { inheritedRole: role });
      assert.throws(() => restricted.reserve(childRole), /unavailable/);
    }
    assert.equal(f.runtime.validate(r, f.hook).role, role);
    f.reserve("reviewer"); // Denials must not consume the root runner's remaining slot.
  });
}

test("controlled argv proves explicit 400000 and disabled percentage only after authenticated SessionStart", { skip: !supported }, async t => {
  const f = fixture(t), r = f.reserve(), child = await start(t, f, r);
  assert.equal(f.runtime.validate(r, f.hook), null);
  assert.throws(() => f.runtime.bind(r, {}, f.hook), /unavailable/);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...f.hook, session_id: "forged-thread" }), /unavailable/);
  const proof = f.runtime.bind(r, r.hookCredential, f.hook);
  assert.deepEqual(f.runtime.bind(r, r.hookCredential, f.hook), proof);
  assert.equal(proof.role, "leader");
  assert.ok(proof.budget.compactAt > 0);
  assert.equal(proof.settingsProvenance, "controlled-cli-forwarding");
  assert.equal(proof.nativeRootSessionId, null);
  assert.equal(proof.nativeThreadId, "native-thread");
  assert.equal(proof.settings.model_auto_compact_token_limit, 400000);
  assert.equal(proof.settings.model_post_turn_compact_threshold_percent, 0);
  const output = await child.output;
  assert.match(output, /model_auto_compact_token_limit=400000/);
  assert.match(output, /model_post_turn_compact_threshold_percent=0/);
  assert.equal(JSON.stringify(r), "{}");
  assert.deepEqual(output.trim().split("\n").slice(1), ["exec", "-C", f.dir, "--json", "-c",
    "model_auto_compact_token_limit=400000", "-c", "model_post_turn_compact_threshold_percent=0", "-"]);
});
test("repository, role, parent, native session and provenance cannot be substituted", { skip: !supported }, async t => {
  const f = fixture(t), other = fixture(t), r = f.reserve();
  await start(t, f, r);
  assert.throws(() => other.runtime.launch(r), /unavailable/);
  assert.throws(() => f.runtime.bind({ ...r }, r.hookCredential, f.hook), /unavailable/);
  for (const extra of [{ cwd: other.dir }, { agent_id: "x" }, { role: "reviewer" }, { hook_event_name: "PreToolUse" }, { source: "resume" }, { source: "compact" }, { source: undefined }])
    assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...f.hook, ...extra }), /unavailable/);
  f.runtime.bind(r, r.hookCredential, f.hook);
  assert.equal(f.runtime.validate(r, { ...f.hook, session_id: "other" }), null);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...f.hook, session_id: "other" }), /unavailable/);
  assert.throws(() => f.reserve("leader", { parent: {} }), /unavailable/);
  assert.throws(() => f.reserve("admin"), /unavailable/);
});
test("worker restriction and admitted scalar budget survive edits and terminal retirement", { skip: !supported }, async t => {
  const policy = { budgets: { implementer: { remindAt: 10, handoffAt: 20 } } };
  const f = fixture(t, { config: policy }), r = f.reserve("implementer");
  policy.budgets.implementer.handoffAt = 200;
  await start(t, f, r);
  const proof = f.runtime.bind(r, r.hookCredential, f.hook);
  assert.equal(proof.settings, null);
  const restricted = fixture(t, { inheritedRole: "implementer" });
  assert.throws(() => restricted.reserve("leader"), /unavailable/);
  assert.throws(() => restricted.reserve("reviewer"), /unavailable/);
  assert.deepEqual(proof.budget, { remindAt: 10, handoffAt: 20 });
  writeFileSync(path.join(f.dir, "qc.config.json"), '{"budgets":{"implementer":null}}');
  assert.deepEqual(f.runtime.validate(r, f.hook).budget, proof.budget);
  assert.throws(() => f.reserve("leader", { parent: r }), /unavailable/);
  assert.throws(() => f.reserve("reviewer", { parent: r }), /unavailable/);
  const closure = path.join(f.dir, "qc-role-budgets", "closed.json");
  mkdirSync(path.dirname(closure));
  const closed = '{"policy":{"budgetClosed":true},"budget":{"remindAt":10,"handoffAt":20}}';
  writeFileSync(closure, closed, { mode: 0o600 });
  f.runtime.terminal(r);
  assert.equal(readFileSync(closure, "utf8"), closed);
  assert.equal(f.runtime.validate(r, f.hook), null);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
  assert.throws(() => f.runtime.launch(r), /unavailable/);

});
test("bounded concurrent reservations isolate native threads and retire on failure or exit", { skip: !supported }, async t => {
  const f = fixture(t, { capacity: 4 }), reservations = Array.from({ length: 4 }, () => f.reserve());
  assert.throws(() => f.reserve(), /unavailable/);
  const children = await Promise.all(reservations.map((r, i) => start(t, f, r, `native-${i}`)));
  const proofs = reservations.map((r, i) => f.runtime.bind(r, r.hookCredential, { ...f.hook, session_id: `native-${i}` }));
  assert.equal(new Set(proofs.map(p => p.incarnation)).size, 4);
  assert.throws(() => f.runtime.launch(reservations[0]), /unavailable/);
  children[0].stdin.end(); await once(children[0], "close");
  assert.equal(f.runtime.validate(reservations[0], { ...f.hook, session_id: "native-0" }), null);
  const fresh = f.reserve();
  await start(t, f, fresh, "native-0");
  assert.throws(() => f.runtime.bind(fresh, fresh.hookCredential, { ...f.hook, session_id: "native-0" }), /unavailable/);
  assert.throws(() => f.runtime.bind(fresh, reservations[0].hookCredential, f.hook), /unavailable/);
  const bad = fixture(t, { executable: path.join(f.dir, "absent") }), pending = bad.reserve();
  const child = bad.runtime.launch(pending); await once(child, "error");
  assert.throws(() => bad.runtime.launch(pending), /unavailable/);
});
test("bounded contract refuses arbitrary flags, weak policy, unsupported platforms and non-repositories", t => {
  if (!supported) { assert.throws(() => createCodexRuntime({}), /unsupported platform/); return; }
  const f = fixture(t);
  for (const extra of [{ args: ["-c", "model_auto_compact_token_limit=1"] }, { args: ["--config=model_post_turn_compact_threshold_percent=90"] }, { profile: "leader" }])
    assert.throws(() => f.reserve("leader", extra), /unavailable/);
  assert.throws(() => f.reserve("leader", { workflowParentId: "x".repeat(129) }), /unavailable/);
  assert.throws(() => fixture(t, { config: { budgets: { implementer: { remindAt: 20, handoffAt: 10 } } } }));
  assert.throws(() => fixture(t, { capacity: 257 }), /unavailable/);
  assert.throws(() => createCodexRuntime({ worktree: os.tmpdir(), executable: f.dir, workflowId: "x" }), /unavailable/);
  assert.equal(statSync(path.join(f.dir, "native")).mode & 0o077, 0);
});
test("bound workflow parent and external native top-level identities remain distinct", { skip: !supported }, async t => {
  const f = fixture(t), parent = f.reserve(); await start(t, f, parent);
  f.runtime.bind(parent, parent.hookCredential, f.hook);
  const worker = f.reserve("reviewer", { parent }); await start(t, f, worker, "external-worker");
  const proof = f.runtime.bind(worker, worker.hookCredential, { ...f.hook, session_id: "external-worker" });
  assert.equal(proof.parentNativeRootSessionId, null);
  assert.equal(proof.parentNativeThreadId, "native-thread");
  assert.equal(proof.nativeRootSessionId, null);
  assert.equal(proof.nativeThreadId, "external-worker");
  assert.equal(proof.workflowParentId, "parent");
  assert.equal(proof.workflowId, "workflow");
  assert.throws(() => { proof.role = "leader"; }, TypeError);
  assert.throws(() => { proof.budget.handoffAt = 1; }, TypeError);
});
test("canonical linked checkout identity is bounded and separate from the common repository", { skip: !supported }, async t => {
  const f = fixture(t), linked = path.join(f.dir, "linked"), gitdir = path.join(f.dir, ".git", "worktrees", "linked");
  mkdirSync(linked); mkdirSync(gitdir, { recursive: true });
  writeFileSync(path.join(linked, ".git"), `gitdir: ${gitdir}\n`);
  writeFileSync(path.join(gitdir, "commondir"), "../..\n");
  const alias = path.join(f.dir, "alias"); symlinkSync(linked, alias);
  const runtime = createCodexRuntime({ worktree: alias, executable: path.join(f.dir, "native"), workflowId: "other-workflow" });
  const r = runtime.reserve({ role: "leader", workflowParentId: "parent" });
  await start(t, { runtime }, r);
  const proof = runtime.bind(r, r.hookCredential, { ...f.hook, cwd: alias });
  assert.equal(proof.worktree, linked);
  assert.equal(proof.repository, path.join(f.dir, ".git"));
  assert.equal(runtime.validate(r, f.hook), null);
  writeFileSync(path.join(linked, ".git"), "x".repeat(8192));
  assert.equal(runtime.validate(r, { ...f.hook, cwd: linked }), null);
  assert.throws(() => createCodexRuntime({ worktree: linked, executable: path.join(f.dir, "native"), workflowId: "x" }), /unavailable/);
});
test("first native event is bounded independently of coalesced later output", { skip: !supported }, async t => {
  const first = '{"type":"thread.started","thread_id":"native-thread"}';
  const later = JSON.stringify({ type: "item.completed", payload: "x".repeat(9000) }) + "\n";
  const exact = first + " ".repeat(8192 - Buffer.byteLength(first));
  const byteOversized = first.slice(0, -1) + ',"payload":"' + "é".repeat(4096) + '"}';
  for (const [chunks, valid] of [
    [[first + "\n" + later], true],
    [[first.slice(0, 17), first.slice(17) + "\n" + later], true],
    [[exact, "\n" + later], true],
    [[exact + " \n" + later], false],
    [[byteOversized], false],
  ]) {
    const f = fixture(t, { capacity: 1 }), r = f.reserve();
    const child = f.runtime.launch(r);
    t.after(() => { child.stdin.end(); child.kill(); });
    await once(child, "spawn");
    // Inject exact stream chunk boundaries while the fixture waits on stdin.
    for (const chunk of chunks) child.stdout.emit("data", chunk);
    if (valid) {
      assert.equal(f.runtime.bind(r, r.hookCredential, f.hook).nativeThreadId, "native-thread");
      assert.throws(() => f.reserve(), /unavailable/);
    } else {
      assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
      f.reserve();
    }
  }
});
test("missing, malformed and oversized native identity streams stay unknown and release slots", { skip: !supported }, async t => {
  for (const line of ["not-json", '{"type":"thread.started"}', "x".repeat(8193)]) {
    const f = fixture(t, { capacity: 1 });
    writeFileSync(path.join(f.dir, "native"), `#!/bin/sh\nprintf '%s\\n' '${line}'\nprintf 'QC_FIXTURE_DONE\\n'\ncat >/dev/null\n`, { mode: 0o700 });
    const r = f.reserve(); await start(t, f, r);
    assert.equal(f.runtime.validate(r, f.hook), null);
    assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
    f.reserve();
  }
  const f = fixture(t, { capacity: 1 }), r = f.reserve();
  assert.throws(() => f.runtime.bind(r, r.hookCredential, f.hook), /unavailable/);
  f.runtime.terminal(r);
  for (let i = 1; i < 256; i++) f.runtime.terminal(f.reserve());
  assert.throws(() => f.reserve(), /unavailable/);
  const bad = fixture(t, { executable: "/invalid\0", capacity: 1 }), pending = bad.reserve();
  assert.throws(() => bad.runtime.launch(pending), /unavailable/);
  bad.reserve();
});

for (const early of [true, false]) test(`startup correlation handles hook first=${early} without holding its acknowledgement`, { skip: !supported }, async t => {
  const f = fixture(t), r = f.reserve(), ready = f.runtime.ready(r);
  if (early) assert.equal(f.runtime.startup(r, r.hookCredential, f.hook), true);
  const child = f.runtime.launch(r);
  t.after(() => { child.stdin.end(); child.kill(); });
  await once(child, "spawn");
  child.stdin.write("native-thread\n");
  if (!early) { await once(child.stdout, "data"); f.runtime.startup(r, r.hookCredential, f.hook); }
  const proof = await ready;
  assert.equal(proof.nativeThreadId, "native-thread");
  assert.equal(f.runtime.startup(r, r.hookCredential, f.hook), true);
  assert.strictEqual(await f.runtime.ready(r), proof);
  for (const source of ["compact", "resume"]) assert.throws(() => f.runtime.startup(r, r.hookCredential, { ...f.hook, source }), /unavailable/);
  assert.equal(child.stdout.listenerCount("data"), 0);
});
test("deferred local header establishes a distinct root once, with immutable admission and selected provenance", { skip: !supported }, async t => {
  const home = mkdtempSync(path.join(os.tmpdir(), "qc-runtime-home-"));
  t.after(() => rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 }));
  const f = fixture(t, { codexHome: home }), r = f.reserve(); await start(t, f, r);
  mkdirSync(path.join(home, "sessions"));
  const transcript = path.join(home, "sessions", "selected.jsonl"), hook = { ...f.hook, transcript_path: transcript };
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...hook, transcript_path: "relative.jsonl" }), /unavailable/);
  assert.equal(f.runtime.validate(r, f.hook), null);
  const admitted = f.runtime.bind(r, r.hookCredential, { ...hook, nativeRootSessionId: "forged", nativeConfig: { model_auto_compact_token_limit: 1 } });
  assert.equal(admitted.nativeRootSessionId, null);
  const timestamp = new Date().toISOString();
  const header = (extra = {}) => JSON.stringify({ type: "session_meta", ordinal: 0, timestamp,
    payload: { id: "native-thread", session_id: "native-root", cli_version: "0.172.0", cwd: f.dir, source: "exec", ...extra } }) + "\n";
  for (const bad of [{ id: "wrong-thread" }, { cwd: os.tmpdir() }, { source: { subagent: { thread_spawn: { parent_thread_id: "parent", agent_role: "implementer", depth: 1 } } } }]) {
    writeFileSync(transcript, header(bad)); assert.equal(f.runtime.validate(r, hook).nativeRootSessionId, null);
  }
  writeFileSync(transcript, header());
  const known = f.runtime.validate(r, hook);
  assert.equal(known.nativeRootSessionId, "native-root");
  assert.equal(known.identityProvenance.provenance, "codex-0.172.0/session_meta/local-file");
  for (const field of ["role", "budget", "incarnation", "settings"]) assert.strictEqual(known[field], admitted[field]);
  assert.equal(known.nativeConfig, undefined);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, { ...hook, transcript_path: transcript + "other" }), /unavailable/);
  assert.equal(f.runtime.validate(r, { ...hook, transcript_path: transcript + "other" }), null);
  writeFileSync(transcript, header({ session_id: "replacement-root" }));
  assert.equal(f.runtime.validate(r, hook), null);
  assert.throws(() => f.runtime.bind(r, r.hookCredential, hook), /unavailable/);
  writeFileSync(transcript, header()); assert.equal(f.runtime.validate(r, hook).nativeRootSessionId, "native-root");
  const replacement = transcript + ".new"; writeFileSync(replacement, header()); renameSync(replacement, transcript);
  assert.equal(f.runtime.validate(r, hook), null);
});
test("pending startup envelopes are bounded, authenticated and isolated", { skip: !supported }, async t => {
  const f = fixture(t, { capacity: 2 }), a = f.reserve(), b = f.reserve();
  const children = [a, b].map(r => f.runtime.launch(r));
  t.after(() => children.forEach(c => { c.stdin.end(); c.kill(); }));
  assert.throws(() => f.runtime.startup(a, b.hookCredential, f.hook), /unavailable/);
  for (const extra of [{ cwd: os.tmpdir() }, { session_id: "bad!" }, { payload: "é".repeat(4096) },
    { settings: {} }, Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`key${i}`, "x"]))])
    assert.throws(() => f.runtime.startup(a, a.hookCredential, { ...f.hook, ...extra }), /unavailable/);
  f.runtime.startup(a, a.hookCredential, f.hook);
  f.runtime.startup(b, b.hookCredential, { ...f.hook, session_id: "second" });
  assert.throws(() => f.runtime.startup(a, a.hookCredential, { ...f.hook, session_id: "second" }), /unavailable/);
  await Promise.all(children.map(c => once(c, "spawn")));
  const ready = [f.runtime.ready(a), f.runtime.ready(b)];
  children[1].stdin.write("second\n"); children[0].stdin.write("native-thread\n");
  assert.deepEqual((await Promise.all(ready)).map(p => p.nativeThreadId), ["native-thread", "second"]);
  f.runtime.terminal(a);
  const replay = f.reserve(); await start(t, f, replay);
  const rejected = assert.rejects(f.runtime.ready(replay), /unavailable/);
  f.runtime.startup(replay, replay.hookCredential, f.hook); await rejected;
  assert.equal(f.runtime.validate(replay, f.hook), null);
});
test("startup deadlines and cancellation/error/exit remove listeners and release capacity", { skip: !supported }, async t => {
  for (const mode of ["timeout", "cancel", "error", "exit", "malformed", "mismatch"]) {
    const f = fixture(t, { capacity: 1, startupTimeoutMs: 200 }), r = f.reserve(), child = f.runtime.launch(r);
    t.after(() => { child.stdin.end(); child.kill(); });
    const failed = assert.rejects(f.runtime.ready(r), /unavailable/);
    f.runtime.startup(r, r.hookCredential, f.hook);
    await once(child, "spawn");
    if (mode === "cancel") f.runtime.terminal(r);
    if (mode === "error") child.emit("error", new Error("fixture failure"));
    if (mode === "exit") child.stdin.end();
    if (mode === "malformed") child.stdout.emit("data", "not-json\n");
    if (mode === "mismatch") child.stdin.write("other-thread\n");
    await failed;
    for (const [emitter, event] of [[child.stdout, "data"], [child, "spawn"], [child, "exit"], [child, "error"]])
      assert.equal(emitter.listenerCount(event), 0, `${mode}: ${event}`);
    assert.equal(f.runtime.validate(r, f.hook), null); f.runtime.terminal(f.reserve());
  }
  for (const startupTimeoutMs of [0, 30001, NaN]) assert.throws(() => fixture(t, { startupTimeoutMs }), /unavailable/);
});

test("trusted runner pin binds real executable digest/version and detects prelaunch drift", { skip: !supported }, async t => {
  for (const drift of [false, "bytes", "path", "replacement"]) {
    const f = fixture(t), executable = path.join(f.dir, "native");
    const pin = { realpath: executable, version: "0.172.0", sha256: createHash("sha256").update(readFileSync(executable)).digest("hex") };
    const runtime = createCodexRuntime({ worktree: f.dir, executable, workflowId: "pinned", executablePin: pin });
    pin.version = "forged";
    const r = runtime.reserve({ role: "leader", workflowParentId: "parent" });
    if (drift === "replacement") { writeFileSync(executable + ".new", readFileSync(executable), { mode: 0o700 }); renameSync(executable + ".new", executable); }
    if (drift === "bytes") writeFileSync(executable, "#!/bin/sh\nexit 1\n");
    if (drift === "path") { rmSync(executable); symlinkSync(process.execPath, executable); }
    if (drift) { assert.throws(() => { const child = runtime.launch(r); t.after(() => child.kill()); }, /unavailable/); assert.throws(() => runtime.ready(r), /unavailable/); }
    else {
      await start(t, { runtime }, r);
      assert.equal(runtime.bind(r, r.hookCredential, f.hook).executablePin.version, "0.172.0");
    }
    assert.throws(() => createCodexRuntime({ worktree: f.dir, executable, workflowId: "bad", executablePin: { ...pin, version: "0.171.0" } }), /unavailable/);
  }
});

test("unlaunched reservations expire and cancellation before spawn drains process listeners", { skip: !supported }, async t => {
  const f = fixture(t, { capacity: 1, startupTimeoutMs: 20 }), r = f.reserve();
  const expired = assert.rejects(f.runtime.ready(r), /unavailable/);
  await new Promise(resolve => setTimeout(resolve, 40)); await expired;
  assert.throws(() => f.runtime.launch(r), /unavailable/);
  for (const executable of [path.join(f.dir, "native"), path.join(f.dir, "missing")]) {
    const g = fixture(t, { executable }), pending = g.reserve(), child = g.runtime.launch(pending);
    const cancelled = assert.rejects(g.runtime.ready(pending), /unavailable/);
    g.runtime.terminal(pending); child.stdin.end();
    await new Promise(resolve => child.once("close", resolve)); await cancelled;
    for (const event of ["error", "spawn", "exit"]) assert.equal(child.listenerCount(event), 0);
  }
});

async function external(t, role = "implementer", config = {}, deferred = false) {
  const f = fixture(t, { config }), r = f.reserve(role);
  mkdirSync(path.join(f.dir, "sessions"));
  const file = path.join(f.dir, "sessions", "usage.jsonl"), timestamp = new Date().toISOString();
  const row = (type, payload, ordinal) => JSON.stringify({ type, payload, ordinal, timestamp }) + "\n";
  const save = (total = 150000, change = {}) => {
    const usage = { input_tokens: total - 1000, cached_input_tokens: total - 1000, output_tokens: 1000, reasoning_output_tokens: 900, total_tokens: total };
    const text = row("session_meta", { id: "native-thread", session_id: "distinct-root", cwd: f.dir, cli_version: "0.172.0", source: "exec" }, 0) +
      row("token_usage_record", { thread_id: "native-thread", session_id: "distinct-root", turn_id: "turn", root_turn_id: "turn", response_id: "response", usage,
        turn_token_usage: usage, thread_token_usage: { ...usage, total_tokens: 9999999 }, ...change }, 1) +
      row("event_msg", { type: "token_count", info: { last_token_usage: usage, total_token_usage: { ...usage, total_tokens: 9999999 } } }, 2);
    writeFileSync(file, text);
  };
  const call = { hook_event_name: "PreToolUse", cwd: f.dir, session_id: "native-thread", turn_id: "turn", tool_use_id: "call",
    transcript_path: file, tool_name: "Bash", tool_input: { command: "npm test" } };
  await start(t, f, r);
  if (!deferred) save();
  f.runtime.bind(r, r.hookCredential, { ...f.hook, transcript_path: file });
  const states = () => readdirSync(path.join(f.dir, "qc-role-budgets")).filter(name => name.endsWith(".json"))
    .map(name => JSON.parse(readFileSync(path.join(f.dir, "qc-role-budgets", name), "utf8")));
  return { ...f, r, file, call, save, states, decide: extra => f.runtime.context(r, { ...call, ...extra }) };
}

test("admitted external usage freezes role policy, serializes decisions and retains closure through source loss", { skip: !supported }, async t => {
  for (const role of ["implementer", "reviewer"]) {
    const config = { budgets: { [role]: { remindAt: 10000, handoffAt: 20000 } } }, f = await external(t, role, config);
    const before = structuredClone(f.call);
    config.budgets[role].handoffAt = 900000;
    writeFileSync(path.join(f.dir, "qc.config.json"), JSON.stringify({ budgets: { [role]: null } }));
    f.save(15000);
    assert.match((await f.decide()).hookSpecificOutput.additionalContext, new RegExp(`budgets.${role}.remindAt`));
    assert.equal(await f.decide(), null);
    assert.equal(f.states()[0].count, 1);
    await Promise.all(Array.from({ length: 8 }, (_, i) => f.decide({ tool_use_id: `parallel_${i}` })));
    assert.equal(f.states()[0].count, 9);
    assert.deepEqual(f.states()[0].budget, { remindAt: 10000, handoffAt: 20000 });
    assert.deepEqual(f.call, before); assert.equal(f.call.agent_id, undefined); assert.equal(f.call.agent_type, undefined);
    f.save(20000);
    assert.equal((await f.decide({ tool_use_id: "close" })).hookSpecificOutput.permissionDecision, "deny");
    const closed = f.states()[0];
    rmSync(f.file);
    assert.equal((await f.decide({ tool_use_id: "missing" })).hookSpecificOutput.permissionDecision, "deny");
    assert.equal(await f.decide({ tool_input: { command: "git status" } }), null);
    const command = "*** Begin Patch\n*** Add File: handoffs/resume.md\n+resume\n*** End Patch";
    assert.equal(await f.decide({ tool_name: "apply_patch", tool_input: { command } }), null);
    assert.equal(f.states()[0].root, closed.root); assert.equal(f.states()[0].policy.budgetClosed, true);
    const saved = f.states(); f.runtime.terminal(f.r);
    await assert.rejects(f.decide(), /unavailable/);
    assert.deepEqual(f.states(), saved);
    const replacement = createCodexRuntime({ worktree: f.dir, executable: path.join(f.dir, "native"), workflowId: "replacement", codexHome: f.dir,
      config: { budgets: { [role]: null } } }), next = replacement.reserve({ role, workflowParentId: "parent" });
    await start(t, { runtime: replacement }, next);
    replacement.bind(next, next.hookCredential, { ...f.hook, transcript_path: f.file });
    await assert.rejects(replacement.context(next, f.call), /unavailable/);
    assert.deepEqual(f.states(), saved);
  }
});

test("external admission rejects forged, serialized, sibling, terminal and repository substitutions", { skip: !supported }, async t => {
  const f = await external(t), g = await external(t);
  const proof = f.runtime.validate(f.r, f.call);
  for (const admission of [{}, { ...f.r }, JSON.parse(JSON.stringify(proof)), g.r, null]) {
    await assert.rejects(decideCodexContext(f.call, { admission, role: "leader", codexHome: f.dir }));
    assert.equal(readCodexUsage(f.call, { admission, role: "leader", codexHome: f.dir }), null);
  }
  await assert.rejects(decideCodexContext({ ...f.call, admission: proof, role: "leader" }, { role: "implementer", codexHome: f.dir }));
  const pending = f.reserve("reviewer");
  await assert.rejects(f.runtime.context(pending, f.call)); f.runtime.terminal(pending);
  for (const extra of [{ cwd: g.dir }, { session_id: "distinct-root" }, { role: "leader" }, { agent_id: "native-thread", agent_type: "profile" }])
    await assert.rejects(f.decide(extra));
  mkdirSync(path.join(f.dir, "nested")); await assert.rejects(f.decide({ cwd: path.join(f.dir, "nested") }));
  const sample = readCodexUsage(f.call, { admission: f.r, codexHome: f.dir });
  assert.equal(sample.rootSessionId, "distinct-root"); assert.equal(sample.usage.params.threadId, "native-thread");
  assert.equal(readCodexUsage(f.call, { role: "implementer", codexHome: f.dir }), null);
  await assert.rejects(g.runtime.context(f.r, f.call));
  const input = JSON.stringify({ ...f.call, admission: proof, role: "leader", nativeConfig: proof.settings });
  for (const args of [[], ["--role", "implementer"]]) {
    const result = spawnSync(process.execPath, [fileURLToPath(new URL("./qc.mjs", import.meta.url)), "codex-context", ...args],
      { input, encoding: "utf8", env: { ...process.env, CODEX_HOME: f.dir } });
    assert.equal(result.status, 2); assert.match(result.stderr, /unsupported input/);
  }
  f.save(150000, { session_id: "native-thread" });
  assert.equal(readCodexUsage(f.call, { admission: f.r, codexHome: f.dir }), null);
  f.save();
  const sibling = f.reserve("reviewer"), siblingFile = path.join(f.dir, "sessions", "sibling.jsonl");
  await start(t, f, sibling, "sibling-thread");
  writeFileSync(siblingFile, readFileSync(f.file, "utf8").replaceAll("native-thread", "sibling-thread").replaceAll("distinct-root", "sibling-root"));
  f.runtime.bind(sibling, sibling.hookCredential, { ...f.hook, session_id: "sibling-thread", transcript_path: siblingFile });
  await assert.rejects(f.runtime.context(sibling, f.call));
  await f.decide();
  await f.runtime.context(sibling, { ...f.call, session_id: "sibling-thread", transcript_path: siblingFile });
  assert.equal(f.states().length, 2); assert.equal(new Set(f.states().map(state => state.admission)).size, 2);
  assert.equal(new Set(f.states().map(state => state.root)).size, 2);
  renameSync(path.join(f.dir, ".git"), path.join(f.dir, "retired-git"));
  await assert.rejects(f.decide());
});

test("external unknown sources and registered leaders keep active settings unknown with a deduplicated note", { skip: !supported }, async t => {
  const worker = await external(t); rmSync(worker.file);
  assert.match((await worker.decide()).hookSpecificOutput.additionalContext, /usage.*unknown/i);
  assert.equal(await worker.decide(), null); assert.equal(worker.states()[0].policy.budgetClosed, undefined);
  for (const fail of [() => mkdirSync(worker.file), () => writeFileSync(worker.file, "malformed\n")]) {
    rmSync(worker.file, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 }); fail();
    assert.equal(await worker.decide(), null);
  }
  const leader = await external(t, "leader");
  const note = await leader.decide({ nativeConfig: { model_auto_compact_token_limit: 200000 }, settings: { model_post_turn_compact_threshold_percent: 0 }, parent: "forged" });
  assert.match(note.hookSpecificOutput.additionalContext, /active native settings unavailable.*automatic compaction/);
  assert.equal(await leader.decide(), null); assert.equal(leader.states()[0].policy.budgetClosed, undefined);
  const disabled = await external(t, "implementer", { budgets: { implementer: null } });
  assert.equal(await disabled.decide(), null);
  writeFileSync(path.join(disabled.dir, "qc.config.json"), '{"budgets":{"implementer":{"remindAt":1,"handoffAt":2}}}');
  assert.equal(await disabled.decide(), null); assert.equal(disabled.states()[0].budget, null);
});

test("external source retains snapshot, freshness, cursor, file and root provenance checks", { skip: !supported }, async t => {
  const f = await external(t, "implementer", {}, true), options = { admission: f.r, codexHome: f.dir };
  assert.equal(f.runtime.validate(f.r, f.call).nativeRootSessionId, null);
  assert.equal(readCodexUsage(f.call, options), null);
  assert.match((await f.decide()).hookSpecificOutput.additionalContext, /usage.*unknown/i);
  f.save(10000);
  const sample = readCodexUsage(f.call, options);
  assert.equal(sample.rootSessionId, "distinct-root");
  assert.ok(readCodexUsage(f.call, { ...options, previous: sample.cursor }));
  for (const previous of [{ ...sample.cursor, file: "0".repeat(64) }, { ...sample.cursor, bytes: sample.cursor.bytes + 1 },
    { ...sample.cursor, timestamp: sample.cursor.timestamp + 1 }, { ...sample.cursor, ordinal: sample.cursor.ordinal + 1 }])
    assert.equal(readCodexUsage(f.call, { ...options, previous }), null);
  assert.equal(readCodexUsage(f.call, { ...options, now: Date.now() + 120001 }), null);
  assert.equal(readCodexUsage({ ...f.call, turn_id: "other" }, options), null);
  f.save(10000, { root_turn_id: "sibling-turn" });
  assert.equal(readCodexUsage(f.call, options), null);
  f.save(10000);
  const text = readFileSync(f.file, "utf8"), lines = text.trimEnd().split("\n");
  for (const rows of [[lines[0], lines[2]], [lines[0], lines[1]],
    [lines[0], lines[1], JSON.stringify({ timestamp: JSON.parse(lines[2]).timestamp, ordinal: 2, type: "turn_context", payload: { turn_id: "turn" } }),
      lines[2].replace('"ordinal":2', '"ordinal":3')]]) {
    writeFileSync(f.file, rows.join("\n") + "\n"); assert.equal(readCodexUsage(f.call, options), null);
  }
  for (const changed of [text.replaceAll("distinct-root", "forged-root"), text.replace('"source":"exec"', '"source":"cli"'),
    text.replace('"ordinal":0', '"ordinal":1')]) {
    writeFileSync(f.file, changed); await assert.rejects(f.decide());
  }
  writeFileSync(f.file, text); assert.ok(readCodexUsage(f.call, options));
  const replacement = f.file + ".replacement"; writeFileSync(replacement, text); renameSync(replacement, f.file);
  await assert.rejects(f.decide());
});

for (const early of [true, false]) test(`bridge startup correlation hook first=${early} accepts native null transcript`, { skip: !supported }, async t => {
  const { createCodexBridge, reportCodexHook } = await import("./codex-bridge.mjs");
  const f = fixture(t), r = f.reserve("implementer");
  const bridge = await createCodexBridge({ runtime: f.runtime, reservation: r }), ready = bridge.ready();
  t.after(() => bridge.close());
  const input = { ...f.hook, transcript_path: null, model: "fixture", permission_mode: "default" };
  const report = () => reportCodexHook(input, { env: bridge.env });
  if (early) assert.equal(await report(), null);
  await start(t, f, r);
  if (!early) assert.equal(await report(), null);
  const proof = await ready;
  assert.equal(proof.nativeThreadId, input.session_id);
  assert.equal(proof.nativeRootSessionId, null);
  assert.equal(proof.role, "implementer");
  assert.equal(await report(), null);
  assert.strictEqual(await f.runtime.ready(r), proof);
  for (const bad of [{ cwd: path.dirname(f.dir) }, { session_id: "sibling" }, { source: "compact" }, { source: "resume" }])
    await assert.rejects(reportCodexHook({ ...input, ...bad }, { env: bridge.env }), /unavailable/);
  assert.strictEqual(await f.runtime.ready(r), proof);
  f.runtime.terminal(r);
  await assert.rejects(report(), /unavailable/);
});

test("bridge late startup cannot revive an expired reservation", { skip: !supported }, async t => {
  const { createCodexBridge, reportCodexHook } = await import("./codex-bridge.mjs");
  const f = fixture(t, { startupTimeoutMs: 25 }), r = f.reserve();
  const bridge = await createCodexBridge({ runtime: f.runtime, reservation: r });
  t.after(() => bridge.close());
  const rejected = assert.rejects(bridge.ready(), /unavailable/);
  assert.equal(await reportCodexHook({ ...f.hook, transcript_path: null, model: "fixture", permission_mode: "default" }, { env: bridge.env }), null);
  await rejected;
  await assert.rejects(reportCodexHook({ ...f.hook, transcript_path: null, model: "fixture", permission_mode: "default" }, { env: bridge.env }), /unavailable/);
});
