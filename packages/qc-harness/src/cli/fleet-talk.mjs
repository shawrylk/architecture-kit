import { readFileSync } from "node:fs";
import { createMessage } from "./fleet-message.mjs";
import { flushOutbox, sendMessage } from "./fleet-node.mjs";
import { livePeer, readState, sessionOf, writeState } from "./fleet-state.mjs";
import { roleComment } from "./role-line.mjs";

export const TALK_VERBS = ["plan", "ask", "say", "approve", "answer", "show", "ack"];
export const TALK_KINDS = ["plan", "question", "say", "approve", "answer"];
const validText = text => typeof text === "string" && text.length <= 20000;

export function findTalk(root, id) {
  return [...Object.values(readState(root, "received")), ...readState(root, "queue"), ...Object.values(readState(root, "plans")), ...Object.values(readState(root, "answers")), ...Object.values(readState(root, "said"))]
    .find(message => message.id === id && TALK_KINDS.includes(message.kind));
}

function retainTalk(root, message) {
  const received = readState(root, "received");
  Object.defineProperty(received, message.id, { value: message, enumerable: true });
  writeState(root, "received", received);
}

/** Receipts use the normal signed transport and retry queue, but never receive receipts. */
export function queueReceipt(root, fleet, original, state, note = "") {
  if (!TALK_KINDS.includes(original.kind)) return;
  const message = createMessage({ from: fleet.self, repo: original.repo, kind: "receipt", body: { message: original.id, state, note, ...(Number.isSafeInteger(original.body?.issue) && original.body.issue > 0 ? { issue: original.body.issue } : {}) } }, fleet.secret);
  const { sig: _sig, time: _time, ...fields } = message;
  writeState(root, "outbox", [...readState(root, "outbox"), { node: original.from, message: fields, attempts: 0, nextAttempt: 0 }]);
}

function recordSent(root, node, message) {
  const sent = readState(root, "sent");
  Object.defineProperty(sent, message.id, { value: { node, repo: message.repo, time: message.time, state: "sent" }, enumerable: true });
  writeState(root, "sent", sent);
}

function requestError(message, assignments, fleet) {
  const { issue, epoch, text } = message.body ?? {};
  if (!Number.isSafeInteger(issue) || issue <= 0 || !Number.isSafeInteger(epoch) || epoch < 0 || !validText(text)) return "invalid request issue, epoch or text";
  if (!fleet.nodes.some(node => node.id === message.from)) return "request sender is not a known fleet node";
  const assignment = assignments[`${message.repo}#${issue}`];
  if (epoch === 0 && assignment?.node !== message.from) return null;
  if (!assignment || assignment.node !== message.from || assignment.epoch !== epoch) return "request sender does not hold this issue at this assignment epoch";
  return null;
}

export function parseTalkArgs(verb, rest) {
  const [target, ...flags] = rest;
  if (!target || target.startsWith("--")) throw new Error(`${verb} needs an issue, node or message ID`);
  if (["plan", "ask"].includes(verb) && (!/^[1-9]\d*$/.test(target) || !Number.isSafeInteger(Number(target)))) throw new Error("issue must be a positive integer");
  const options = { verb, target };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!(flag === "--file" && !["show", "ack"].includes(verb)) && !(flag === "--changes" && verb === "approve") && !(flag === "--note" && verb === "ack")) throw new Error(`unknown argument ${flag}`);
    if (Object.hasOwn(options, flag)) throw new Error(`duplicate argument ${flag}`);
    if (flag === "--changes") options[flag] = true;
    else {
      if (!flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error(`${flag} needs a value`);
      options[flag] = flags[++i];
    }
  }
  if (["plan", "ask", "say", "answer"].includes(verb) && !options["--file"]) throw new Error(`${verb} needs --file`);
  return options;
}

function fileText(file) {
  const text = readFileSync(file, "utf8");
  if (!validText(text)) throw new Error("text must be at most 20000 characters");
  return text;
}

