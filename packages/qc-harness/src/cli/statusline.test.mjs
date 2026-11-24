import test from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, spawnSync } from "node:child_process";

const script = fileURLToPath(new URL("../../../../user-config/claude/statusline.js", import.meta.url));

function fixture(t, { checkout = true } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "qc-statusline-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 }));
  const home = path.join(root, "home");
  const cwd = path.join(root, "project");
  mkdirSync(home);
  mkdirSync(cwd);
  const installed = path.join(home, "statusline.cjs");
  copyFileSync(script, installed);
  if (checkout) execFileSync("git", ["init", "--quiet", cwd]);
  const fleet = path.join(home, "fleet.json");
  const nodeFile = path.join(cwd, ".git", "qc", "fleet", "node.json");
  return {
    fleet, cwd, root, home,
    node(value) {
      mkdirSync(path.dirname(nodeFile), { recursive: true });
      writeFileSync(nodeFile, JSON.stringify(value));
    },
    run(dir = cwd, extraEnv = {}) {
      const result = spawnSync(process.execPath, [installed], {
        cwd: dir,
        env: { ...process.env, HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: path.join(home, ".claude"), QC_FLEET_FILE: fleet, ...extraEnv },
        input: JSON.stringify({ workspace: { current_dir: dir } }), encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stderr, "");
      return result.stdout.replace(/\x1b\[[0-9;]*m/g, "");
    },
  };
}

test("omits the fleet when its file is missing", t => {
  assert.doesNotMatch(fixture(t).run(), /fleet /);
});

test("silently omits unreadable, malformed, and invalid fleet settings", t => {
  const f = fixture(t);
  assert.throws(() => readFileSync(f.root, "utf8"), /EISDIR|EPERM|EACCES/);
  assert.doesNotMatch(f.run(f.cwd, { QC_FLEET_FILE: f.root }), /fleet /);
  for (const value of ["{", "null", "{}", ...["", "UPPER", "has space", "a".repeat(33), 123].map(self => JSON.stringify({ self }))]) {
    writeFileSync(f.fleet, value);
    assert.doesNotMatch(f.run(), /fleet /);
  }
});

test("uses the platform config directory when no fleet override is set", t => {
  const f = fixture(t);
  const xdg = path.join(f.root, "xdg");
  const appdata = path.join(f.root, "appdata");
  for (const [base, self] of [[xdg, "xdg-node"], [appdata, "windows-node"], [path.join(f.home, ".config"), "home-node"]]) {
    mkdirSync(path.join(base, "qc"), { recursive: true });
    writeFileSync(path.join(base, "qc", "fleet.json"), JSON.stringify({ self }));
  }
  assert.match(f.run(f.cwd, { QC_FLEET_FILE: "", XDG_CONFIG_HOME: xdg, APPDATA: appdata }),
    process.platform === "win32" ? /fleet windows-node off / : /fleet xdg-node off /);
  assert.match(f.run(f.cwd, { QC_FLEET_FILE: "", XDG_CONFIG_HOME: "", APPDATA: "" }), /fleet home-node off /);
});

test("shows the name after git and no mark for a live follower", t => {
  const f = fixture(t);
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  f.node({ pid: process.pid, leader: false });
  assert.match(f.run(), / [^\n]+ fleet dev-1 /);
});

test("marks a live leader", t => {
  const f = fixture(t);
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  f.node({ pid: process.pid, leader: true });
  assert.match(f.run(), /fleet dev-1 leader /);
});

test("marks a live leader through a symlinked checkout subfolder", t => {
  const f = fixture(t);
  const nested = path.join(f.cwd, "nested");
  const linked = path.join(f.root, "linked-subfolder");
  mkdirSync(nested);
  symlinkSync(nested, linked, process.platform === "win32" ? "junction" : "dir");
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  f.node({ pid: process.pid, leader: true });
  assert.match(f.run(linked), /fleet dev-1 leader /);
});

test("marks a live leader using GIT_DIR and GIT_WORK_TREE", t => {
  const f = fixture(t);
  const outside = path.join(f.root, "outside");
  mkdirSync(outside);
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  f.node({ pid: process.pid, leader: true });
  assert.match(f.run(outside, {
    GIT_DIR: path.join(f.cwd, ".git"),
    GIT_WORK_TREE: f.cwd,
  }), /fleet dev-1 leader /);
});

test("marks missing, malformed, and stopped nodes off", t => {
  const f = fixture(t);
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  assert.match(f.run(), /fleet dev-1 off /);
  for (const value of [null, {}, { pid: -1, leader: true }, { pid: 2147483647, leader: true }, { pid: String(process.pid), leader: true }]) {
    f.node(value);
    assert.match(f.run(), /fleet dev-1 off /);
  }
});

test("shows the fleet without a mark outside a checkout", t => {
  const f = fixture(t, { checkout: false });
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  assert.match(f.run(), /fleet dev-1 /);
});

test("reads the common directory from a linked worktree and nested folder", t => {
  const f = fixture(t);
  execFileSync("git", ["-C", f.cwd, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--quiet", "--allow-empty", "-m", "fixture"]);
  const linked = path.join(f.root, "linked");
  execFileSync("git", ["-C", f.cwd, "worktree", "add", "--quiet", "--detach", linked]);
  const nested = path.join(linked, "nested");
  mkdirSync(nested);
  writeFileSync(f.fleet, JSON.stringify({ self: "dev-1" }));
  f.node({ pid: process.pid, leader: true });
  assert.match(f.run(nested), /fleet dev-1 leader /);
});
