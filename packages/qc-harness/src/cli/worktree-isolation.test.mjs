import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BRANCH,
  OFF,
  WORKTREE,
  isolationRefusal,
  isolationSettings,
  leaseHeldByAnother,
  worktreeKind,
} from "./worktree-isolation.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const base = (overrides = {}) => ({
  settings: isolationSettings({ isolation: { require: WORKTREE } }),
  branch: "feat/tasks",
  kind: "linked",
  inSpecialOperation: false,
  lease: null,
  sessionId: "session-aaaa",
  now: NOW,
  ...overrides,
});

test("off is the default, and an unconfigured repository is never restricted", () => {
  assert.equal(isolationSettings().require, OFF);
  assert.equal(isolationRefusal(base({ settings: isolationSettings(), branch: "main", kind: "primary" })), null);
});

test("an agent on its own branch in its own worktree is allowed", () => {
  assert.equal(isolationRefusal(base()), null);
});

test("generating code on a protected branch is refused and names the branch", () => {
  const reason = isolationRefusal(base({ branch: "main" }));
  assert.match(reason, /"main" is a protected branch/);
  assert.match(reason, /git worktree add/);
});

test("the protected branch list is configurable", () => {
  const settings = isolationSettings({ isolation: { require: BRANCH, protectedBranches: ["trunk"] } });
  assert.match(isolationRefusal(base({ settings, branch: "trunk" })), /"trunk" is a protected branch/);
  assert.equal(isolationRefusal(base({ settings, branch: "main" })), null);
});

test("require:branch permits the primary worktree, require:worktree does not", () => {
  const onBranch = isolationSettings({ isolation: { require: BRANCH } });
  assert.equal(isolationRefusal(base({ settings: onBranch, kind: "primary" })), null);
  assert.match(isolationRefusal(base({ kind: "primary" })), /primary worktree/);
});

test("a second session in one worktree is refused, because that is two agents on one branch", () => {
  const lease = { sessionId: "session-bbbb", branch: "feat/tasks", updatedAt: "2026-09-20T11:30:00Z" };
  assert.match(isolationRefusal(base({ lease })), /Another agent \(session session-/);
});

test("an agent's own lease never refuses its own edit", () => {
  const lease = { sessionId: "session-aaaa", branch: "feat/tasks", updatedAt: "2026-09-20T11:30:00Z" };
  assert.equal(isolationRefusal(base({ lease })), null);
});

test("an abandoned lease expires, so a crashed session cannot wedge a worktree", () => {
  const stale = { sessionId: "session-bbbb", updatedAt: "2026-09-19T12:00:00Z" };
  assert.equal(leaseHeldByAnother(stale, "session-aaaa", NOW, 8), null);
  assert.equal(isolationRefusal(base({ lease: stale })), null);
});

test("a detached HEAD is refused, but not mid-rebase when detaching is the point", () => {
  assert.match(isolationRefusal(base({ branch: "" })), /HEAD is detached/);
  assert.equal(isolationRefusal(base({ branch: "", inSpecialOperation: true })), null);
});

test("a linked worktree is told apart from the primary by its git dir", () => {
  assert.equal(worktreeKind("/repo/.git", "/repo/.git"), "primary");
  assert.equal(worktreeKind("/repo/.git/worktrees/tasks", "/repo/.git"), "linked");
});

test("a misconfigured isolation level is a named config error, not a silent pass", () => {
  assert.throws(() => isolationSettings({ isolation: { require: "yes" } }), /swarm\.isolation\.require/);
  assert.throws(() => isolationSettings({ isolation: { leaseHours: 0 } }), /swarm\.isolation\.leaseHours/);
  assert.throws(() => isolationSettings({ isolation: { leaseHours: "8" } }), /swarm\.isolation\.leaseHours/);
});
