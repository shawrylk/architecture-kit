import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { collectFinished, runMilestone } from "./milestone.mjs";
import { appendRecord, ledgerFileOf } from "./ledger.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: "pipe" }).trim();
function file(root, name, text) {
  writeFileSync(path.join(root, name), text);
  git(root, "add", ".");
  git(root, "commit", "-qm", name);
}
function fixture(t, { conflict = false } = {}) {
  const top = mkdtempSync(path.join(tmpdir(), "qc-milestone-"));
  t.after(() => rmSync(top, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const root = path.join(top, "repo");
  const origin = path.join(top, "origin");
  mkdirSync(root); mkdirSync(origin);
  git(origin, "init", "-q", "--bare");
  git(root, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "qc"], ["user.email", "qc@example.com"], ["commit.gpgsign", "false"]]) git(root, "config", key, value);
  file(root, "shared.txt", "base\n");
  git(root, "remote", "add", "origin", origin);
  git(root, "push", "-q", "origin", "main");
  const members = [];
  for (let n = 1; n <= 3; n++) {
    const branch = `feat/${n}-member`;
    git(root, "switch", "-qc", branch, "main");
    file(root, conflict && n < 3 ? "shared.txt" : `${n}.txt`, `${n}\n`);
    git(root, "push", "-q", "origin", branch);
    const sha = git(root, "rev-parse", "HEAD");
    members.push({ branch, sha, issue: String(n) });
    appendRecord(ledgerFileOf(root), { type: "verdict", sha, kind: n === 2 ? "branch" : "codex", verdict: "APPROVED" });
  }
  git(root, "switch", "-q", "main");
  const config = { root, worktree: { base: "origin/main" }, swarm: { review: { merge: "branch" } }, generated: { globs: [] } };
  const calls = []; const output = [];
  const io = { say: (s) => output.push(s), gh: (args) => { calls.push(args); return args[1] === "view" ? null : "https://github.com/a/b/pull/1"; } };
  return { root, origin, members, config, calls, output, io };
}
const created = (calls) => calls.filter((args) => args[1] === "create");

test("two finished branches → one milestone branch, one PR body with both Refs lines", async (t) => {
  const f = fixture(t);
  appendRecord(ledgerFileOf(f.root), { type: "verdict", sha: f.members[2].sha, kind: "codex", verdict: "CHANGES_REQUIRED" });
  assert.equal(await runMilestone(f.config, [], f.io), 0);
  assert.match(git(f.root, "branch", "--show-current"), /^milestone\/\d{4}-\d{2}-\d{2}-1$/);
  assert.equal(created(f.calls).length, 1);
  const args = created(f.calls)[0];
  assert.ok(!args.includes("--draft"));
  assert.match(args[args.indexOf("--body") + 1], /Refs #1\nRefs #2/);
  assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.root, "rev-parse", "@{upstream}"));
  { // generated files settle once
    const f = fixture(t);
    let runs = 0;
    f.config.generated.command = "generate";
    f.config.generated.globs = ["generated.txt"];
    assert.equal(await runMilestone(f.config, [], { ...f.io, run: () => { runs++; writeFileSync(path.join(f.root, "generated.txt"), "generated output\n"); return 0; } }), 0);
    assert.equal(runs, 1);
    assert.equal(git(f.root, "show", "HEAD:generated.txt"), "generated output");
    assert.equal(git(f.root, "log", "-1", "--format=%s"), "chore: regenerate the generated files");
    assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.root, "rev-parse", "@{upstream}"));
  }
  { // local-date numbering skips occupied local and remote ordinals
    const f = fixture(t);
    git(f.root, "branch", "milestone/2026-01-02-1", "main");
    git(f.root, "push", "-q", "origin", "main:refs/heads/milestone/2026-01-02-2");
    assert.equal(await runMilestone(f.config, [], { ...f.io, now: new Date(2026, 0, 2, 0, 5) }), 0);
    assert.equal(git(f.root, "branch", "--show-current"), "milestone/2026-01-02-3");
  }
});

test("a branch without an APPROVED verdict is not collected", (t) => {
  const f = fixture(t);
  rmSync(ledgerFileOf(f.root));
  assert.deepEqual(collectFinished(f.config), []);
});

