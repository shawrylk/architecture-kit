import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { ghApiMerges, ghMerges } from "./gh-merge-command.mjs";
import { powershellSegments } from "./powershell-command.mjs";
import { segmentsOf } from "./shell-command.mjs";

test("a POSIX merge carries its sha, PR, repository, and GH_* prefix, and never a token", () => {
  assert.deepEqual(
    ghMerges("GH_CONFIG_DIR=~/.config/gh-personal GH_TOKEN=x gh pr merge 60 -R o/r --squash --match-head-commit abc1234", segmentsOf),
    [{ sha: "abc1234", repo: "o/r", selector: "60", auto: false, env: { GH_CONFIG_DIR: "~/.config/gh-personal" } }],
  );
});

test("inline flag values, an exported setting, and a merge with no PR named", () => {
  assert.deepEqual(ghMerges("gh pr merge --repo=o/r --match-head-commit=abc1234 61", segmentsOf), [
    { sha: "abc1234", repo: "o/r", selector: "61", auto: false, env: {} },
  ]);
  assert.deepEqual(ghMerges("export GH_HOST=ghe.example.com && gh pr merge --auto -s", segmentsOf), [
    { sha: null, repo: null, selector: null, auto: true, env: { GH_HOST: "ghe.example.com" } },
  ]);
  assert.deepEqual(ghMerges('gh pr merge -b "Closes #1" -t subject 62 --match-head-commit abc1234', segmentsOf)[0].selector, "62");
});

test("a PowerShell merge reads the $env: settings before it", () => {
  assert.deepEqual(ghMerges(String.raw`$env:GH_CONFIG_DIR = "C:\gh"; gh pr merge 63 --match-head-commit abc1234`, powershellSegments), [
    { sha: "abc1234", repo: null, selector: "63", auto: false, env: { GH_CONFIG_DIR: String.raw`C:\gh` } },
  ]);
  assert.deepEqual(ghMerges(String.raw`$env:gh_host="ghe.example.com"; gh.exe pr merge 64`, powershellSegments)[0].env, { GH_HOST: "ghe.example.com" });
});

test("a nested shell's merge is found, and what is no merge is left alone", () => {
  assert.equal(ghMerges(`bash -c "gh pr merge 65"`, segmentsOf).length, 1);
  assert.equal(ghMerges(`pwsh -Command "gh pr merge 66 --match-head-commit abc1234"`, powershellSegments)[0].sha, "abc1234");
  for (const command of ["gh pr view 60", "gh pr merge 60 --disable-auto", "git merge feat/x", "echo gh pr merge"]) {
    assert.deepEqual(ghMerges(command, segmentsOf), [], command);
  }
});

test("a gh api call to a PR's merge endpoint is found, in each spelling, and no other gh api call is", () => {
  const endpoints = (command, parse = segmentsOf) => ghApiMerges(command, parse).map((call) => call.endpoint);
  assert.deepEqual(endpoints("gh api -X PUT repos/o/r/pulls/60/merge -f merge_method=squash"), ["repos/o/r/pulls/60/merge"]);
  assert.deepEqual(endpoints("gh api --method=PUT /repos/{owner}/{repo}/pulls/61/merge"), ["/repos/{owner}/{repo}/pulls/61/merge"]);
  assert.deepEqual(endpoints(`bash -c "gh api repos/o/r/pulls/62/merge -X PUT"`), ["repos/o/r/pulls/62/merge"]);
  assert.deepEqual(endpoints(String.raw`gh.exe api repos/o/r/pulls/63/merge -X PUT`, powershellSegments), ["repos/o/r/pulls/63/merge"]);
  for (const command of [
    "gh api repos/o/r/pulls/60",
    "gh api repos/o/r/pulls/60/comments",
    "gh api repos/o/r/issues/60 -f body=x/pulls/1/merge",
    "gh pr merge 60",
    "echo gh api repos/o/r/pulls/60/merge",
  ]) {
    assert.deepEqual(endpoints(command), [], command);
  }
});

const MUTATION = "mutation { mergePullRequest(input: {pullRequestId: \"X\"}) { clientMutationId } }";

test("a mutation word in any argument is found, whatever the spelling of the GraphQL URL", () => {
  for (const url of ["graphql", "/graphql", "https://api.github.com/graphql", "https://ghe.example.com/api/graphql", "graphql/"]) {
    assert.deepEqual(ghApiMerges(`gh api ${url} -f query='${MUTATION}'`, segmentsOf).map((call) => call.endpoint), [url], url);
  }
  assert.equal(ghApiMerges(`gh api -X POST graphql -F query='${MUTATION}'`, segmentsOf).length, 1);
  assert.equal(ghApiMerges(`gh api graphql -f query='${MUTATION}'`, powershellSegments).length, 1);
  assert.equal(ghApiMerges(`gh api graphql -f query='query { viewer { login } }'`, segmentsOf).length, 0);
  assert.equal(ghApiMerges("gh api https://api.github.com/graphql -f query='query { viewer { login } }'", segmentsOf).length, 0);
});

