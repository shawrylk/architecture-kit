#!/usr/bin/env node
// The trigger that holds `gh pr merge` to its review. Before the call it needs `--match-head-commit` and an
// APPROVED review of `swarm.review.merge` for that sha. After the call it records the merge and its issues.

import { fileURLToPath } from "node:url";
import { PARSERS } from "./bash-command-guard.mjs";
import { ghApiMerges, ghMerges } from "./gh-merge-command.mjs";
import { runGh } from "./gh-run.mjs";
import { appendRecord, latestVerdictFor, readLedger } from "./ledger.mjs";
import { workflowAt } from "./workflow-settings.mjs";

const VIEW_FIELDS = "number,url,state,mergedAt,baseRefName,headRefName,body,closingIssuesReferences";
const MAYBE_GH = /\bgh(?:\.exe)?\b/i;
const BODY_REF = /(?<![\w/#])#(\d+)\b/g;
const PR_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/;
const POST_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const REVIEWER = { branch: "the branch reviewer (sdd-branch-reviewer)", task: "the task reviewer (sdd-reviewer)" };

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const context = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

/** @returns the reason the first of `merges` may not run, or null when each pins an approved head. */
export function mergeRefusal(merges, records, kind) {
  for (const merge of merges) {
    if (!merge.sha) {
      return `Merge guard: \`gh pr merge\` must pass \`--match-head-commit <sha>\` with the head the ${kind} review approved, so a push after the review cannot merge unreviewed. Add it.`;
    }
    const verdict = latestVerdictFor(records, merge.sha, [kind]);
    if (verdict?.verdict !== "APPROVED") {
      const latest = verdict ? ` (the latest is ${verdict.verdict})` : "";
      return (
        `Merge guard: the ledger holds no APPROVED ${kind} review of ${merge.sha}${latest}. ` +
        `Dispatch ${REVIEWER[kind]} on that head, and merge after it approves. ` +
        "`qc ledger` lists the verdicts, and swarm.review.merge names the kind that counts."
      );
    }
  }
  return null;
}

/** The issues a PR names: its closing references, then each `#n` in its body, less its own number and each repeat. */
export function namedIssues(pr, repo) {
  const found = new Map();
  const add = (issueRepo, number) => {
    if (Number.isInteger(number) && !(issueRepo === repo && number === pr.number)) found.set(`${issueRepo}#${number}`, { repo: issueRepo, number });
  };
  for (const ref of pr.closingIssuesReferences ?? []) {
    const owner = ref.repository?.owner?.login;
    const name = ref.repository?.name;
    add(owner && name ? `${owner}/${name}` : repo, ref.number);
  }
  for (const match of String(pr.body ?? "").matchAll(BODY_REF)) add(repo, Number(match[1]));
  return [...found.values()];
}

function recordMerge(merge, call, workflow, gh) {
  const args = ["pr", "view", ...(merge.selector ? [merge.selector] : []), ...(merge.repo ? ["-R", merge.repo] : []), "--json", VIEW_FIELDS];
  const out = gh(args, { cwd: call.cwd ?? process.cwd(), env: merge.env });
  let pr = null;
  try {
    pr = out === null ? null : JSON.parse(out);
  } catch {
    pr = null;
  }
  if (!pr) {
    // After a failed call there may be no merge to read, so only a successful one reports this.
    return call.hook_event_name === "PostToolUse" ? "Merge guard: gh pr view could not read the merge, so the ledger does not record it." : null;
  }
  const repo = PR_URL.exec(pr.url ?? "")?.[1] ?? null;
  if (pr.state !== "MERGED" || !repo) return null;
  if (readLedger(workflow.ledger).some((record) => record.type === "merge" && record.repo === repo && record.pr === pr.number)) return null;
  try {
    appendRecord(workflow.ledger, {
      type: "merge",
      session: call.session_id ?? "session",
      pr: pr.number,
      repo,
      sha: merge.sha,
      branch: pr.headRefName ?? null,
      base: pr.baseRefName ?? null,
      mergedAt: pr.mergedAt ?? null,
      issues: namedIssues(pr, repo),
      ghEnv: merge.env,
    });
  } catch (error) {
    return `Merge guard: the ledger write failed (${error.message}), so this merge is not recorded.`;
  }
  return null;
}

/** The verdict on one Bash or PowerShell event. @returns the hook output, or null to let it pass with no message. */
export function decide(call, { gh = runGh } = {}) {
  const event = call.hook_event_name;
  if (event !== "PreToolUse" && !POST_EVENTS.has(event)) return null;
  const parse = PARSERS[call.tool_name];
  const command = call.tool_input?.command;
  if (!parse || typeof command !== "string" || !MAYBE_GH.test(command)) return null;
  let workflow;
  try {
    workflow = workflowAt(call.cwd ?? process.cwd());
  } catch (error) {
    return event === "PreToolUse" ? context(`Merge guard is off: ${error.message}`) : null;
  }
  if (!workflow) return null;
  if (event === "PreToolUse") {
    const [endpoint] = ghApiMerges(command, parse);
    if (endpoint) {
      return deny(
        `Merge guard: \`gh api ${endpoint}\` merges with no review check and no head pin. ` +
          "Run `gh pr merge <n> --match-head-commit <sha>` with the head an APPROVED review named.",
      );
    }
  }
  const merges = ghMerges(command, parse);
  if (merges.length === 0) return null;
  if (event === "PreToolUse") {
    const refusal = mergeRefusal(merges, readLedger(workflow.ledger), workflow.review.merge);
    return refusal ? deny(refusal) : null;
  }
  const notes = merges.map((merge) => recordMerge(merge, call, workflow, gh)).filter(Boolean);
  return notes.length > 0 ? { systemMessage: notes.join(" ") } : null;
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
    // Not hook input, so there is no command to judge.
  }
  const output = call ? decide(call) : null;
  if (output) process.stdout.write(JSON.stringify(output));
}
