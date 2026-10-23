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
  // The typecheck and the lint run on every stop; `ran` lists the gates that judge the structure, `tools` the other two.
  const lines = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : []);
  const ran = () => lines().filter((line) => !/ (?:typecheck|lint)$/.test(line));
  const tools = () => lines().filter((line) => / (?:typecheck|lint)$/.test(line));
  // Each workspace owns its temp folder, so the gate's memory of a block is shared with no other test.
  const tmp = path.join(base, "tmp");
  mkdirSync(tmp, { recursive: true });
  const run = (input = {}, env = {}) =>
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
        ...env,
      },
      encoding: "utf8",
    });
  return { ran, tools, run, tmpDir: tmp, installedCli: installed ? path.join(repo, "node_modules", "architecture-harness", "src", "cli") : null };
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

test("drift alone never blocks: the stop passes with a note that names the setup", (t) => {
  const ws = workspace(t, { codes: { doctor: 1 }, withDoctor: true });
  const result = ws.run();
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(ws.ran(), ["installed doctor", "installed check"]);
  const message = JSON.parse(result.stdout).systemMessage;
  assert.match(message, /kit setup drifts/);
  assert.match(message, /FAIL {2}doctor from installed/);
});

test("a red check beside drift blocks, and the block text carries the code failure, not the drift", (t) => {
  const ws = workspace(t, { codes: { doctor: 1, check: 1 }, withDoctor: true });
  const result = ws.run();
  assert.equal(result.status, 2);
  assert.match(result.stderr, /FAIL {2}check from installed/);
  assert.doesNotMatch(result.stderr, /doctor from installed/);
});

const HOOK_DRIFT = "FAIL  .githooks/pre-commit  hook-drift: pre-commit never calls `qc work-order-check`, so that step is off.";

test("hook drift reported only through qc check is drift, so the stop passes with a note", (t) => {
  const output = [HOOK_DRIFT, "", "1 problem(s). docs/enforcement.md"].join("\n");
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: output } });
  const result = ws.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(JSON.parse(result.stdout).systemMessage, /kit setup drifts/);
});

