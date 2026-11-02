#!/usr/bin/env node
// Trigger: surface GitHub comments and keep their acknowledgments in a session ledger.
import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../config.mjs";
import { PARSERS, programName } from "./bash-command-guard.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { commonDirOf } from "./ledger.mjs";
import { originOf } from "./git-read.mjs";
import { ghCalls, ghCommand, ghMerges } from "./gh-merge-command.mjs";
import { runGh } from "./gh-run.mjs";
import { commandWords } from "./shell-command.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const itemKey = ({ repo, number }) => `${repo.toLowerCase()}#${number}`;
const itemUrl = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)/g;
const verbs = new Set(["create", "comment", "view", "close", "merge"]);

// Fragment: extract issue references from a body or a commit message.
function references(body, repo, add, linked = false) {
  for (const match of body.matchAll(itemUrl)) add(match[1], Number(match[3]));
  if (linked) for (const match of body.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) add(match[1], Number(match[2]));
  if (linked) {
    for (const match of body.matchAll(/(?<![\w/])#(\d+)\b/g)) add(repo, Number(match[1]));
  } else {
    for (const match of body.matchAll(/\b(?:fixes|refs)\s+([^\r\n]*)/gi)) references(match[1], repo, add, true);
  }
}

// Fragment: read a command's body flags without running the shell.
function fields(args, cwd) {
  const result = { selector: null, repo: null, body: "" };
  const values = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-m", "--message", "--title", "-t", "--base", "-B", "--head", "-H", "--json", "--jq", "--template"]);
  for (let i = 0; i < args.length; i++) {
    const attached = /^-([bmF])(.+)$/s.exec(args[i]);
    const [flag, ...tail] = attached ? [`-${attached[1]}`, attached[2]] : args[i].split("=");
    if (values.has(flag)) {
      const value = tail.length ? tail.join("=") : args[++i];
      if (flag === "-R" || flag === "--repo") result.repo = value;
      if (["-b", "--body", "-m", "--message"].includes(flag)) result.body += `\n${value ?? ""}`;
      if (["-F", "--body-file"].includes(flag) && value && value !== "-") {
        result.body += `\n${readFileSync(path.resolve(cwd, value), "utf8")}`;
      }
    } else if (/^-R.+/.test(flag)) result.repo = flag.slice(2).replace(/^=/, "");
    else if (!flag.startsWith("-") && result.selector === null) result.selector = args[i];
  }
  return result;
}

export function watchedItems(call, origin, parse = PARSERS[call.tool_name]) {
  const items = new Map();
  const add = (repo, number) => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !Number.isSafeInteger(number) || number < 1) return;
    const item = { repo: repo.toLowerCase(), number };
    items.set(itemKey(item), item);
  };
  const command = call.tool_input?.command ?? "";
  for (const { words, env } of ghCalls(command, parse)) {
    const { group, verb, args, repo } = ghCommand(words);
    if (!["issue", "pr"].includes(group) || !verbs.has(verb)) continue;
    const found = fields(args, call.cwd ?? process.cwd());
    const repository = found.repo ?? repo ?? env.GH_REPO ?? origin;
    if (/^\d+$/.test(found.selector ?? "")) add(repository, Number(found.selector));
    references(found.selector ?? "", repository, add);
    references(found.body, repository, add);
  }
  for (const segment of parse(command)) {
    const [program, verb, ...args] = commandWords(segment);
    if (programName(program) === "git") {
      const words = [verb, ...args];
      const commit = words.indexOf("commit");
      if (commit !== -1) references(fields(words.slice(commit + 1), call.cwd ?? process.cwd()).body, origin, add);
    }
  }
  const output = typeof call.tool_response === "string" ? call.tool_response : JSON.stringify(call.tool_response ?? "");
  if (ghCalls(command, parse).length) references(output, origin, add);
  return [...items.values()];
}

