import { strict as assert } from "node:assert";
import { test } from "node:test";
import { reviewDefaults } from "../config.mjs";
import {
  baseCheck,
  briefCheck,
  briefPathOf,
  countFindings,
  countFiles,
  reviewedShaOf,
  reviewerCheck,
} from "./review-gate.mjs";

const SHA = "a".repeat(40);
const TIP = "b".repeat(40);
const review = { ...reviewDefaults, implementerTypes: ["sdd-implementer"] };
const branchVerdict = { type: "verdict", kind: "branch", verdict: "APPROVED", sha: "c".repeat(40), branch: "feat/1-x" };

test("the Reviewed line names the last reviewed sha, and only a hex sha counts", () => {
  assert.equal(reviewedShaOf("Reviewed: abcdef1\nmore"), "abcdef1");
  assert.equal(reviewedShaOf("x\n  reviewed:  " + SHA + "  \n"), SHA);
  assert.equal(reviewedShaOf("Reviewed: soon"), null);
  assert.equal(reviewedShaOf("Reviewed: abc12"), null);
  assert.equal(reviewedShaOf("the Reviewed: abcdef1 is inline"), null);
  assert.equal(reviewedShaOf(""), null);
});

// One review per PR

const branchPrompt = (more = "") => `Worktree: /w\n${more}`;
const check = (over = {}) =>
  reviewerCheck({
    type: "sdd-branch-reviewer",
    prompt: branchPrompt(),
    review: { ...review, reviewerTypes: { task: ["sdd-reviewer"], branch: ["sdd-branch-reviewer"] } },
    base: "origin/main",
    records: [],
    root: "/w",
    branch: "feat/1-x",
    head: SHA,
    ciState: () => ({ reason: null, unknown: null }),
    reads: { remoteTip: () => TIP, lookup: () => ({ sha: TIP }), isAncestor: () => true },
    ...over,
  });

test("a first branch review passes, whether or not the ledger holds other verdicts", () => {
  assert.deepEqual(check(), { refusal: null, note: null });
  const taskVerdict = { ...branchVerdict, kind: "task" };
  assert.equal(check({ records: [taskVerdict] }).refusal, null);
  assert.equal(check({ records: [{ ...branchVerdict, branch: "feat/2-y" }] }).refusal, null);
});

test("a second branch review with no Reviewed line is refused, and the refusal names the increment", () => {
  const { refusal } = check({ records: [branchVerdict] });
  assert.match(refusal, /^Task gate:/);
  assert.match(refusal, /feat\/1-x/);
  assert.match(refusal, /Reviewed: ccccccc/);
  assert.match(refusal, /delta diff/);
});

test("a second branch review that carries a Reviewed line passes", () => {
  assert.equal(check({ records: [branchVerdict], prompt: branchPrompt("Reviewed: ccccccc") }).refusal, null);
});

test("the refusal and the Reviewed line speak of the last head a branch review named", () => {
  assert.match(check({ records: [branchVerdict] }).refusal, /the last head a branch review named/);
});

test("a Reviewed sha that no branch verdict on the branch names is refused, and the refusal names the right one", () => {
  const { refusal } = check({ records: [branchVerdict], prompt: branchPrompt("Reviewed: 1234567") });
  assert.match(refusal, /^Task gate:/);
  assert.match(refusal, /1234567/);
  assert.match(refusal, /Reviewed: ccccccc/);
  assert.match(refusal, /the last head a branch review named/);
});

test("a Reviewed sha matches a branch verdict of either verdict, and only one on this branch", () => {
  const changes = { ...branchVerdict, verdict: "CHANGES_REQUIRED", sha: "d".repeat(40) };
  assert.equal(check({ records: [branchVerdict, changes], prompt: branchPrompt("Reviewed: ddddddd") }).refusal, null);
  assert.equal(check({ records: [branchVerdict, changes], prompt: branchPrompt("Reviewed: ccccccc") }).refusal, null);
  const other = { ...branchVerdict, branch: "feat/2-y", sha: "e".repeat(40) };
  assert.match(check({ records: [branchVerdict, other], prompt: branchPrompt("Reviewed: eeeeeee") }).refusal ?? "", /Reviewed: ccccccc/);
  const task = { ...branchVerdict, kind: "task", sha: "f".repeat(40) };
  assert.match(check({ records: [branchVerdict, task], prompt: branchPrompt("Reviewed: fffffff") }).refusal ?? "", /Reviewed: ccccccc/);
});

test("a Reviewed line with no branch verdict on the branch passes, since the ledger has nothing to match", () => {
  assert.equal(check({ prompt: branchPrompt("Reviewed: 1234567") }).refusal, null);
});

