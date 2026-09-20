import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { needsLoader, parseInput, runRun } from "./run.mjs";
import { listing } from "./run-dispatch.mjs";

test("--json carries the whole input", () => {
  assert.deepEqual(parseInput(["--json", '{"projectId":"P3","qty":12}']), { projectId: "P3", qty: 12 });
});

test("--key value pairs build an input without any json", () => {
  assert.deepEqual(parseInput(["--project", "P3", "--title", "a task"]), { project: "P3", title: "a task" });
});

test("--key=value is read the same way", () => {
  assert.deepEqual(parseInput(["--project=P3"]), { project: "P3" });
});

test("a flag with no value reads as true rather than swallowing the next flag", () => {
  assert.deepEqual(parseInput(["--dry-run", "--project", "P3"]), { "dry-run": "true", project: "P3" });
});

test("a pair overrides the same key inside --json", () => {
  assert.deepEqual(parseInput(["--json", '{"project":"P1"}', "--project", "P3"]), { project: "P3" });
});

test("invalid json fails loudly rather than dispatching an empty input", () => {
  assert.throws(() => parseInput(["--json", "{nope"]), /not valid JSON/);
});

test("a typescript registry needs the configured loader, a javascript one does not", () => {
  assert.equal(needsLoader("a/commands.generated.ts", ["tsx"]), true);
  assert.equal(needsLoader("a/commands.generated.mjs", ["tsx"]), false);
  assert.equal(needsLoader("a/commands.generated.ts", []), false);
});

test("the listing names every command, sorted, with its description", () => {
  const commands = { "tasks.kanban": { describe: "board columns" }, "progress.entries": {} };
  assert.deepEqual(listing(commands), ["  progress.entries", `  ${"tasks.kanban".padEnd(38)}board columns`]);
});

test("a repository that configures no registry is told so rather than crashing", async () => {
  const code = await runRun({ root: process.cwd(), cli: {} }, ["tasks.kanban"]);
  assert.equal(code, 1);
});

test("a configured registry that does not exist names codegen as the fix", async () => {
  const code = await runRun({ root: process.cwd(), cli: { registry: "nowhere/commands.generated.ts" } }, []);
  assert.equal(code, 1);
});

test("a javascript registry dispatches in process and returns the command's result", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qc-run-"));
  const registry = "commands.generated.mjs";
  await writeFile(
    path.join(dir, registry),
    'export const commands = { "tasks.kanban": { run: (input) => ({ seen: input }) } };',
  );
  const code = await runRun({ root: dir, cli: { registry, loader: [] } }, ["tasks.kanban", "--project", "P3"]);
  assert.equal(code, 0);
});

test("an unknown command fails and does not run anything", async () => {
  const dir = await mkdtemp(path.join(tmpdir(), "qc-run-"));
  const registry = "commands.generated.mjs";
  await writeFile(path.join(dir, registry), 'export const commands = { "tasks.kanban": { run: () => 1 } };');
  const code = await runRun({ root: dir, cli: { registry, loader: [] } }, ["tasks.nope"]);
  assert.equal(code, 1);
});
