import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { load } from "../config.mjs";

const HEAD = "a".repeat(40);
const QC = fileURLToPath(new URL("./qc.mjs", import.meta.url));
const PROMOTION = { integration: "dev", release: "main" };
const PR = { number: 7, headRefName: "dev", baseRefName: "main", headRefOid: HEAD, url: "https://github.com/example/repo/pull/7" };

async function fixture(t, { swarm = { dispatch: {}, review: { promotion: PROMOTION } }, pr = PR, diff = "infra/net.tf\ndb/migrations/0042.sql\nsrc/a.ts\n" } = {}) {
  const { runReview } = await import("./review-promotion.mjs");
  const root = realpathSync.native(mkdtempSync(path.join(os.tmpdir(), "qc-review-promotion-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const init = spawnSync("git", ["init", "--quiet"], { cwd: root, encoding: "utf8", windowsHide: true });
  assert.equal(init.status, 0, init.stderr);
  writeFileSync(path.join(root, "qc.config.json"), JSON.stringify({ swarm }));
  const out = [];
  const err = [];
  const calls = [];
  const gh = (args, options) => {
    assert.equal(options.cwd, root);
    calls.push(args);
    if (args.join(" ") === "pr view 7 --json number,headRefName,baseRefName,headRefOid,url") return pr === null ? null : JSON.stringify(pr);
    if (args.join(" ") === "pr diff 7 --name-only") return diff;
    assert.fail(`Unexpected gh call: ${args.join(" ")}`);
  };
  const run = (args = ["promotion", "7"]) => runReview(load(root), args, { gh, out: (line) => out.push(line), err: (line) => err.push(line) });
  return { root, out, err, calls, run, file: path.join(root, ".git", "qc", "promotion", "pr-7.md") };
}

test("qc review promotion 7 writes the brief of the files on the risk surfaces", async (t) => {
  const f = await fixture(t);
  assert.equal(await f.run(), 0, f.err.join("\n"));
  const brief = readFileSync(f.file, "utf8");
  for (const text of ["# Promotion review", "#7", "dev", "main", `Head: ${HEAD}`, "Scope: promotion", "2 of 3", "infra/net.tf", "db/migrations/0042.sql", "## Review these files", "## Checks"]) {
    assert.ok(brief.includes(text), text);
  }
  assert.doesNotMatch(brief, /src\/a\.ts/);
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
  assert.match(brief, /3 more.*gh pr diff 7 --name-only/);
});

test("qc review uses configured surfaces", async (t) => {
  const f = await fixture(t, { swarm: { dispatch: {}, review: { promotion: { ...PROMOTION, surfaces: ["src/**"] } } } });
  assert.equal(await f.run(), 0);
  const brief = readFileSync(f.file, "utf8");
  assert.match(brief, /1 of 3/);
  assert.match(brief, /src\/a\.ts/);
  assert.doesNotMatch(brief, /infra\/net\.tf|db\/migrations\/0042\.sql/);
});