test("the task reviewer is not held to one review", () => {
  assert.equal(check({ type: "sdd-reviewer", records: [branchVerdict] }).refusal, null);
});

test("oneBranchReview off lets a second branch review through", () => {
  assert.equal(check({ records: [branchVerdict], review: { ...review, oneBranchReview: false, reviewerTypes: { task: [], branch: ["sdd-branch-reviewer"] } } }).refusal, null);
});

// Green CI

test("a red or running head refuses a reviewer of either kind, and the refusal names the run", () => {
  const ciState = () => ({ reason: "CI on aaaaaaa: build ended failure", unknown: null });
  for (const type of ["sdd-reviewer", "sdd-branch-reviewer"]) {
    const { refusal } = check({ type, ciState });
    assert.match(refusal, /^Task gate:/);
    assert.match(refusal, /build ended failure/);
    assert.match(refusal, /green/);
  }
});

test("a green head passes with no note", () => {
  assert.deepEqual(check({ ciState: () => ({ reason: null, unknown: null }) }), { refusal: null, note: null });
});

test("a head whose CI is unknown passes with a note that says why", () => {
  const { refusal, note } = check({ ciState: () => ({ reason: null, unknown: "gh failed or timed out" }) });
  assert.equal(refusal, null);
  assert.match(note, /CI on aaaaaaa is unknown: gh failed or timed out/);
});

test("requireGreen off never asks CI", () => {
  let asked = 0;
  const ciState = () => ((asked += 1), { reason: "red", unknown: null });
  assert.equal(check({ ciState, review: { ...review, requireGreen: false, reviewerTypes: { task: [], branch: ["sdd-branch-reviewer"] } } }).refusal, null);
  assert.equal(asked, 0);
});

// Head contains the base tip

const tipReads = (over = {}) => ({ remoteTip: () => TIP, lookup: () => ({ sha: TIP }), isAncestor: () => true, ...over });

test("a head that contains the tip of the base passes", () => {
  assert.deepEqual(baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads() }), { refusal: null, note: null });
});

test("a tip that is missing locally refuses, and the refusal says to fetch then merge", () => {
  const { refusal } = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ lookup: () => ({ unknown: true }) }) });
  assert.match(refusal, /git fetch/);
  assert.match(refusal, /merge origin\/main into the branch/);
  assert.match(refusal, /bbbbbbb/);
});

test("a head that lacks the tip refuses, and the refusal says CI tests the merge ref", () => {
  const { refusal } = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ isAncestor: () => false }) });
  assert.match(refusal, /merge origin\/main into the branch first/);
  assert.match(refusal, /CI tests the merge ref/);
});

test("the remote is read for the branch after origin/, and a bare name too", () => {
  const asked = [];
  const remoteTip = (_cwd, remote, branch) => (asked.push([remote, branch]), TIP);
  baseCheck({ root: "/w", base: "origin/dev", head: SHA, reads: tipReads({ remoteTip }) });
  baseCheck({ root: "/w", base: "main", head: SHA, reads: tipReads({ remoteTip }) });
  assert.deepEqual(asked, [["origin", "dev"], ["origin", "main"]]);
});

test("an origin that does not answer falls back to the local ref, with a note", () => {
  const lookups = [];
  const lookup = (_cwd, ref) => (lookups.push(ref), { sha: TIP });
  const { refusal, note } = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ remoteTip: () => null, lookup }) });
  assert.equal(refusal, null);
  assert.deepEqual(lookups, ["origin/main"]);
  assert.match(note, /local origin\/main/);
  const stale = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ remoteTip: () => null, isAncestor: () => false }) });
  assert.match(stale.refusal, /merge origin\/main into the branch first/);
});

test("a base that git cannot read passes with a note", () => {
  const none = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ remoteTip: () => null, lookup: () => ({ unknown: true }) }) });
  assert.equal(none.refusal, null);
  assert.match(none.note, /origin\/main/);
  const failed = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ lookup: () => ({ error: "git timed out" }) }) });
  assert.equal(failed.refusal, null);
  assert.match(failed.note, /git timed out/);
  const unsure = baseCheck({ root: "/w", base: "origin/main", head: SHA, reads: tipReads({ isAncestor: () => null }) });
  assert.equal(unsure.refusal, null);
  assert.match(unsure.note, /could not tell/);
});

test("requireBase off never reads the base", () => {
  const reads = { remoteTip: () => assert.fail("read"), lookup: () => assert.fail("read"), isAncestor: () => assert.fail("read") };
  assert.equal(check({ reads, review: { ...review, requireBase: false, reviewerTypes: { task: [], branch: ["sdd-branch-reviewer"] } } }).refusal, null);
});

