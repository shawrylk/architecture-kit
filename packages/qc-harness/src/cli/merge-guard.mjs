#!/usr/bin/env node
// The trigger that holds `gh pr merge` to its review. Before the call it needs `--match-head-commit` and an
// APPROVED review of `swarm.review.merge` for that sha, or a head inside the direct lane of `swarm.direct`.
// After the call it records the merge and its issues.
// A `gh pr merge` that names another repository than the checkout's `origin` is that repository's own, so it passes.
// A raw API merge, REST or GraphQL, reads the base policy of its PR. It passes with `swarm.dispatch` off.
// It denies with dispatch on, or when the guard cannot read the PR or its base.
// Any `gh api graphql` call that mixes `--input` with a field denies, whether it reads or writes.
// This applies in every checkout, with `swarm.dispatch` on or off.

import { fileURLToPath } from "node:url";
import { PARSERS } from "./bash-command-guard.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { LANE_BUDGET_MS, mergeLane, sizeLine } from "./direct-lane.mjs";
import { ghApiMerges, ghMerges } from "./gh-merge-command.mjs";
import { runGh } from "./gh-run.mjs";
import { gitOutWithin, originOf, repoOfSpelling } from "./git-read.mjs";
import { appendRecord, decidingVerdictFor, dispatchedScopesFor, latestVerdictFor, readLedger } from "./ledger.mjs";
import { workflowAt } from "./workflow-settings.mjs";
import { worktreeRuleAt } from "./worktree-settings.mjs";

