import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HOOK = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "..", "hooks", "stop-gate.sh");

/**
 * A qc CLI stub that logs `<label> <command>` and exits with the code given for that command.
 * `withDoctor` ships the doctor.mjs file the stop gate probes for.
 */
function stubHarness(cliDir, label, log, codes, withDoctor, outputs = {}) {
  mkdirSync(cliDir, { recursive: true });
  writeFileSync(
    path.join(cliDir, "qc.mjs"),
    [
      `import { appendFileSync } from "node:fs";`,
      `const command = process.argv[2];`,
      `appendFileSync(${JSON.stringify(log)}, ${JSON.stringify(label)} + " " + command + String.fromCharCode(10));`,
      `const codes = ${JSON.stringify(codes)};`,
      `const outputs = ${JSON.stringify(outputs)};`,
      `if (codes[command]) console.error(outputs[command] ?? "FAIL  " + command + " from " + ${JSON.stringify(label)});`,
      `process.exit(codes[command] ?? 0);`,
    ].join("\n"),
  );
  if (withDoctor) writeFileSync(path.join(cliDir, "doctor.mjs"), "");
}

/** A repository that adopted the kit, and a plugin whose bundled copy is older: its `check` fails. */
function workspace(t, installed) {
  const base = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-stop-gate-")));
  t.after(() => rmSync(base, { recursive: true, force: true }));
  const repo = path.join(base, "repo");
  mkdirSync(repo, { recursive: true });
  writeFileSync(path.join(repo, "qc.config.json"), "{}");
  const log = path.join(base, "qc-ran.log");
  const pluginRoot = path.join(base, "plugin");
  stubHarness(path.join(pluginRoot, "packages", "qc-harness", "src", "cli"), "plugin", log, { check: 1 }, false);
  if (installed) {
    const cli = path.join(repo, "node_modules", "architecture-harness", "src", "cli");
    stubHarness(cli, "installed", log, installed.codes, installed.withDoctor, installed.outputs);
  }
  const ran = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  // Each workspace owns its temp folder, so the gate's memory of a block is shared with no other test.
  const tmp = path.join(base, "tmp");
  mkdirSync(tmp, { recursive: true });
  const run = (input = {}) =>
    spawnSync("bash", [HOOK], {
      input: JSON.stringify({ hook_event_name: "Stop", ...input }),
      env: {
        ...process.env,
        CLAUDE_PROJECT_DIR: repo,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        QC_STOP_EXTRA: "",
        TMPDIR: tmp,
        TEMP: tmp,
        TMP: tmp,
      },
      encoding: "utf8",
    });
  return { ran, run, tmpDir: tmp, installedCli: installed ? path.join(repo, "node_modules", "architecture-harness", "src", "cli") : null };
}

test("an installed harness newer than the bundled one judges the repository, and the stop passes", (t) => {
  const ws = workspace(t, { codes: {}, withDoctor: false });
  const result = ws.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ws.ran(), ["installed check"]);
});

test("with no installed harness, the bundled copy judges the repository", (t) => {
  const ws = workspace(t, null);
  const result = ws.run();
  assert.equal(result.status, 2);
  assert.deepEqual(ws.ran(), ["plugin check"]);
  assert.match(result.stderr, /FAIL {2}check from plugin/);
});

test("drift alone refuses the first stop, and names the setup, not the code", (t) => {
  const ws = workspace(t, { codes: { doctor: 1 }, withDoctor: true });
  const result = ws.run();
  assert.equal(result.status, 2);
  assert.deepEqual(ws.ran(), ["installed doctor", "installed check"]);
  assert.match(result.stderr, /FAIL {2}doctor from installed/);
  assert.match(result.stderr, /kit setup, not in your code/);
});

test("drift alone after a refused stop lets the session end with a note, so a stale plugin never loops it", (t) => {
  const ws = workspace(t, { codes: { doctor: 1 }, withDoctor: true });
  const result = ws.run({ stop_hook_active: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).systemMessage, /The kit setup still drifts/);
});

test("a red check after a refused stop still refuses, because only drift is excused", (t) => {
  const ws = workspace(t, { codes: { doctor: 1, check: 1 }, withDoctor: true });
  const result = ws.run({ stop_hook_active: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /FAIL {2}check from installed/);
});

const HOOK_DRIFT = "FAIL  .githooks/pre-commit  hook-drift: pre-commit never calls `qc work-order-check`, so that step is off.";

test("hook drift reported only through qc check is drift, so a refused stop may end with a note", (t) => {
  const output = [HOOK_DRIFT, "", "1 problem(s). docs/enforcement.md"].join("\n");
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: output } });
  const refused = ws.run();
  assert.equal(refused.status, 2);
  assert.match(refused.stderr, /kit setup, not in your code/);
  const result = ws.run({ stop_hook_active: true });
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).systemMessage, /The kit setup still drifts/);
});

