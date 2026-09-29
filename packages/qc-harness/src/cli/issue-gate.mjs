#!/usr/bin/env node
// The Stop trigger that holds a merge to its issues. Each issue that a PR merged in this session names is
// closed, or has a comment after the merge, before the turn ends. It makes one gh call per unsettled issue.

import os from "node:os";
import { fileURLToPath } from "node:url";
import { runGh } from "./gh-run.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { workflowOf } from "./workflow-settings.mjs";

const pairOf = (prRepo, pr, repo, number) => `${prRepo}#${pr}>${repo}#${number}`;

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

/** The state and merge time of a pending merge's PR, or null when gh cannot read it. */
function prView(merge, gh, cwd) {
  const out = gh(["pr", "view", String(merge.pr), "-R", merge.repo, "--json", "state,mergedAt"], { cwd, env: merge.ghEnv ?? {} });
  try {
    return out === null ? null : JSON.parse(out);
  } catch {
    return null;
  }
}

/**
 * The merges of this session that count now: each merge record, and each pending one whose PR has since merged,
 * which gets its own merge record. A pending merge still open, or one gh cannot read, stays pending.
 * A pending merge whose PR closed unmerged gets one `closed` record, which counts as no merge and ends the reads.
 */
function mergesOf(records, session, workflow, gh, append) {
  const key = (record) => `${record.repo}#${record.pr}`;
  const done = new Set(records.filter((record) => record.type === "merge" && !record.pending && !record.closed).map(key));
  const closedAt = new Map();
  records.forEach((record, index) => record.type === "merge" && record.closed && closedAt.set(key(record), index));
  const write = (record) => {
    try {
      append(workflow.ledger, record);
    } catch {
      // The record only saves a later read; the next stop reads the PR again.
    }
  };
  const merges = [];
  records.forEach((record, index) => {
    if (record.type !== "merge" || record.session !== session || record.closed) return;
    if (!record.pending) {
      merges.push(record);
      return;
    }
    if (done.has(key(record)) || closedAt.get(key(record)) > index) return;
    const view = prView(record, gh, workflow.root);
    if (view?.state === "CLOSED") {
      closedAt.set(key(record), Infinity);
      write({ ...record, pending: undefined, closed: true, mergedAt: null });
    }
    if (view?.state !== "MERGED") return;
    done.add(key(record));
    const resolved = { ...record, mergedAt: view.mergedAt ?? record.mergedAt ?? null };
    delete resolved.pending;
    write(resolved);
    merges.push(resolved);
  });
  return merges;
}

const nameOf = ({ issue }) => `${issue.repo}#${issue.number}`;

/** The GH_* settings of a merge in words, so the sentence holds in Bash and in PowerShell alike. */
function settingsOf(env = {}) {
  const names = Object.entries(env);
  return names.length === 0 ? "" : ` Set ${names.map(([name, value]) => `${name} to \`${value}\``).join(" and ")} for these gh calls.`;
}

function refusalOf(open) {
  const lines = open.map(({ issue, merge }) => {
    return (
      `- ${issue.repo}#${issue.number}, named by ${merge.repo}#${merge.pr} (merged into ${merge.base ?? "its base"}). ` +
      `Close it: \`gh issue close ${issue.number} -R ${issue.repo} --comment "<what the merge finished>"\`. ` +
      `Or comment on what is left: \`gh issue comment ${issue.number} -R ${issue.repo} --body "<what is left>"\`.` +
      settingsOf(merge.ghEnv)
    );
  });
  return [
    "Issue check: a PR this session merged names an open issue with no comment since the merge. " +
      "A `Refs` issue stays open, and a merge into a branch other than the default closes none.",
    ...lines,
  ].join("\n");
}

/** The verdict on one Stop. @returns the hook output, or null to let the turn end with no message. */
export function decide(call, { gh = runGh, tmp = os.tmpdir(), append: appendTo = appendRecord } = {}) {
  if (call.hook_event_name !== "Stop") return null;
  // A stop this hook already blocked once records nothing new, so the ledger holds one state for the retry.
  const append = call.stop_hook_active ? () => {} : appendTo;
  let workflow;
  try {
    workflow = workflowOf(call, tmp);
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
  for (const merge of mergesOf(records, session, workflow, gh, append)) {
    for (const issue of merge.issues ?? []) {
      const pair = pairOf(merge.repo, merge.pr, issue.repo, issue.number);
      if (settled.has(pair)) continue;
      settled.add(pair);
      const status = statusOf(issue, merge, gh, workflow.root);
      if (status === null) unread.push(`${issue.repo}#${issue.number}`);
      else if (status === "open") open.push({ issue, merge });
      else {
        try {
          append(workflow.ledger, { type: "issue-update", session, pr: merge.pr, prRepo: merge.repo, repo: issue.repo, number: issue.number, how: status });
        } catch {
          // The issue is settled on GitHub; without the record the next stop reads it once more. The open list stays.
        }
      }
    }
  }
  if (open.length > 0) {
    // A stop the hook already blocked once must end, or a denied close or comment loops forever.
    if (call.stop_hook_active) return { systemMessage: `Issue check: ${open.map(nameOf).join(", ")} still open with no update since the merge. Update each by hand.` };
    return { decision: "block", reason: refusalOf(open) };
  }
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
