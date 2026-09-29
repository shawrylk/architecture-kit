#!/usr/bin/env node
// The Stop trigger that holds a merge to its issues. Each issue that a PR merged in this session names is
// closed, or has a comment after the merge, before the turn ends. It makes one gh call per unsettled issue.

import { fileURLToPath } from "node:url";
import { runGh } from "./gh-run.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { workflowAt } from "./workflow-settings.mjs";

const pairOf = (prRepo, pr, repo, number) => `${prRepo}#${pr}>${repo}#${number}`;
const prefixOf = (env = {}) => Object.entries(env).map(([name, value]) => `${name}=${value} `).join("");

/** @returns "closed", "commented" after `mergedAt`, "open", or null when the view says neither. */
export function issueStatus(view, mergedAt) {
  if (view?.state === "CLOSED") return "closed";
  if (view?.state !== "OPEN") return null;
  const since = Date.parse(mergedAt);
  return (view.comments ?? []).some((comment) => Date.parse(comment.createdAt) >= since) ? "commented" : "open";
}

function statusOf(issue, merge, gh, cwd) {
  const out = gh(["issue", "view", String(issue.number), "-R", issue.repo, "--json", "state,comments"], { cwd, env: merge.ghEnv ?? {} });
  if (out === null) return null;
  try {
    return issueStatus(JSON.parse(out), merge.mergedAt ?? merge.at);
  } catch {
    return null;
  }
}

function refusalOf(open) {
  const lines = open.map(({ issue, merge }) => {
    const gh = `${prefixOf(merge.ghEnv)}gh`;
    return (
      `- ${issue.repo}#${issue.number}, named by ${merge.repo}#${merge.pr} (merged into ${merge.base ?? "its base"}). ` +
      `Close it: \`${gh} issue close ${issue.number} -R ${issue.repo} --comment "<what the merge finished>"\`. ` +
      `Or comment on what is left: \`${gh} issue comment ${issue.number} -R ${issue.repo} --body "<what is left>"\`.`
    );
  });
  return [
    "Issue check: a PR this session merged names an open issue with no comment since the merge. " +
      "A `Refs` issue stays open, and a merge into a branch other than the default closes none.",
    ...lines,
  ].join("\n");
}

/** The verdict on one Stop. @returns the hook output, or null to let the turn end with no message. */
export function decide(call, { gh = runGh } = {}) {
  if (call.hook_event_name !== "Stop") return null;
  let workflow;
  try {
    workflow = workflowAt(call.cwd ?? process.cwd());
  } catch {
    // The pre-call hooks report a config error; a stop that cannot read the config lets the turn end.
    return null;
  }
  if (!workflow) return null;
  const session = call.session_id ?? "session";
  let records;
  try {
    records = readLedger(workflow.ledger);
  } catch {
    return null;
  }
  const settled = new Set(records.filter((r) => r.type === "issue-update").map((r) => pairOf(r.prRepo, r.pr, r.repo, r.number)));
  const open = [];
  const unread = [];
  for (const merge of records.filter((record) => record.type === "merge" && record.session === session)) {
    for (const issue of merge.issues ?? []) {
      const pair = pairOf(merge.repo, merge.pr, issue.repo, issue.number);
      if (settled.has(pair)) continue;
      settled.add(pair);
      const status = statusOf(issue, merge, gh, workflow.root);
      if (status === null) unread.push(`${issue.repo}#${issue.number}`);
      else if (status === "open") open.push({ issue, merge });
      else appendRecord(workflow.ledger, { type: "issue-update", session, pr: merge.pr, prRepo: merge.repo, repo: issue.repo, number: issue.number, how: status });
    }
  }
  if (open.length > 0) return { decision: "block", reason: refusalOf(open) };
  return unread.length > 0 ? { systemMessage: `Issue check: gh could not read ${unread.join(", ")}. Check each by hand.` } : null;
}

async function readStdin() {
  let data = "";
  for await (const chunk of process.stdin) data += chunk;
  return data;
}

const isEntryPoint = process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1];
if (isEntryPoint) {
  let call = null;
  try {
    call = JSON.parse(await readStdin());
  } catch {
    // Not hook input, so there is no merge to follow up.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
