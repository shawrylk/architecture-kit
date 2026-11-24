import { createMessage, verifyMessage } from "./fleet-message.mjs";
import { parseMarker, roleComment } from "./role-line.mjs";
import { parsePages, runGh } from "./gh-run.mjs";
import { highestTerm, validTerm, pruneSeen, readState, writeState } from "./fleet-state.mjs";

const assignmentRef = row => row && typeof row.repo === "string" && /^[a-z0-9][a-z0-9-]*\/[a-z0-9_.-]+$/i.test(row.repo) &&
  Number.isSafeInteger(row.issue) && row.issue > 0 && Number.isSafeInteger(row.epoch) && row.epoch > 0;
export const validBranch = value => value === undefined || value === null || (typeof value === "string" && value.length > 0 && !/[\s\x00-\x1f\x7f]/.test(value));
export const validHead = value => value === undefined || value === null || (typeof value === "string" && /^[0-9a-f]{40}$/i.test(value));
export const validWork = row => assignmentRef(row) && [null, "plan", "code", "review", "merge"].includes(row.step) && validBranch(row.branch) && validHead(row.head);
const validHeartbeat = body => validTerm(body.term) && typeof body.leader === "boolean" && (body.kit === null || typeof body.kit === "string") &&
  (body.work === undefined || (Array.isArray(body.work) && body.work.every(validWork))) &&
  (body.assigned === undefined || (Array.isArray(body.assigned) && body.assigned.every(assignmentRef)));

const WORK_KINDS = new Set(["assign", "plan", "approve", "question", "answer", "pushed", "verdict", "platform-check", "platform-result"]);
const isWork = message => WORK_KINDS.has(message?.kind) && Number.isSafeInteger(message.body?.issue) && message.body.issue > 0;

/** HTTP and GitHub share verification and synchronous replay/queue persistence. */
export function receiveMessage({ root, fleet, message, clock = Date.now }) {
  const time = clock();
  const seen = pruneSeen(readState(root, "seen"), time);
  const result = verifyMessage(message, { secret: fleet.secret, nodes: fleet.nodes, seen, now: time });
  if (!result.ok) return result;
  if (message.kind === "heartbeat" && !validHeartbeat(message.body)) {
    return { ok: false, reason: "bad-heartbeat" };
  }
  // No await between verification and persistence: requests cannot race the saved IDs.
  if (message.kind !== "heartbeat") writeState(root, "queue", [...readState(root, "queue"), message]);
  writeState(root, "seen", seen);
  if (message.kind === "heartbeat") {
    const election = readState(root, "election"), node = readState(root, "node");
    const highest = Math.max(highestTerm(root), message.body.term);
    const accepted = message.body.leader && message.body.term >= highest;
    election.highest = highest;
    if (message.body.term > (node.term ?? 1)) writeState(root, "node", { ...node, leader: false, term: highest });
    if (accepted) {
      election.lastLeaderAt = time;
      if (readState(root, "proposal").term <= message.body.term) writeState(root, "proposal", {});
    }
    writeState(root, "election", election);
    const peers = readState(root, "peers");
    const previous = peers[message.from];
    if (message.body.term < (previous?.term ?? 1) || (message.body.term === (previous?.term ?? 1) &&
      Date.parse(message.time) <= Date.parse(previous?.messageTime))) {
      peers[message.from].time = time;
    } else Object.defineProperty(peers, message.from, { value: { time, messageTime: message.time, kit: message.body.kit, term: message.body.term, leader: accepted,
      ...(message.body.os === undefined ? {} : { os: message.body.os }),
      ...(message.body.work === undefined ? {} : { work: message.body.work }),
      ...(message.body.assigned === undefined ? {} : { assigned: message.body.assigned }) }, enumerable: true, configurable: true, writable: true });
    for (const peer of Object.values(peers)) if ((peer.term ?? 1) < highest) peer.leader = false;
    writeState(root, "peers", peers);
  }
  return { ok: true };
}

