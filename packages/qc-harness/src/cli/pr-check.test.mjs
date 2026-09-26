import { strict as assert } from "node:assert";
import { test } from "node:test";
import { checkPullRequest, issueReferences } from "./pr-check.mjs";

const event = (body) => ({
  repository: { full_name: "acme/app" },
  pull_request: { number: 9, body, created_at: "2026-05-02T00:00:00Z" },
});
/** A gh runner that knows the issues given, by `owner/repo#n`, with their creation times. */
const ghKnowing = (issues) => async (args) => {
  const repo = args[args.indexOf("-R") + 1];
  const created = issues[`${repo}#${args[2]}`];
  if (!created) return { ok: false, stderr: "GraphQL: Could not resolve to an issue or pull request with the number of 404." };
  return { ok: true, stdout: JSON.stringify({ createdAt: created }) };
};

test("a PR body names its issue as Fixes #n, Refs #n, or a cross-repository Refs owner/repo#n", () => {
  assert.deepEqual(issueReferences("Fixes #12\nrefs #3, and Refs other/lib#7", "acme/app"), [
    { repo: "acme/app", number: 12 },
    { repo: "acme/app", number: 3 },
    { repo: "other/lib", number: 7 },
  ]);
  assert.deepEqual(issueReferences("Mentions #12 in passing", "acme/app"), []);
});

test("a PR body with no reference fails", async () => {
  const result = await checkPullRequest(event("Tidy the readme."), { gh: ghKnowing({}), hasToken: true });
  assert.match(result.problems.join("\n"), /names no issue/);
});

test("an issue that exists and predates the PR passes; a missing or newer one fails", async () => {
  const gh = ghKnowing({ "acme/app#12": "2026-05-01T00:00:00Z", "acme/app#13": "2026-05-03T00:00:00Z" });
  assert.deepEqual((await checkPullRequest(event("Fixes #12"), { gh, hasToken: true })).problems, []);
  assert.match((await checkPullRequest(event("Fixes #404"), { gh, hasToken: true })).problems.join(), /acme\/app#404 does not exist/);
  assert.match((await checkPullRequest(event("Refs #13"), { gh, hasToken: true })).problems.join(), /was opened after the pull request/);
});

test("with no token, or no network, the issue lookup skips with a note, but the reference is still required", async () => {
  const noToken = await checkPullRequest(event("Fixes #12"), { gh: ghKnowing({}), hasToken: false });
  assert.deepEqual(noToken.problems, []);
  assert.match(noToken.notes.join(), /no GH_TOKEN/);
  const offline = await checkPullRequest(event("Fixes #12"), { gh: async () => ({ ok: false, stderr: "dial tcp: lookup api.github.com: no such host" }), hasToken: true });
  assert.deepEqual(offline.problems, []);
  assert.match(offline.notes.join(), /could not reach GitHub/);
  assert.match((await checkPullRequest(event(""), { gh: ghKnowing({}), hasToken: false })).problems.join(), /names no issue/);
});

test("a repository the token cannot see is a note, never a missing issue", async () => {
  const gh = async () => ({ ok: false, stderr: "GraphQL: Could not resolve to a Repository with the name 'acme/private'. (repository)" });
  const result = await checkPullRequest(event("Refs acme/private#5"), { gh, hasToken: true });
  assert.deepEqual(result.problems, []);
  assert.match(result.notes.join(), /the token cannot see acme.private/);
});

test("an event that is no pull request is skipped", async () => {
  const result = await checkPullRequest({ repository: { full_name: "acme/app" } }, { gh: ghKnowing({}), hasToken: true });
  assert.deepEqual(result.problems, []);
  assert.match(result.notes.join(), /not a pull request/);
});
