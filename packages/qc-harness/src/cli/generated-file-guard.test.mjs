import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { decide } from "./generated-file-guard.mjs";

const GUARD = fileURLToPath(new URL("./generated-file-guard.mjs", import.meta.url));

const ENFORCEMENT = [
  "# Enforcement",
  "",
  "Hand-written intro.",
  "",
  "<!-- generated: rule-to-check. pnpm codegen. -->",
  "",
  "| Rule | Check |",
  "| A comment is one line | `qc/comment-style` |",
  "",
  "<!-- /generated -->",
  "",
  "Hand-written judgement calls.",
  "",
].join("\n");

/** A checkout with the given config, holding a generated file, its source, and a doc with a generated region. */
function workspace(t, config = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-generated-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  execFileSync("git", ["init", "-q"], { cwd: root, stdio: "pipe" });
  if (config !== null) writeFileSync(path.join(root, "qc.config.json"), JSON.stringify(config));
  for (const dir of ["src", "docs", "gen"]) mkdirSync(path.join(root, dir));
  writeFileSync(path.join(root, "docs", "enforcement.md"), ENFORCEMENT);
  writeFileSync(path.join(root, "docs", "crlf.md"), ENFORCEMENT.replace(/\n/g, "\r\n"));
  return { root, at: (rel) => path.join(root, rel) };
}

const edit = (file, old_string, tool_input = {}) => ({
  hook_event_name: "PreToolUse",
  tool_name: "Edit",
  cwd: path.dirname(file),
  tool_input: { file_path: file, old_string, new_string: "x", ...tool_input },
});
const write = (file) => ({ ...edit(file, ""), tool_name: "Write", tool_input: { file_path: file, content: "x" } });
const reasonOf = (output) => (output?.hookSpecificOutput?.permissionDecision === "deny" ? output.hookSpecificOutput.permissionDecisionReason : null);

test("an edit of a generated file is denied, and the reason names the command that writes it", (t) => {
  const ws = workspace(t);
  for (const call of [edit(ws.at("src/routes.generated.ts"), "a"), write(ws.at("src/routes.generated.ts"))]) {
    const reason = reasonOf(decide(call));
    assert.match(reason, /src\/routes\.generated\.ts is generated/);
    assert.match(reason, /`pnpm codegen`/);
  }
});

test("an edit of the generated file's source passes", (t) => {
  const ws = workspace(t);
  assert.equal(decide(edit(ws.at("src/routes.ts"), "a")), null);
  assert.equal(decide(write(ws.at("src/routes.ts"))), null);
});

test("generated.globs and generated.command in qc.config.json replace the defaults", (t) => {
  const ws = workspace(t, { generated: { globs: ["gen/**"], command: "npm run gen" } });
  assert.match(reasonOf(decide(write(ws.at("gen/a.ts")))), /`npm run gen`/);
  assert.equal(decide(write(ws.at("src/routes.generated.ts"))), null);
});

test("an edit whose old_string lies in or across a generated region is denied", (t) => {
  const ws = workspace(t);
  const doc = ws.at("docs/enforcement.md");
  assert.match(reasonOf(decide(edit(doc, "| A comment is one line | `qc/comment-style` |"))), /generated region of docs\/enforcement\.md/);
  assert.ok(reasonOf(decide(edit(doc, "Hand-written intro.\n\n<!-- generated: rule-to-check."))));
  assert.ok(reasonOf(decide(edit(ws.at("docs/crlf.md"), "| Rule | Check |\n| A comment"))));
  const multi = {
    tool_name: "MultiEdit",
    tool_input: { file_path: doc, edits: [{ old_string: "Hand-written intro." }, { old_string: "| Rule | Check |" }] },
  };
  assert.ok(reasonOf(decide({ ...edit(doc, ""), ...multi })));
});

test("an edit outside the generated region passes", (t) => {
  const ws = workspace(t);
  assert.equal(decide(edit(ws.at("docs/enforcement.md"), "Hand-written judgement calls.")), null);
  assert.equal(decide(edit(ws.at("docs/enforcement.md"), "Hand-written intro.", { replace_all: true })), null);
});

test("a repository with no qc.config.json is never guarded", (t) => {
  const ws = workspace(t, null);
  assert.equal(decide(write(ws.at("src/routes.generated.ts"))), null);
});

test("the hook process prints the deny", (t) => {
  const ws = workspace(t);
  const result = spawnSync(process.execPath, [GUARD], { input: JSON.stringify(write(ws.at("src/a.generated.ts"))), encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).hookSpecificOutput.permissionDecision, "deny");
});
