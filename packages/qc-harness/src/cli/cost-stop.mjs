#!/usr/bin/env node
// The SubagentStop trigger that adds one cost record to the ledger: the tokens and tool calls of the agent,
// by role. It reads the transcript and never blocks. `qc ledger --cost` totals the records.

import os from "node:os";
import { checkoutRootOf } from "./checkout-root.mjs";
import { pathKey } from "./git-read.mjs";
import { appendRecord, readLedger } from "./ledger.mjs";
import { roleOf } from "./report-stop.mjs";
import { agentTranscriptOf, agentTypeOf, readRequests, toolCallsIn } from "./transcript-usage.mjs";
import { firstUserText, resolveNamedWorktree, workflowOfRepo } from "./workflow-place.mjs";
import { workflowOf } from "./workflow-settings.mjs";
import { fileURLToPath } from "node:url";

const ROLES = { implementer: "implementer", task: "reviewer", branch: "branch-reviewer" };

/** The role a cost record names: the review roles of the workflow, the planner, or other. */
function costRole(agentType, review) {
  const role = roleOf(agentType, review);
  if (role) return ROLES[role];
  return review.plannerTypes.includes(agentType) ? "planner" : "other";
}

const sum = (requests, key) => requests.reduce((total, { usage }) => total + (usage?.[key] ?? 0), 0);

/** The newest dispatch of this session and type that named the worktree, or null. */
const dispatchOf = (records, session, agentType, worktree) =>
  worktree === null
    ? null
    : (records.findLast(
        (record) =>
          record.type === "dispatch" &&
          record.session === session &&
          record.agentType === agentType &&
          typeof record.worktree === "string" &&
          pathKey(record.worktree) === pathKey(worktree),
      ) ?? null);

/** Writes the cost record of one SubagentStop. @returns null always: a cost record never blocks an agent. */
export function decide(call, tmp = os.tmpdir()) {
  try {
    record(call, tmp);
  } catch {
    // A failed read or write records nothing, and the agent still stops.
  }
  return null;
}

function record(call, tmp) {
  const agentId = call.agent_id;
  if (call.hook_event_name !== "SubagentStop" || typeof agentId !== "string" || agentId === "") return;
  const transcript = agentTranscriptOf(call);
  if (transcript === null) return;
  const requests = readRequests(transcript);
  if (requests.length === 0) return;
  const own = workflowOf(call, tmp);
  if (!own) return;
  // The worktree the prompt names decides the repository, and so the ledger, as it does for the report stop.
  const text = firstUserText(transcript);
  const place = text === null ? null : resolveNamedWorktree(text, call.cwd ?? process.cwd());
  const root = place?.found ? checkoutRootOf(place.abs) : null;
  const workflow = root ? (workflowOfRepo(root, own) ?? own) : own;
  const session = call.session_id ?? "session";
  const agentType = call.agent_type ?? agentTypeOf(transcript) ?? "unknown";
  const dispatch = dispatchOf(readLedger(workflow.ledger), session, agentType, place?.found ? place.abs : null);
  appendRecord(workflow.ledger, {
    type: "cost",
    session,
    agentId,
    agentType,
    role: costRole(agentType, workflow.review),
    model: requests.findLast((request) => request.model)?.model ?? null,
    input: sum(requests, "input_tokens"),
    output: sum(requests, "output_tokens"),
    cacheRead: sum(requests, "cache_read_input_tokens"),
    cacheCreation: sum(requests, "cache_creation_input_tokens"),
    toolCalls: toolCallsIn(transcript),
    branch: dispatch?.branch ?? null,
    head: dispatch?.head ?? null,
  });
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
    // Not hook input, so there is no stop to record.
  }
  if (call) decide(call);
}
