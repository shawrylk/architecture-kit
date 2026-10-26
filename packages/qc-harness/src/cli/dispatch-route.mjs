// This branch keeps the panel's runtime and model consistent with the dispatch.
import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { familyOf, isImplementer, typeOf } from "./dispatch.mjs";

export const isCodexType = (type) => type === "codex" || type === "architecture:codex";
export const RUNTIME_LINE = /^[\t ]*Runtime:[\t ]*claude[\t ]+(\S[^\r\n]*?)[\t ]*$/im;

export function routeRefusal(input, settings, limit) {
  const type = typeOf(input);
  const prompt = typeof input.prompt === "string" ? input.prompt : "";
  if (isCodexType(type)) {
    if (!limit) return null;
    const preferred = "architecture:sdd-implementer";
    const fallback = settings.implementerTypes.includes(preferred) ? preferred :
      settings.implementerTypes.find((name) => name.endsWith("sdd-implementer")) ?? preferred;
    const brief = prompt.match(/^[\t ]*Brief:[^\r\n]*$/m)?.[0] ?? "Brief: <path>";
    return `Dispatch guard: Codex is limited until ${limit.until.toISOString()}; run \`qc codex status\` to check the limit. ` +
      `Dispatch \`${fallback}\` with model \`sonnet\` and the same brief:\n${brief}`;
  }
  if (!limit && isImplementer(type, settings) && !RUNTIME_LINE.test(prompt)) {
    return "Dispatch guard: an implementer dispatch while Codex is free needs a prompt line `Runtime: claude <reason>` with a reason.";
  }
  return null;
}

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