/** Work alone can bypass HTTP backoff when retries or missing heartbeats warrant it. */
export function githubFallback({ root, entry, now }) {
  if (!isWork(entry.message)) return false;
  const last = readState(root, "peers")[entry.node]?.time;
  return entry.attempts >= 3 || !Number.isFinite(last) || now - last >= 90_000;
}

/** A failed comment leaves the original entry available on the next node tick. */
export function postGithubMessage({ root, fleet, entry, leader = false, clock = Date.now, gh = runGh, signal }) {
  if (signal?.aborted) return false;
  try {
    const message = createMessage({ ...entry.message, from: fleet.self, time: new Date(clock()).toISOString() }, fleet.secret);
    const issue = message.body.issue;
    const body = roleComment({ role: leader ? "leader" : "coder", node: fleet.self, kind: message.kind, ref: `#${issue}`,
      summary: `${message.kind} for #${issue}`,
      body: `<!-- qc:msg to=${entry.node} ${Buffer.from(JSON.stringify(message)).toString("base64url")} -->` }, { secret: fleet.secret });
    return typeof gh(["issue", "comment", String(issue), "--repo", message.repo, "--body", body], { cwd: root }) === "string";
  } catch { return false; }
}

function commentMessage(comment, { fleet, login, repo }) {
  const source = /^https:\/\/api\.github\.com\/repos\/([^/]+\/[^/]+)\/issues\/([1-9]\d*)$/.exec(comment?.issue_url);
  const issue = Number(source?.[2]);
  if (source?.[1].toLowerCase() !== repo.toLowerCase() || !Number.isSafeInteger(issue)) return null;
  const marker = parseMarker(comment?.body, { secret: fleet.secret, nodes: fleet.nodes.map(node => node.id), ownAuthor: comment?.user?.login === login });
  if (marker.refused) return null;
  const lines = comment.body.split("\n").filter(line => line.startsWith("<!-- qc:msg"));
  if (lines.length !== 1) return null;
  const match = /^<!-- qc:msg to=([\w-]+) ([\w-]+) -->$/.exec(lines[0]);
  if (!match || match[1] !== fleet.self) return null;
  try {
    const bytes = Buffer.from(match[2], "base64url");
    if (bytes.length > 64 * 1024 || bytes.toString("base64url") !== match[2]) return null;
    const message = JSON.parse(bytes.toString("utf8"));
    if (!isWork(message) || message.from !== marker.node || message.kind !== marker.kind || marker.ref !== `#${issue}`
      || message.repo?.toLowerCase() !== repo.toLowerCase() || message.body.issue !== issue) return null;
    return message;
  } catch { return null; }
}

/** Discover work across repositories using GitHub timestamps and a replay-safe overlap. */
export function readGithub({ root, fleet, repo, clock = Date.now, gh = runGh }) {
  const repos = new Set([repo, ...Object.values(readState(root, "assignments")).map(row => row.repo)].filter(Boolean).map(repo => repo.toLowerCase()));
  if (!repos.size) return;
  let login;
  try { login = JSON.parse(gh(["api", "user"], { cwd: root }))?.login; }
  catch { return; }
  if (typeof login !== "string" || !login) return;
  const state = readState(root, "github");
  const cursors = { ...state.cursors };
  for (const repo of repos) {
    try {
      const since = cursors[repo] ?? new Date(clock() - 600_000).toISOString();
      const pages = parsePages(gh(["api", "--paginate", `repos/${repo}/issues/comments?per_page=100&since=${since}`], { cwd: root }));
      if (!pages?.length || !pages.every(Array.isArray)) continue;
      let newest = -Infinity;
      for (const comment of pages.flat()) {
        const updated = Date.parse(comment?.updated_at);
        if (Number.isFinite(updated)) newest = Math.max(newest, updated);
        const message = commentMessage(comment, { fleet, login, repo });
        if (message) receiveMessage({ root, fleet, message, clock });
      }
      if (Number.isFinite(newest)) {
        Object.defineProperty(cursors, repo, { value: new Date(newest - 60_000).toISOString(), enumerable: true, configurable: true, writable: true });
        writeState(root, "github", { ...state, cursors });
      }
    } catch { /* A gh/read failure keeps this repository's cursor for the next poll. */ }
  }
}
