import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { fleetPath, validateFleet, ownerOf, freeIssues, runFleet } from "./fleet.mjs";

const nodes = [
  { id: "a1", weight: 1, maxSize: "L", active: true },
  { id: "b2", weight: 1, maxSize: "L", active: true },
  { id: "c3", weight: 2, maxSize: "L", active: true },
];
const issue = (number, labels = [], createdAt = "2026-01-01T00:00:00Z") => ({ number, labels: labels.map(name => ({ name })), createdAt });
const qc = fileURLToPath(new URL("./qc.mjs", import.meta.url));

function fixture(t) {
  const cwd = mkdtempSync(path.join(os.tmpdir(), "qc-fleet-"));
  t.after(() => rmSync(cwd, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const env = { QC_FLEET_FILE: path.join(cwd, "config", "fleet.json") };
  const lines = [], errors = [];
  const deps = { cwd, env, say: line => lines.push(line), warn: line => errors.push(line) };
  const run = (args, extra = {}) => {
    lines.length = errors.length = 0;
    const code = runFleet(args, { ...deps, ...extra });
    return { code, lines: [...lines], errors: [...errors] };
  };
  return { cwd, env, run };
}

function fakeGh(issues, prs = []) {
  return (args, options) => {
    assert.ok(options.cwd);
    const expected = args[0] === "issue"
      ? ["issue", "list", "--state", "open", "--limit", "500", "--json", "number,labels,createdAt", "--repo", "o/r"]
      : ["pr", "list", "--state", "open", "--limit", "200", "--json", "number,headRefName,body", "--repo", "o/r"];
    assert.deepEqual(args, expected);
    return JSON.stringify(args[0] === "issue" ? issues : prs);
  };
}

test("fleet validates every field, defaults, paths, missing file and unreadable inputs", t => {
  const valid = { self: "a1", nodes: [{ id: "a1", weight: 1 }] };
  assert.deepEqual(validateFleet(valid), { self: "a1", nodes: [nodes[0]] });
  for (const [value, field] of [
    [null, "fleet"], [{}, "nodes"], [{ self: "a1", nodes: [] }, "self"],
    [{ ...valid, self: "other" }, "self"],
    ...["A", "a/b", "a".repeat(33), ""].map(id => [{ ...valid, nodes: [{ id, weight: 1 }] }, "id"]),
    [{ ...valid, nodes: [nodes[0], nodes[0]] }, "id"],
    ...[0, -1, 101, "1", NaN, Infinity].map(weight => [{ ...valid, nodes: [{ id: "a1", weight }] }, "weight"]),
    [{ ...valid, nodes: [null] }, "nodes"],
    [{ ...valid, nodes: [{ ...nodes[0], maxSize: "XL" }] }, "maxSize"],
    [{ ...valid, nodes: [{ ...nodes[0], active: "false" }] }, "active"],
  ]) assert.throws(() => validateFleet(value), new RegExp(field));
  assert.equal(fleetPath({ QC_FLEET_FILE: "/fleet" }, "linux", "/home/test"), "/fleet");
  assert.equal(fleetPath({ APPDATA: "/app" }, "win32", "/home/test"), path.join("/app", "qc", "fleet.json"));
  assert.equal(fleetPath({ XDG_CONFIG_HOME: "/xdg" }, "linux", "/home/test"), path.join("/xdg", "qc", "fleet.json"));
  assert.equal(fleetPath({}, "linux", "/home/test"), path.join("/home/test", ".config", "qc", "fleet.json"));
  const f = fixture(t);
  for (const verb of ["next", "status"]) {
    const result = f.run([verb]);
    assert.equal(result.code, 1);
    assert.deepEqual(result.errors, [`fleet is off: no ${f.env.QC_FLEET_FILE}`]);
  }
  assert.equal(f.run(["init", "--self", "a1", "--nodes", "a1:1:L"]).code, 0);
  writeFileSync(f.env.QC_FLEET_FILE, "{");
  assert.match(f.run(["status"]).errors.join(""), /fleet.*JSON/i);
  writeFileSync(f.env.QC_FLEET_FILE, JSON.stringify(valid));
  assert.equal(f.run(["next", "--wat"]).code, 1);
  assert.equal(f.run(["next", "--repo"]).code, 1);
  assert.equal(f.run(["next", "--repo", "bad"]).code, 1);
  for (const gh of [() => null, () => "{}", () => "bad"]) {
    assert.equal(f.run(["status", "--repo", "o/r"], { gh, git: () => "" }).code, 1);
  }
  assert.equal(f.run(["next", "--repo", "o/r"], { gh: fakeGh([]), git: () => null }).code, 1);
  assert.equal(f.run(["status", "--repo", "o/r"], { gh: args => args[0] === "issue" ? "[]" : null, git: () => "" }).code, 1);
  assert.equal(f.run(["next"], { origin: () => null }).code, 1);
});

test("ownerOf repeats across calls and repo case, using the specified SHA-256 score", () => {
  for (let number = 1; number <= 100; number++) {
    const expected = [...nodes].sort((a, b) => {
      const score = node => {
        const bytes = createHash("sha256").update(`o/r#${number}:${node.id}`).digest().readBigUInt64BE();
        const u = Number(bytes + 1n) / Number(2n ** 64n + 2n);
        return -node.weight / Math.log(u);
      };
      return score(b) - score(a);
    })[0].id;
    assert.equal(ownerOf("O/R", number, "M", nodes), expected);
    assert.equal(ownerOf("o/r", number, "M", [...nodes].reverse()), expected);
  }
});

test("weights 1,1,2 give the weight-2 node 45% to 55% of 3000 issues", () => {
  let count = 0;
  for (let number = 1; number <= 3000; number++) if (ownerOf("o/r", number, "M", nodes) === "c3") count++;
  assert.ok(count >= 1350 && count <= 1650, `c3 owns ${count}/3000`);
});

test("deactivation moves only the inactive node's issues", () => {
  const reduced = nodes.map(node => ({ ...node, active: node.id !== "b2" }));
  for (let number = 1; number <= 300; number++) {
    const before = ownerOf("o/r", number, "M", nodes);
    const after = ownerOf("o/r", number, "M", reduced);
    if (before === "b2") assert.notEqual(after, "b2");
    else assert.equal(after, before);
  }
});

test("size filtering respects S < M < L, defaults and case-insensitive labels", () => {
  const small = [{ id: "s", weight: 1, maxSize: "S" }];
  assert.equal(ownerOf("o/r", 1, "S", small), "s");
  assert.equal(ownerOf("o/r", 1, "M", small), null);
  assert.equal(ownerOf("o/r", 1, "L", [{ ...small[0], maxSize: "M" }]), null);
  assert.equal(ownerOf("o/r", 1, "S", [{ ...small[0], active: false }]), null);
  const result = freeIssues("o/r", "/tmp", { gh: fakeGh([issue(1, ["SIZE:s"]), issue(2), issue(3, ["size:l"])]), git: () => "" });
  assert.deepEqual(result.free.map(row => row.size), ["S", "M", "L"]);
});

test("free issues exclude hold labels and taken PR bodies, PR branches and origin branches", () => {
  const issues = Array.from({ length: 12 }, (_, i) => issue(i + 1));
  issues.push(issue(13, ["hold"]), issue(14, ["custom-hold"]), issue(15, ["fleet-skip"]));
  const prs = [{ number: 90, headRefName: "feat/2-work", body: "Fixes #1, #12. Avoid #30 and x#4 and #5suffix and #6_thing." }];
  let branchRead = false;
  const result = freeIssues("o/r", "/tmp", {
    gh: fakeGh(issues, prs), holdLabel: "custom-hold",
    git: (cwd, ...args) => {
      assert.equal(cwd, "/tmp");
      assert.deepEqual(args, ["ls-remote", "--heads", "origin"]);
      branchRead = true;
      return "abc\trefs/heads/fix/3-work\nabc\trefs/heads/fix/40-work\nabc\trefs/heads/fix/7\nabc\trefs/heads/nested/fix/8-work\n";
    },
  });
  assert.ok(branchRead);
  assert.deepEqual(result.free.map(row => row.number), [4, 5, 6, 7, 8, 9, 10, 11]);
  assert.equal(result.taken, 4);
  assert.deepEqual(freeIssues("o/r", "/tmp", {
    gh: fakeGh([issue(1)], [{ number: 90, headRefName: "feat/12-x", body: "Fixes #12" }]),
    git: () => "abc\trefs/heads/feat/12-x\n",
  }).free.map(row => row.number), [1]);
});

test("next prints the oldest five or all, exits 3 when empty, and status stays within 15 lines", t => {
  const remoteFixture = fixture(t);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: remoteFixture.cwd, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout;
  };
  git("init");
  git("init", "--bare", "origin.git");
  git("init", "--bare", "requested.git");
  git("-c", "user.name=Fleet Test", "-c", "user.email=fleet@example.test", "-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "fixture");
  git("remote", "add", "origin", path.join(remoteFixture.cwd, "origin.git"));
  git("push", "origin", "HEAD:refs/heads/feat/1-x");
  git("config", `url.${path.join(remoteFixture.cwd, "requested.git")}.insteadOf`, "https://github.com/o/r.git");
  assert.equal(remoteFixture.run(["init", "--self", "a1", "--nodes", "a1:1:L"]).code, 0);
  const remoteReaders = { gh: fakeGh([issue(1)]), origin: () => "local/repo" };
  assert.equal(remoteFixture.run(["next", "--repo", "local/repo"], {
    ...remoteReaders, gh: args => JSON.stringify(args[0] === "issue" ? [issue(1)] : []),
  }).code, 3);
  assert.deepEqual(remoteFixture.run(["next", "--repo", "o/r"], remoteReaders), {
    code: 0, lines: ["1"], errors: [],
  });
  const f = fixture(t);
  assert.equal(f.run(["init", "--self", "a1", "--nodes", "a1:1:L,b2:1:S"]).code, 0);
  const issues = Array.from({ length: 12 }, (_, i) => issue(i + 1, ["size:L"], `2026-01-${String(12 - i).padStart(2, "0")}T00:00:00Z`));
  const extra = { gh: fakeGh(issues), git: () => "", origin: () => "o/r" };
  assert.deepEqual(f.run(["next"], extra), { code: 0, lines: ["12", "11", "10", "9", "8"], errors: [] });
  assert.deepEqual(f.run(["next", "--repo", "o/r", "--all"], extra).lines, issues.map(row => String(row.number)).reverse());
  writeFileSync(path.join(f.cwd, "qc.config.json"), JSON.stringify({ merge: { holdLabel: "custom-hold" } }));
  assert.equal(f.run(["next", "--repo", "o/r"], { ...extra, gh: fakeGh([issue(99, ["custom-hold"])]) }).code, 3);
  const empty = f.run(["next", "--repo", "o/r"], { ...extra, gh: fakeGh([]) });
  assert.deepEqual(empty, { code: 3, lines: [], errors: ["no free issue for a1"] });
  const status = f.run(["status", "--repo", "o/r"], extra);
  assert.equal(status.code, 0);
  assert.equal(status.lines.length, 3);
  assert.match(status.lines[0], /a1.*1.*L.*true.*12.*12,11,10,9,8,7,6,5,4,3$/);
  assert.match(status.lines[1], /b2.*1.*S.*true.*0/);
  assert.match(status.lines[2], /taken.*0.*unassigned.*0/);
  const many = Array.from({ length: 20 }, (_, i) => ({ id: `pc${i}`, weight: 1, maxSize: "L", active: true }));
  writeFileSync(f.env.QC_FLEET_FILE, JSON.stringify({ self: "pc0", nodes: many }));
  const capped = f.run(["status", "--repo", "o/r"], extra);
  assert.equal(capped.lines.length, 15);
  assert.match(capped.lines.at(-1), /6 more nodes/);
  writeFileSync(f.env.QC_FLEET_FILE, JSON.stringify({ self: "a1", nodes: [{ ...nodes[0], active: false }] }));
  assert.match(f.run(["status", "--repo", "o/r"], extra).lines.at(-1), /unassigned.*12/);
});

test("init routes through qc from an empty folder, creates mode 0600 and refuses replacement", t => {
  const guide = readFileSync(new URL("../../../../docs/fleet.md", import.meta.url), "utf8");
  assert.ok(guide.trimEnd().split("\n").length <= 40);
  assert.match(guide, /QC_FLEET_FILE/);
  assert.match(guide, /active.*false/);
  const reference = readFileSync(new URL("../../../../docs/reference.md", import.meta.url), "utf8");
  for (const verb of ["init", "next", "status"]) assert.match(reference, new RegExp(`\\| .*qc fleet ${verb}.*\\|`));
  const f = fixture(t);
  const call = args => spawnSync(process.execPath, [qc, "fleet", ...args], { cwd: f.cwd, env: { ...process.env, ...f.env }, encoding: "utf8" });
  const args = ["init", "--self", "a1", "--nodes", "a1:1:L,b2:2:M,c3:1:S"];
  const first = call(args);
  assert.equal(first.status, 0, first.stderr);
  const saved = readFileSync(f.env.QC_FLEET_FILE, "utf8");
  assert.equal(JSON.parse(saved).nodes.length, 3);
  if (process.platform !== "win32") assert.equal(statSync(f.env.QC_FLEET_FILE).mode & 0o777, 0o600);
  assert.equal(call(args).status, 1);
  assert.equal(readFileSync(f.env.QC_FLEET_FILE, "utf8"), saved);
  assert.equal(call([...args, "--force"]).status, 0);
  for (const nodesArg of ["a1:1:L:extra", "a1:no:L", "a1:1:XL"]) assert.equal(call(["init", "--self", "a1", "--nodes", nodesArg, "--force"]).status, 1);
  assert.equal(call(["init", "--self", "a1"]).status, 1);
});
