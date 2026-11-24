import { createMessage, verifyMessage } from "./fleet-message.mjs";
import { parseMarker, roleComment } from "./role-line.mjs";
import { parsePages, runGh } from "./gh-run.mjs";
import { pruneSeen, readState, writeState } from "./fleet-state.mjs";

const WORK_KINDS = new Set(["assign", "plan", "approve", "question", "answer", "pushed", "verdict", "platform-check", "platform-result"]);
const isWork = message => WORK_KINDS.has(message?.kind) && Number.isSafeInteger(message.body?.issue) && message.body.issue > 0;

/** HTTP and GitHub share verification and synchronous replay/queue persistence. */
export function receiveMessage({ root, fleet, message, clock = Date.now }) {
  const time = clock();
  const seen = pruneSeen(readState(root, "seen"), time);
  const result = verifyMessage(message, { secret: fleet.secret, nodes: fleet.nodes, seen, now: time });
  if (!result.ok) return result;
  if (message.kind === "heartbeat" && !(typeof message.body.leader === "boolean" && (message.body.kit === null || typeof message.body.kit === "string"))) {
    return { ok: false, reason: "bad-heartbeat" };
  }
  // No await between verification and persistence: both transports share saved IDs.
  if (message.kind !== "heartbeat") writeState(root, "queue", [...readState(root, "queue"), message]);
  writeState(root, "seen", seen);
  if (message.kind === "heartbeat") {
    const peers = readState(root, "peers");
    Object.defineProperty(peers, message.from, { value: { time, kit: message.body.kit, leader: message.body.leader }, enumerable: true, configurable: true, writable: true });
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

function commentMessage(comment, { fleet, login, repo, issue }) {
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
      || message.repo !== repo || message.body.issue !== issue) return null;
    return message;
  } catch { return null; }
}

/** Poll every held issue (and every assigned issue on the Leader), preserving failed cursors. */
export function readGithub({ root, fleet, leader = false, clock = Date.now, gh = runGh }) {
  const issues = Object.values(readState(root, "assignments")).filter(row => leader || row.node === fleet.self);
  if (!issues.length) return;
  let login;
  try { login = JSON.parse(gh(["api", "user"], { cwd: root }))?.login; }
  catch { return; }
  if (typeof login !== "string" || !login) return;
  const state = readState(root, "github");
  const cursors = { ...state.cursors };
  for (const { repo, issue } of issues) {
    const key = `${repo}#${issue}`, until = new Date(clock()).toISOString();
    try {
      const pages = parsePages(gh(["api", `repos/${repo}/issues/${issue}/comments`, "--method", "GET", "--paginate",
        "-f", `since=${cursors[key] ?? new Date(0).toISOString()}`], { cwd: root }));
      if (!pages?.length || !pages.every(Array.isArray)) continue;
      for (const comment of pages.flat()) {
        const message = commentMessage(comment, { fleet, login, repo, issue });
        if (message) receiveMessage({ root, fleet, message, clock });
      }
      Object.defineProperty(cursors, key, { value: until, enumerable: true, configurable: true, writable: true });
      writeState(root, "github", { ...state, cursors });
    } catch { /* A gh/read failure keeps this issue's cursor for the next poll. */ }
  }
}
