import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { filePlanStore } from "./plan-store.mjs";
const tempDir = (t) => { const root = mkdtempSync(path.join(tmpdir(), "qc-plan-")); t.after(() => rmSync(root, {recursive:true, force:true, maxRetries:5, retryDelay:100})); return root; };
test("the file store writes, reads and lists plans", (t) => {
  const root = tempDir(t);
  const store = filePlanStore(root);
  store.write("docs/plans/12-demo.md", "x\n");
  assert.equal(store.read("docs/plans/12-demo.md"), "x\n");
  assert.deepEqual(store.list(), ["docs/plans/12-demo.md"]);
  assert.equal(existsSync(path.join(root, "docs/plans/12-demo.md.tmp")), false);
});
test("the file store lists nothing without the folder", (t) => assert.deepEqual(filePlanStore(tempDir(t)).list(), []));
test("the file store refuses a ref outside its root", (t) => {
  const store = filePlanStore(tempDir(t));
  assert.throws(() => store.read("../other/plan.md"), /outside/);
  assert.throws(() => store.write("../other/plan.md", "x"), /outside/);
});
