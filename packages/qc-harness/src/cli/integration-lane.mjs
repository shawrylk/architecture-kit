import { defaults, merge } from "../config.mjs";
import { globMatcher } from "../glob.mjs";
import { configAtBase, gitBy, gitFailed, LANE_BUDGET_MS } from "./direct-lane.mjs";
import { decidingVerdictFor, shaMatches } from "./ledger.mjs";

export const REGENERATE_SUBJECT = "chore: regenerate the generated files";

/** The integration review pipeline checks scoped verdicts and the commits their heads cover. */
export function integrationLane({ root, baseOid, headBranch, sha, records, kinds, budgetMs = LANE_BUDGET_MS }) {
  const git = gitBy(budgetMs);
  const policy = configAtBase(root, baseOid, git, "the PR base");
  if (policy.problem) return { applies: false };
  const settings = merge(defaults.integrate, policy.config?.integrate ?? {});
  if (settings.review !== true || !new RegExp(settings.branchPattern).test(headBranch)) return { applies: false };

  const failure = (what) => ({ applies: true, problem: gitFailed(git, what) });
  const historyText = git(root, "log", "--format=%H", sha, "--not", baseOid);
  if (historyText === null) return failure("git cannot read the integration history");
  const history = historyText.split("\n").filter(Boolean);
  const scopes = new Set(records.filter((record) => record.type === "dispatch" && record.branch === headBranch && typeof record.scope === "string").map((record) => record.scope));
  const newest = new Map();
  for (const record of records) {
    if (record.type === "verdict" && kinds.includes(record.kind) && history.some((commit) => shaMatches(record.sha, commit))) newest.set(record.scope ?? null, record);
  }
  for (const scope of scopes) {
    if (!newest.has(scope)) return { applies: true, problem: `scope ${JSON.stringify(scope)} holds no APPROVED review (no verdict)` };
  }
  for (const [scope, record] of newest) {
    if (record.verdict !== "APPROVED") return { applies: true, problem: `scope ${JSON.stringify(scope)} holds no APPROVED review (${record.verdict})` };
  }

  const heads = history.filter((commit) => decidingVerdictFor(records, commit, kinds)?.verdict === "APPROVED");
  if (heads.length === 0) return { applies: true, problem: "the integration history holds no APPROVED review" };
  const uncovered = git(root, "log", "--no-merges", "--format=%H%x09%s", sha, "--not", baseOid, ...heads);
  if (uncovered === null) return failure("git cannot read the commits after the integration reviews");
  const commits = uncovered.split("\n").filter(Boolean).map((line) => {
    const tab = line.indexOf("\t");
    return { sha: line.slice(0, tab), subject: line.slice(tab + 1) };
  });
  const generated = globMatcher(policy.config?.generated?.globs ?? defaults.generated.globs);
  const needsReview = [];
  for (const commit of commits) {
    if (commit.subject === REGENERATE_SUBJECT) {
      // Raw metadata protects path whitespace from the Git reader's trim; paths occupy odd fields.
      const files = git(root, "diff-tree", "--root", "-r", "--no-commit-id", "--raw", "-z", "--no-renames", commit.sha);
      if (files === null) return failure(`git cannot read regenerate commit ${commit.sha.slice(0, 7)}`);
      if (files.split("\0").filter((_, index) => index % 2 === 1).every(generated)) continue;
    }
    needsReview.push(commit);
  }
  if (needsReview.length > 0) {
    const first = needsReview[0];
    return { applies: true, problem: `${needsReview.length} commit(s) hold no APPROVED review, such as ${first.sha.slice(0, 7)} "${first.subject}"` };
  }

  const merges = git(root, "log", "--merges", "--format=%H", sha, "--not", baseOid, ...heads);
  if (merges === null) return failure("git cannot read the merges after the integration reviews");
  for (const commit of merges.split("\n").filter(Boolean)) {
    const resolved = git(root, "diff-tree", "--cc", "-r", "--no-commit-id", "--name-only", commit);
    if (resolved === null) return failure(`git cannot read merge ${commit.slice(0, 7)}`);
    if (resolved !== "") return { applies: true, problem: `merge ${commit.slice(0, 7)} was hand-resolved after the last review` };
  }
  return { applies: true, problem: null, heads: heads.length };
}
