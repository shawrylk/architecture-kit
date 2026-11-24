import { readFileSync } from "node:fs";
import { createMessage } from "./fleet-message.mjs";
import { flushOutbox, sendMessage } from "./fleet-node.mjs";
import { readState, writeState } from "./fleet-state.mjs";
import { roleComment } from "./role-line.mjs";

export const TALK_VERBS = ["plan", "ask", "approve", "answer", "show"];
const validText = text => typeof text === "string" && text.length <= 20000;

function requestError(message, assignments) {
  const { issue, epoch, text } = message.body ?? {};
  if (!Number.isSafeInteger(issue) || issue <= 0 || !Number.isSafeInteger(epoch) || epoch <= 0 || !validText(text)) return "invalid request issue, epoch or text";
  const assignment = assignments[`${message.repo}#${issue}`];
  if (!assignment || assignment.node !== message.from || assignment.epoch !== epoch) return "request sender does not hold this issue at this assignment epoch";
  return null;
}

export function parseTalkArgs(verb, rest) {
  const [target, ...flags] = rest;
  if (!target || target.startsWith("--")) throw new Error(`${verb} needs an issue or message ID`);
  if (["plan", "ask"].includes(verb) && (!/^[1-9]\d*$/.test(target) || !Number.isSafeInteger(Number(target)))) throw new Error("issue must be a positive integer");
  const options = { verb, target };
  for (let i = 0; i < flags.length; i++) {
    const flag = flags[i];
    if (!(flag === "--file" && verb !== "show") && !(flag === "--changes" && verb === "approve")) throw new Error(`unknown argument ${flag}`);
    if (Object.hasOwn(options, flag)) throw new Error(`duplicate argument ${flag}`);
    if (flag === "--changes") options[flag] = true;
    else {
      if (!flags[i + 1] || flags[i + 1].startsWith("--")) throw new Error("--file needs a value");
      options[flag] = flags[++i];
    }
  }
  if (["plan", "ask", "answer"].includes(verb) && !options["--file"]) throw new Error(`${verb} needs --file`);
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
  const inbox = readState(root, "inbox");
  let changed = false, savedPlan = false, savedAnswer = false;
  for (const message of queue) {
    const request = leader && ["plan", "question"].includes(message.kind);
    const reply = !leader && ["approve", "answer"].includes(message.kind);
    if (!request && !reply) { kept.push(message); continue; }
    changed = true;
    const body = message.body ?? {}, { issue, epoch } = body;
    if (!Number.isSafeInteger(issue) || issue <= 0 || !Number.isSafeInteger(epoch) || epoch <= 0) continue;
    if (request ? requestError(message, assignments) : message.kind === "approve"
      ? typeof body.approved !== "boolean" || typeof body.plan !== "string" || !body.plan || !validText(body.note)
      : typeof body.question !== "string" || !body.question || !validText(body.text)) continue;
    const key = `${message.repo}#${issue}`, assignment = assignments[key];
    if (!assignment || assignment.node !== (request ? message.from : fleet.self) || assignment.epoch !== epoch) continue;
    if (reply && peers[message.from]?.leader !== true) {
      if (peers[message.from]?.leader !== false && now - Date.parse(message.time) < 600_000) kept.push(message);
      continue;
    }
    if (request) kept.push(message);
    else if (message.kind === "approve") { plans[key] = message; savedPlan = true; }
    else {
      Object.defineProperty(answers, body.question, { value: message, enumerable: true, writable: true, configurable: true });
      savedAnswer = true;
    }
    if (reply) inbox.push({ id: message.id, kind: message.kind, repo: message.repo, issue, time: message.time });
  }
  if (savedPlan) writeState(root, "plans", plans);
  if (savedAnswer) writeState(root, "answers", answers);
  if (savedPlan || savedAnswer) {
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

export async function runTalk(options, { root, fleet, repo, gh, say, node = {} }) {
  const { verb, target } = options;
  if (verb === "show") {
    const message = [...readState(root, "queue"), ...Object.values(readState(root, "plans")), ...Object.values(readState(root, "answers"))].find(message => message.id === target);
    if (!message) throw new Error(`message not found: ${target}`);
    say(`${message.kind} from=${message.from} issue=#${message.body.issue} epoch=${message.body.epoch}\n${message.body.text ?? message.body.note ?? ""}`);
    return 0;
  }
  const request = ["plan", "ask"].includes(verb);
  if (!request && readState(root, "node").leader !== true) throw new Error(`${verb} runs on the Leader only`);
  let recipient, body, kind, comment, queued;
  if (!request) {
    queued = readState(root, "queue").find(message => message.id === target && message.repo === repo && message.kind === (verb === "approve" ? "plan" : "question"));
    if (!queued) throw new Error(`${verb} request not found: ${target}`);
    const reason = requestError(queued, readState(root, "assignments"));
    if (reason) {
      writeState(root, "queue", readState(root, "queue").filter(message => message.id !== target));
      throw new Error(reason);
    }
  }
  const text = options["--file"] ? fileText(options["--file"]) : "";
  if (request) {
    const issue = Number(target), assignment = readState(root, "assignments")[`${repo}#${issue}`];
    if (!assignment || assignment.node !== fleet.self) throw new Error(`this node does not hold #${issue}`);
    const peers = readState(root, "peers");
    recipient = fleet.nodes.find(peer => peer.id !== fleet.self && peer.active !== false && peers[peer.id]?.leader === true);
    if (!recipient) throw new Error("no Leader heartbeat");
    kind = verb === "plan" ? "plan" : "question";
    body = { issue, epoch: assignment.epoch, text };
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
  if (request) {
    const { sig: _sig, time: _time, ...fields } = message;
    writeState(root, "outbox", [...readState(root, "outbox"), { node: recipient.id, message: fields, attempts: 0, nextAttempt: (node.clock ?? Date.now)() }]);
    await flushOutbox({ ...node, root, fleet });
  }
  if (comment) {
    const result = gh(["issue", "comment", String(body.issue), "--repo", repo, "--body", roleComment({ ...comment, node: fleet.self, ref: `#${body.issue}` }, { secret: fleet.secret })], { cwd: root });
    if (result == null) throw new Error("gh issue comment failed");
  }
  if (!request) await sendMessage({ ...node, root, fleet, node: recipient, message });
  if (queued) writeState(root, "queue", readState(root, "queue").filter(message => message.id !== target));
  say(`${kind} ${message.id}`);
  return 0;
}
