// The branch that turns an agent's context size into a note: nothing, keep new output small, or hand off.
// It reads no file and never refuses a call; the budget guard gives it the numbers and prints the note.

import { contextDefaults, merge } from "../config.mjs";

const KEY = "swarm.context";
export const LEVELS = ["none", "summarize", "handoff"];
const ESTIMATE_LINE = /^[ \t]*(?:\*\*)?Estimate:(?:\*\*)?[ \t]*(\d+)/im;

const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const wrong = (key, value, want) => new Error(`${KEY}.${key} in qc.config.json must be ${want}, got ${JSON.stringify(value)}`);

/** @returns the signal settings, or null when the repository turns it off; throws naming the key it got wrong. */
export function contextSettings(swarm = {}) {
  const raw = swarm.context;
  if (raw === false || raw === null) return null;
  if (raw !== undefined && !isPlainObject(raw)) {
    throw new Error(`${KEY} in qc.config.json must be an object or false, got ${JSON.stringify(raw)}`);
  }
  const settings = merge(contextDefaults, raw ?? {});
  for (const key of ["every", "minCallsLeft", "repeatEvery"]) {
    if (!Number.isInteger(settings[key]) || settings[key] < 1) throw wrong(key, settings[key], "a positive whole number");
  }
  if (typeof settings.summarizeRatio !== "number" || !(settings.summarizeRatio > 1)) {
    throw wrong("summarizeRatio", settings.summarizeRatio, "a number above 1");
  }
  if (typeof settings.handoffRatio !== "number" || !(settings.handoffRatio > settings.summarizeRatio)) {
    throw wrong("handoffRatio", settings.handoffRatio, "a number above summarizeRatio");
  }
  if (!Array.isArray(settings.handoffTypes) || !settings.handoffTypes.every((type) => typeof type === "string" && type !== "")) {
    throw wrong("handoffTypes", settings.handoffTypes, "a list of agent types");
  }
  return settings;
}

/** The number on a prompt's `Estimate:` line, or null. */
export function estimateOf(prompt) {
  const match = ESTIMATE_LINE.exec(String(prompt ?? ""));
  return match ? Number(match[1]) : null;
}

/** The calls the task still needs: to the estimate while the count is under it, else to the budget. */
export function callsLeft({ count, budget, estimate = null }) {
  const toBudget = Math.max(budget - count, 0);
  return Number.isInteger(estimate) && estimate > count ? Math.min(estimate - count, toBudget) : toBudget;
}

function levelOf({ ratio, left, agentType }, settings) {
  if (ratio >= settings.handoffRatio && left >= settings.minCallsLeft && settings.handoffTypes.includes(agentType)) return "handoff";
  return ratio >= settings.summarizeRatio ? "summarize" : "none";
}

const thousands = (n) => `${Math.round(n / 1000)}K`;
const times = (ratio) => `${ratio.toFixed(1)}x`;

const summarizeText = ({ context, first, ratio }) =>
  `Context signal: each call of this agent re-sends about ${thousands(context)} tokens, ${times(ratio)} its first call (${thousands(first)}). ` +
  "New output adds to every later call: a line range costs less than a whole file, a summary of a long command output " +
  "less than the output, and a file already in context needs no second read.";

const handoffText = ({ context, first, ratio, left }) =>
  `Context signal: each call of this agent re-sends about ${thousands(context)} tokens, ${times(ratio)} its first call (${thousands(first)}), ` +
  `with about ${left} calls of work left. A fresh agent starts near ${thousands(first)}, so the rest of the task costs less there. ` +
  "The hand-off at the next green step: commit and push, write a note in a `handoffs/` folder beside the report file " +
  "(lines `Brief:`, `Worktree:`, `Branch:`, and `Head:`; sections `## Done`, `## Left`, and `## Next step`), " +
  "and send the report with a line `HANDOFF: <note path>`. The controller starts a fresh implementer from the note.";

/**
 * The note for one check. `fired` is `{ level, at }` of the last note, or null.
 * @returns `{ level, text }`, or null when there is nothing new to say
 */
export function contextVerdict({ context, first, count, budget, estimate = null, agentType, fired = null }, settings) {
  if (!(first > 0) || !(context > 0)) return null;
  const ratio = context / first;
  const left = callsLeft({ count, budget, estimate });
  const level = levelOf({ ratio, left, agentType }, settings);
  if (level === "none") return null;
  const firedRank = fired ? Math.max(LEVELS.indexOf(fired.level), 0) : 0;
  const repeat = level === "handoff" && fired?.level === "handoff" && count - fired.at >= settings.repeatEvery;
  if (LEVELS.indexOf(level) <= firedRank && !repeat) return null;
  const facts = { context, first, ratio, left };
  return { level, text: level === "handoff" ? handoffText(facts) : summarizeText(facts) };
}

/** The line a hand-back gains when the agent ends large, so the controller can weigh a resume against a fresh agent. */
export function handbackStamp({ context, first }, settings) {
  if (!(first > 0) || !(context > 0) || context / first < settings.summarizeRatio) return null;
  return (
    `CONTEXT: this agent ended at about ${thousands(context)} tokens per call, ${times(context / first)} its first call (${thousands(first)}). ` +
    `A resume re-sends that on each call; a fresh agent of this type starts near ${thousands(first)}.`
  );
}
