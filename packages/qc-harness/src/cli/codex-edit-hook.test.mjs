import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseCodexPatch } from "./codex-edit-hook.mjs";
import { decideCodexHook, runCodexHook } from "./codex-hook.mjs";

// openai/codex rust-v0.172.0 codex-rs/apply-patch/src/{parser,streaming_parser}.rs.
const patch = (...lines) => ["*** Begin Patch", ...lines, "*** End Patch"].join("\n");
function workspace(t) {
  const cwd = mkdtempSync(path.join(tmpdir(), "qc-codex-edit-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  return cwd;
}

test("0.172.0 fixtures cover add, delete, multi-chunk update, move, and literal escaped paths", (t) => {
  const cwd = workspace(t);
  const literal = process.platform === "win32" ? "space name.ts" : 'space "quoted" \\name.ts';
  const input = patch(`*** Add File: ${literal}`, "+$(touch NEVER_EXECUTE)", "+*** Delete File: decoy",
    "*** Delete File: removed.ts", "*** Update File: old.ts", "*** Move to: new.ts", "@@ function f()",
    " before", "-old", "+new", "@@", "+tail", "*** End of File");
  const operations = parseCodexPatch(input, cwd);
  assert.deepEqual(operations.map(op => [op.kind, op.file, op.destination]), [
    ["add", path.resolve(cwd, literal), undefined], ["delete", path.resolve(cwd, "removed.ts"), undefined],
    ["update", path.resolve(cwd, "old.ts"), path.resolve(cwd, "new.ts")],
  ]);
  assert.equal(operations[0].content, "$(touch NEVER_EXECUTE)\n*** Delete File: decoy\n");
  assert.deepEqual(operations[2].chunks.map(c => [c.old.join("\n"), c.next.join("\n")]),
    [["before\nold", "before\nnew"], ["", "tail"]]);
  for (const opener of ["<<EOF", "<<'EOF'", '<<"EOF"']) {
    assert.deepEqual(parseCodexPatch(`${opener}\n${input}\nEOF`, cwd), operations);
  }
  assert.deepEqual(parseCodexPatch(patch("*** Update File: ./a.ts", "-old", "+new"), cwd)[0].file, path.join(cwd, "a.ts"));
});

// 0.172.0 core/src/tools/handlers/apply_patch.rs and context.rs: command input, string response.
const wire = (cwd, command, extra = {}) => ({ cwd, session_id: "stable", turn_id: "turn", tool_use_id: "call",
  hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { command }, ...extra });
const options = { role: "leader" };
test("every patch member and both move endpoints reach all shared entry points with stable identity and notes", async (t) => {
  const cwd = workspace(t), seen = [];
  writeFileSync(path.join(cwd, "old.ts"), "before\nold\n");
  const input = patch("*** Add File: ./new.ts", "+safe", "*** Delete File: gone.ts",
    "*** Update File: old.ts", "*** Move to: moved.ts", "@@", " before", "-old", "+new");
  const guards = Array.from({ length: 5 }, (_, index) => (call, root) => {
    assert.equal(root, cwd); assert.equal(call.session_id, "stable"); assert.equal(call.agent_type, "leader");
    seen.push([index, path.basename(call.tool_input.file_path), call.tool_input.content]);
    return { hookSpecificOutput: { additionalContext: `note-${index}` } };
  });
  const result = await decideCodexHook(wire(cwd, input), options, { editGuards: guards });
  assert.deepEqual(seen.filter(([i]) => i === 0).map(([, f, content]) => [f, content]),
    [["new.ts", "safe\n"], ["gone.ts", ""], ["old.ts", ""], ["moved.ts", "before\nnew\n"]]);
  assert.equal(seen.length, 20); assert.match(result.hookSpecificOutput.additionalContext, /note-0.*note-4/);
  assert.equal(existsSync(path.join(cwd, "new.ts")), false);
  assert.equal(readFileSync(path.join(cwd, "old.ts"), "utf8"), "before\nold\n");
});

test("real scope, generated regions, controller, reuse hints, and slot policies govern mixed patches", async (t) => {
  const cwd = workspace(t);
  const git = (...args) => execFileSync("git", args, { cwd, stdio: "pipe" });
  git("init", "-q"); mkdirSync(path.join(cwd, ".claude"));
  const config = value => writeFileSync(path.join(cwd, "qc.config.json"), JSON.stringify(value));
  const denied = async (lines, reason, extra = {}, opts = options) => {
    const result = await decideCodexHook(wire(cwd, patch("*** Add File: okay.ts", "+ok", ...lines), extra), opts);
    assert.equal(result.hookSpecificOutput.permissionDecision, "deny");
    assert.match(result.hookSpecificOutput.permissionDecisionReason, reason);
  };
  config({}); writeFileSync(path.join(cwd, ".claude/work-order.local.json"), JSON.stringify({ paths: ["okay.ts"] }));
  await denied(["*** Delete File: denied.ts"], /outside this work order/);
  await denied(["*** Add File: sub/../denied.ts", "+x"], /outside this work order/);
  mkdirSync(path.join(cwd, "nested"));
  const nested = await decideCodexHook(wire(path.join(cwd, "nested"), patch("*** Add File: denied.ts", "+x")), options);
  assert.match(nested.hookSpecificOutput.permissionDecisionReason, /outside this work order/);
  rmSync(path.join(cwd, ".claude/work-order.local.json"));
  await denied(["*** Add File: routes.generated.ts", "+x"], /Generated-file guard/);
  const doc = "Intro\n<!-- generated: test. -->\nlocked\n<!-- /generated -->\n";
  writeFileSync(path.join(cwd, "doc.md"), doc);
  await denied(["*** Update File: doc.md", "@@", "-locked", "+changed"], /generated region/);
  await denied(["*** Delete File: doc.md"], /generated region/);
  const allowed = await decideCodexHook(wire(cwd, patch("*** Update File: doc.md", "@@", "-Intro", "+New intro")), options);
  assert.equal(allowed, null);
  writeFileSync(path.join(cwd, "old.ts"), "x\n");
  await denied(["*** Update File: old.ts", "*** Move to: routes.generated.ts", "@@", "-x", "+y"], /Generated-file guard/);
  writeFileSync(path.join(cwd, "routes.generated.ts"), "x\n");
  await denied(["*** Update File: routes.generated.ts", "*** Move to: safe.ts", "@@", "-x", "+y"], /Generated-file guard/);
  config({ swarm: { dispatch: {}, direct: false } });
  await denied(["*** Add File: other.ts", "+x"], /Controller guard/);
  config({});
  await denied(["*** Delete File: architecture-kit/gate-slots/slot.json"], /Slot guard/,
    { agent_id: "child", agent_type: "default" }, { role: "implementer" });
  config({ ui: { componentRoots: ["components"] } }); mkdirSync(path.join(cwd, "components"));
  writeFileSync(path.join(cwd, "components/Button.tsx"), "export function Button() { return <button />; }\n");
  const hint = await decideCodexHook(wire(cwd, patch("*** Add File: components/NewButton.tsx", "+export function Button() {}")), options);
  assert.match(hint.hookSpecificOutput.additionalContext, /Existing components.*Button/);
});

test("patch errors and missing identity block through the CLI boundary before evaluation", async (t) => {
  const cwd = workspace(t), errors = [];
  const event = wire(cwd, patch("*** Add File: a", "+x"));
  for (const input of [ ...["cwd", "session_id", "turn_id", "tool_use_id"].map(key => ({ ...event, [key]: "" })),
    { ...event, tool_input: { patch: event.tool_input.command } },
    wire(cwd, patch("*** Add File: a", "+x", "*** Unsupported: b")) ]) {
    assert.equal(await runCodexHook(["--role", "leader"], { stdin: [JSON.stringify(input)],
      editGuards: [() => assert.fail("must parse/validate first")], error: value => errors.push(value) }), 2);
  }
  assert.equal(errors.length, 6);
});

test("post-edit checks visit every touched endpoint, retain context, and report failures after the edit", async (t) => {
  const cwd = workspace(t), seen = [], errors = [], output = [];
  const event = wire(cwd, patch("*** Add File: a.ts", "+x", "*** Delete File: b.ts", "*** Update File: old.ts",
    "*** Move to: new.ts", "@@", "-x", "+y", "*** Add File: doc.md", "+text"),
  { hook_event_name: "PostToolUse", tool_response: "Success. Updated the following files:\nA a.ts\nD b.ts\nM new.ts" });
  const postEdit = (bin, args, opts) => {
    assert.equal(bin, "bash"); assert.match(args[0], /post-edit-gate\.sh$/);
    const file = JSON.parse(opts.input).tool_input.file_path;
    seen.push(path.basename(file)); assert.equal(opts.cwd, cwd);
    return { status: 0, stderr: "", stdout: JSON.stringify({ hookSpecificOutput: { additionalContext: file } }) };
  };
  const result = await decideCodexHook(event, options, { postEdit });
  assert.deepEqual(seen, ["a.ts", "b.ts", "old.ts", "new.ts"]);
  assert.equal(result.hookSpecificOutput.hookEventName, "PostToolUse");
  assert.match(result.hookSpecificOutput.additionalContext, /a\.ts.*b\.ts.*old\.ts.*new\.ts/);
  seen.length = 0;
  assert.equal(await runCodexHook(["--role", "leader"], { stdin: [JSON.stringify(event)],
    write: value => output.push(value), error: value => errors.push(value), postEdit: (...args) => {
      postEdit(...args); return { status: 2, stdout: "", stderr: "original gate failure" };
    } }), 2);
  assert.equal(seen.length, 4); assert.deepEqual(output, []);
  assert.match(errors[0], /post-edit.*already.*original gate failure/);
  await assert.rejects(decideCodexHook(event, options, { postEdit: () => ({ status: null, error: new Error("spawn failed") }) }), /spawn failed/);
  await assert.rejects(decideCodexHook(event, options, { postEdit: () => { throw new Error("thrown spawn failure"); } }), /post-edit.*already.*thrown spawn failure/);
});

test("uncertain previews fail closed, CRLF stays intact, and denial notes survive", async (t) => {
  const cwd = workspace(t), file = path.join(cwd, "a.ts");
  const update = text => wire(cwd, patch("*** Update File: a.ts", "@@", "-old", `+${text}`));
  writeFileSync(file, "old\r\n");
  await decideCodexHook(update("new"), options, { editGuards: [call => { assert.equal(call.tool_input.content, "new\r\n"); }] });
  for (const text of [" old \n", "old\r\nother\n", "binary\0"]) {
    writeFileSync(file, text);
    await assert.rejects(decideCodexHook(update("new"), options), /unsupported|binary/);
  }
  rmSync(file); mkdirSync(file);
  await assert.rejects(decideCodexHook(update("new"), options), /EISDIR|EPERM|EACCES/);
  const event = wire(cwd, patch("*** Add File: a", "+x", "*** Add File: b", "+y"));
  const result = await decideCodexHook(event, options, { editGuards: [() => ({ hookSpecificOutput: {
    permissionDecision: "deny", permissionDecisionReason: "blocked member", additionalContext: "retain note" } })] });
  assert.equal(result.hookSpecificOutput.additionalContext, "retain note");
  await assert.rejects(decideCodexHook(event, options, { editGuards: [() => ({ hookSpecificOutput: {
    additionalContext: "Direct lane: individually small" } })] }), /multi-path.*Direct lane:/);
  assert.throws(() => parseCodexPatch(patch("*** Add File: a", "+x", "*** Delete File: ./a"), cwd), /overlapping/);
});

test("malformed and unsupported patch operations fail closed before any member is checked", (t) => {
  const cwd = workspace(t);
  for (const input of [null, {}, "", "*** Begin Patch\n", patch("*** Rename File: a"),
    patch("*** Add File: a", "unprefixed"), patch("*** Delete File: a", "+bad"),
    patch("*** Update File: a"), patch("*** Update File: a", "@@", "bad"), patch("*** Add File: ", "+x"),
    patch("*** Update File: a", "*** Move to: ", "@@", "+x"), patch("*** Add File: a\0b", "+x"),
    patch("*** Environment ID: remote", "*** Add File: a", "+x")]) {
    assert.throws(() => parseCodexPatch(input, cwd), /Codex patch:/);
  }
});
