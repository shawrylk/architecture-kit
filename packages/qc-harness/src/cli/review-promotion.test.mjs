import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "../config.mjs";
import { appendRecord, ledgerFileOf } from "./ledger.mjs";

const HEAD = "a".repeat(40);
const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const PROMOTION = { integration: "dev", release: "main" };
const PR = { number: 7, headRefName: "dev", baseRefName: "main", headRefOid: HEAD, url: "https://github.com/example/repo/pull/7", isCrossRepository: false };

async function fixture(t, { swarm = { dispatch: {}, review: { promotion: PROMOTION } }, pr = PR, diff = "infra/net.tf\ndb/migrations/0042.sql\nsrc/a.ts\n", records = [], increment = "infra/increment.tf\nsrc/a.ts\n" } = {}) {
  const { runReview } = await import("./review-promotion.mjs");
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-review-promotion-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ swarm }));
  for (const record of records) appendRecord(ledgerFileOf(root), record);
  const out = [];
  const err = [];
  const calls = [];
  const gitCalls = [];
  const git = (cwd, ...args) => {
    assert.equal(cwd, root);
    gitCalls.push(args);
    return increment;
  };
  const gh = (args, options) => {
    assert.equal(options.cwd, root);
    calls.push(args);
    if (args.join(" ") === "pr view 7 --json number,headRefName,baseRefName,headRefOid,url,isCrossRepository") return pr === null ? null : JSON.stringify(pr);
    if (args.join(" ") === "api --paginate repos/{owner}/{repo}/pulls/7/files --jq .[].filename") return diff;
    assert.fail(`Unexpected gh call: ${args.join(" ")}`);
  };
  const run = (args = ["promotion", "7"]) => runReview(load(root), args, { gh, git, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { root, out, err, calls, gitCalls, run, file: path.join(root, ".git", "qc", "promotion", "pr-7.md") };
}

test("qc review promotion 7 writes the brief of the files on the risk surfaces", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), 0, f.err.join("\n"));
  const brief = readFileSync(f.file, "utf8");
  for (const text of ["# Promotion review", "#7", "dev", "main", `Head: ${HEAD}`, "Scope: promotion", "2 of 3", "infra/net.tf", "db/migrations/0042.sql", "## Review these files", "## Checks"]) {
    assert.ok(brief.includes(text), text);
  }
  assert.doesNotMatch(brief, /src\/a\.ts/);
  assert.doesNotMatch(brief + f.out.join("\n"), /Reviewed:/);
  for (const check of [/infra:.*permissions.*public exposure.*removed protections/i, /migrations:.*order.*destructive statements.*rollback path/i,
    /workflows:.*new triggers.*secret use.*unpinned actions/i, /secrets in logs:.*log or error output.*token.*key.*password.*personal data/i]) assert.match(brief, check);
  assert.match(brief, new RegExp(`first line.*VERDICT: APPROVED ${HEAD}.*VERDICT: CHANGES_REQUIRED ${HEAD}`));
  assert.equal(f.out.length, 3);
  assert.equal(f.out[0], `Wrote ${f.file}`);
  assert.match(f.out[1], /architecture:sdd-branch-reviewer.*model.*opus/);
  assert.ok(f.out[1].includes(`Brief: ${f.file}\nScope: promotion\nWorktree:`));
  assert.ok(f.out[1].includes(`dev at ${HEAD}`));
  assert.equal(f.out[2], `Merge with --match-head-commit ${HEAD} after the review approves.`);
  assert.equal(f.calls.length, 2);
});

for (const [name, swarm, cause] of [
  ["promotion unset", { dispatch: {} }, /swarm\.review\.promotion/],
  ["dispatch off", { dispatch: false, review: { promotion: PROMOTION } }, /swarm\.dispatch/],
]) {
  test(`qc review refuses ${name}`, async (t) => {
    const f = await fixture(t, { swarm });
    assert.equal(await f.run(), 1);
    assert.match(f.err.join("\n"), cause);
    assert.equal(f.calls.length, 0);
  });
}

for (const field of ["headRefName", "baseRefName"]) {
  test(`qc review refuses the wrong ${field} and names both configured branches`, async (t) => {
    const f = await fixture(t, { pr: { ...PR, [field]: "other" } });
    assert.equal(await f.run(), 1);
    assert.match(f.err.join("\n"), /dev.*main/);
    assert.match(f.err.join("\n"), /other/);
    assert.equal(f.calls.length, 1);
  });
}

for (const [name, options] of [["PR", { pr: null }], ["diff", { diff: null }]]) {
  test(`qc review refuses a null gh ${name} answer`, async (t) => {
    const f = await fixture(t, options);
    assert.equal(await f.run(), 1);
    assert.match(f.err.join("\n"), /gh/);
    assert.match(f.err.join("\n"), /7/);
  });
}

test("qc review promotion without a PR prints usage and exits 2", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(["promotion"]), 2);
  assert.match([...f.out, ...f.err].join("\n"), /qc review promotion <pr>/);
  assert.equal(f.calls.length, 0);
  const cli = spawnSync(process.execPath, [QC, "review", "promotion"], { cwd: f.root, encoding: "utf8", windowsHide: true });
  assert.equal(cli.status, 2, cli.stderr);
  assert.match(cli.stdout + cli.stderr, /qc review promotion <pr>/);
});

