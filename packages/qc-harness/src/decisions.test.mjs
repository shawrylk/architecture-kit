import test from "node:test";
import assert from "node:assert/strict";
import { defaults } from "./config.mjs";
import {
  alreadyChecked,
  audit,
  isBareId,
  isImmutable,
  mergeCandidates,
  parseRegister,
  planProblems,
  registerProblems,
  renamePlan,
  rewrite,
  similarity,
  squashPlan,
  terms,
} from "./decisions.mjs";

test("a squash closes every gap and leaves a contiguous register alone", () => {
  assert.deepEqual(
    [...squashPlan(["ADR-0001", "ADR-0006", "ADR-0009", "QC-001", "QC-002"])],
    [["ADR-0006", "ADR-0002"], ["ADR-0009", "ADR-0003"]],
  );
  assert.equal(squashPlan(["ADR-0001", "ADR-0002"]).size, 0);
});

test("a squash keeps the width the series was written at", () => {
  assert.deepEqual([...squashPlan(["QC-003"])], [["QC-003", "QC-001"]]);
});

test("a series written at two widths settles on the wider one, so no id is truncated", () => {
  assert.deepEqual([...squashPlan(["ADR-001", "ADR-0005"])], [["ADR-001", "ADR-0001"], ["ADR-0005", "ADR-0002"]]);
});

test("a run shifting down does not clobber an id it has not moved yet", () => {
  const plan = squashPlan(["ADR-0001", "ADR-0002", "ADR-0003", "ADR-0005"]);
  assert.equal(rewrite("ADR-0005 then ADR-0003", plan), "ADR-0004 then ADR-0003");
});

test("a swap survives being written through itself", () => {
  const plan = renamePlan("ADR-0001=ADR-0002,ADR-0002=ADR-0001");
  assert.equal(rewrite("ADR-0001 and ADR-0002", plan), "ADR-0002 and ADR-0001");
});

test("a citation is rewritten only whole", () => {
  assert.equal(rewrite("ADR-0001 ADR-00012", new Map([["ADR-0001", "ADR-0009"]])), "ADR-0009 ADR-00012");
});

test("a plan naming an id the register does not define is refused", () => {
  assert.deepEqual(planProblems(renamePlan("ADR-0099=ADR-0001"), new Set(["ADR-0001"])), [
    "ADR-0099 is not a decision this repository defines",
    "ADR-0001 is already taken by a decision this plan does not move",
  ]);
});

test("a plan landing on an id that is not itself moving is refused", () => {
  const problems = planProblems(renamePlan("ADR-0002=ADR-0001"), new Set(["ADR-0001", "ADR-0002"]));
  assert.deepEqual(problems, ["ADR-0001 is already taken by a decision this plan does not move"]);
});

test("two ids landing on one are refused", () => {
  const defined = new Set(["ADR-0001", "ADR-0002", "ADR-0003"]);
  const problems = planProblems(renamePlan("ADR-0002=ADR-0009,ADR-0003=ADR-0009"), defined);
  assert.deepEqual(problems, ["ADR-0002 and ADR-0003 would both become ADR-0009"]);
});

test("a gap, an uncited decision and an undefined citation are each reported", () => {
  const sites = new Map([
    ["ADR-0001", [{ file: "docs/decisions.md" }, { file: "src/a.ts" }]],
    ["ADR-0003", [{ file: "docs/decisions.md" }]],
    ["ADR-0400", [{ file: "src/b.ts" }]],
  ]);
  const problems = registerProblems(new Set(["ADR-0001", "ADR-0003"]), sites, "docs/decisions.md");
  assert.deepEqual(problems, [
    { text: "ADR: 1 gap(s) below ADR-0003", fatal: true },
    { text: "ADR-0003: defined and never cited — delete it, or cite it", fatal: false },
    { text: "ADR-0400: cited and not defined in docs/decisions.md", fatal: true },
  ]);
});

test("a register with no gap, no orphan and no dangling citation reports nothing", () => {
  const sites = new Map([["ADR-0001", [{ file: "docs/decisions.md" }, { file: "src/a.ts" }]]]);
  assert.deepEqual(registerProblems(new Set(["ADR-0001"]), sites, "docs/decisions.md"), []);
});

test("an id is a lookup, and a rename pair that contains one is not", () => {
  assert.equal(isBareId("ADR-0001"), true);
  assert.equal(isBareId("ADR-0047=ADR-0027"), false);
  assert.equal(isBareId("see ADR-0001", undefined), false);
  assert.equal(isBareId("--squash"), false);
});

