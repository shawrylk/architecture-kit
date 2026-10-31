import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { integrationLane, REGENERATE_SUBJECT } from "./integration-lane.mjs";
import { mergeVerdict } from "./merge-guard.mjs";

function integrationRepo(t, { config = { generated: { globs: ["generated.txt"] } }, conflict = false } = {}) {
  const root = realpathSync.native(mkdtempSync(path.join(tmpdir(), "qc-integration-lane-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "pipe", encoding: "utf8" }).trim();
  const commit = (file, content, subject) => {
    writeFileSync(path.join(root, file), content);
    git("add", file);
    git("commit", "-q", "-m", subject);
    return git("rev-parse", "HEAD");
  };
  git("init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git("config", key, value);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify(config));
  git("add", "qc.config.json");
  const baseOid = commit("shared.txt", "base\n", "base");
  git("switch", "-q", "-c", "feat/7-integration");
  const taskHeads = [];
  const mergeHeads = [];
  for (const feature of ["api", "ui"]) {
    git("switch", "-q", "-c", `task/7-${feature}`, baseOid);
    taskHeads.push(commit(conflict ? "shared.txt" : `${feature}.txt`, `${feature}\n`, `add ${feature} feature`));
    git("switch", "-q", "feat/7-integration");
    const merge = () => git("merge", "--no-ff", "-m", `merge ${feature}`, `task/7-${feature}`);
    if (conflict && feature === "ui") {
      assert.throws(merge);
      commit("shared.txt", "api and ui\n", "resolve feature conflict");
      assert.notEqual(git("diff-tree", "--cc", "-r", "--no-commit-id", "--name-only", "HEAD"), "");
    } else {
      merge();
    }
    mergeHeads.push(git("rev-parse", "HEAD"));
  }
  const sha = commit("generated.txt", "generated\n", REGENERATE_SUBJECT);
  return { root, baseOid, headBranch: "feat/7-integration", sha, taskHeads, mergeHeads, git, commit };
}

const approved = (sha, scope, kind = "branch") => ({ type: "verdict", kind, verdict: "APPROVED", sha, scope });
const judge = (repo, records, options = {}) => integrationLane({ ...repo, records, kinds: ["branch"], ...options });

test("approved task heads cover clean merges and the regenerate commit", (t) => {
  const repo = integrationRepo(t);
  assert.equal(REGENERATE_SUBJECT, "chore: regenerate the generated files");
  assert.deepEqual(judge(repo, repo.taskHeads.map((sha) => approved(sha))), { applies: true, problem: null, heads: 2 });
});

test("a task head without a review names its subject", (t) => {
  const repo = integrationRepo(t);
  const result = judge(repo, [approved(repo.taskHeads[0])]);
  assert.equal(result.applies, true);
  assert.match(result.problem, /1 commit\(s\) hold no APPROVED review/);
  assert.ok(result.problem.includes(`${repo.taskHeads[1].slice(0, 7)} "add ui feature"`));
});

test("a fix after the last approved head needs a review", (t) => {
  const repo = integrationRepo(t);
  const sha = repo.commit("fix.txt", "fix\n", "fix the integrated API");
  const result = judge(repo, repo.taskHeads.map((head) => approved(head)), { sha });
  assert.match(result.problem, /hold no APPROVED review/);
  assert.ok(result.problem.includes(`${sha.slice(0, 7)} "fix the integrated API"`));
});

test("a rejected scope blocks an approved later head in another scope", (t) => {
  const repo = integrationRepo(t);
  const records = [
    approved(repo.taskHeads[0], "api"),
    { ...approved(repo.mergeHeads[0], "api"), verdict: "CHANGES_REQUIRED" },
    approved(repo.sha, "ui"),
  ];
  assert.match(judge(repo, records).problem, /scope "api"/);
});

test("separate scopes can approve successive integration merge heads", (t) => {
  const repo = integrationRepo(t);
  const result = judge(repo, [approved(repo.mergeHeads[0], "a"), approved(repo.mergeHeads[1], "b")]);
  assert.deepEqual(result, { applies: true, problem: null, heads: 2 });
});

test("the newest verdict of a scope supersedes its rejection", (t) => {
  const repo = integrationRepo(t);
  const records = [
    { ...approved(repo.taskHeads[0], "api"), verdict: "CHANGES_REQUIRED" },
    approved(repo.sha, "api"),
  ];
  assert.equal(judge(repo, records).problem, null);
});

test("hand-resolved merges need an approved head at or after the merge", (t) => {
  const repo = integrationRepo(t, { conflict: true });
  const records = repo.taskHeads.map((sha) => approved(sha));
  assert.match(judge(repo, records).problem, /hand-resolved/);
  assert.ok(judge(repo, records).problem.includes(repo.mergeHeads[1].slice(0, 7)));
  assert.equal(judge(repo, [...records, approved(repo.mergeHeads[1])]).problem, null);
  assert.equal(judge(repo, [...records, approved(repo.sha)]).problem, null);
});

test("other branches bypass the integration lane", (t) => {
  const repo = integrationRepo(t);
  assert.deepEqual(judge(repo, [], { headBranch: "feat/8-other" }), { applies: false });
  assert.deepEqual(judge(repo, [], { headBranch: "fix/12-integration-tests" }), { applies: false });
});

test("the base configuration can disable integration reviews", (t) => {
  const repo = integrationRepo(t, { config: { integrate: { review: false } } });
  assert.deepEqual(judge(repo, []), { applies: false });
});

test("the base configuration controls the branch pattern", (t) => {
  const repo = integrationRepo(t, { config: { integrate: { branchPattern: "^release/" } } });
  assert.deepEqual(judge(repo, []), { applies: false });
  assert.equal(judge(repo, [approved(repo.sha)], { headBranch: "release/7" }).problem, null);
});

test("a lane with no approved verdict reports the missing review", (t) => {
  const repo = integrationRepo(t);
  assert.match(judge(repo, []).problem, /no APPROVED review/);
});

test("task verdicts count only when the caller includes their kind", (t) => {
  const repo = integrationRepo(t);
  const records = repo.taskHeads.map((sha) => approved(sha, undefined, "task"));
  assert.match(judge(repo, records).problem, /no APPROVED review/);
  assert.equal(judge(repo, records, { kinds: ["task"] }).problem, null);
});

test("verdicts outside the integration history and other kinds do not block", (t) => {
  const repo = integrationRepo(t);
  const records = [
    ...repo.taskHeads.map((sha) => approved(sha)),
    { ...approved(repo.baseOid, "api"), verdict: "CHANGES_REQUIRED" },
    { ...approved(repo.sha, "api", "task"), verdict: "CHANGES_REQUIRED" },
  ];
  assert.equal(judge(repo, records).problem, null);
});

test("an unreadable base policy bypasses the lane", (t) => {
  const repo = integrationRepo(t);
  assert.deepEqual(judge(repo, [], { baseOid: "invalid" }), { applies: false });
});

test("a failed history read reports a git problem", (t) => {
  const repo = integrationRepo(t);
  const result = judge(repo, [], { sha: "invalid" });
  assert.equal(result.applies, true);
  assert.match(result.problem, /git cannot/);
});

test("every dispatched scope blocks until it approves across head changes", (t) => {
  const repo = integrationRepo(t);
  const head = repo.mergeHeads[1];
  const records = [
    ...["a", "b"].map((scope) => ({ type: "dispatch", branch: repo.headBranch, head, scope })),
    approved(head, "a"),
  ];
  const lane = (merge) => {
    const result = judge(repo, records, { sha: merge.sha });
    return result.applies ? { problem: result.problem, note: "lane" } : null;
  };
  const refusal = (sha) => mergeVerdict([{ sha }], records, "branch", lane).refusal;
  assert.match(refusal(head), /scope "b"/);
  assert.match(refusal(repo.sha) ?? "", /scope "b"/);
  repo.git("switch", "-q", "main");
  repo.baseOid = repo.commit("base-change.txt", "base update\n", "update the base");
  repo.git("switch", "-q", repo.headBranch);
  repo.git("merge", "--no-ff", "-q", "-m", "merge the base", "main");
  const sha = repo.git("rev-parse", "HEAD");
  assert.match(refusal(sha) ?? "", /scope "b"/);
  assert.match(judge(repo, [...records, approved(head, "b", "task")], { sha }).problem ?? "", /scope "b"/);
  assert.match(judge(repo, [...records, approved(repo.baseOid, "b")], { sha }).problem ?? "", /scope "b"/);
  assert.equal(judge(repo, [...records, approved(head, "b")], { sha }).problem, null);
  assert.match(judge(repo, [...records, approved(head, "b"), { ...approved(sha, "b"), verdict: "CHANGES_REQUIRED" }], { sha }).problem, /scope "b"/);
});

test("dispatches on other branches do not require their scopes", (t) => {
  const repo = integrationRepo(t);
  const records = [approved(repo.sha, "a"), { type: "dispatch", branch: "feat/8-integration", head: repo.sha, scope: "b" }];
  assert.equal(judge(repo, records).problem, null);
});

test("a regenerate title needs coverage when any changed file is outside the base globs", (t) => {
  const repo = integrationRepo(t);
  const records = repo.taskHeads.map((sha) => approved(sha));
  repo.commit("generated.txt", "new generated output\n", "prepare generated output");
  repo.git("reset", "--soft", "HEAD^");
  const sha = repo.commit("x.js", "unreviewed code\n", REGENERATE_SUBJECT);
  assert.match(judge(repo, records, { sha }).problem ?? "", /hold no APPROVED review/);
  assert.equal(judge(repo, [...records, approved(sha)], { sha }).problem, null);
});

test("short shas count for approvals and newer scope rejections", (t) => {
  const repo = integrationRepo(t);
  const records = [
    approved(repo.taskHeads[0].slice(0, 7), "api"),
    { ...approved(repo.mergeHeads[0].slice(0, 7), "api"), verdict: "CHANGES_REQUIRED" },
    approved(repo.sha.slice(0, 7), "ui"),
  ];
  assert.match(judge(repo, records).problem ?? "", /scope "api"/);
  assert.equal(judge(repo, [...records, approved(repo.sha.slice(0, 7), "api")]).problem, null);
});

test("regenerate paths keep leading whitespace when the lane checks the globs", (t) => {
  const repo = integrationRepo(t);
  const sha = repo.commit(" generated.txt", "source outside the generated globs\n", REGENERATE_SUBJECT);
  assert.match(judge(repo, repo.taskHeads.map((head) => approved(head)), { sha }).problem ?? "", /hold no APPROVED review/);
});