test("qc review accepts only promotion with one positive PR number", async (t) => {
  const f = await fixture(t);
  for (const args of [[], ["branch", "7"], ["promotion", "../7"], ["promotion", "0"], ["promotion", "7", "extra"]]) {
    assert.equal(await f.run(args), 2);
  }
  assert.equal(f.calls.length, 0);
});

test("the brief limits the paths to 200 and names how to read the rest", async () => {
  const { promotionBrief } = await import("./review-promotion.mjs");
  const files = Array.from({ length: 203 }, (_, i) => `infra/${i}.tf`);
  const brief = promotionBrief({ pr: 7, head: HEAD, ...PROMOTION, files, total: 205 });
  assert.match(brief, /203 of 205/);
  assert.equal(brief.match(/^- `infra\//gm).length, 200);
  assert.doesNotMatch(brief, /infra\/200\.tf/);
  assert.match(brief, /3 more.*gh api --paginate repos\/\{owner\}\/\{repo\}\/pulls\/7\/files --jq '\.\[\]\.filename'/);
});

test("qc review lists a thousand changed files through the paginated API", async (t) => {
  const diff = Array.from({ length: 1000 }, (_, i) => `infra/${i}.tf`).join("\n");
  const f = await fixture(t, { diff });
  assert.equal(await f.run(), 0, f.err.join("\n"));
  assert.match(readFileSync(f.file, "utf8"), /1000 of 1000/);
  assert.deepEqual(f.calls[1], ["api", "--paginate", "repos/{owner}/{repo}/pulls/7/files", "--jq", ".[].filename"]);
});

test("qc review uses configured surfaces", async (t) => {
  const f = await fixture(t, { swarm: { dispatch: {}, review: { promotion: { ...PROMOTION, surfaces: ["src/**"] } } } });
  assert.equal(await f.run(), 0);
  const brief = readFileSync(f.file, "utf8");
  assert.match(brief, /1 of 3/);
  assert.match(brief, /src\/a\.ts/);
  assert.doesNotMatch(brief, /infra\/net\.tf|db\/migrations\/0042\.sql/);
});

test("a repeated promotion names the newest scoped branch verdict and briefs its increment", async (t) => {
  const reviewed = "b".repeat(40);
  const record = { type: "verdict", kind: "branch", branch: "dev", scope: "promotion", verdict: "APPROVED", sha: "c".repeat(40) };
  const f = await fixture(t, { records: [
    record,
    { ...record, sha: reviewed, verdict: "CHANGES_REQUIRED" },
    { ...record, branch: "other" },
    { ...record, kind: "task" },
    { ...record, scope: "security" },
    { ...record, type: "dispatch" },
  ] });
  assert.equal(await f.run(), 0, f.err.join("\n"));
  const brief = readFileSync(f.file, "utf8");
  assert.ok(brief.includes(`\nReviewed: ${reviewed}\n`));
  assert.ok(f.out[1].includes(`\nReviewed: ${reviewed}\n`));
  assert.match(brief, /1 of 2/);
  assert.match(brief, /infra\/increment\.tf/);
  assert.doesNotMatch(brief, /infra\/net\.tf|0042\.sql/);
  assert.deepEqual(f.gitCalls, [["diff", "--name-only", `${reviewed}..${HEAD}`, "--"]]);
});

test("a repeated promotion refuses an unreadable increment", async (t) => {
  const f = await fixture(t, { records: [{ type: "verdict", kind: "branch", branch: "dev", scope: "promotion", sha: "b".repeat(40) }], increment: null });
  assert.equal(await f.run(), 1);
  assert.match(f.err.join("\n"), /increment.*7/i);
});

test("a repeated promotion lists the full increment command after 200 paths", async () => {
  const { promotionBrief } = await import("./review-promotion.mjs");
  const reviewed = "b".repeat(40);
  const files = Array.from({ length: 201 }, (_, i) => `infra/${i}.tf`);
  const brief = promotionBrief({ pr: 7, head: HEAD, reviewed, ...PROMOTION, files, total: 201 });
  assert.ok(brief.includes(`git diff --name-only ${reviewed}..${HEAD} --`));
});

test("qc review normalizes configured origin branches and finds the previous promotion", async (t) => {
  const reviewed = "b".repeat(40);
  const f = await fixture(t, {
    swarm: { dispatch: {}, review: { promotion: { integration: "origin/dev", release: "origin/main" } } },
    records: [{ type: "verdict", kind: "branch", branch: "dev", scope: "promotion", sha: reviewed }],
  });
  assert.equal(await f.run(), 0, f.err.join("\n"));
  const brief = readFileSync(f.file, "utf8");
  assert.match(brief, /dev -> main/);
  assert.ok(brief.includes(`Reviewed: ${reviewed}`));
  assert.ok(f.out[1].includes(`dev at ${HEAD}`));
});

for (const isCrossRepository of [true, undefined, null]) {
  test(`qc review refuses a promotion without confirmed repository equality: ${isCrossRepository}`, async (t) => {
    const f = await fixture(t, { pr: { ...PR, isCrossRepository } });
    assert.equal(await f.run(), 1);
    assert.match(f.err.join("\n"), /same repository/i);
    assert.equal(f.calls.length, 1);
  });
}