test("a query file the call reads is searched for the mutation, and a file the guard cannot read fails closed", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-gh-api-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "merge.graphql"), MUTATION);
  writeFileSync(path.join(dir, "viewer.graphql"), "query { viewer { login } }");
  writeFileSync(path.join(dir, "body.json"), JSON.stringify({ query: MUTATION }));
  const found = (command) => ghApiMerges(command, segmentsOf, { cwd: dir });
  assert.equal(found("gh api https://api.github.com/graphql -F query=@merge.graphql").length, 1);
  assert.equal(found("gh api graphql --field=query=@merge.graphql").length, 1);
  assert.equal(found("gh api graphql --input body.json").length, 1);
  assert.equal(found(`gh api graphql -F query=@${path.join(dir, "merge.graphql").replaceAll("\\", "/")}`).length, 1);
  assert.equal(found("gh api graphql -Fquery=@merge.graphql").length, 1, "an attached short flag carries its value");
  assert.equal(found("gh api graphql -F=query=@merge.graphql").length, 1);
  assert.equal(found("gh api graphql -fquery=@merge.graphql").length, 0, "-f reads no file");
  assert.equal(found("gh api graphql -Fquery=@missing.graphql")[0].unreadable, "missing.graphql");
  assert.equal(found("gh api graphql -iFquery=@merge.graphql").length, 1, "a cluster of short flags ends in -F");
  assert.equal(found("gh api graphql -i -F query=@merge.graphql").length, 1);
  assert.equal(found("gh api graphql -iF query=@merge.graphql").length, 1, "a cluster that ends in -F takes the next argument");
  assert.equal(found("gh api graphql -fFquery=@merge.graphql").length, 0, "-f takes the rest of the word as its value");
  assert.equal(found("gh api graphql -iFquery=@viewer.graphql").length, 0);
  assert.equal(found("gh api graphql --field=query=@missing.graphql")[0].unreadable, "missing.graphql");
  assert.equal(found("gh api graphql -Fquery=@-")[0].unreadable, "-");
  assert.equal(found("gh api graphql -iFquery=@missing.graphql")[0].unreadable, "missing.graphql");
  assert.equal(found("gh api graphql -Fquery=@viewer.graphql").length, 0);
  assert.equal(found("gh api graphql -F query=@viewer.graphql").length, 0);
  assert.equal(found("gh api graphql -f query=@merge.graphql").length, 0, "-f sends the text as written and reads no file");
  const [unreadable] = found("gh api graphql -F query=@missing.graphql");
  assert.equal(unreadable.endpoint, "graphql");
  assert.equal(unreadable.unreadable, "missing.graphql");
  assert.equal(found("gh api graphql -F query=@-")[0].unreadable, "-");
  assert.equal(found("gh api graphql --input -")[0].unreadable, "-");
  // A call to another endpoint never fails closed on a file it cannot read.
  assert.equal(found("gh api repos/o/r/issues/1/comments -F body=@notes.txt").length, 0);
  assert.equal(found("gh api repos/o/r/issues/1/comments -F body=@-").length, 0);
});

test("the repository of a merge comes from a PR URL, GH_REPO, an attached -R, or a cluster that ends in -R", () => {
  const repoOf = (command, parse = segmentsOf) => ghMerges(command, parse)[0].repo;
  assert.equal(repoOf("gh pr merge https://github.com/o/r/pull/5 --match-head-commit abc1234"), "o/r");
  assert.equal(repoOf("gh pr merge https://ghe.example.com/o/r/pull/5/files"), "o/r");
  assert.equal(repoOf("GH_REPO=o/r gh pr merge 5"), "o/r");
  assert.equal(repoOf("export GH_REPO=o/r && gh pr merge 5"), "o/r");
  assert.equal(repoOf(String.raw`$env:GH_REPO = "o/r"; gh pr merge 5`, powershellSegments), "o/r");
  assert.equal(repoOf("gh pr merge 5 -Ro/r"), "o/r");
  assert.equal(repoOf("gh pr merge 5 -R=o/r"), "o/r");
  assert.equal(repoOf("gh pr merge 5 -sRo/r"), "o/r");
  assert.equal(repoOf("gh pr merge 5 -sR o/r"), "o/r");
  assert.equal(repoOf("gh pr merge 5 --repo=o/r"), "o/r");
  assert.equal(repoOf("GH_REPO=x/y gh pr merge 5 -R o/r"), "o/r", "an explicit -R beats GH_REPO");
  assert.equal(repoOf("gh pr merge https://github.com/o/r/pull/5 -R x/y"), "o/r", "a PR URL beats -R");
  assert.equal(repoOf("gh pr merge 5"), null);
  assert.equal(repoOf("gh pr merge 5 -bRo/r"), null, "-b takes the rest of the word as its value");
  assert.deepEqual(ghMerges("GH_REPO=o/r gh pr merge 5", segmentsOf)[0].env, {}, "GH_REPO is not kept as a setting");
});

test("a mutation search skips a call whose endpoint is a repos/ REST path", (t) => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "qc-gh-api-rest-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(path.join(dir, "review.md"), "The bypass is the mergePullRequest mutation.");
  const found = (command) => ghApiMerges(command, segmentsOf, { cwd: dir });
  assert.equal(found("gh api repos/o/r/issues/64/comments -F body=@review.md").length, 0);
  assert.equal(found("gh api repos/o/r/issues/64/comments -f body='see mergePullRequest'").length, 0);
  assert.equal(found("gh api https://api.github.com/repos/o/r/issues/64/comments -F body=@review.md").length, 0);
  assert.equal(found("gh api -X POST -H 'Accept: x' /repos/o/r/issues/64/comments -iFbody=@review.md").length, 0);
  // The REST merge endpoint stays refused by its own rule.
  assert.equal(found("gh api -X PUT repos/o/r/pulls/64/merge -F body=@review.md").length, 1);
  // A word that only looks like a path, as the value of a flag, is no endpoint.
  assert.equal(found("gh api -H repos/x graphql -f query='mutation { mergePullRequest(input: {}) { clientMutationId } }'").length, 1);
  assert.equal(found("gh api graphql -F query=@review.md -f x=repos/o/r").length, 1);
  assert.equal(found("gh api -q repos/x graphql -F query=@review.md").length, 1);
});
