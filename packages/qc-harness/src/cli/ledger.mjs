// The resource for the workflow ledger: JSON lines in `<git common dir>/qc/ledger.jsonl`, shared by every
// worktree. This module is its one writer, and every workflow check reads it through `readLedger`.

import { appendFileSync, closeSync, mkdirSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { checkoutRootOf } from "./checkout-root.mjs";

export const RECORD_TYPES = ["dispatch", "stop", "verdict", "merge", "issue-update"];
const MIN_SHA = 7;
const HEX = /^[0-9a-f]+$/;

/** @returns the git common dir of the checkout at `root`, read with no git process, or null. */
export function commonDirOf(root) {
  const dotGit = path.join(root, ".git");
  let stat;
  try {
    stat = statSync(dotGit);
  } catch {
    return null;
  }
  if (stat.isDirectory()) return dotGit;
  // A linked worktree's `.git` file names its own git dir, whose `commondir` names the shared one.
  const match = /^gitdir:[ \t]*(.+?)[ \t]*$/m.exec(readFileSync(dotGit, "utf8"));
  if (!match) return null;
  const gitDir = path.resolve(root, match[1]);
  try {
    return path.resolve(gitDir, readFileSync(path.join(gitDir, "commondir"), "utf8").trim());
  } catch {
    return gitDir;
  }
}

/** @returns the ledger file of the checkout at `root`, or null when it has no git dir. */
export function ledgerFileOf(root) {
  const common = commonDirOf(root);
  return common ? path.join(common, "qc", "ledger.jsonl") : null;
}

/** True when the file holds bytes and its last one is not a newline, which is a line torn by a crash. */
function endsTorn(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const { size } = statSync(file);
    if (size === 0) return false;
    const last = Buffer.alloc(1);
    readSync(fd, last, 0, 1, size - 1);
    return last[0] !== 0x0a;
  } catch {
    return false;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

/** Appends one record, stamped with its time, on a line of its own. An unknown type throws, so no reader meets a shape it does not know. */
export function appendRecord(file, record, now = new Date()) {
  if (!RECORD_TYPES.includes(record?.type)) throw new Error(`ledger: unknown record type ${JSON.stringify(record?.type)}`);
  mkdirSync(path.dirname(file), { recursive: true });
  const line = `${JSON.stringify({ ...record, at: now.toISOString() })}\n`;
  // A torn last line ends at this newline, so it never swallows the new record.
  appendFileSync(file, endsTorn(file) ? `\n${line}` : line);
}

/** Every record in the file, oldest first. A missing file is an empty ledger, and a torn line is skipped. */
export function readLedger(file) {
  let text;
  try {
    text = readFileSync(file, "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  const records = [];
  for (const line of text.split(/\r?\n/)) {
    if (line.trim() === "") continue;
    try {
      const record = JSON.parse(line);
      if (RECORD_TYPES.includes(record?.type)) records.push(record);
    } catch {
      // A line torn by a crash mid-write carries no record.
    }
  }
  return records;
}

/** True when two shas name one commit: the shorter, of at least seven hex digits, starts the longer. */
export function shaMatches(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const [short, long] = a.length <= b.length ? [a.toLowerCase(), b.toLowerCase()] : [b.toLowerCase(), a.toLowerCase()];
  return short.length >= MIN_SHA && HEX.test(short) && long.startsWith(short);
}

/** The newest verdict of one of `kinds` that names `sha`, or null. */
export const latestVerdictFor = (records, sha, kinds) =>
  records.findLast((record) => record.type === "verdict" && kinds.includes(record.kind) && shaMatches(record.sha, sha)) ?? null;

/** The newest verdict of any kind on `branch`, or null. */
export const latestVerdictOn = (records, branch) =>
  records.findLast((record) => record.type === "verdict" && record.branch === branch) ?? null;

/** The newest implementer dispatch that named a worktree on `branch`, or null. */
export const lastTaskDispatchOn = (records, branch) =>
  records.findLast((record) => record.type === "dispatch" && record.task === true && record.branch === branch) ?? null;

const short = (sha) => (typeof sha === "string" ? sha.slice(0, MIN_SHA) : "");

const SUMMARIES = {
  dispatch: (r) =>
    `${r.agentType} ${r.task ? `${r.branch} ${short(r.head)}` : "(no task)"}${r.resumeReason ? ` NO-RESUME: ${r.resumeReason}` : ""}${
      r.handoff ? ` HANDOFF: ${r.handoff}` : ""
    }`,
  stop: (r) => `${r.role} ${r.agentType} ${r.agentId}${r.plan ? ` ${r.plan}` : ""}${r.handoff ? ` HANDOFF: ${r.handoff}` : ""}`,
  verdict: (r) => `${r.kind} ${r.verdict} ${short(r.sha)} ${r.branch ?? "(no branch)"}`,
  merge: (r) =>
    `${r.repo}#${r.pr} ${short(r.sha)} ${r.branch ?? ""} into ${r.base ?? "?"} names ${
      (r.issues ?? []).map((issue) => `${issue.repo}#${issue.number}`).join(" ") || "no issue"
    }`,
  "issue-update": (r) => `${r.repo}#${r.number} ${r.how} after ${r.prRepo}#${r.pr}`,
};

/** One line of `qc ledger`: the time, the type, and the fields that say what happened. */
export const formatRecord = (record) =>
  `${record.at}  ${record.type.padEnd(12)}  ${SUMMARIES[record.type](record).replace(/\s+/g, " ").trim()}`;

/** `qc ledger [branch]`: every record, or those that name the branch. @returns the exit code */
export function runLedger(config, [branch] = []) {
  const root = checkoutRootOf(config.root ?? process.cwd());
  const file = root ? ledgerFileOf(root) : null;
  if (!file) {
    console.error("qc ledger: this folder is in no git checkout.");
    return 1;
  }
  const records = readLedger(file).filter((record) => branch === undefined || record.branch === branch);
  for (const record of records) console.log(formatRecord(record));
  if (records.length === 0) console.log(branch ? `No record in ${file} names ${branch}.` : `The ledger at ${file} is empty.`);
  return 0;
}