// Resource: append records so simultaneous hooks preserve each other's watches and acknowledgments.
function ledger(root, session) {
  if (!session) return null;
  const common = commonDirOf(root);
  if (!common) return null;
  const file = path.join(common, "qc", `comment-watch-${hash(session)}.jsonl`);
  const items = new Map();
  let next = null;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.next) { next = record.next; continue; }
        const key = itemKey(record);
        const item = items.get(key) ?? { repo: record.repo, number: record.number, seen: new Set() };
        for (const stamp of record.seen ?? []) item.seen.add(stamp);
        items.set(key, item);
      } catch { /* A torn record leaves earlier acknowledgments intact. */ }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { items, next, append(record) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n${JSON.stringify(record)}\n`);
  } };
}

// Resource: bound all gh processes in one invocation to a shared deadline.
function github(root, config, deadline, run) {
  const logins = new Map();
  return (repo, args) => {
    const dir = Object.entries(config.github?.configDirs ?? {}).find(([owner]) => owner.toLowerCase() === repo.split("/")[0].toLowerCase())?.[1];
    if (args[0] === "api" && args[1] === "user" && logins.has(dir)) return logins.get(dir);
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("deadline");
    const text = run(args, { cwd: root, env: { GH_CONFIG_DIR: dir ?? "", GH_PROMPT_DISABLED: "1" }, timeoutMs });
    if (text === null) throw new Error("gh");
    const result = JSON.parse(text);
    if (args[0] === "api" && args[1] === "user") logins.set(dir, result);
    return result;
  };
}

function comments(item, gh) {
  const prefix = `repos/${item.repo}`;
  const issue = gh(item.repo, ["api", `${prefix}/issues/${item.number}`]);
  const list = (endpoint) => {
    const pages = gh(item.repo, ["api", "--paginate", "--slurp", `${prefix}/${endpoint}?per_page=100`]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("pages");
    return pages.flat();
  };
  const rows = list(`issues/${item.number}/comments`);
  if (issue.pull_request) rows.push(...list(`pulls/${item.number}/reviews`), ...list(`pulls/${item.number}/comments`));
  return rows;
}

function unseen(item, gh) {
  const login = gh(item.repo, ["api", "user"]).login;
  if (typeof login !== "string" || !login) throw new Error("login");
  return comments(item, gh).filter((row) => row.user?.login?.toLowerCase() !== login.toLowerCase() && (row.body?.trim() || row.state))
    .map((row) => ({ row, stamp: hash(JSON.stringify([row.html_url, row.id, row.updated_at ?? row.submitted_at ?? row.created_at, row.body, row.state])) }))
    .filter(({ stamp }) => !item.seen?.has(stamp));
}

const describe = (item, row) => `@${row.user?.login ?? "unknown"} on ${itemKey(item)} ${row.html_url}: ${[row.state, row.body].filter(Boolean).join(" ").replace(/\s+/g, " ").trim().slice(0, 700)}`;
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

export function commentWatch(call, { gh: run = runGh } = {}) {
  const root = checkoutRootOf(call.cwd ?? process.cwd());
  if (!root || !call.session_id) return null;
  const event = call.hook_event_name;
  try {
    const config = load(root);
    if (config.commentWatch === false) return null;
    const state = ledger(root, call.session_id);
    if (!state) return null;
    const deadline = Date.now() + 3500;
    const gh = github(root, config, deadline, run);
    if (event === "PostToolUse") {
      const parse = PARSERS[call.tool_name];
      if (!parse) return null;
      const origin = originOf(root, 1000);
      for (const item of watchedItems(call, origin, parse)) state.append(item);
      for (const { words, env } of ghCalls(call.tool_input?.command ?? "", parse)) {
        const command = ghCommand(words);
        if (command.group !== "pr" || !verbs.has(command.verb)) continue;
        const found = fields(command.args, root);
        const created = command.verb === "create" ? [...JSON.stringify(call.tool_response ?? "").matchAll(itemUrl)].find(match => match[2] === "pull") : null;
        if (command.verb === "create" && !created) continue;
        const repo = created?.[1] ?? found.repo ?? command.repo ?? env.GH_REPO ?? origin;
        if (!repo) continue;
        const selector = created?.[3] ?? found.selector;
        const pr = gh(repo, ["pr", "view", ...(selector ? [selector] : []), "-R", repo, "--json", "number,body"]);
        state.append({ repo, number: pr.number });
        references(pr.body ?? "", repo, (repo, number) => state.append({ repo, number }), true);
      }
      return null;
    }
    if (event === "UserPromptSubmit" || event === "Stop") {
      const lines = [];
      const items = [...state.items.values()];
      const start = Math.max(0, items.findIndex(item => itemKey(item) === state.next));
      for (let i = 0; i < items.length; i++) {
        const item = items[(start + i) % items.length];
        try {
          const fresh = unseen(item, gh);
          lines.push(...fresh.map(({ row }) => describe(item, row)));
          if (fresh.length && event === "UserPromptSubmit") state.append({ repo: item.repo, number: item.number, lastSeen: new Date().toISOString(), seen: fresh.map(({ stamp }) => stamp) });
        } catch { lines.push(`Comment watch: GitHub comments for ${itemKey(item)} could not be checked; retry on the next prompt.`); }
        if (Date.now() >= deadline) {
          state.append({ next: itemKey(items[(start + i + 1) % items.length]) });
          if (i + 1 < items.length) lines.push("Comment watch: the time budget expired; remaining items continue on the next prompt.");
          break;
        }
      }
      return lines.length ? (event === "Stop" ? { systemMessage: lines.join("\n") } : context(event, lines.join("\n"))) : null;
    }
    if (event === "PreToolUse") {
      const parse = PARSERS[call.tool_name];
      if (!parse) return null;
      const merges = ghMerges(call.tool_input?.command ?? "", parse);
      if (!merges.length) return null;
      const origin = originOf(root, 1000);
      const lines = [];
      let failed = false;
      for (const merge of merges) {
        const repo = merge.repo ?? origin;
        if (!repo) throw new Error("repository");
        const pr = gh(repo, ["pr", "view", ...(merge.selector ? [merge.selector] : []), "-R", repo, "--json", "number,body"]);
        const targets = new Map();
        const add = (repo, number) => targets.set(itemKey({ repo, number }), { repo: repo.toLowerCase(), number });
        add(repo, pr.number);
        references(pr.body ?? "", repo, add, true);
        for (const target of targets.values()) {
          state.append(target);
          const item = state.items.get(itemKey(target)) ?? target;
          try { lines.push(...unseen(item, gh).map(({ row }) => describe(item, row))); }
          catch { failed = true; lines.push(`GitHub comments for ${itemKey(target)} could not be checked.`); }
        }
      }
      if (lines.length || failed) return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: `Merge guard: read these unseen GitHub comments on the next prompt before merging. Retry any failed checks.\n${lines.join("\n")}` } };
    }
    return null;
  } catch {
    const note = "Comment watch: GitHub comments could not be checked; retry on the next prompt.";
    if (event === "PreToolUse") return { hookSpecificOutput: { hookEventName: event, permissionDecision: "deny", permissionDecisionReason: "Merge guard: GitHub comments could not be checked. Retry before merging." } };
    return ["UserPromptSubmit", "PreToolUse"].includes(event) ? context(event, note) : { systemMessage: note };
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try { const result = commentWatch(JSON.parse(input)); if (result) process.stdout.write(`${JSON.stringify(result)}\n`); } catch { /* Ignore non-hook input. */ }
}