test("an uncited decision is reported and does not fail the check", () => {
  const sites = new Map([["ADR-0001", [{ file: "docs/decisions.md" }]]]);
  const problems = registerProblems(new Set(["ADR-0001"]), sites, "docs/decisions.md");
  assert.deepEqual(problems.map((problem) => problem.fatal), [false]);
});

const REGISTER = `# Decisions

| id | decision | the rule it imposes |
|---|---|---|
| ADR-0001 | Keyset pagination only | \`offset\` and \`skip\` are rejected |
| ADR-0002 | Pagination is keyset | Never an offset, never a skip |
| ADR-0003 | One cloud | No provider abstraction layer |
`;

test("a register parses to rows, and a heading separator is not one", () => {
  const rows = parseRegister(REGISTER, ["ADR"]);
  assert.deepEqual(rows.map((row) => row.id), ["ADR-0001", "ADR-0002", "ADR-0003"]);
  assert.equal(rows[2].decision, "One cloud");
});

test("filler words are not what makes two decisions alike", () => {
  assert.equal(terms("the one and only of it").size, 0);
  assert.deepEqual([...terms("Keyset pagination only")], ["keyset", "pagination"]);
});

test("similarity is over the smaller set, so a terse decision is comparable to a wordy one", () => {
  assert.equal(similarity(terms("keyset pagination"), terms("keyset pagination rejected skip offset")), 1);
  assert.equal(similarity(new Set(), terms("anything")), 0);
});

test("two decisions saying the same thing are offered as a merge, and a third is not", () => {
  const pairs = mergeCandidates(parseRegister(REGISTER, ["ADR"]));
  assert.deepEqual(pairs.map((pair) => [pair.left, pair.right]), [["ADR-0001", "ADR-0002"]]);
  assert.ok(pairs[0].shared.includes("keyset"));
});

test("every decision whose rule a check already states is reported against that check", () => {
  const rows = parseRegister(REGISTER, ["ADR"]);
  const checks = [{ name: "qc/no-offset-pagination", description: "offset and skip are rejected" }];
  assert.deepEqual(alreadyChecked(rows, checks), [
    { id: "ADR-0001", check: "qc/no-offset-pagination", score: 1 },
    { id: "ADR-0002", check: "qc/no-offset-pagination", score: 1 },
  ]);
});

test("a backticked identifier is what makes a rule distinctive, not noise to strip", () => {
  assert.ok(terms("`offset` and `skip` are rejected").has("offset"));
});

test("a verdict follows how far a decision reaches", () => {
  const sites = new Map([
    ["ADR-0001", [{ file: "docs/decisions.md" }, { file: "backend/src/a.ts" }, { file: "frontend/src/b.ts" }]],
    ["ADR-0002", [{ file: "backend/src/a.ts" }, { file: "backend/src/b.ts" }]],
    ["ADR-0003", [{ file: "backend/src/a.ts" }]],
  ]);
  const { verdicts } = audit(parseRegister(REGISTER, ["ADR"]), sites, "docs/decisions.md");
  assert.deepEqual(verdicts.map((entry) => [entry.id, entry.verdict]), [
    ["ADR-0001", "keep"],
    ["ADR-0002", "local?"],
    ["ADR-0003", "inline?"],
  ]);
});

test("a decision nothing cites is offered for abort", () => {
  const { verdicts } = audit(parseRegister(REGISTER, ["ADR"]), new Map(), "docs/decisions.md");
  assert.deepEqual([...new Set(verdicts.map((entry) => entry.verdict))], ["abort?"]);
});

test("a migration a ledger hashes is never rewritten, wherever it sits", () => {
  const patterns = defaults.decisions.immutable;
  for (const file of [
    "backend/src/drizzle/0004_pins.sql",
    "db/migrations/0001_init.sql",
    "services/api/migration/0002_add_tenant.sql",
  ]) {
    assert.equal(isImmutable(file, patterns), true, file);
  }
});

test("ordinary source and docs stay rewritable", () => {
  const patterns = defaults.decisions.immutable;
  for (const file of [
    "backend/src/features/pins/schema.ts",
    "docs/decisions.md",
    "backend/src/drizzle/meta/_journal.json",
  ]) {
    assert.equal(isImmutable(file, patterns), false, file);
  }
});