/** Keep full envelopes so show and watch can use the original sender and message ID. */
export function receiveTalk(root, fleet, leader, now) {
  const queue = readState(root, "queue"), peers = readState(root, "peers"), assignments = readState(root, "assignments");
  const plans = readState(root, "plans"), answers = readState(root, "answers"), kept = [];
  const said = readState(root, "said");
  const inbox = readState(root, "inbox");
  let changed = false, savedPlan = false, savedAnswer = false, savedSay = false;
  for (const message of queue) {
    if (message.kind === "receipt") {
      changed = true;
      const { message: id, state, note = "" } = message.body ?? {}, sent = readState(root, "sent");
      const entry = typeof id === "string" && Object.hasOwn(sent, id) ? sent[id] : null;
      const states = ["sent", "delivered", "read", "done"];
      if (entry?.node === message.from && entry.repo === message.repo && ["delivered", "read", "done"].includes(state) && validText(note) && states.indexOf(state) > states.indexOf(entry.state)) {
        sent[id] = { ...entry, state, note };
        writeState(root, "sent", sent);
      }
      continue;
    }
    if (message.kind === "say") {
      changed = true;
      if (!validText(message.body?.text)) continue;
      Object.defineProperty(said, message.id, { value: message, enumerable: true, writable: true, configurable: true });
      inbox.push({ id: message.id, kind: message.kind, from: message.from, repo: message.repo, time: message.time });
      savedSay = true;
      continue;
    }
    const request = leader && ["plan", "question"].includes(message.kind);
    const reply = !leader && ["approve", "answer"].includes(message.kind);
    if (!request && !reply) { kept.push(message); continue; }
    changed = true;
    const body = message.body ?? {}, { issue, epoch } = body;
    if (!Number.isSafeInteger(issue) || issue <= 0 || !Number.isSafeInteger(epoch) || epoch < 0) continue;
    if (request ? requestError(message, assignments, fleet) : message.kind === "approve"
      ? typeof body.approved !== "boolean" || typeof body.plan !== "string" || !body.plan || !validText(body.note)
      : typeof body.question !== "string" || !body.question || !validText(body.text)) continue;
    const key = `${message.repo}#${issue}`, assignment = assignments[key];
    if (reply && (epoch === 0 ? assignment?.node === fleet.self
      : !assignment || assignment.node !== fleet.self || assignment.epoch !== epoch)) continue;
    if (reply && peers[message.from]?.leader !== true) {
      if (peers[message.from]?.leader !== false && now - Date.parse(message.time) < 600_000) kept.push(message);
      continue;
    }
    retainTalk(root, message);
    if (request) kept.push(message);
    else if (message.kind === "approve") { plans[key] = message; savedPlan = true; }
    else {
      Object.defineProperty(answers, body.question, { value: message, enumerable: true, writable: true, configurable: true });
      savedAnswer = true;
    }
    if (reply) inbox.push({ id: message.id, kind: message.kind, from: message.from, repo: message.repo, issue, time: message.time });
  }
  if (savedPlan) writeState(root, "plans", plans);
  if (savedAnswer) writeState(root, "answers", answers);
  if (savedSay) writeState(root, "said", said);
  if (savedPlan || savedAnswer || savedSay) {
    const watched = readState(root, "watched");
    let excess = inbox.filter(entry => Object.hasOwn(watched, entry.id)).length - 200;
    writeState(root, "inbox", inbox.filter(entry => {
      if (excess > 0 && Object.hasOwn(watched, entry.id)) {
        excess--;
        return false;
      }
      return true;
    }));
  }
  if (changed) writeState(root, "queue", kept);
}

