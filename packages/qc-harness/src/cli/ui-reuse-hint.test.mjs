import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { decide, exportedNames } from "./ui-reuse-hint.mjs";

const UI = "frontend/src/platform/ui";

function project() {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-hint-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  writeFileSync(path.join(root, "qc.config.json"), "{}");
  mkdirSync(path.join(root, UI), { recursive: true });
  writeFileSync(path.join(root, UI, "confirm-dialog.tsx"), "/** Asks the user to confirm a destructive action. */\nexport const ConfirmDialog = () => null;\n");
  return root;
}

const write = (root, rel, content) => ({ tool_name: "Write", cwd: root, tool_input: { file_path: path.join(root, rel), content } });

test("a new component file under the roots gets the components that may already do the job", async () => {
  const root = project();
  try {
    const out = await decide(write(root, `${UI}/confirm-modal.tsx`, "export const Modal = () => null;"));
    const text = out.hookSpecificOutput.additionalContext;
    assert.equal(out.hookSpecificOutput.hookEventName, "PreToolUse");
    assert.equal(out.hookSpecificOutput.permissionDecision, undefined);
    assert.match(text, /^Existing components that may already do this: ConfirmDialog \(frontend\/src\/platform\/ui\/confirm-dialog\.tsx\)\./);
    assert.match(text, /Reuse or extend one; write a new one only when none fits, and say why in its JSDoc\.$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a file that exists, is outside the roots, is not tsx, or matches nothing gets no message", async () => {
  const root = project();
  try {
    assert.equal(await decide(write(root, `${UI}/confirm-dialog.tsx`, "export const ConfirmDialog = () => null;")), null);
    assert.equal(await decide(write(root, "frontend/src/pages/confirm-page.tsx", "export const ConfirmPage = () => null;")), null);
    assert.equal(await decide(write(root, `${UI}/confirm-thing.ts`, "export const x = 1;")), null);
    assert.equal(await decide(write(root, `${UI}/zebra.tsx`, "export const Zebra = () => null;")), null);
    assert.equal(await decide({ tool_name: "Edit", cwd: root, tool_input: { file_path: path.join(root, `${UI}/new.tsx`) } }), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a repository with no config file gets no message", async () => {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-hint-"));
  try {
    assert.equal(await decide(write(root, `${UI}/confirm.tsx`, "export const Confirm = () => null;")), null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("exportedNames reads declared and listed exports", () => {
  assert.deepEqual(exportedNames("export const A = 1;\nexport default function B() {}\nconst c = 1; export { c, C as D };"), ["A", "B", "D"]);
});
