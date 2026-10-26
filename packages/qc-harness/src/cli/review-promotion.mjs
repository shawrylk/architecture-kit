import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { PROMOTION_SCOPE } from "../config.mjs";
import { globMatcher } from "../glob.mjs";
import { runGh } from "./gh-run.mjs";
import { ledgerFileOf } from "./ledger.mjs";
import { reviewSettings } from "./workflow-settings.mjs";

const USAGE = "Usage: qc review promotion <pr>";
const MAX_PATHS = 200;

/** The fragment that formats the scope and checks for a promotion reviewer. */
export function promotionBrief({ pr, head, integration, release, files, total }) {
  return [
    `# Promotion review #${pr}: ${integration} -> ${release}`,
    "",
    `Head: ${head}`,
    `Scope: ${PROMOTION_SCOPE}`,
    "",
    "## Review these files",
    "",
    `${files.length} of ${total} changed files match the promotion risk surfaces.`,
    "",
    ...files.slice(0, MAX_PATHS).map((file) => `- \`${file}\``),
    ...(files.length > MAX_PATHS ? ["", `${files.length - MAX_PATHS} more paths; read the full list with \`gh pr diff ${pr} --name-only\`.`] : []),
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
export function runReview(config, args, { gh = runGh, out = console.log, err = console.error } = {}) {
  const [command, number] = args;
  if (command !== PROMOTION_SCOPE || args.length !== 2 || !/^[1-9]\d*$/.test(number ?? "")) {
    err(USAGE);
    return 2;
  }
  try {
    const promotion = reviewSettings(config.swarm)?.promotion;
    if (!promotion) throw new Error("Set swarm.review.promotion and enable swarm.dispatch in qc.config.json.");
    const root = config.root;
    const { integration, release, surfaces } = promotion;
    const answer = gh(["pr", "view", number, "--json", "number,headRefName,baseRefName,headRefOid,url"], { cwd: root });
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
    if (pr.headRefName !== integration || pr.baseRefName !== release) {
      throw new Error(`PR #${number} must promote ${integration} -> ${release}; got ${pr.headRefName} -> ${pr.baseRefName}.`);
    }
    const changed = gh(["pr", "diff", number, "--name-only"], { cwd: root });
    if (changed === null) throw new Error(`gh could not read changed files for PR #${number}.`);
    const files = changed.split(/\r?\n/).filter(Boolean);
    const brief = promotionBrief({ pr: pr.number, head: pr.headRefOid, integration, release, files: files.filter(globMatcher(surfaces)), total: files.length });
    const ledger = ledgerFileOf(root);
    if (!ledger) throw new Error("The checkout has no git common directory for the promotion brief.");
    const file = path.join(path.dirname(ledger), "promotion", `pr-${number}.md`);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, brief);
    out(`Wrote ${file}`);
    out(`Dispatch architecture:sdd-branch-reviewer with model opus:\nBrief: ${file}\nScope: ${PROMOTION_SCOPE}\nWorktree: <a worktree on ${integration} at ${pr.headRefOid}>`);
    out(`Merge with --match-head-commit ${pr.headRefOid} after the review approves.`);
    return 0;
  } catch (error) {
    err(error.message);
    return 1;
  }
}
