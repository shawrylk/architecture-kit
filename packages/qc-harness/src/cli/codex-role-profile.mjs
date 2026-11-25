// Parent-private mappings, never authority from a hook payload. Scout/tests keep
// their lifecycles with canonical reviewer/implementer runtime and budget policy.
const profiles = Object.freeze(Object.fromEntries(Object.entries({
  leader: ["leader", "leader"], implementer: ["implementer", "implementer"],
  reviewer: ["reviewer", "reviewer"], "branch-reviewer": ["reviewer", "branch-reviewer"],
  planner: ["reviewer", "planner"], scout: ["reviewer", "planner"],
  tests: ["implementer", "implementer"],
}).map(([role, [runtime, route]]) => [role, Object.freeze({ runtime, route })])));
export function codexRoleProfile(role) {
  if (typeof role !== "string" || !Object.hasOwn(profiles, role)) throw Error("Codex role profile unavailable");
  return profiles[role];
}

export function scoutReportProblem(text) {
  for (const label of ["Gap", "Plan", "Check", "Risks", "Questions"]) {
    if (!new RegExp(`^${label}:[ \\t]*(?:\\S|\\r?\\n(?:[ \\t]*\\r?\\n)*[ \\t]*(?:[-*]|\\d+[.)]))`, "m").test(text)) return `scout report requires ${label}:`;
  }
  return /^Breaking:[ \t]*(yes|no)[ \t]*\r?$/m.test(text) ? null : "scout report requires Breaking: yes|no";
}
