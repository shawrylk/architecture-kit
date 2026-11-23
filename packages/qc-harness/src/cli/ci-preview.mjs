// A pipeline reserves platform previews, dispatches CI, and records passing legs.
import { execFileSync } from "node:child_process";
import { closeSync, mkdirSync, openSync, unlinkSync } from "node:fs";
import path from "node:path";
import { appendLeg, gitText, legRecords } from "./legs.mjs";
import { ledgerFileOf } from "./ledger.mjs";

const ghCommand = (root, args) => execFileSync("gh", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 16 * 1024 * 1024 });
const platforms = (value) => value === "both" ? ["linux", "windows"] : [value];
const jobOS = (name) => /windows/i.test(name) ? "windows" : /linux|ubuntu/i.test(name) ? "linux" : null;

export async function runCiPreview(root, args = [], options = {}) {
  const write = options.write ?? console.error;
  const os = args.length === 0 ? "both" : args.length === 2 && args[0] === "--os" ? args[1] : null;
  if (!["linux", "windows", "both"].includes(os)) { write("ci-preview: use --os linux, windows, or both"); return 1; }
  const git = options.git ?? ((...words) => gitText(root, ...words));
  const gh = options.gh ?? ((words) => ghCommand(root, words));
  const records = options.records ?? (() => legRecords(root));
  const record = options.record ?? appendLeg;
  const sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  let lock;
  let fd;
  try {
    const head = git("rev-parse", "HEAD");
    const branch = git("branch", "--show-current");
    if (!branch) throw new Error("a preview needs a branch");
    const file = ledgerFileOf(root);
    if (!file) throw new Error("a preview needs a git worktree");
    mkdirSync(path.dirname(file), { recursive: true });
    lock = `${file}.preview-lock`;
    fd = openSync(lock, "wx");
    const wanted = platforms(os);
    const previous = records();
    if (wanted.some((leg) => previous.some((r) => r.head === head && r.os === leg && r.source === "preview"))) throw new Error("a preview already exists for this head and platform");
    const listArgs = ["run", "list", "--workflow", "ci.yml", "--event", "workflow_dispatch", "--branch", branch, "--commit", head, "--limit", "100", "--json", "databaseId,headSha"];
    const before = new Set(JSON.parse(gh(listArgs)).map((run) => run.databaseId));
    for (const leg of wanted) record(root, { type: "leg-preview", os: leg, head, source: "preview" });
    gh(["workflow", "run", "ci.yml", "--ref", branch, "-f", `os=${os}`]);
    let run;
    for (let attempt = 0; attempt < (options.attempts ?? 30); attempt += 1) {
      const candidates = JSON.parse(gh(listArgs)).filter((r) => r.headSha === head && !before.has(r.databaseId));
      if (candidates.length > 1) throw new Error("multiple new preview runs match this head");
      if (candidates.length === 1) { run = candidates[0]; break; }
      await sleep(2000);
    }
    if (!run) throw new Error("the dispatched preview run did not appear");
    gh(["run", "watch", String(run.databaseId)]);
    const result = JSON.parse(gh(["run", "view", String(run.databaseId), "--json", "headSha,jobs"]));
    if (result.headSha !== head) throw new Error("preview run head differs from the requested head");
    let passed = 0;
    for (const leg of wanted) {
      const jobs = result.jobs.filter((job) => jobOS(job.name) === leg);
      if (jobs.length > 0 && jobs.every((job) => job.conclusion === "success")) {
        record(root, { type: "leg", os: leg, head, source: "preview" });
        passed += 1;
      }
    }
    if (passed !== wanted.length) { write("ci-preview: one or more requested platform legs failed or are missing"); return 1; }
    return 0;
  } catch (error) { write(`ci-preview: ${error.message.split("\n")[0]}`); return 1; }
  finally { if (fd !== undefined) { closeSync(fd); unlinkSync(lock); } }
}
