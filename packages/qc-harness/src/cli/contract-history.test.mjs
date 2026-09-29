import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { contractHistory } from "./contract-history.mjs";

const git = (dir, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });
const options = {
  base: "main",
  contract: "contracts/openapi.yaml",
  legacy: "contracts/idempotency-legacy.json",
  fields: ["mutationId"],
  exemptDeleteById: true,
};
const CONTRACT = "paths:\n  /v1/a:\n    post:\n      operationId: createA\n    get:\n      operationId: listA\n";

/** A repository whose one commit holds `files` under `folder`. The history is asked from `folder`. */
function committed(files, folder = "") {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-history-"));
  git(dir, "init", "-q", "-b", "main");
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(dir, folder, name);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, text);
  }
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "base");
  return { root: path.join(dir, folder), done: () => rmSync(dir, { recursive: true, force: true }) };
}

test("the operations and the ledger are read as they stood at the merge base, and owed marks a missing key", async () => {
  const repo = committed({ "contracts/openapi.yaml": CONTRACT, "contracts/idempotency-legacy.json": '["createA"]' });
  const found = await contractHistory(repo.root, options);
  repo.done();
  assert.deepEqual(found.ledger, ["createA"]);
  assert.deepEqual(found.operations, [
    { id: "createA", method: "post", path: "/v1/a", owed: true },
    { id: "listA", method: "get", path: "/v1/a", owed: false },
  ]);
});

test("a root that is a folder inside the repository reads its own files", async () => {
  const repo = committed({ "contracts/openapi.yaml": CONTRACT, "contracts/idempotency-legacy.json": '["createA"]' }, "service");
  const found = await contractHistory(repo.root, options);
  repo.done();
  assert.deepEqual(found.ledger, ["createA"]);
  assert.equal(found.operations.length, 2);
});

test("a malformed base ledger reads as empty", async () => {
  const repo = committed({ "contracts/openapi.yaml": CONTRACT, "contracts/idempotency-legacy.json": "{not json" });
  const found = await contractHistory(repo.root, options);
  repo.done();
  assert.deepEqual(found.ledger, []);
  assert.equal(found.operations.length, 2);
});

test("a contract absent at the base holds no operations, so every ledger id is new", async () => {
  const repo = committed({ "README.md": "x\n" });
  const found = await contractHistory(repo.root, options);
  repo.done();
  assert.deepEqual(found, { ledger: [], operations: [] });
});

test("a base contract that does not parse is reported, not skipped", async () => {
  const repo = committed({ "contracts/openapi.yaml": "paths: [unclosed\n" });
  const found = await contractHistory(repo.root, options);
  repo.done();
  assert.equal(found.skip, undefined);
  assert.match(found.unreadable, /merge base/);
});

test("no ref, and no repository, skip with a reason", async () => {
  const repo = committed({ "README.md": "x\n" });
  assert.match((await contractHistory(repo.root, { ...options, base: "no-such-ref" })).skip, /no ref 'no-such-ref'/);
  repo.done();
  const bare = mkdtempSync(path.join(tmpdir(), "qc-history-"));
  try {
    assert.match((await contractHistory(bare, options)).skip, /no git/);
  } finally {
    rmSync(bare, { recursive: true, force: true });
  }
});
