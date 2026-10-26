import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROMOTION_SCOPE } from "../config.mjs";
import { globMatcher } from "../glob.mjs";
import { runGh } from "./gh-run.mjs";
import { gitOut } from "./git-read.mjs";
import { ledgerFileOf, readLedger } from "./ledger.mjs";
import { promotionBranchName } from "./promotion-branch.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

const USAGE = "Usage: qc review promotion <pr>";
const MAX_PATHS = 200;
const FILES_TIMEOUT_MS = 120_000;
const API_FILE_LIMIT = 3000;

/** The fragment that formats the scope and checks for a promotion reviewer. */
export function promotionBrief({ pr, head, reviewed, previous, integration, release, files, total }) {
  const listCommand = reviewed
    ? `git diff --name-only ${reviewed}..${head} --`
    : `gh api --paginate repos/{owner}/{repo}/pulls/${pr}/files --jq '.[].filename'`;
  return [
    `# Promotion review #${pr}: ${integration} -> ${release}`,
    "",
    `Head: ${head}`,
    `Scope: ${PROMOTION_SCOPE}`,
    ...(reviewed ? [`Reviewed: ${reviewed}`] : []),
    ...(previous ? [`Previous verdict: ${previous.verdict ?? "unknown"}`, ...(previous.file ? [`Previous review: ${previous.file}`] : [])] : []),
    ...(previous?.verdict === "CHANGES_REQUIRED" ? ["Check each earlier finding and confirm its resolution, not only the increment."] : []),
    "",
    "## Review these files",
    "",
    `${files.length} of ${total} changed files match the promotion risk surfaces.`,
    "",
    ...files.slice(0, MAX_PATHS).map((file) => `- \`${file}\``),
    ...(files.length > MAX_PATHS ? ["", `${files.length - MAX_PATHS} more paths; read the full list with \`${listCommand}\`.`] : []),
    "",
    "## Checks",
    "",
    "- Infra: permissions, public exposure, and removed protections.",
    "- Migrations: order, destructive statements, and a rollback path.",
    "- Workflows: new triggers, secret use, and unpinned actions.",
    "- Secrets in logs: any log or error output that can hold a token, key, password, or personal data.",
    "",
    `Write the report's first line as \`VERDICT: APPROVED ${head}\` or \`VERDICT: CHANGES_REQUIRED ${head}\`.`,
    "",
  ].join("\n");
}

/** The pipeline that reads a promotion PR and writes its scoped reviewer brief. */
export function runReview(config, args, { gh = runGh, git = gitOut, out = console.log, err = console.error } = {}) {
  const [command, number] = args;
  if (command !== PROMOTION_SCOPE || args.length !== 2 || !/^[1-9]\d*$/.test(number ?? "")) {
    err(USAGE);
    return 2;
  }
  try {
    const promotion = reviewSettings(config.swarm)?.promotion;
    if (!promotion) throw new Error("Set swarm.review.promotion and enable swarm.dispatch in qc.config.json.");
    const root = config.root;
    const integration = promotionBranchName(promotion.integration);
    const release = promotionBranchName(promotion.release);
    const { surfaces } = promotion;
    const answer = gh(["pr", "view", number, "--json", "number,headRefName,baseRefName,headRefOid,url,isCrossRepository,changedFiles"], { cwd: root });
    if (answer === null) throw new Error(`gh could not read PR #${number}.`);
    let pr;
    try {
      pr = JSON.parse(answer);
    } catch {
      throw new Error(`gh returned an invalid PR #${number} answer.`);
    }
    if (!pr || String(pr.number) !== number || !/^[0-9a-f]{40}$/i.test(pr.headRefOid ?? "")) {
      throw new Error(`gh returned an invalid PR #${number} head.`);
    }
    if (pr.isCrossRepository !== false) throw new Error(`PR #${number} must have its head and base in the same repository.`);
    if (!Number.isSafeInteger(pr.changedFiles) || pr.changedFiles < 0) throw new Error(`PR #${number} has an invalid changedFiles count: ${JSON.stringify(pr.changedFiles)}.`);
    if (promotionBranchName(pr.headRefName) !== integration || promotionBranchName(pr.baseRefName) !== release) {
      throw new Error(`PR #${number} must promote ${integration} -> ${release}; got ${pr.headRefName} -> ${pr.baseRefName}.`);
    }
    const ledger = ledgerFileOf(root);
    if (!ledger) throw new Error("The checkout has no git common directory for the promotion brief.");
    const last = readLedger(ledger).findLast((record) =>
      record.type === "verdict" && record.kind === "branch" && record.branch === pr.headRefName && record.scope === PROMOTION_SCOPE);
    const reviewed = last?.sha;
    if (last && !/^[0-9a-f]{7,40}$/i.test(reviewed ?? "")) throw new Error(`The last promotion verdict for PR #${number} has an invalid reviewed head.`);
    const changed = reviewed
      ? git(root, "diff", "--name-only", `${reviewed}..${pr.headRefOid}`, "--")
      : gh(["api", "--paginate", `repos/{owner}/{repo}/pulls/${number}/files`, "--jq", ".[].filename"], { cwd: root, timeoutMs: FILES_TIMEOUT_MS });
    if (changed === null) throw new Error(reviewed
      ? `git could not read the increment for PR #${number}; fetch commits ${reviewed} and ${pr.headRefOid}.`
      : `gh could not read changed files for PR #${number}.`);
    const files = changed.split(/\r?\n/).filter(Boolean);
    if (!reviewed && (files.length !== pr.changedFiles || files.length >= API_FILE_LIMIT)) {
      throw new Error(`PR #${number}: read ${files.length} files; changedFiles ${pr.changedFiles}. ${files.length >= API_FILE_LIMIT ? "The GitHub API has a 3,000-file limit. " : ""}Refusing to brief a partial file list.`);
    }
    const brief = promotionBrief({ pr: pr.number, head: pr.headRefOid, reviewed, previous: last, integration, release, files: files.filter(globMatcher(surfaces)), total: files.length });
    const file = path.join(path.dirname(ledger), "promotion", `pr-${number}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, brief);
    out(`Wrote ${file}`);
    out(`Dispatch architecture:sdd-branch-reviewer with model opus:\nBrief: ${file}\nScope: ${PROMOTION_SCOPE}\n${reviewed ? `Reviewed: ${reviewed}\n` : ""}Worktree: <a worktree on ${integration} at ${pr.headRefOid}>`);
    out(`Merge with --match-head-commit ${pr.headRefOid} after the review approves.`);
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}
