import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { overloaded } from "./fleet-assign.mjs";
import { liveJob, redactJobText, tailLines, validJob, validJobId } from "./fleet-jobs.mjs";
import { createMessage } from "./fleet-message.mjs";
import { flushOutbox } from "./fleet-node.mjs";
import { validPlatformBranch } from "./fleet-platform.mjs";
import { requestUpdate, validKitVersion } from "./fleet-update.mjs";
import { highestTerm, livePeer, readState, writeState } from "./fleet-state.mjs";

export const DISPATCH_VERBS = ["job", "jobs", "cancel", "slots", "update"];
export function parseDispatchArgs(verb, args) {
  if (verb === "jobs" && args.length === 0) return { verb };
  if (verb === "cancel" && args.length === 1 && validJobId(args[0])) return { verb, id: args[0] };
  if (verb === "update") {
    const [version, flag, node, ...rest] = args;
    if (!validKitVersion(version)) throw new Error("update needs a version such as 0.32.0");
    if (flag === undefined) return { verb, version };
    if (flag !== "--node" || !/^[a-z0-9-]{1,32}$/.test(node ?? "") || rest.length) throw new Error("update takes only --node <id>");
    return { verb, version, "--node": node };
  }
  if (verb === "slots") {
    const [value, flag, node, ...rest] = args;
    if (value !== "auto" && !(/^\d+$/.test(value ?? "") && Number.isSafeInteger(Number(value)))) throw new Error("slots needs auto or a nonnegative integer");
    if (flag === undefined) return { verb, mode: value === "auto" ? value : Number(value) };
    if (flag !== "--node" || !/^[a-z0-9-]{1,32}$/.test(node ?? "") || rest.length) throw new Error("slots takes only --node <id>");
    return { verb, mode: value === "auto" ? value : Number(value), "--node": node };
  }
  if (verb !== "job") throw new Error(`${verb} needs ${verb === "cancel" ? "a job id" : "no arguments"}`);
  const options = { verb };
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!["--brief", "--branch", "--base", "--rounds", "--node", "--id"].includes(flag) || Object.hasOwn(options, flag)) throw new Error(`invalid or duplicate argument ${flag}`);
    if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
    options[flag] = args[++i];
  }
  if (!options["--brief"] || !validPlatformBranch(options["--branch"]) || !validPlatformBranch(options["--base"])) throw new Error("job needs --brief, --branch and --base");
  const rounds = Number(options["--rounds"] ?? 3);
  if (!Number.isInteger(rounds) || rounds < 1 || rounds > 6) throw new Error("--rounds must be from 1 to 6");
  if (options["--id"] !== undefined && !validJobId(options["--id"])) throw new Error("invalid job id");
  if (options["--node"] !== undefined && !/^[a-z0-9-]{1,32}$/.test(options["--node"])) throw new Error("invalid node id");
  return options;
}
function requireLeader(root) {
  const node = readState(root, "node");
  if (node.leader !== true || (node.term ?? 1) < highestTerm(root)) throw new Error("only the current leader can send jobs or cancel them");
}
const pendingJob = row => row.state === "queued" || liveJob(row);
export function pickJobNode({ fleet, peers, now, node, jobs = {} }) {
  const candidates = fleet.nodes.filter(row => {
    const peer = peers[row.id], slots = peer?.jobs;
    const pending = Object.values(jobs).filter(job => job.node === row.id && pendingJob(job)).length;
    return (!node || row.id === node) && row.active !== false && row.address && livePeer(peer, now) &&
      slots && Number.isSafeInteger(slots.max) && slots.max > 0 && Number.isSafeInteger(slots.live) && slots.live >= 0 &&
      slots.max > Math.max(slots.live, pending) && Number.isFinite(slots.limitedUntil) && now >= slots.limitedUntil && !overloaded(peer.load).length;
  }).sort((a, b) => {
    const free = id => peers[id].jobs.max - Math.max(peers[id].jobs.live, Object.values(jobs).filter(job => job.node === id && pendingJob(job)).length);
    return free(b.id) - free(a.id) || a.id.localeCompare(b.id);
  });
  if (!candidates.length) throw new Error("no live node with available job slots");
  return candidates[0];
}
async function queueMessage(context, target, kind, body) {
  const { root, fleet, repo, clock = Date.now, fetch, signal } = context;
  requireLeader(root);
  const message = createMessage({ from: fleet.self, repo, kind, body, time: new Date(clock()).toISOString() }, fleet.secret);
  writeState(root, "outbox", [...readState(root, "outbox"), { node: target, message, attempts: 0, nextAttempt: 0 }]);
  await flushOutbox({ root, fleet, fetch, clock, signal });
}
export async function runDispatch(options, context) {
  const { root, fleet, repo, clock = Date.now, say = console.log } = context;
  if (options.verb === "jobs") {
    const peers = readState(root, "peers");
    for (const row of Object.values(readState(root, "jobs"))) {
      const step = peers[row.node]?.jobs?.steps?.find(step => step.id === row.id)?.step || row.step || "-";
      say(redactJobText(`${row.id} ${row.node} ${row.state} ${row.branch} ${step} ${Math.max(0, Math.floor((clock() - row.created) / 1000))}s`, fleet.secret));
    }
    return 0;
  }
  if (options.verb === "update") {
    requireLeader(root);
    // With no --node, every other active node gets the version. The leader updates itself only by name.
    const targets = options["--node"] ? [options["--node"]] : fleet.nodes.filter(node => node.active !== false && node.id !== fleet.self).map(node => node.id);
    if (targets.some(id => !fleet.nodes.some(node => node.id === id))) throw new Error("unknown node id");
    for (const target of targets) {
      if (target === fleet.self) requestUpdate(root, options.version);
      else await queueMessage(context, target, "kit-update", { version: options.version });
    }
    say(`update ${options.version} ${targets.join(" ")}`); return 0;
  }
  if (options.verb === "slots") {
    const target = options["--node"] ?? fleet.self;
    if (target === fleet.self) writeState(root, "node", { ...readState(root, "node"), jobs: { mode: options.mode } });
    else {
      if (!fleet.nodes.some(node => node.id === target)) throw new Error("unknown node id");
      await queueMessage(context, target, "codex-slots", { mode: options.mode });
    }
    say(`slots ${target} ${options.mode}`); return 0;
  }
  requireLeader(root);
  const jobs = readState(root, "jobs");
  if (options.verb === "cancel") {
    const row = jobs[options.id];
    if (!row || row.repo !== repo) throw new Error("unknown job id");
    await queueMessage(context, row.node, "codex-cancel", { id: row.id });
    say(`cancel ${row.id}`); return 0;
  }
  const branch = options["--branch"], base = options["--base"], brief = readFileSync(options["--brief"], "utf8");
  const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 35) || "job";
  const id = options["--id"] ?? `${slug}-${randomBytes(2).toString("hex")}`;
  const body = { id, branch, base, brief, rounds: Number(options["--rounds"] ?? 3) };
  if (!validJob(body)) throw new Error("invalid job body or brief over 64 KiB");
  if (redactJobText(JSON.stringify(body), fleet.secret) !== JSON.stringify(body)) throw new Error("job contains fleet secret");
  if (Object.hasOwn(jobs, id)) throw new Error("job id already known");
  const node = pickJobNode({ fleet, peers: readState(root, "peers"), now: clock(), jobs, node: options["--node"] });
  jobs[id] = { id, node: node.id, repo, branch, base, state: "queued", created: clock(), time: clock(), step: "-" };
  writeState(root, "jobs", jobs);
  await queueMessage(context, node.id, "codex-job", body);
  say(`job ${id} ${node.id} ${branch}`); return 0;
}
function event(root, row, state, head, now) {
  writeState(root, "inbox", [...readState(root, "inbox"), { id: randomUUID(), kind: "codex-result", repo: row.repo,
    time: new Date(now).toISOString(), detail: `${row.id} ${state} ${row.branch} ${head ?? "-"}` }]);
}
const states = ["started", "refused", "approved", "limit", "stopped", "failed", "cancelled"];
function validResult(body, row) {
  return body && states.includes(body.state) && (body.branch === undefined || body.branch === row.branch) &&
    (body.state !== "approved" || (body.branch === row.branch && /^[a-f0-9]{40}$/i.test(body.head ?? ""))) &&
    (body.head === undefined || (typeof body.head === "string" && /^[a-f0-9]{40}$/i.test(body.head))) &&
    ["reason", "status"].every(key => body[key] === undefined || (typeof body[key] === "string" && Buffer.byteLength(JSON.stringify(body[key])) <= 48_000)) &&
    Object.keys(body).every(key => ["id", "state", "branch", "head", "reason", "status"].includes(key));
}
/** The leader owns state and watch events; only the saved worker can change a job. */
export function dispatchTick({ root, fleet, clock = Date.now }) {
  const node = readState(root, "node");
  if (node.leader !== true || (node.term ?? 1) < highestTerm(root)) return;
  const jobs = readState(root, "jobs"), peers = readState(root, "peers"), queue = readState(root, "queue");
  const messages = queue.filter(row => row.kind === "codex-result");
  if (messages.length) writeState(root, "queue", queue.filter(row => row.kind !== "codex-result"));
  let changed = false;
  for (const message of messages) {
    const row = jobs[message.body?.id], body = message.body;
    if (!row || row.node !== message.from || row.repo !== message.repo || !validResult(body, row)) continue;
    // A late started result must not undo a final result or a lost-node decision.
    if (body.state === "started" && !["queued", "starting"].includes(row.state)) continue;
    // A final result stays final; a refusal counts only before the worker started the job.
    if (!["queued", "starting", "started", "lost"].includes(row.state)) continue;
    if (body.state === "refused" && !["queued", "starting"].includes(row.state)) continue;
    if (body.state === row.state) continue;
    const status = body.status === undefined ? row.status : tailLines(body.status, fleet.secret);
    Object.assign(row, { state: body.state, time: clock(), ...(body.head ? { head: body.head } : {}),
      ...(status === undefined ? {} : { status, step: status.split("\n").at(-1).slice(0, 120) }),
      ...(body.reason === undefined ? {} : { reason: tailLines(body.reason, fleet.secret) }) });
    event(root, row, row.state, row.head, clock()); changed = true;
  }
  for (const row of Object.values(jobs)) {
    if (!pendingJob(row) || livePeer(peers[row.node] ?? { time: row.created }, clock())) continue;
    row.state = "lost"; row.time = clock(); event(root, row, "lost", row.head, clock()); changed = true;
  }
  if (changed) writeState(root, "jobs", jobs);
}
