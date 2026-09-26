// A git hook cannot see a pull request's body, so this half of "register the work first" runs in CI:
// the body names an issue, the issue exists, and it was opened before the pull request.

import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";

const REFERENCE = /\b(?:fix(?:e[sd])?|close[sd]?|resolve[sd]?|refs?)\s*:?\s+(?:([\w.-]+\/[\w.-]+))?#(\d+)\b/gi;
const NO_ISSUE = /could not resolve to an? (issue|pull request)/i;
// The CI token sees only its own repository, so another repository reads as missing.
const NO_REPOSITORY = /could not resolve to a repository|HTTP 404/i;

/** @returns each issue a body names with a closing keyword or `Refs`, as `{repo, number}`. */
export function issueReferences(body, repo) {
  return [...(body ?? "").matchAll(REFERENCE)].map((match) => ({ repo: match[1] ?? repo, number: Number(match[2]) }));
}

/** Runs gh, and never throws: a missing binary is a failed call like any other. */
function runGh(args) {
  return new Promise((resolve) => {
    execFile("gh", args, { encoding: "utf8" }, (error, stdout, stderr) => {
      resolve(error ? { ok: false, stderr: `${stderr || error.message}` } : { ok: true, stdout });
    });
  });
}

/**
 * @param {object} event the GitHub event payload
 * @param {{gh?: (args: string[]) => Promise<{ok: boolean, stdout?: string, stderr?: string}>, hasToken: boolean}} options
 * @returns {Promise<{problems: string[], notes: string[]}>}
 */
export async function checkPullRequest(event, { gh = runGh, hasToken }) {
  const pr = event?.pull_request;
  if (!pr) return { problems: [], notes: ["the event is not a pull request, so there is no body to read"] };
  const references = issueReferences(pr.body, event.repository?.full_name);
  if (references.length === 0) {
    return {
      problems: [`pull request #${pr.number} names no issue. Add "Fixes #<n>" or "Refs #<n>" to its body, after you open the issue.`],
      notes: [],
    };
  }
  if (!hasToken) return { problems: [], notes: ["no GH_TOKEN, so the issues were not looked up"] };

  const problems = [];
  const notes = [];
  for (const { repo, number } of references) {
    const name = `${repo}#${number}`;
    const result = await gh(["issue", "view", String(number), "-R", repo, "--json", "createdAt"]);
    if (!result.ok) {
      const stderr = result.stderr ?? "";
      if (NO_ISSUE.test(stderr)) problems.push(`${name} does not exist. Open the issue, then reference it.`);
      else if (NO_REPOSITORY.test(stderr)) notes.push(`the token cannot see ${repo}, so ${name} was not looked up`);
      else notes.push(`could not reach GitHub for ${name}: ${(result.stderr ?? "").trim().split("\n")[0]}`);
      continue;
    }
    const created = JSON.parse(result.stdout).createdAt;
    if (Date.parse(created) > Date.parse(pr.created_at)) {
      problems.push(`${name} was opened after the pull request. Register the work before it starts.`);
    }
  }
  return { problems, notes };
}

export async function runPrCheck(env = process.env) {
  if (!env.GITHUB_EVENT_PATH) {
    console.log("SKIP  pr-check     no GITHUB_EVENT_PATH, so this is not a CI run");
    return 0;
  }
  const event = JSON.parse(readFileSync(env.GITHUB_EVENT_PATH, "utf8"));
  const { problems, notes } = await checkPullRequest(event, { hasToken: Boolean(env.GH_TOKEN || env.GITHUB_TOKEN) });
  for (const note of notes) console.log(`NOTE  pr-check     ${note}`);
  for (const problem of problems) console.error(`FAIL  pr-check     ${problem}`);
  if (problems.length === 0) console.log("OK  pr-check     the pull request names an issue opened before it");
  return problems.length > 0 ? 1 : 0;
}