test("a reviewer of either kind whose head or branch cannot be read is refused, and the refusal names the Worktree line", () => {
  for (const type of ["sdd-reviewer", "sdd-branch-reviewer"]) {
    for (const over of [{ head: null }, { branch: null }]) {
      const { refusal } = check({ type, ...over, ciState: () => assert.fail("CI asked"), reads: {} });
      assert.match(refusal, /^Task gate:/);
      assert.match(refusal, /Worktree: <path>/);
      assert.match(refusal, /checked-out branch/);
    }
  }
});

test("the base check runs before CI, so a stale head is not sent to wait on a red run", () => {
  const result = check({ reads: tipReads({ isAncestor: () => false }), ciState: () => assert.fail("CI asked") });
  assert.match(result.refusal, /merge origin\/main/);
});

// The brief

const brief = (...sections) => sections.join("\n");
const files = (n) => Array.from({ length: n }, (_unused, index) => `src/file${index}.ts`).join(", ");
const findings = (n) => Array.from({ length: n }, (_unused, index) => `${index + 1}. fix thing ${index}`).join("\n");
const onBrief = (file) => file.replaceAll("\\", "/").endsWith("/plans/brief.md");
const briefCheckOf = (text, over = {}) =>
  briefCheck({ prompt: "Read it.\nBrief: /plans/brief.md\nReport: /plans/report.md", dirs: ["/w"], review, exists: onBrief, read: () => text, ...over });
const offAll = { ...review, productDecisions: false, roundFindings: 0, roundFiles: 0 };

test("a brief with a Product decisions heading passes, with no note when it is under the limits", () => {
  assert.deepEqual(briefCheckOf(brief("# Brief", "## Product decisions", "None.", "1. one", `Files: ${files(3)}`)), { refusal: null, note: null });
  assert.equal(briefCheckOf("## product decisions  \nNone.").refusal, null);
});

