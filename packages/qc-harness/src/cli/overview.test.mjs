import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { buildOverview, fileDebt, debtDue } from "./overview.mjs";

function fixture(t) {
  const root = mkdtempSync(path.join(os.tmpdir(), "qc-overview-"));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }));
  const git = (args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  git(["init", "-q", "-b", "main"]);
  git(["config", "user.name", "Overview test"]);
  git(["config", "user.email", process.env.GIT_AUTHOR_EMAIL || "overview@example.test"]);
  git(["remote", "add", "origin", "https://github.com/local/repo.git"]);
  git(["commit", "-q", "--allow-empty", "-m", "base"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const put = (file, text) => { mkdirSync(path.dirname(path.join(root, file)), { recursive: true }); writeFileSync(path.join(root, file), text); };
  return { root, git, put, mark: path.join(root, ".git/qc/debt-review.json") };
}

test("overview prints at most 60 lines on a repo with 200 files", async (t) => {
  const { root, git, put } = fixture(t);
  for (let i = 0; i < 200; i++) put(`src/mod/file${i}.mjs`, "x\n".repeat(i + 1));
  put("docs/architecture.md", "# Architecture\n" + "## Module\n".repeat(20));
  put("docs/large.md", "docs\n".repeat(500));
  put("package-lock.json", "x\n".repeat(300));
  put("src/binary.bin", Buffer.from([0, 255, 10]));
  put("src/binary.mjs", Buffer.from([0, 255, 10]));
  if (process.platform !== "win32") put("src/line\nbreak.mjs", "x\n".repeat(250));
  git(["add", "."]); git(["commit", "-qm", "files"]);
  put("src/mod/file0.mjs", "changed\n");
  put("docs/large.md", "updated docs\n".repeat(500));
  git(["add", "."]); git(["commit", "-qm", "touch source and docs"]);
  put(".git/qc/ledger.jsonl", [
    { type: "ci-failure", id: "local", repository: "local/repo", branch: "main", test: "broken\ntest" },
    { type: "ci-failure", id: "foreign", repository: "other/repo", branch: "main", test: "foreign failure" },
    { type: "ci-failure", id: "fixed", repository: "local/repo", branch: "main", test: "fixed failure" },
    { type: "ci-resolution", branch: "main", ids: ["fixed"] },
  ].map((r) => JSON.stringify(r)).join("\n") + "\n");
  const output = await buildOverview(root, { gh: () => JSON.stringify(Array.from({ length: 20 }, () => ({ title: "debt\n" + "x".repeat(150) }))) });
  const lines = output.trimEnd().split("\n");
  assert.ok(lines.length <= 60);
  for (const section of ["Modules", "Largest", "Churn", "CI failures", "Debt"]) assert.ok(lines.includes(section));
  assert.ok(lines.every((line) => line.length <= 100));
  for (const section of output.split(/^(?:Modules|Largest|Churn|CI failures|Debt)$/m).slice(1)) assert.ok(section.trim().split("\n").length <= 10);
  const sectionRows = (name, next) => output.split(`${name}\n`)[1].split(`\n${next}\n`)[0].split("\n");
  if (process.platform !== "win32") {
    assert.deepEqual(sectionRows("Largest", "Churn").slice(0, 2), ["- src/line break.mjs: 250 lines", "- src/mod/file199.mjs: 200 lines"]);
    assert.deepEqual(sectionRows("Churn", "CI failures").slice(0, 2), ["- src/mod/file0.mjs: 2 touches", "- src/line break.mjs: 1 touches"]);
  }
  assert.doesNotMatch(sectionRows("Largest", "Churn").join("\n") + sectionRows("Churn", "CI failures").join("\n"), /docs\//);
  assert.match(output, /broken test/);
  assert.doesNotMatch(output, /package-lock|binary\.(?:bin|mjs)|foreign failure|fixed failure/);
});

test("debt file skips an item whose title is already an open issue", async (t) => {
  const { root, put, git, mark } = fixture(t);
  const title = "x".repeat(80), calls = [];
  put("report.md", `## Debt\n- Existing. Details\n- New $(touch pwned). More\n  continuation\n- New $(touch pwned). Repeated\n- ${title} extra. Body\n## Other\n- Ignore\n`);
  const linked = path.join(root, "linked");
  git(["worktree", "add", "-qb", "review", linked]);
  await fileDebt(linked, path.join(root, "report.md"), { gh: (args) => { calls.push(args); return args[1] === "list" ? '[{"title":"Existing"}]' : "created"; } });
  assert.deepEqual(calls[0], ["issue", "list", "--state", "open", "--limit", "1000", "--json", "title"]);
  assert.deepEqual(calls.slice(1).map((args) => args[args.indexOf("--title") + 1]), ["New $(touch pwned)", title]);
  assert.match(calls[1][calls[1].indexOf("--body") + 1], /continuation/);
  assert.ok(calls.slice(1).every((args) => args.includes("debt")));
  assert.deepEqual(JSON.parse(readFileSync(mark, "utf8")), { main: git(["rev-parse", "origin/main"]) });
  assert.equal(existsSync(path.join(root, "pwned")), false);
  assert.equal(existsSync(path.join(root, ".git/qc/ledger.jsonl")), false);
});

test("debt due counts first-parent milestone merges and resets after filing", async (t) => {
  const { root, git, put } = fixture(t), output = [];
  const base = git(["rev-parse", "HEAD"]);
  const check = () => debtDue(root, { log: (line) => output.push(line) });
  assert.equal(await check(), 1); assert.equal(output.pop(), "not due: 0 of 10");
  git(["commit", "-q", "--allow-empty", "-m", "mention milestone/not-a-merge"]);
  git(["checkout", "-qb", "feature/side"]);
  git(["checkout", "-qb", "milestone/side"]); git(["commit", "-q", "--allow-empty", "-m", "side"]);
  git(["checkout", "-q", "feature/side"]); git(["merge", "--no-ff", "-qm", "Merge milestone/side", "milestone/side"]);
  git(["checkout", "-q", "main"]); git(["merge", "--no-ff", "-qm", "Merge feature/side", "feature/side"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(await check(), 1); assert.equal(output.pop(), "not due: 0 of 10");
  for (let i = 0; i < 10; i++) {
    const branch = `feature/milestone/${i}`;
    git(["checkout", "-qb", branch]);
    git(["commit", "-q", "--allow-empty", "-m", "feature"]);
    git(["checkout", "-q", "main"]);
    git(["merge", "--no-ff", "-qm", `Merge branch '${branch}'`, branch]);
  }
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  assert.equal(await check(), 1); assert.equal(output.pop(), "not due: 0 of 10");
  for (let i = 0; i < 10; i++) {
    git(["checkout", "-qb", `milestone/${i}`]);
    put("src/hot/file.mjs", `export const replacement = '�'; // ${i}\n`);
    put("docs/hottest.md", `${i}\n`);
    put("src/aaa/binary.mjs", Buffer.from(i % 2 ? [255, i] : [0, i]));
    put("src/deleted/file.ts", `${i}\n`);
    if (i === 0) put("src/cold/file.ts", "cold\n");
    git(["add", "."]); git(["commit", "-qm", "change"]);
    git(["checkout", "-q", "main"]); git(["merge", "--no-ff", "-qm", (i % 2 ? "Merge pull request #1 from local/milestone/2026-11-23-1" : "Merge branch 'milestone/2026-11-23-1'"), `milestone/${i}`]);
    git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
    if (i === 8) { assert.equal(await check(), 1); assert.equal(output.pop(), "not due: 9 of 10"); }
  }
  git(["rm", "-q", "src/deleted/file.ts"]); git(["commit", "-qm", "remove old source"]);
  git(["update-ref", "refs/remotes/origin/main", "HEAD"]);
  git(["checkout", "-q", "--detach", base]);
  put("src/checkout-only/file.ts", "checkout only\n");
  assert.equal(await check(), 0); assert.equal(output.pop(), "due: src/hot");
  put("report.md", "## Debt\nNone.\n- Ignored\n");
  await fileDebt(root, "report.md", { gh: () => "[]" });
  assert.equal(await check(), 1); assert.equal(output.pop(), "not due: 0 of 10");
});

test("debt commands preserve the watermark on errors and due exits 3", async (t) => {
  const { root, put, mark } = fixture(t);
  put("report.md", "## Debt\n- One. Body\n- Two. Body\n");
  const before = '{"main":"saved"}\n'; put(".git/qc/debt-review.json", before);
  let creates = 0;
  await assert.rejects(() => fileDebt(root, "report.md", { gh: (args) => {
    if (args[1] === "list") return "[]";
    if (++creates === 2) throw new Error("gh failed");
    return "created";
  } }), /gh failed/);
  assert.equal(readFileSync(mark, "utf8"), before);
  await assert.rejects(() => fileDebt(root, "missing.md"), /ENOENT/);
  await assert.rejects(() => fileDebt(root, "report.md", { gh: () => { throw new Error("list failed"); } }), /list failed/);
  assert.equal(creates, 2);
  const errors = [];
  assert.equal(await debtDue(root, { error: (line) => errors.push(line) }), 3);
  assert.ok(errors.length);
  rmSync(mark);
  assert.equal(await debtDue(root, { git: () => { throw new Error("git failed"); }, error: (line) => errors.push(line) }), 3);
  assert.equal(errors.at(-1), "debt: git failed");
});
