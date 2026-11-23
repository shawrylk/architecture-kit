// A fragment that runs one gh call for a workflow hook. The caller passes the GH_* settings the user's
// own command made, so the hook reads with the account that command used.

import { execFile, spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";

const GH_TIMEOUT_MS = 20_000;

/** Reads the consecutive JSON values printed by `gh api --paginate`. */
export function parsePages(text) {
  if (typeof text !== "string" || !text.trim()) return null;
  const pages = [];
  const scalar = /(?:true|false|null|-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?)/y;
  let offset = 0;
  try {
    while (offset < text.length) {
      if (/\s/.test(text[offset])) { offset++; continue; }
      const start = offset;
      if ('{["'.includes(text[offset])) {
        let depth = 0;
        let quoted = false;
        let escaped = false;
        do {
          const char = text[offset++];
          if (quoted) {
            if (escaped) escaped = false;
            else if (char === "\\") escaped = true;
            else if (char === '"') quoted = false;
          } else if (char === '"') quoted = true;
          else if (char === "{" || char === "[") depth++;
          else if (char === "}" || char === "]") depth--;
        } while (offset < text.length && (depth > 0 || quoted));
        if (depth !== 0 || quoted) return null;
      } else {
        scalar.lastIndex = offset;
        if (!scalar.exec(text)) return null;
        offset = scalar.lastIndex;
      }
      pages.push(JSON.parse(text.slice(start, offset)));
    }
    return pages;
  } catch {
    return null;
  }
}

/** Flattens API object pages, or returns null for an unreadable list. */
export function parseApiList(text, key) {
  const pages = parsePages(text);
  if (!pages || !pages.every((page) => Array.isArray(page?.[key]))) return null;
  return pages.flatMap((page) => page[key]);
}

/** Expands a leading `~`, `~/`, or `~\` in each value, as a shell does for an assignment. */
export function expandHome(env) {
  return Object.fromEntries(
    Object.entries(env ?? {}).map(([name, value]) => [
      name,
      typeof value === "string" && (value === "~" || value.startsWith("~/") || value.startsWith("~\\")) ? path.join(os.homedir(), value.slice(1)) : value,
    ]),
  );
}

/** @returns gh's stdout on exit 0, or null when gh fails, times out, or is not installed. */
export function runGh(args, { cwd = process.cwd(), env = {}, timeoutMs = GH_TIMEOUT_MS } = {}) {
  const result = runGhResult(args, { cwd, env, timeoutMs });
  return result.status === 0 ? (result.stdout ?? "") : null;
}

/** Resource: run a gh request without blocking other requests under the caller's deadline. */
export function runGhAsync(args, { cwd = process.cwd(), env = {}, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return new Promise((resolve) => {
    execFile("gh", args, {
      cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true,
      timeout: timeoutMs, env: { ...process.env, ...expandHome(env) },
    }, (error, stdout) => resolve(error ? null : stdout));
  });
}

/** Returns the process result, including stderr and any spawn error. */
export function runGhResult(args, { cwd = process.cwd(), env = {}, timeoutMs = GH_TIMEOUT_MS } = {}) {
  return spawnSync("gh", args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    windowsHide: true,
    timeout: timeoutMs,
    env: { ...process.env, ...expandHome(env) },
  });
}
