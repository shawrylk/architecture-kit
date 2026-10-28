// The ledger resource for passing platform legs and preview reservations.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { load } from "../config.mjs";
import { ledgerFileOf } from "./ledger.mjs";
import { platformRisk } from "./platform-risk.mjs";

export const hostOS = (platform = process.platform) => platform === "win32" ? "windows" : platform;
export const gitText = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

export function legRecords(root) {
  const file = ledgerFileOf(root);
  if (!file) throw new Error("platform legs need a git worktree");
  let contents;
  try { contents = readFileSync(file, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return contents.split(/\r?\n/).flatMap((line) => {
    try { const record = JSON.parse(line); return ["leg", "leg-preview"].includes(record.type) ? [record] : []; }
    catch { return []; }
  });
}

export function appendLeg(root, record) {
  if (record.type !== undefined && !["leg", "leg-preview"].includes(record.type)) throw new Error("invalid platform leg type");
  if (!["linux", "windows"].includes(record.os)) throw new Error("unknown platform for leg");
  if (!record.head || !["local", "preview"].includes(record.source)) throw new Error("invalid platform leg");
  const file = ledgerFileOf(root);
  if (!file) throw new Error("platform legs need a git worktree");
  mkdirSync(path.dirname(file), { recursive: true });
  // A leading newline separates a record from a torn write by another ledger producer.
  appendFileSync(file, `\n${JSON.stringify({ ...record, type: record.type ?? "leg", at: new Date().toISOString() })}\n`);
}

export function readyProblems(root, head) {
  const config = load(root);
  const hits = platformRisk(root, config.check.base, head);
  const passed = new Set(legRecords(root).filter((record) => record.type === "leg" && record.head === head && ["linux", "windows"].includes(record.os) && ["local", "preview"].includes(record.source)).map((record) => record.os));
  const missing = hits.length > 0 || passed.size === 0 ? config.ready.platforms.filter((os) => !passed.has(os)) : [];
  return { missing, hits };
}

export function readyLines({ missing, hits }) {
  return missing.length === 0 ? [] : [`Missing platform legs: ${missing.join(", ")}`, ...hits.slice(0, 3).map((hit) => `${hit.file}:${hit.line}: ${hit.reason}`)];
}

export function runReadyCheck(root, write = console.error) {
  try {
    const problems = readyProblems(root, gitText(root, "rev-parse", "HEAD"));
    for (const line of readyLines(problems)) write(line);
    return problems.missing.length > 0 ? 1 : 0;
  } catch (error) { write(`ready-check: ${error.message.split("\n")[0]}`); return 1; }
}
