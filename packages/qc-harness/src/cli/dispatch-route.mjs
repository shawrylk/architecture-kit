// This branch keeps the panel's runtime and model consistent with the dispatch.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { familyOf, typeOf } from "./dispatch.mjs";

export const isCodexType = (type) => type === "codex" || type === "architecture:codex";

export function codexModelOf(env = process.env) {
  const home = env.CODEX_HOME || path.join(os.homedir(), ".codex");
  let config;
  try {
    config = readFileSync(path.join(home, "config.toml"), "utf8");
  } catch {
    return null;
  }
  for (const line of config.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const match = line.match(/^\s*model\s*=\s*(["'])(.*?)\1\s*(?:#.*)?$/);
    if (match) return match[2];
  }
  return null;
}

export function runtimeTagOf(input, { codexModel } = {}) {
  if (isCodexType(typeOf(input))) return `Codex ${codexModel || "default"} \u00b7 `;
  const model = typeof input.model === "string" && input.model !== "" ? input.model : null;
  return `Claude ${(model && (familyOf(model) || model)) || "default"} \u00b7 `;
}

export function tagRefusal(input, options) {
  const tag = runtimeTagOf(input, options);
  if (typeof input.description === "string" && input.description.trimStart().startsWith(tag)) return null;
  return `Dispatch guard: the description of a ${typeOf(input)} dispatch must start with "${tag}" so the agent panel shows the runtime and the model. Write "${tag}<what the agent does>".`;
}