test("hook drift beside a real gate failure still refuses a stop after a refused one", (t) => {
  const output = [HOOK_DRIFT, "FAIL  orders  citations: ADR-0099 is cited but not defined", "", "2 problem(s)."].join("\n");
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: output } });
  const result = ws.run({ stop_hook_active: true });
  assert.equal(result.status, 2);
  assert.match(result.stderr, /citations: ADR-0099/);
});

test("a failure text with backslashes reaches stderr byte for byte", (t) => {
  const text = String.raw`FAIL  C:\Users\x\AppData\Local\Temp\tmp.x\new  a \t b \U c \n d`;
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: text } });
  const result = ws.run();
  assert.equal(result.status, 2);
  assert.ok(result.stderr.includes(text), result.stderr);
  assert.doesNotMatch(result.stderr, /printf/);
});

const SESSION_FAIL = "FAIL  orders  citations: ADR-0099 is cited but not defined";

test("a repeat stop with the same failure ends with a system message that names it", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  const first = ws.run({ session_id: "session-same" });
  assert.equal(first.status, 2);
  const repeat = ws.run({ session_id: "session-same", stop_hook_active: true });
  assert.equal(repeat.status, 0, repeat.stderr);
  const message = JSON.parse(repeat.stdout).systemMessage;
  assert.match(message, /still fails/);
  assert.ok(message.includes("ADR-0099 is cited but not defined"), message);
});

test("a repeat stop with a changed failure blocks again", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "session-changed" }).status, 2);
  writeFileSync(
    path.join(ws.installedCli, "qc.mjs"),
    `console.error(${JSON.stringify(SESSION_FAIL.replace("0099", "0100"))}); process.exit(1);`,
  );
  const repeat = ws.run({ session_id: "session-changed", stop_hook_active: true });
  assert.equal(repeat.status, 2);
  assert.match(repeat.stderr, /ADR-0100/);
  const third = ws.run({ session_id: "session-changed", stop_hook_active: true });
  assert.equal(third.status, 0, third.stderr);
});

test("a repeat stop with no session id blocks", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run().status, 2);
  assert.equal(ws.run({ stop_hook_active: true }).status, 2);
});

test("a first stop with stop_hook_active set and no earlier block still blocks", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "session-fresh", stop_hook_active: true }).status, 2);
});

test("a green gate forgets the last block, so the same failure later blocks again", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "session-green" }).status, 2);
  const qc = readFileSync(path.join(ws.installedCli, "qc.mjs"), "utf8");
  writeFileSync(path.join(ws.installedCli, "qc.mjs"), "process.exit(0);");
  assert.equal(ws.run({ session_id: "session-green" }).status, 0);
  writeFileSync(path.join(ws.installedCli, "qc.mjs"), qc);
  assert.equal(ws.run({ session_id: "session-green", stop_hook_active: true }).status, 2);
});

test("a session id with path characters cannot write outside the memory folder", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "../../escape" }).status, 2);
  assert.equal(existsSync(path.join(ws.tmpDir, "..", "escape.last")), false);
});

test("the same failure at a stop that follows no refusal blocks, because only a repeat block ends", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "session-plain" }).status, 2);
  assert.equal(ws.run({ session_id: "session-plain" }).status, 2);
});

test("a repeat stop names the first line of a failure that has no FAIL line", (t) => {
  const text = ["error TS2322: Type 'string' is not assignable to type 'number'.", "src/a.ts(1,1): more"].join("\n");
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: text } });
  assert.equal(ws.run({ session_id: "session-bare" }).status, 2);
  const repeat = ws.run({ session_id: "session-bare", stop_hook_active: true });
  assert.equal(repeat.status, 0, repeat.stderr);
  const message = JSON.parse(repeat.stdout).systemMessage;
  assert.ok(message.includes("error TS2322"), message);
  assert.ok(!message.includes("structure failed:"), message);
});

test("a repeat stop names the FAIL line when other output comes before it", (t) => {
  const text = ["OK    orders  structure", SESSION_FAIL].join("\n");
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: text } });
  assert.equal(ws.run({ session_id: "session-later" }).status, 2);
  const repeat = ws.run({ session_id: "session-later", stop_hook_active: true });
  assert.equal(repeat.status, 0, repeat.stderr);
  const message = JSON.parse(repeat.stdout).systemMessage;
  assert.ok(message.includes("ADR-0099 is cited but not defined"), message);
  assert.ok(!message.includes("OK    orders"), message);
});

test("the memory file holds a hash of the failure text, not the text", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "session-hash" }).status, 2);
  const stored = readFileSync(path.join(ws.tmpDir, "qc-stop-gate", "session-hash.last"), "utf8");
  assert.match(stored.trim(), /^[0-9a-f]{64}$/);
  assert.ok(!stored.includes("ADR-0099"));
});