test("one conflicting branch is left out and the other two merge", async (t) => {
  const f = fixture(t, { conflict: true });
  assert.equal(await runMilestone(f.config, [], f.io), 0);
  assert.match(f.output.join("\n"), /Left out:.*feat\/2-member/);
  for (const n of [0, 2]) git(f.root, "merge-base", "--is-ancestor", f.members[n].sha, "HEAD");
  assert.match(readFileSync(path.join(f.root, "shared.txt"), "utf8"), /1/);
  assert.match(created(f.calls)[0].at(-1), /Refs #3/);
  { // all conflicts return success without a push or PR and restore the original branch
    const f = fixture(t, { conflict: true });
    appendRecord(ledgerFileOf(f.root), { type: "verdict", sha: f.members[2].sha, kind: "codex", verdict: "CHANGES_REQUIRED" });
    file(f.root, "shared.txt", "new base\n");
    f.config.worktree.base = "main";
    assert.equal(await runMilestone(f.config, [], f.io), 0);
    assert.equal(git(f.root, "branch", "--show-current"), "main");
    assert.equal(f.calls.length, 0);
    assert.equal(git(f.root, "branch", "-r", "--list", "origin/milestone/*"), "");
    assert.equal(f.output.filter((s) => s.startsWith("Left out:")).length, 2);
  }
});

test("--drop rebuilds without the named branch", async (t) => {
  const f = fixture(t);
  assert.equal(await runMilestone(f.config, [], f.io), 0);
  const branch = git(f.root, "branch", "--show-current");
  // Pinned members and original base survive later movement of their source refs.
  git(f.root, "branch", "-f", f.members[0].branch, "main");
  assert.equal(await runMilestone(f.config, ["--drop", "feat/2-member"], f.io), 0);
  assert.equal(git(f.root, "branch", "--show-current"), branch);
  assert.throws(() => git(f.root, "cat-file", "-e", "HEAD:2.txt"));
  git(f.root, "cat-file", "-e", "HEAD:1.txt");
  assert.equal(created(f.calls).length, 1);
  assert.ok(f.calls.some((a) => a[1] === "edit" && !a.at(-1).includes("Refs #2")));

  // Reproduce interruption after the leased push, before the replacement state is saved.
  const interrupted = fixture(t);
  assert.equal(await runMilestone(interrupted.config, [], interrupted.io), 0);
  const name = git(interrupted.root, "branch", "--show-current");
  const manifest = path.join(interrupted.root, ".git", "qc", "milestones", `${name.slice(10)}.json`);
  const old = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(await runMilestone(interrupted.config, ["--drop", "feat/2-member"], interrupted.io), 0);
  const pushed = git(interrupted.root, "rev-parse", "HEAD");
  git(interrupted.root, "switch", "-qc", "saved-replay", pushed);
  git(interrupted.root, "branch", "-f", name, old.head);
  git(interrupted.root, "switch", "-q", name);
  old.pendingDrop = { target: "feat/2-member", head: pushed, replay: "saved-replay" };
  writeFileSync(manifest, JSON.stringify(old));
  // A retry must recognize the already published replay and make no second push.
  writeFileSync(path.join(interrupted.root, ".git", "hooks", "pre-push"), "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
  assert.equal(await runMilestone(interrupted.config, ["--drop", "feat/2-member"], interrupted.io), 0);
  assert.equal(git(interrupted.root, "branch", "--show-current"), name);
  assert.equal(git(interrupted.root, "rev-parse", "HEAD"), pushed);
  const recovered = JSON.parse(readFileSync(manifest, "utf8"));
  assert.equal(recovered.phase, "done");
  assert.equal(recovered.publishedSha, pushed);
  assert.ok(!recovered.pendingDrop);
  assert.ok(!recovered.members.some((m) => m.branch === "feat/2-member"));
  { // drop recovers a GitHub body update failure without another push
    const f = fixture(t);
    assert.equal(await runMilestone(f.config, [], f.io), 0);
    assert.equal(await runMilestone(f.config, ["--drop", "feat/2-member"], { ...f.io, gh: () => null }), 1);
    const head = git(f.root, "rev-parse", "HEAD");
    assert.equal(await runMilestone(f.config, [], f.io), 0);
    assert.equal(git(f.root, "rev-parse", "HEAD"), head);
    assert.ok(f.calls.some((a) => a[1] === "edit" && !a.at(-1).includes("Refs #2")));
  }
});

test("collection pins pushed heads, ignores local-only/stale approvals and honors revocation and scopes", (t) => {
  const f = fixture(t);
  git(f.root, "switch", "-q", f.members[0].branch);
  file(f.root, "local.txt", "local\n");
  assert.equal(collectFinished(f.config)[0].sha, f.members[0].sha);
  git(f.root, "push", "-q", "origin", f.members[0].branch);
  appendRecord(ledgerFileOf(f.root), { type: "verdict", sha: f.members[1].sha, kind: "codex", verdict: "CHANGES_REQUIRED", scope: "security" });
  assert.deepEqual(collectFinished(f.config).map((m) => m.branch), [f.members[2].branch]);
  { // failed fetch refuses stale candidates
    const f = fixture(t);
    git(f.root, "remote", "set-url", "origin", path.join(f.root, "missing"));
    assert.throws(() => collectFinished(f.config), /fetch/);
  }
});

test("dry-run changes no refs or files and no candidates is a successful no-op", async (t) => {
  const f = fixture(t);
  const refs = git(f.root, "show-ref");
  assert.equal(await runMilestone(f.config, ["--dry-run"], f.io), 0);
  assert.equal(git(f.root, "show-ref"), refs);
  assert.equal(f.calls.length, 0);
  rmSync(ledgerFileOf(f.root));
  assert.equal(await runMilestone(f.config, [], f.io), 0);
  assert.match(f.output.join("\n"), /nothing to merge/);
  { // a concurrent milestone refuses before switching branches
    const f = fixture(t);
    const dir = path.join(f.root, ".git", "qc", "milestones");
    mkdirSync(dir, { recursive: true });
    writeFileSync(path.join(dir, "lock"), JSON.stringify({ pid: process.pid }));
    assert.equal(await runMilestone(f.config, [], f.io), 1);
    assert.equal(git(f.root, "branch", "--show-current"), "main");
    assert.equal(f.calls.length, 0);
  }
});

test("publication failure resumes the same branch and PR creation without another batch", async (t) => {
  const f = fixture(t);
  assert.equal(await runMilestone(f.config, [], { ...f.io, gh: () => null }), 1);
  const branch = git(f.root, "branch", "--show-current");
  assert.equal(await runMilestone(f.config, [], f.io), 0);
  assert.equal(git(f.root, "branch", "--show-current"), branch);
  assert.equal(created(f.calls).length, 1);
  { // an unfinished clean build resumes from pinned members
    const f = fixture(t);
    f.config.generated.command = "generate";
    assert.equal(await runMilestone(f.config, [], { ...f.io, run: () => 1 }), 1);
    const branch = git(f.root, "branch", "--show-current");
    assert.equal(await runMilestone(f.config, [], { ...f.io, run: () => 0 }), 0);
    assert.equal(git(f.root, "branch", "--show-current"), branch);
    assert.equal(created(f.calls).length, 1);
  }
  { // a rejected initial push resumes the same built milestone
    const f = fixture(t);
    const hook = path.join(f.root, ".git", "hooks", "pre-push");
    writeFileSync(hook, "#!/usr/bin/env node\nprocess.exit(1);\n", { mode: 0o755 });
    assert.equal(await runMilestone(f.config, [], f.io), 1);
    const branch = git(f.root, "branch", "--show-current");
    rmSync(hook);
    git(f.root, "switch", "-q", "main");
    assert.equal(await runMilestone(f.config, [], f.io), 0);
    assert.equal(git(f.root, "rev-parse", `origin/${branch}`), git(f.root, "rev-parse", branch));
    assert.equal(created(f.calls).length, 1);
  }
});

test("a lease race cannot overwrite another writer and retains the pinned replay", async (t) => {
  const f = fixture(t);
  assert.equal(await runMilestone(f.config, [], f.io), 0);
  const branch = git(f.root, "branch", "--show-current");
  const original = git(f.root, "rev-parse", "HEAD");
  const hook = path.join(f.root, ".git", "hooks", "pre-push");
  writeFileSync(hook, `#!/usr/bin/env node\nrequire('node:child_process').execFileSync('git', ['--git-dir', ${JSON.stringify(f.origin)}, 'update-ref', 'refs/heads/${branch}', ${JSON.stringify(f.members[2].sha)}]);\n`, { mode: 0o755 });
  assert.equal(await runMilestone(f.config, ["--drop", "feat/2-member"], f.io), 1);
  assert.equal(git(f.origin, "rev-parse", `refs/heads/${branch}`), f.members[2].sha);
  assert.equal(git(f.root, "rev-parse", "HEAD"), original);
  const state = JSON.parse(readFileSync(path.join(f.root, ".git", "qc", "milestones", `${branch.slice(10)}.json`), "utf8"));
  assert.equal(state.publishedSha, original);
  assert.equal(state.pendingDrop.target, "feat/2-member");
  { // drop refuses a moved published ref and preserves recoverable state
    const f = fixture(t);
    assert.equal(await runMilestone(f.config, [], f.io), 0);
    const branch = git(f.root, "branch", "--show-current");
    const published = git(f.root, "rev-parse", "HEAD");
    file(f.root, "someone.txt", "moved\n");
    git(f.root, "push", "-q", "origin", branch);
    assert.equal(await runMilestone(f.config, ["--drop", "feat/2-member"], f.io), 1);
    assert.equal(git(f.root, "rev-parse", "HEAD"), git(f.root, "rev-parse", `origin/${branch}`));
    assert.notEqual(git(f.root, "rev-parse", "HEAD"), published);
  }
});
