import { closeSync, fstatSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import path from "node:path";
import { runGit } from "./fleet-git.mjs";

export const DETAIL_LIMIT = 4000;
const LIMITS = { reportTail: 1500, progressTail: 600, pushError: 800 };
const TEXT_KEYS = Object.keys(LIMITS);
const SECRET_LINE = /--secret|token|password|authorization/i;
const PUSH_FAILURE = /error: failed to push|pre-push|! \[(remote )?rejected\]/gi;
const READ_BYTES = 128 * 1024;
const plain = value => value !== null && typeof value === "object" && !Array.isArray(value);

/** Drop each line that can hold a credential, then hide the fleet secret itself. */
export function scrubDetailText(value, secret) {
  const text = String(value).split(/\r?\n/).filter(line => !SECRET_LINE.test(line)).join("\n");
  return secret ? text.replace(new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "gi"), "[REDACTED]") : text;
}
const clip = (value, secret, limit) => scrubDetailText(value, secret).trim().slice(-limit);

function readEnd(file) {
  const fd = openSync(file, "r");
  try {
    const size = fstatSync(fd).size, buffer = Buffer.alloc(Math.min(size, READ_BYTES));
    readSync(fd, buffer, 0, buffer.length, size - buffer.length);
    return buffer.toString("utf8");
  } finally { closeSync(fd); }
}
/** The end of the newest file in the job directory whose name matches; "" when there is none. */
function newest(dir, pattern) {
  let names;
  try { names = readdirSync(dir).filter(name => pattern.test(name)); }
  catch (error) { if (error.code === "ENOENT") return ""; throw error; }
  const files = names.map(name => ({ file: path.join(dir, name), time: statSync(path.join(dir, name)).mtimeMs }))
    .sort((a, b) => b.time - a.time || a.file.localeCompare(b.file));
  return files.length ? readEnd(files[0].file) : "";
}
/** The text that ends at the last push failure line, or "" when the text shows no failed push. */
export function pushFailure(text) {
  const last = [...String(text).matchAll(PUSH_FAILURE)].at(-1);
  if (!last) return "";
  const end = text.indexOf("\n", last.index);
  return text.slice(0, end < 0 ? text.length : end);
}
/** Trim the longest text from its start until the JSON form fits the limit. */
export function capDetail(detail, limit = DETAIL_LIMIT) {
  const capped = { ...detail };
  for (let size = JSON.stringify(capped).length; size > limit; size = JSON.stringify(capped).length) {
    const key = TEXT_KEYS.filter(name => capped[name]).sort((a, b) => capped[b].length - capped[a].length)[0];
    if (!key) return undefined;
    // One character can take six characters in JSON, so a cut of one sixth of the excess never removes too much.
    capped[key] = capped[key].slice(Math.ceil((size - limit) / 6));
    if (!capped[key]) delete capped[key];
  }
  return capped;
}
/** Keep only the known fields of a detail from the wire or from disk; undefined when nothing valid is left. */
export function cleanDetail(detail, secret) {
  if (!plain(detail)) return undefined;
  const clean = {};
  for (const key of TEXT_KEYS) {
    const text = typeof detail[key] === "string" ? clip(detail[key], secret, LIMITS[key]) : "";
    if (text) clean[key] = text;
  }
  const head = detail.head;
  if (plain(head) && typeof head.commit === "string" && /^[a-f0-9]{40}$/i.test(head.commit)) {
    const flag = value => typeof value === "boolean" ? value : null;
    clean.head = { commit: head.commit, ahead: flag(head.ahead), onOrigin: flag(head.onOrigin) };
  }
  return Object.keys(clean).length ? capDetail(clean) : undefined;
}
/** A git answer, or undefined when git cannot give one: the detail then says "unknown". */
async function ask(git, cwd, ...args) {
  try { return (await git(cwd, ...args)).stdout.trim(); } catch { return undefined; }
}
async function headState(git, row) {
  if (!row.worktree) return undefined;
  const commit = await ask(git, row.worktree, "rev-parse", "HEAD");
  if (!/^[a-f0-9]{40}$/i.test(commit ?? "")) return undefined;
  const count = row.base ? await ask(git, row.worktree, "rev-list", "--count", `origin/${row.base}..HEAD`) : undefined;
  const remote = row.branch ? await ask(git, row.worktree, "ls-remote", "--heads", "origin", `refs/heads/${row.branch}`) : undefined;
  return { commit, ahead: /^\d+$/.test(count ?? "") ? Number(count) > 0 : null,
    onOrigin: remote === undefined ? null : remote.split(/\s+/)[0].toLowerCase() === commit.toLowerCase() };
}
/**
 * What the leader needs to see why a job stopped or failed, read from the job directory and the job worktree.
 * `pushError` is the output of a push that the worker ran; without it the loop output and the logs are searched.
 */
export async function buildJobDetail({ row, git = runGit, secret, pushError, output = "" }) {
  const detail = { pushError: pushError || pushFailure(output) };
  if (row.dir) {
    detail.reportTail = newest(row.dir, /-report\.md$/);
    detail.progressTail = newest(row.dir, /-progress\.md$/);
    detail.pushError ||= pushFailure(newest(row.dir, /\.wrapper$/)) || pushFailure(newest(row.dir, /-codex\.log$/));
  }
  detail.head = await headState(git, row);
  return cleanDetail(detail, secret);
}
/** One line for `fleet jobs`: the commit state, or else the first line of the push error. */
export function detailSummary(detail) {
  const head = detail?.head, first = detail?.pushError?.split("\n").find(line => line.trim())?.trim().slice(0, 120);
  if (!head) return first ?? "";
  const short = head.commit.slice(0, 9);
  const commit = head.ahead === true ? `committed ${short}` : head.ahead === false ? `no new commit, head ${short}` : `head ${short}`;
  return `${commit}, ${head.onOrigin === true ? "on origin" : head.onOrigin === false ? "not on origin" : "origin unknown"}`;
}
/** The stored detail in full, for `fleet jobs --detail <id>`. */
export function detailLines(row) {
  const lines = [`${row.id} ${row.node} ${row.state} ${row.branch}`, `step: ${row.step || "-"}`];
  if (row.reason) lines.push(`reason: ${row.reason}`);
  const detail = row.detail;
  if (!detail) return [...lines, "detail: none. The node sent none: it runs a version before 0.33.0, or the job did not stop or fail."];
  lines.push(`summary: ${detailSummary(detail) || "-"}`);
  if (detail.head) lines.push(`head: ${detail.head.commit}`);
  for (const key of ["pushError", "progressTail", "reportTail"]) if (detail[key]) lines.push(`--- ${key}`, detail[key]);
  return lines;
}