const VIEW_FIELDS = "number,url,state,mergedAt,baseRefName,headRefName,body,closingIssuesReferences";
const MAYBE_GH = /\bgh(?:\.exe)?\b/i;
const BODY_REF = /(?<![\w/#])#(\d+)\b/g;
const REF_LINE = /^\s*(?:[-*]\s+)?(?:refs|closes|fixes|resolves)\b/i;
const PR_URL = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/;
const POST_EVENTS = new Set(["PostToolUse", "PostToolUseFailure"]);
const REVIEWER = { branch: "the branch reviewer (sdd-branch-reviewer)", task: "the task reviewer (sdd-reviewer)" };

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const context = (text) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", additionalContext: text } });

/**
 * Judges each merge: an APPROVED review of `kind` on its head, or else the direct lane that `lane(merge)` decides.
 * @returns `{ refusal }` for the first merge that may not run, or `{ refusal: null, direct }` with the lane notes.
 */
export function mergeVerdict(merges, records, kind, lane = null) {
  const direct = [];
  for (const merge of merges) {
    if (!merge.sha) {
      return { refusal: `Merge guard: \`gh pr merge\` must pass \`--match-head-commit <sha>\` with the head the ${kind} review approved, so a push after the review cannot merge unreviewed. Add it.` };
    }
    const verdict = decidingVerdictFor(records, merge.sha, [kind]);
    const missing = dispatchedScopesFor(records, merge.sha).find(
      (scope) => latestVerdictFor(records, merge.sha, [kind], scope)?.verdict !== "APPROVED",
    );
    if (verdict?.verdict === "APPROVED" && missing === undefined) continue;
    if (missing !== undefined) {
      return {
        refusal:
          `Merge guard: the ledger holds no APPROVED ${kind} review of scope "${missing}" on ${merge.sha}, and a review of that scope was dispatched. ` +
          `Dispatch ${REVIEWER[kind]} with \`Scope: ${missing}\` on that head, and merge after every scope approves.`,
      };
    }
    const fit = lane ? lane(merge) : null;
    if (fit && fit.problem === null) {
      direct.push(fit.note);
      continue;
    }
    const latest = verdict ? ` (the latest is ${verdict.verdict})` : "";
    const laneNote = fit ? ` The direct lane of swarm.direct does not apply: ${fit.problem}.` : "";
    return {
      refusal:
        `Merge guard: the ledger holds no APPROVED ${kind} review of ${merge.sha}${latest}. ` +
        `Dispatch ${REVIEWER[kind]} on that head, and merge after it approves. ` +
        "`qc ledger` lists the verdicts, and swarm.review.merge names the kind that counts." +
        laneNote,
    };
  }
  return { refusal: null, direct };
}

/** @returns the reason the first of `merges` may not run, or null when each pins an approved head. */
export const mergeRefusal = (merges, records, kind, lane = null) => mergeVerdict(merges, records, kind, lane).refusal;

/** The base the PR of `merge` merges into, as gh reads it before the merge: `{ name, oid }`, or null. `oid` is null when gh names none. */
function prBaseOf(merge, cwd, gh, timeoutMs) {
  const args = merge.nodeId
    ? ["api", "graphql", "-f", "query=query($id: ID!) { node(id:$id){... on PullRequest{number baseRefName baseRefOid repository{nameWithOwner}}}}", "-f", `id=${merge.nodeId}`]
    : ["pr", "view", ...(merge.selector ? [merge.selector] : []), ...(merge.repo ? ["-R", merge.repo] : []), "--json", "baseRefName,baseRefOid"];
  try {
    const answer = JSON.parse(gh(args, { cwd, env: merge.env, timeoutMs }) ?? "null");
    const pr = merge.nodeId ? answer?.data?.node : answer;
    if (merge.nodeId && (answer?.errors?.length || !Number.isInteger(pr?.number) || pr.number <= 0 ||
      typeof pr?.baseRefOid !== "string" || !pr.baseRefOid || typeof pr?.repository?.nameWithOwner !== "string" || !pr.repository.nameWithOwner)) return null;
    return typeof pr?.baseRefName === "string" ? { name: pr.baseRefName, oid: pr.baseRefOid ?? null } : null;
  } catch {
    return null;
  }
}

/** The fragment that reads one merge's PR base and workflow within the shared deadline. */
function policyOf(merge, root, cwd, gh, deadline) {
  const left = deadline - Date.now();
  const pr = left > 0 ? prBaseOf(merge, cwd, gh, left) : null;
  if (!pr) throw new Error("gh cannot read the base branch of the PR within the time budget of the lane");
  const git = (dir, ...args) => {
    const remaining = deadline - Date.now();
    return remaining > 0 ? gitOutWithin(remaining, dir, ...args) : null;
  };
  git.late = () => Date.now() >= deadline;
  return { pr, workflow: workflowAt(root, { baseOid: pr.oid, git }) };
}

/** The fragment that names a REST or GraphQL merge's PR; null when the call cannot name one. */
function apiPrOf({ endpoint, env, nodeId }) {
  const { GH_REPO, ...settings } = env;
  const host = /^https?:\/\/([^/]+)\//.exec(endpoint)?.[1];
  if (host) settings.GH_HOST = host === "api.github.com" ? "github.com" : host;
  if (nodeId !== undefined) return nodeId ? { nodeId, env: settings } : null;
  const match = /^(?:https?:\/\/([^/]+)\/(?:api\/v3\/)?)?\/?(?:repos\/([^/]+\/[^/]+)\/)?pulls\/(\d+)\/merge\/?(?:\?.*)?$/.exec(endpoint);
  if (!match || /[{}]/.test(endpoint.replace("repos/{owner}/{repo}/", "repos/owner/repo/"))) return null;
  const repo = match[2] === "{owner}/{repo}" ? GH_REPO ?? null : match[2] ?? GH_REPO ?? null;
  return { selector: match[3], repo, env: settings };
}

/**
 * The direct lane of one workflow, as `mergeVerdict` asks it. Either config can close it with `swarm.direct: false`; a wrong
 * value names itself. The lane judges against the base commit that gh names for the PR, so no local ref decides.
 * A PR into a branch other than `worktree.base` stays out of it. The merges of one call share one time budget.
 */
function laneOf(workflow, records, pr, deadline) {
  const { direct, directProblem, base } = workflow;
  if (!direct) return directProblem ? () => ({ problem: directProblem }) : null;
  return (merge) => {
    if (pr === null) return { problem: "gh cannot read the base branch of the PR within the time budget of the lane" };
    if (pr.name !== base && `origin/${pr.name}` !== base) return { problem: `the PR merges into ${pr.name}, and the lane measures against ${base}` };
    const fit = mergeLane({ root: workflow.root, baseOid: pr.oid, protectedBranches: workflow.protectedBranches, sha: merge.sha, records, budgetMs: deadline - Date.now() });
    if (fit.problem !== null) return fit;
    const reviewed = fit.review ? `the APPROVED ${fit.review.kind} review of ${fit.review.sha}` : "no review";
    return { problem: null, note: `Merge guard: ${merge.sha} merges through the direct lane, with ${sizeLine(fit.size, fit.direct)} and ${reviewed}.` };
  };
}

/**
 * The issues a PR names: its closing references, then each `#n` on a body line that starts with `Refs`, `Closes`,
 * `Fixes`, or `Resolves`, less its own number and each repeat. A number elsewhere in the body is context.
 */
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
  for (const line of String(pr.body ?? "").split(/\r?\n/)) {
    if (REF_LINE.test(line)) for (const match of line.matchAll(BODY_REF)) add(repo, Number(match[1]));
  }
  return [...found.values()];
}

/** Splits the merges into those of this checkout's repository and those that name another repository. */
function partition(merges, root, deadline) {
  const left = deadline - Date.now();
  const origin = left > 0 && merges.some((merge) => merge.repo) ? originOf(root, Math.min(5_000, left)) : null;
  const foreign = (merge) => origin !== null && merge.repo && repoOfSpelling(merge.repo) !== origin;
  return { origin, own: merges.filter((merge) => !foreign(merge)), other: merges.filter(foreign) };
}

function recordMerge(merge, call, workflow, gh, deadline) {
  const args = ["pr", "view", ...(merge.selector ? [merge.selector] : []), ...(merge.repo ? ["-R", merge.repo] : []), "--json", VIEW_FIELDS];
  const left = deadline - Date.now();
  const out = left > 0 ? gh(args, { cwd: call.cwd ?? process.cwd(), env: merge.env, timeoutMs: left }) : null;
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
  const merged = pr.state === "MERGED";
  // An `--auto` merge on an open PR is pending: the issue gate reads the PR at Stop to see whether it merged.
  // A failed call is no proof of a queued merge: `gh pr merge --auto` may have been refused on the open PR.
  const pending = call.hook_event_name === "PostToolUse" && !merged && merge.auto && pr.state === "OPEN";
  if ((!merged && !pending) || !repo) return null;
  const ofPr = (record) => record.type === "merge" && record.repo === repo && record.pr === pr.number;
  try {
    // A closed record ends what came before it: a PR reopened after it gets its own record.
    const records = readLedger(workflow.ledger);
    const closedAt = records.findLastIndex((record) => ofPr(record) && record.closed);
    if (records.slice(closedAt + 1).some((record) => ofPr(record) && (pending || !record.pending))) return null;
    appendRecord(workflow.ledger, {
      type: "merge",
      ...(pending ? { pending: true } : {}),
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
    return `Merge guard: the ledger failed (${error.message}), so this merge is not recorded.`;
  }
  return null;
}

/** The verdict on one Bash or PowerShell event. @returns the hook output, or null to let it pass with no message. */
export function decide(call, { gh = runGh } = {}) {
  const deadline = Date.now() + LANE_BUDGET_MS;
  const event = call.hook_event_name;
  if (event !== "PreToolUse" && !POST_EVENTS.has(event)) return null;
  const parse = PARSERS[call.tool_name];
  const command = call.tool_input?.command;
  if (!parse || typeof command !== "string" || !MAYBE_GH.test(command)) return null;
  const cwd = call.cwd ?? process.cwd();
  const root = checkoutRootOf(cwd);
  if (!root) return null;
  let workflow;
  if (event !== "PreToolUse") {
    try {
      workflow = workflowAt(cwd);
    } catch {
      return null;
    }
    if (!workflow) workflow = worktreeRuleAt(cwd);
    if (!workflow) return null;
  }
  if (event === "PreToolUse") {
    for (const found of ghApiMerges(command, parse, { cwd })) {
      const use = "Run `gh pr merge <n> --match-head-commit <sha>` with the head an APPROVED review named.";
      if (found.inputField !== undefined) {
        return deny(`Merge guard: \`gh api ${found.endpoint}\` mixes \`--input\` with \`${found.inputField}\`. Fields enter the URL query string, so the guard cannot pin the body to one PR. ${use}`);
      }
      const merge = apiPrOf(found);
      if (merge) {
        try {
          if (!policyOf(merge, root, cwd, gh, deadline).workflow) continue;
        } catch (error) {
          return deny(`Merge guard: the base policy cannot be read (${error.message}). ${use}`);
        }
      }
      return deny(
        found.unreadable === undefined
          ? `Merge guard: \`gh api ${found.endpoint}\` merges with no review check and no head pin. ${use}`
          : `Merge guard: \`gh api ${found.endpoint}\` reads \`${found.unreadable}\`, which the guard cannot read, so it may merge with no review check and no head pin. ${use}`,
      );
    }
  }
  const merges = ghMerges(command, parse);
  if (merges.length === 0) return null;
  const { origin, own, other } = partition(merges, root, deadline);
  if (event === "PreToolUse") {
    const notes = [];
    for (const merge of own) {
      try {
        const policy = policyOf(merge, root, cwd, gh, deadline);
        const { pr } = policy;
        workflow = policy.workflow;
        if (!workflow) continue;
        const records = readLedger(workflow.ledger);
        const result = mergeVerdict([merge], records, workflow.review.merge, laneOf(workflow, records, pr, deadline));
        if (result.refusal) return deny(result.refusal);
        notes.push(...result.direct);
      } catch (error) {
        return deny(`Merge guard: the base policy or ledger cannot be read (${error.message}), so no review can be checked.`);
      }
    }
    if (other.length > 0) {
      notes.push(
        `Merge guard passes ${[...new Set(other.map((merge) => merge.repo))].join(", ")}: it is not this checkout's repository (${origin}), ` +
          "so its reviews are not in this ledger. The guard records nothing for it.",
      );
    }
    return notes.length > 0 ? context(notes.join(" ")) : null;
  }
  const notes = own.map((merge) => recordMerge(merge, call, workflow, gh, deadline)).filter(Boolean);
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