test("a brief with no Product decisions heading is refused, and the refusal names the heading and the questions", () => {
  const { refusal } = briefCheckOf("# Brief\nDo the work.");
  assert.match(refusal, /^Task gate:/);
  assert.match(refusal, /plans\/brief\.md/);
  assert.match(refusal, /## Product decisions/);
  assert.match(refusal, /one question/);
  assert.equal(briefCheckOf("Product decisions are in the issue.").refusal !== null, true);
  assert.equal(briefCheckOf("### Product decisions\nx").refusal !== null, true);
});

test("a Product decisions heading with no text before the next heading, or the end, is refused", () => {
  for (const text of ["## Product decisions\n", "## Product decisions\n\n  \n", "## Product decisions\n\n## Findings\n1. a", "# Brief\n## Product decisions\r\n\r\n# Next\r\nx"]) {
    const { refusal } = briefCheckOf(text);
    assert.match(refusal ?? "", /^Task gate:.*empty/, JSON.stringify(text));
    assert.match(refusal, /## Product decisions/);
    assert.match(refusal, /`none`/);
  }
});

test("the text under the heading is a ruling or the word none, and a sub-heading is text", () => {
  assert.equal(briefCheckOf("## Product decisions\nnone\n## Findings").refusal, null);
  assert.equal(briefCheckOf("## Product decisions\n- A reviewer with no head is refused.\n").refusal, null);
  assert.equal(briefCheckOf("## Product decisions\n### Ruling\nx").refusal, null);
});

test("a prompt with no Brief line is refused, and the refusal names the line, even when the prompt holds the heading", () => {
  const prompt = "Do the work. See /plans/brief.md.\n## Product decisions\nNone.";
  const { refusal } = briefCheck({ prompt, dirs: ["/w"], review, exists: () => assert.fail("looked"), read: () => assert.fail("read") });
  assert.match(refusal, /^Task gate:/);
  assert.match(refusal, /`Brief: <path>`/);
});

test("a Brief line whose file is missing or unreadable is refused, and the refusal names the line and the path", () => {
  const missing = briefCheck({ prompt: "Brief: /plans/gone.md", dirs: ["/w"], review, exists: () => false, read: () => assert.fail("read") });
  assert.match(missing.refusal, /`Brief: <path>`/);
  assert.match(missing.refusal, /\/plans\/gone\.md/);
  const read = () => {
    throw new Error("EACCES");
  };
  const unreadable = briefCheck({ prompt: "Brief: /plans/brief.md", dirs: ["/w"], review, exists: () => true, read });
  assert.match(unreadable.refusal, /`Brief: <path>`/);
  assert.match(unreadable.refusal, /EACCES/);
});

test("the brief is the path on the Brief line, and no other .md path or the hand-off note is", () => {
  const read = (file) => (file.endsWith("brief.md") ? "## Product decisions\nNone." : assert.fail(file));
  const exists = (file) => file.endsWith("note.md") || file.endsWith("brief.md") || file.endsWith("report.md");
  const prompt = "Report: /plans/report.md\nHANDOFF: /plans/note.md\nBrief: /plans/brief.md\nSee /plans/other.md";
  assert.equal(briefCheck({ prompt, dirs: ["/w"], review, exists, read }).refusal, null);
});

test("a relative Brief path is found under each directory, and a Git Bash drive path in Windows spelling", () => {
  const seen = [];
  const exists = (file) => (seen.push(file), false);
  briefCheck({ prompt: "Brief: plans/b.md", dirs: ["/w/a", "/w/b"], review, exists, read: () => "" });
  assert.equal(seen.length, 2);
  assert.ok(seen[0].replaceAll("\\", "/").endsWith("/w/a/plans/b.md"));
  assert.ok(seen[1].replaceAll("\\", "/").endsWith("/w/b/plans/b.md"));
});

test("a quoted Brief path, a Windows path, and a short-name path are read as written", () => {
  for (const spelled of ['"/plans/brief.md"', "`/plans/brief.md`", "  /plans/brief.md  ", "/plans/brief.md"]) {
    assert.equal(briefCheckOf("## Product decisions\nNone.", { prompt: `Brief: ${spelled}` }).refusal, null, spelled);
  }
  assert.equal(briefPathOf("Brief: C:\\Users\\NGUYEN~1\\s\\brief.md\nReport: /r/report.md"), "C:\\Users\\NGUYEN~1\\s\\brief.md");
  assert.equal(briefPathOf("a\n  brief: /b/x.md"), "/b/x.md");
  assert.equal(briefPathOf("The Brief: is inline /b/x.md"), null);
  assert.equal(briefPathOf("Brief:"), null);
  assert.equal(briefPathOf(""), null);
});

test("productDecisions off never refuses a brief for its heading", () => {
  assert.equal(briefCheckOf("no heading", { review: { ...review, productDecisions: false } }).refusal, null);
});

test("with every brief check off, the brief is not read and no Brief line is needed", () => {
  const result = briefCheck({ prompt: "Do it.", dirs: ["/w"], review: offAll, exists: () => assert.fail("looked"), read: () => assert.fail("read") });
  assert.deepEqual(result, { refusal: null, note: null });
});

test("a brief over the findings limit warns and names the split", () => {
  const { refusal, note } = briefCheckOf(brief("## Product decisions", "None.", findings(9)));
  assert.equal(refusal, null);
  assert.match(note, /9 numbered findings/);
  assert.match(note, /roundFindings \(8\)/);
  assert.match(note, /parallel implementers on disjoint paths/);
  assert.match(note, /sub-branches in separate worktrees/);
  assert.match(note, /merged by the controller/);
});

test("a brief over the files limit warns, and one at the limit does not", () => {
  const over = briefCheckOf(brief("## Product decisions", "None.", `Files: ${files(11)}`));
  assert.match(over.note, /11 files/);
  assert.match(over.note, /roundFiles \(10\)/);
  assert.equal(briefCheckOf(brief("## Product decisions", "None.", findings(8), `Files: ${files(10)}`)).note, null);
});

test("a limit of 0 turns its warning off", () => {
  const off = { ...review, roundFindings: 0, roundFiles: 0 };
  assert.equal(briefCheckOf(brief("## Product decisions", "None.", findings(30), files(30)), { review: off }).note, null);
});

test("a refused brief reports no round-size note", () => {
  const result = briefCheckOf(brief(findings(30), files(30)));
  assert.ok(result.refusal);
  assert.equal(result.note, null);
});

test("numbered findings are the lines that start with a number and a dot", () => {
  assert.equal(countFindings("1. a\n  2. b\n10. c\nversion 1. x\n1) no\n- 3. no"), 3);
  assert.equal(countFindings(""), 0);
});

test("a file is a path with a separator or a known extension; a URL, a version, and an abbreviation are not", () => {
  assert.equal(countFiles("src/a.ts and src\\b.ts and c.mjs and src/a.ts again"), 3);
  assert.equal(countFiles("see https://github.com/o/r/issues/1 and e.g. v0.20.4, i.e. the 1.5x speed"), 0);
  assert.equal(countFiles("docs/a.md, `packages/x/y.json`, (hooks/hooks.json)."), 3);
  assert.equal(countFiles("README.md and README.md"), 1);
});
