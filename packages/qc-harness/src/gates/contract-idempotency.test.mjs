import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { defaults, load } from "../config.mjs";
import { runCheck } from "../cli/check.mjs";
import { checkContractIdempotency, checkLedgerGrowth, isDeleteById } from "./contract-idempotency.mjs";

const options = {
  fields: ["mutationId", "idempotencyKey"],
  exemptDeleteById: true,
  contract: "contracts/openapi.yaml",
  ledger: "contracts/idempotency-legacy.json",
};

const op = (method, path, extra = {}) => ({ method, path, id: extra.id ?? `${method.toUpperCase()} ${path}`, params: [], bodyProps: [], ...extra });

test("a new POST without the field fails as missing-idempotency-field", () => {
  const found = checkContractIdempotency([op("post", "/v1/boards", { bodyProps: ["name"] })], [], options);
  assert.deepEqual(found.map((problem) => problem.rule), ["missing-idempotency-field"]);
  assert.equal(found[0].path, "contracts/openapi.yaml");
  assert.match(found[0].detail, /POST \/v1\/boards/);
  assert.match(found[0].detail, /mutationId, idempotencyKey/);
});

test("a legacy POST passes", () => {
  const found = checkContractIdempotency([op("post", "/v1/boards", { id: "createBoard" })], ["createBoard"], options);
  assert.deepEqual(found, []);
});

test("a legacy entry whose operation now declares the field fails, so the ledger shrinks", () => {
  const found = checkContractIdempotency(
    [op("post", "/v1/boards", { id: "createBoard", bodyProps: ["mutationId"] })],
    ["createBoard"],
    options,
  );
  assert.deepEqual(found.map((problem) => problem.rule), ["legacy-now-declares"]);
  assert.equal(found[0].path, "contracts/idempotency-legacy.json");
  assert.match(found[0].detail, /createBoard/);
});

test("a legacy entry for a removed operation fails", () => {
  const found = checkContractIdempotency([], ["createBoard"], options);
  assert.deepEqual(found.map((problem) => problem.rule), ["legacy-now-declares"]);
  assert.match(found[0].detail, /no longer in the contract/);
});

test("a legacy entry for an operation that needs none fails", () => {
  const found = checkContractIdempotency([op("get", "/v1/boards", { id: "listBoards" })], ["listBoards"], options);
  assert.deepEqual(found.map((problem) => problem.rule), ["legacy-now-declares"]);
});

test("DELETE by id is exempt when exemptDeleteById is on", () => {
  const remove = op("delete", "/v1/boards/{id}");
  assert.deepEqual(checkContractIdempotency([remove], [], options), []);
  const found = checkContractIdempotency([remove], [], { ...options, exemptDeleteById: false });
  assert.deepEqual(found.map((problem) => problem.rule), ["missing-idempotency-field"]);
});

test("DELETE of a collection is not a delete by id", () => {
  assert.equal(isDeleteById(op("delete", "/v1/boards/{id}")), true);
  assert.equal(isDeleteById(op("delete", "/v1/boards/:id")), true);
  assert.equal(isDeleteById(op("delete", "/v1/boards/{id}/photos")), false);
  assert.equal(isDeleteById(op("post", "/v1/boards/{id}")), false);
  const found = checkContractIdempotency([op("delete", "/v1/boards")], [], options);
  assert.deepEqual(found.map((problem) => problem.rule), ["missing-idempotency-field"]);
});

test("the field as a parameter passes; the field as a body property passes", () => {
  const asParam = op("put", "/v1/boards/{id}", { params: ["id", "idempotencyKey"] });
  const asBody = op("patch", "/v1/boards/{id}", { bodyProps: ["mutationId", "name"] });
  assert.deepEqual(checkContractIdempotency([asParam, asBody], [], options), []);
});

test("a read is never judged", () => {
  assert.deepEqual(checkContractIdempotency([op("get", "/v1/boards"), op("head", "/v1/boards")], [], options), []);
});

test("every failing operation is named once, in the order the contract lists it", () => {
  const found = checkContractIdempotency([op("post", "/v1/a"), op("put", "/v1/b"), op("patch", "/v1/c")], [], options);
  assert.deepEqual(found.map((problem) => problem.detail.match(/(POST|PUT|PATCH) \/v1\/\w/)[0]), ["POST /v1/a", "PUT /v1/b", "PATCH /v1/c"]);
});

const GATE_RULES = new Set([
  "missing-idempotency-field",
  "legacy-now-declares",
  "legacy-grew",
  "unreadable-contract",
  "unreadable-ledger",
  "contract-reader-unavailable",
]);

