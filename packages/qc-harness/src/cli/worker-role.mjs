// Who a hook call comes from. A Claude subagent carries an `agent_id`; a Codex implementer carries no `agent_id`,
// so the orchestrator that launches it sets `QC_ROLE=implementer` in its environment instead.

/** True when the call comes from a worker (a subagent or a Codex implementer), not the main session. */
export const isWorker = (call, env = process.env) =>
  (typeof call.agent_id === "string" && call.agent_id !== "") || env.QC_ROLE === "implementer";