export async function runTalk(options, { root, fleet, repo, gh, say, warn = console.error, node = {} }) {
  const { verb, target } = options;
  if (verb === "ack") {
    const message = findTalk(root, target), note = options["--note"] ?? "";
    if (!message || message.repo !== repo) throw new Error(`message not found: ${target}`);
    if (!validText(note)) throw new Error("text must be at most 20000 characters");
    if (!fleet.nodes.some(peer => peer.id === message.from && peer.address)) throw new Error("recipient needs a fleet address");
    queueReceipt(root, fleet, message, "done", note);
    await flushOutbox({ ...node, root, fleet });
    say(`done ${target}`);
    return 0;
  }
  if (verb === "show") {
    const message = findTalk(root, target);
    if (!message) throw new Error(`message not found: ${target}`);
    const issue = message.kind === "say" ? "" : ` issue=#${message.body.issue} epoch=${message.body.epoch}`;
    say(`${message.kind} from=${message.from}${issue}\n${message.body.text ?? message.body.note ?? ""}`);
    return 0;
  }
  const request = ["plan", "ask"].includes(verb);
  const direct = verb === "say";
  if (!request && !direct && readState(root, "node").leader !== true) throw new Error(`${verb} runs on the Leader only`);
  let recipient, body, kind, comment, queued;
  if (!request && !direct) {
    queued = readState(root, "queue").find(message => message.id === target && message.repo === repo && message.kind === (verb === "approve" ? "plan" : "question"));
    if (!queued) throw new Error(`${verb} request not found: ${target}`);
    const reason = requestError(queued, readState(root, "assignments"), fleet);
    if (reason) {
      writeState(root, "queue", readState(root, "queue").filter(message => message.id !== target));
      throw new Error(reason);
    }
  }
  const text = options["--file"] ? fileText(options["--file"]) : "";
  if (direct) {
    const peers = readState(root, "peers"), now = (node.clock ?? Date.now)();
    recipient = fleet.nodes.find(peer => peer.id !== fleet.self && peer.active !== false && peer.address && livePeer(peers[peer.id], now) &&
      (target === "leader" ? peers[peer.id].leader === true : peer.id === target));
    if (!recipient) throw new Error(`no live recipient heartbeat: ${target}`);
    if (sessionOf(peers[recipient.id], now) === "none") warn(`no session listens on ${recipient.id}`);
    kind = "say";
    body = { text };
  } else if (request) {
    const issue = Number(target), assignment = readState(root, "assignments")[`${repo}#${issue}`];
    const peers = readState(root, "peers");
    recipient = fleet.nodes.find(peer => peer.id !== fleet.self && peer.active !== false && peers[peer.id]?.leader === true);
    if (!recipient) throw new Error("no Leader heartbeat");
    kind = verb === "plan" ? "plan" : "question";
    body = { issue, epoch: assignment?.node === fleet.self ? assignment.epoch : 0, text };
    if (verb === "plan") comment = { role: "coder", kind, summary: "Plan for review", body: text };
  } else {
    recipient = fleet.nodes.find(peer => peer.id === queued.from);
    kind = verb;
    const { issue, epoch } = queued.body;
    body = verb === "approve" ? { issue, epoch, plan: target, approved: !options["--changes"], note: text }
      : { issue, epoch, question: target, text };
    comment = { role: "leader", kind, summary: verb === "approve" ? body.approved ? "Plan approved" : "Plan needs changes" : "Answer",
      body: verb === "answer" ? `${queued.body.text.split(/\r?\n/).map(line => `> ${line}`).join("\n")}\n\n${text}` : text };
  }
  if (!recipient?.address) throw new Error("recipient needs a fleet address");
  const message = createMessage({ from: fleet.self, repo, kind, body }, fleet.secret);
  if (request || direct) {
    recordSent(root, recipient.id, message);
    const { sig: _sig, time: _time, ...fields } = message;
    writeState(root, "outbox", [...readState(root, "outbox"), { node: recipient.id, message: fields, attempts: 0, nextAttempt: (node.clock ?? Date.now)() }]);
    await flushOutbox({ ...node, root, fleet });
  }
  if (comment) {
    const result = gh(["issue", "comment", String(body.issue), "--repo", repo, "--body", roleComment({ ...comment, node: fleet.self, ref: `#${body.issue}` }, { secret: fleet.secret })], { cwd: root });
    if (result == null) throw new Error("gh issue comment failed");
  }
  if (!request && !direct) {
    recordSent(root, recipient.id, message);
    await sendMessage({ ...node, root, fleet, node: recipient, message });
  }
  if (queued) {
    retainTalk(root, queued);
    writeState(root, "queue", readState(root, "queue").filter(message => message.id !== target));
  }
  say(`${kind} ${message.id}`);
  return 0;
}
