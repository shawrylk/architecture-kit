import { defaults } from "../config.mjs";

const roles = Object.keys(defaults.budgets);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function invalid(key, want, value) {
  throw new Error(`${key} in qc.config.json must be ${want}, got ${JSON.stringify(value)}`);
}

function positiveWhole(key, value) {
  if (!Number.isInteger(value) || value < 1) invalid(key, "a positive whole number", value);
  return value;
}

export function budgetsOf(config) {
  const budgets = config.budgets === undefined ? defaults.budgets : config.budgets;
  if (!isObject(budgets)) invalid("budgets", "an object", budgets);
  for (const role of Object.keys(budgets)) {
    if (!roles.includes(role)) invalid(`budgets.${role}`, `a known role (${roles.join(", ")})`, budgets[role]);
  }
  const result = {};
  for (const role of roles) {
    const value = budgets[role] === undefined ? defaults.budgets[role] : budgets[role];
    if (value === null) {
      result[role] = null;
      continue;
    }
    if (!isObject(value)) invalid(`budgets.${role}`, "an object or null", value);
    const keys = Object.keys(defaults.budgets[role]);
    for (const key of Object.keys(value)) {
      if (!keys.includes(key)) invalid(`budgets.${role}.${key}`, `a known key (${keys.join(", ")})`, value[key]);
    }
    const resolved = { ...defaults.budgets[role], ...value };
    if (role === "codex" && resolved.compactAt === null) {
      const fallback = config.codex === undefined ? defaults.codex.compactTokens : config.codex?.compactTokens;
      resolved.compactAt = positiveWhole("codex.compactTokens", fallback);
    }
    for (const key of keys) {
      positiveWhole(`budgets.${role}.${key}`, resolved[key]);
    }
    if (resolved.remindAt >= resolved.handoffAt) {
      invalid(`budgets.${role}.remindAt`, `smaller than handoffAt (${resolved.handoffAt})`, resolved.remindAt);
    }
    result[role] = resolved;
  }
  return result;
}