test("hook drift beside a real gate failure blocks", (t) => {
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

/** A stop gate whose only failing step is `QC_STOP_EXTRA`, which prints the file the test rewrites and fails. */
function extraWorkspace(t) {
  const ws = workspace(t, { codes: {}, withDoctor: false });
  const file = path.join(ws.tmpDir, "extra.txt");
  const env = { QC_STOP_EXTRA: 'cat "$QC_TEST_EXTRA_FILE"; false', QC_TEST_EXTRA_FILE: file };
  return { run: (input) => ws.run(input, env), set: (lines) => writeFileSync(file, lines.map((line) => `${line}\n`).join("")) };
}

test("a repeat stop blocks when only an early error line beyond the last 20 changed", (t) => {
  const gate = extraWorkspace(t);
  const tail = Array.from({ length: 24 }, (_, i) => `error TS2322: line ${i + 2}`);
  gate.set(["error TS0001: first A", ...tail]);
  assert.equal(gate.run({ session_id: "session-long" }).status, 2);
  gate.set(["error TS0001: first B", ...tail]);
  const repeat = gate.run({ session_id: "session-long", stop_hook_active: true });
  assert.equal(repeat.status, 2, repeat.stdout);
  assert.equal(gate.run({ session_id: "session-long", stop_hook_active: true }).status, 0, "the same text again ends the turn");
});

test("a repeat stop whose only change is a clock time and a duration ends the turn", (t) => {
  const gate = extraWorkspace(t);
  gate.set(["Start at 10:22:11", "FAIL  orders  citations: ADR-0099 is cited but not defined", "Duration 12.34s (transform 3ms)", " ✓ src/a.test.ts (3 tests) 12ms", "ℹ duration_ms 812.5"]);
  assert.equal(gate.run({ session_id: "session-clock" }).status, 2);
  gate.set(["Start at 10:23:45.678", "FAIL  orders  citations: ADR-0099 is cited but not defined", "Duration 9ms (transform 41ms)", " ✓ src/a.test.ts (3 tests) 9ms", "ℹ duration_ms 79.1"]);
  const repeat = gate.run({ session_id: "session-clock", stop_hook_active: true });
  assert.equal(repeat.status, 0, repeat.stderr);
  assert.match(JSON.parse(repeat.stdout).systemMessage, /still fails/);
});

test("a repeat stop that changes a number beside a clock time and a duration still blocks", (t) => {
  const gate = extraWorkspace(t);
  gate.set(["Start at 10:22:11", "FAIL  ADR-0099 is cited but not defined", "Duration 12.34s"]);
  assert.equal(gate.run({ session_id: "session-digit" }).status, 2);
  gate.set(["Start at 10:23:45", "FAIL  ADR-0100 is cited but not defined", "Duration 1.5s"]);
  assert.equal(gate.run({ session_id: "session-digit", stop_hook_active: true }).status, 2);
});

test("a repeat stop whose only change is a duration inside an assertion message still blocks", (t) => {
  const gate = extraWorkspace(t);
  gate.set([" ✓ src/a.test.ts (3 tests) 12ms", "AssertionError: expected 200ms, received 400ms"]);
  assert.equal(gate.run({ session_id: "session-assert-ms" }).status, 2);
  gate.set([" ✓ src/a.test.ts (3 tests) 9ms", "AssertionError: expected 200ms, received 100ms"]);
  assert.equal(gate.run({ session_id: "session-assert-ms", stop_hook_active: true }).status, 2);
});

test("a repeat stop whose only change is a clock value inside an assertion message still blocks", (t) => {
  const gate = extraWorkspace(t);
  gate.set(["Start at 10:22:11", "AssertionError: expected 10:00:00, received 10:22:12"]);
  assert.equal(gate.run({ session_id: "session-assert-clock" }).status, 2);
  gate.set(["Start at 10:23:45", "AssertionError: expected 10:00:00, received 10:22:13"]);
  assert.equal(gate.run({ session_id: "session-assert-clock", stop_hook_active: true }).status, 2);
});

test("the memory file holds a hash of the failure text, not the text", (t) => {
  const ws = workspace(t, { codes: { check: 1 }, withDoctor: false, outputs: { check: SESSION_FAIL } });
  assert.equal(ws.run({ session_id: "session-hash" }).status, 2);
  const stored = readFileSync(path.join(ws.tmpDir, "qc-stop-gate", "session-hash.last"), "utf8");
  assert.match(stored.trim(), /^[0-9a-f]{64}$/);
  assert.ok(!stored.includes("ADR-0099"));
});

test("an installed harness with `qc lint` runs the typecheck and the lint, and an older one leaves both to the plugin", (t) => {
  const current = workspace(t, { codes: {}, withDoctor: false });
  writeFileSync(path.join(current.installedCli, "lint-changed.mjs"), "");
  assert.equal(current.run().status, 0);
  assert.deepEqual(current.tools(), ["installed typecheck", "installed lint"]);
  const older = workspace(t, { codes: {}, withDoctor: false });
  assert.equal(older.run().status, 0);
  assert.deepEqual(older.tools(), ["plugin typecheck", "plugin lint"]);
});

test("a red typecheck or a red lint blocks, each under its own heading", (t) => {
  for (const command of ["typecheck", "lint"]) {
    const ws = workspace(t, { codes: { [command]: 1 }, withDoctor: false });
    writeFileSync(path.join(ws.installedCli, "lint-changed.mjs"), "");
    const result = ws.run();
    assert.equal(result.status, 2);
    assert.match(result.stderr, new RegExp(`${command} failed:\nFAIL {2}${command} from installed`));
    assert.match(result.stderr, /The change is red/);
  }
});

/** A workspace whose repository is a git repository with one commit, so the gate can fingerprint it. */
function gitWorkspace(t, installed = { codes: {}, withDoctor: false }) {
  const ws = workspace(t, installed);
  const repo = path.join(path.dirname(ws.tmpDir), "repo");
  const git = (...args) => {
    const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd: repo, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
  };
  writeFileSync(path.join(repo, ".gitignore"), "node_modules\n");
  writeFileSync(path.join(repo, "a.txt"), "one\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "first");
  return { ...ws, repo, git };
}

test("a second stop on an unchanged checkout skips the gate", (t) => {
  const ws = gitWorkspace(t);
  assert.equal(ws.run().status, 0);
  assert.deepEqual(ws.ran(), ["installed check"]);
  assert.equal(ws.run().status, 0);
  assert.deepEqual(ws.ran(), ["installed check"]);
});

test("an edited tracked file makes the next stop run the full gate", (t) => {
  const ws = gitWorkspace(t);
  ws.run();
  writeFileSync(path.join(ws.repo, "a.txt"), "two\n");
  ws.run();
  assert.equal(ws.ran().length, 2);
  writeFileSync(path.join(ws.repo, "a.txt"), "three\n");
  ws.run();
  assert.equal(ws.ran().length, 3);
});

test("a new untracked file makes the next stop run the full gate", (t) => {
  const ws = gitWorkspace(t);
  ws.run();
  writeFileSync(path.join(ws.repo, "b.txt"), "new\n");
  ws.run();
  assert.equal(ws.ran().length, 2);
  ws.run();
  assert.equal(ws.ran().length, 2);
});

test("a new commit makes the next stop run the full gate", (t) => {
  const ws = gitWorkspace(t);
  ws.run();
  ws.git("commit", "-q", "--allow-empty", "-m", "second");
  ws.run();
  assert.equal(ws.ran().length, 2);
});

test("a new installed harness on an unchanged checkout makes the next stop run the full gate", (t) => {
  const ws = gitWorkspace(t);
  ws.run();
  writeFileSync(path.join(ws.repo, "node_modules", "architecture-harness", "package.json"), '{"version":"9.9.9"}');
  ws.run();
  assert.equal(ws.ran().length, 2);
  ws.run();
  assert.equal(ws.ran().length, 2);
});

test("a new extra stop step on an unchanged checkout makes the next stop run the full gate", (t) => {
  const ws = gitWorkspace(t);
  ws.run();
  ws.run({}, { QC_STOP_EXTRA: "true" });
  assert.equal(ws.ran().length, 2);
});

test("a red first run stores nothing, so the next stop runs the full gate again", (t) => {
  const ws = gitWorkspace(t, { codes: { check: 1 }, withDoctor: false });
  assert.equal(ws.run().status, 2);
  assert.equal(ws.run().status, 2);
  assert.equal(ws.ran().length, 2);
});

test("a repository that is no git checkout always runs the full gate", (t) => {
  const ws = workspace(t, { codes: {}, withDoctor: false });
  ws.run();
  ws.run();
  assert.equal(ws.ran().length, 2);
});

test("two checkout roots do not share a fingerprint", (t) => {
  const a = gitWorkspace(t);
  const b = gitWorkspace(t);
  // Same temp folder, same content, same commit shape: only the root path differs.
  const shared = { TMPDIR: a.tmpDir, TEMP: a.tmpDir, TMP: a.tmpDir };
  const runIn = (ws) =>
    spawnSync("bash", [HOOK], {
      input: JSON.stringify({ hook_event_name: "Stop" }),
      env: { ...process.env, CLAUDE_PROJECT_DIR: ws.repo, CLAUDE_PLUGIN_ROOT: path.join(path.dirname(ws.tmpDir), "plugin"), QC_STOP_EXTRA: "", ...shared },
      encoding: "utf8",
    });
  runIn(a);
  runIn(b);
  assert.equal(a.ran().length, 1);
  assert.equal(b.ran().length, 1);
  runIn(a);
  assert.equal(a.ran().length, 1);
});