// The runner reads the contract and the ledger from disk and reports what the gate finds.
async function checked({ contract, ledger, gates = { "contract-idempotency": true }, overrides = {} }) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-idem-"));
  try {
    execFileSync("git", ["init", "-q"], { cwd: dir });
    mkdirSync(path.join(dir, "contracts"), { recursive: true });
    const file = overrides.contract ?? "contracts/openapi.yaml";
    mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    if (contract !== undefined) writeFileSync(path.join(dir, file), contract);
    if (ledger !== undefined) writeFileSync(path.join(dir, "contracts/idempotency-legacy.json"), ledger);
    const config = { ...load(dir), ...overrides, gates: { ...load(dir).gates, ...gates } };
    const { problems, lines } = await runCheck(config);
    return { problems: problems.filter((problem) => GATE_RULES.has(problem.rule)), lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const POSTS = "paths:\n  /v1/boards:\n    post:\n      operationId: createBoard\n      requestBody:\n        content:\n          application/json:\n            schema:\n              properties:\n                name: {}\n";

test("qc check reads the contract and its ledger", async () => {
  const bare = await checked({ contract: POSTS });
  assert.deepEqual(bare.problems.map((problem) => problem.rule), ["missing-idempotency-field"]);
  const owed = await checked({ contract: POSTS, ledger: '["createBoard"]' });
  assert.deepEqual(owed.problems, []);
  assert.ok(owed.lines.some((line) => line.includes("idempotency")));
  const stale = await checked({ contract: POSTS, ledger: '["createBoard","gone"]' });
  assert.deepEqual(stale.problems.map((problem) => problem.rule), ["legacy-now-declares"]);
});

test("the gate ships off, and an absent contract is ordinary", async () => {
  assert.deepEqual((await checked({ contract: POSTS, gates: {} })).problems, []);
  assert.equal(defaults.gates["contract-idempotency"], false);
  assert.deepEqual((await checked({})).problems, []);
});

test("a contract or a ledger the gate cannot read is a problem, not a crash", async () => {
  const broken = await checked({ contract: "paths: [unclosed\n" });
  assert.deepEqual(broken.problems.map((problem) => problem.rule), ["unreadable-contract"]);
  const ledger = await checked({ contract: POSTS, ledger: '{"createBoard": true}' });
  assert.deepEqual(ledger.problems.map((problem) => problem.rule), ["unreadable-ledger"]);
});

test("the contract path is the top-level `contract`, and an override moves it", async () => {
  assert.equal(defaults.contract, "contracts/openapi.yaml");
  assert.equal(defaults.contractIdempotency.contract, undefined);
  const moved = await checked({ contract: POSTS, overrides: { contract: "api/spec.yaml" } });
  assert.deepEqual(moved.problems.map((problem) => problem.rule), ["missing-idempotency-field"]);
  assert.equal(moved.problems[0].path, "api/spec.yaml");
});

test("a ledger with an entry that is not a string is unreadable", async () => {
  const ledger = await checked({ contract: POSTS, ledger: '["createBoard", 7]' });
  assert.deepEqual(ledger.problems.map((problem) => problem.rule), ["unreadable-ledger"]);
});

test("an id added to the ledger fails unless the operation existed at the merge base", () => {
  const before = { ledger: ["oldOne"], ids: ["oldOne", "existedThenUnlisted"] };
  const after = ["oldOne", "existedThenUnlisted", "brandNew"];
  const found = checkLedgerGrowth(after, before, { ledger: "contracts/idempotency-legacy.json" });
  assert.deepEqual(found.map((problem) => problem.rule), ["legacy-grew"]);
  assert.equal(found[0].path, "contracts/idempotency-legacy.json");
  assert.match(found[0].detail, /brandNew/);
  assert.deepEqual(checkLedgerGrowth(["oldOne"], before, { ledger: "l.json" }), []);
});

// Growth is compared with the merge base, so these run in a repository with two commits.
const git = (dir, ...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd: dir, stdio: "pipe" });

async function grown({ atBase, now, base = "main" }) {
  const dir = mkdtempSync(path.join(tmpdir(), "qc-growth-"));
  try {
    git(dir, "init", "-q", "-b", "main");
    mkdirSync(path.join(dir, "contracts"), { recursive: true });
    const write = (files) => {
      for (const [name, text] of Object.entries(files)) writeFileSync(path.join(dir, "contracts", name), text);
    };
    write(atBase);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "base");
    git(dir, "checkout", "-q", "-b", "topic");
    write(now);
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "topic");
    const start = load(dir);
    const config = { ...start, ratchet: { base }, gates: { ...start.gates, "contract-idempotency": true } };
    const { problems, lines } = await runCheck(config);
    return { problems: problems.filter((problem) => GATE_RULES.has(problem.rule)), lines };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const TWO_POSTS = `${POSTS}  /v1/tasks:\n    post:\n      operationId: createTask\n`;

test("qc check fails a ledger id whose operation is new since the merge base", async () => {
  const found = await grown({
    atBase: { "openapi.yaml": POSTS, "idempotency-legacy.json": '["createBoard"]' },
    now: { "openapi.yaml": TWO_POSTS, "idempotency-legacy.json": '["createBoard","createTask"]' },
  });
  assert.deepEqual(found.problems.map((problem) => problem.rule), ["legacy-grew"]);
  assert.match(found.problems[0].detail, /createTask/);
});

test("a ledger first written on the branch may list what the contract already held", async () => {
  const found = await grown({
    atBase: { "openapi.yaml": POSTS },
    now: { "openapi.yaml": POSTS, "idempotency-legacy.json": '["createBoard"]' },
  });
  assert.deepEqual(found.problems, []);
});

test("with no merge base the growth check passes and says it did not run", async () => {
  const found = await grown({
    atBase: { "openapi.yaml": POSTS, "idempotency-legacy.json": '["createBoard"]' },
    now: { "openapi.yaml": TWO_POSTS, "idempotency-legacy.json": '["createBoard","createTask"]' },
    base: "no-such-ref",
  });
  assert.deepEqual(found.problems, []);
  assert.ok(found.lines.some((line) => line.includes("growth") && line.includes("skipped")));
});
