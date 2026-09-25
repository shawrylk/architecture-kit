import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  BRANCH,
  OFF,
  WORKTREE,
  duration,
  isolationRefusal,
  isolationSettings,
  leaseHeldByAnother,
  leaseState,
  sessionIdOf,
  worktreeKind,
} from "./worktree-isolation.mjs";

const NOW = Date.parse("2026-09-20T12:00:00Z");
const LEASE_FILE = "/repo/.git/worktrees/tasks/qc-agent-lease.json";
const base = (overrides = {}) => ({
  settings: isolationSettings({ isolation: { require: WORKTREE } }),
  branch: "feat/tasks",
  kind: "linked",
  inSpecialOperation: false,
  lease: null,
  sessionId: "session-aaaa",
  now: NOW,
  leaseFile: LEASE_FILE,
  root: "/repo-tasks",
  qc: "qc",
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

test("the refusal of a held lease names the file, the holder, its age, its lapse, and both lease commands", () => {
  const lease = { sessionId: "session-bbbb-0000-1111", branch: "feat/tasks", updatedAt: "2026-09-20T11:30:00Z" };
  const reason = isolationRefusal(base({ lease }));
  assert.ok(reason.includes(LEASE_FILE), reason);
  assert.ok(reason.includes("session session-bbbb-0000-1111"), "the holder is named in full, so --session can match it");
  assert.ok(reason.includes("30m ago"), reason);
  assert.ok(reason.includes("lapses at 2026-09-20T19:30:00.000Z, in 7h 30m"), reason);
  assert.ok(reason.includes('`qc lease status "/repo-tasks"`'), reason);
  assert.ok(reason.includes('`qc lease release "/repo-tasks" --session <id>`'), reason);
  assert.ok(reason.includes('`qc lease release "/repo-tasks" --force`'), reason);
});

test("a lease lapses leaseHours after its last write, and not before", () => {
  const lease = { sessionId: "session-bbbb", branch: "feat/tasks", updatedAt: "2026-09-20T11:00:00Z" };
  const fresh = leaseState(lease, NOW, 8);
  assert.deepEqual(
    { holder: fresh.holder, branch: fresh.branch, age: fresh.age, lapsesAt: fresh.lapsesAt, live: fresh.live },
    { holder: "session-bbbb", branch: "feat/tasks", age: 3_600_000, lapsesAt: Date.parse("2026-09-20T19:00:00Z"), live: true },
  );
  assert.equal(leaseState(lease, NOW, 1).live, true, "a lease exactly leaseHours old still binds");
  assert.equal(leaseState(lease, NOW + 1, 1).live, false);
});

test("a lease with no readable holder or time never binds, and never crashes the guard", () => {
  const written = "2026-09-20T11:30:00Z";
  for (const lease of [
    { sessionId: 123, updatedAt: written },
    { sessionId: "   ", updatedAt: written },
    { sessionId: "session-bbbb", updatedAt: "yesterday-ish" },
    { sessionId: "session-bbbb", updatedAt: "2026-09-20T13:00:00Z" },
  ]) {
    assert.equal(leaseState(lease, NOW, 8).live, false, JSON.stringify(lease));
    assert.equal(isolationRefusal(base({ lease })), null, JSON.stringify(lease));
  }
});

test("a blank or non-string session id is no session, so it neither holds nor is refused", () => {
  assert.equal(sessionIdOf("   "), null);
  assert.equal(sessionIdOf(42), null);
  assert.equal(sessionIdOf(" session-aaaa "), "session-aaaa");
  const lease = { sessionId: "session-bbbb", branch: "feat/tasks", updatedAt: "2026-09-20T11:30:00Z" };
  assert.equal(isolationRefusal(base({ lease, sessionId: "   " })), null);
});

test("a duration reads in whole hours and minutes, and seconds under a minute", () => {
  assert.equal(duration(45_000), "45s");
  assert.equal(duration(30 * 60_000 + 59_000), "30m");
  assert.equal(duration(7 * 3_600_000 + 5 * 60_000), "7h 5m");
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
