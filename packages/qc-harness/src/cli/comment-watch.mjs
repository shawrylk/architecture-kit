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
import { runGhAsync } from "./gh-run.mjs";
import { commandWords } from "./shell-command.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const itemKey = ({ repo, number }) => `${repo.toLowerCase()}#${number}`;
const itemUrl = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)/g;

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
    const cluster = /^-[a-zA-Z]*m$/.test(args[i]) && !args[i].startsWith("--");
    const attached = /^-([bmF])(.+)$/s.exec(args[i]);
    const [flag, ...tail] = cluster ? ["-m"] : attached ? [`-${attached[1]}`, attached[2]] : args[i].split("=");
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
  const add = (repo, number, kind = "issue") => {
    if (!/^[\w.-]+\/[\w.-]+$/.test(repo ?? "") || !Number.isSafeInteger(number) || number < 1) return;
    const item = { repo: repo.toLowerCase(), number, kind };
    if (items.get(itemKey(item))?.kind === "pr") item.kind = "pr";
    items.set(itemKey(item), item);
  };
  const command = call.tool_input?.command ?? "";
  for (const { words, env } of ghCalls(command, parse)) {
    const { group, verb, args, repo } = ghCommand(words);
    if (!["issue", "pr"].includes(group)) continue;
    const found = fields(args, call.cwd ?? process.cwd());
    const repository = found.repo ?? repo ?? env.GH_REPO ?? origin;
    if (/^\d+$/.test(found.selector ?? "")) add(repository, Number(found.selector), group);
    for (const match of (found.selector ?? "").matchAll(itemUrl)) add(match[1], Number(match[3]), match[2] === "pull" ? "pr" : "issue");
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
  if (ghCalls(command, parse).length) for (const match of output.matchAll(itemUrl)) add(match[1], Number(match[3]), match[2] === "pull" ? "pr" : "issue");
  return [...items.values()];
}

// Resource: append records so simultaneous hooks preserve each other's watches and acknowledgments.
function ledger(root, session) {
  if (!session) return null;
  const common = commonDirOf(root);
  if (!common) return null;
  const file = path.join(common, "qc", `comment-watch-${hash(session)}.jsonl`);
  const items = new Map();
  const own = new Set();
  let next = null;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.own) { for (const url of record.own) own.add(url); continue; }
        if (record.next) { next = record.next; continue; }
        const key = itemKey(record);
        const item = items.get(key) ?? { repo: record.repo, number: record.number, seen: new Set(), pending: new Map(), prs: new Set() };
        if (record.kind) item.kind = record.kind;
        for (const pr of record.prs ?? []) item.prs.add(pr);
        for (const pending of record.pending ?? []) item.pending.set(pending.stamp, pending);
        for (const stamp of record.seen ?? []) item.seen.add(stamp);
        items.set(key, item);
      } catch { /* A torn record leaves earlier acknowledgments intact. */ }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { items, own, next, append(record) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n${JSON.stringify(record)}\n`);
  } };
}

// Resource: bound all gh processes in one invocation to a shared deadline.
function github(root, config, deadline, run) {
  return async (repo, args) => {
    const dir = Object.entries(config.github?.configDirs ?? {}).find(([owner]) => owner.toLowerCase() === repo.split("/")[0].toLowerCase())?.[1];
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("deadline");
    const text = await run(args, { cwd: root, env: { GH_CONFIG_DIR: dir ?? "", GH_PROMPT_DISABLED: "1" }, timeoutMs });
    if (text === null) throw new Error("gh");
    const result = JSON.parse(text);
    return result;
  };
}

async function comments(item, gh) {
  const prefix = `repos/${item.repo}`;
  const list = async (endpoint) => {
    const pages = await gh(item.repo, ["api", "--paginate", "--slurp", `${prefix}/${endpoint}?per_page=100`]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("pages");
    return pages.flat().map(row => ({ ...row, endpoint: `${prefix}/${endpoint}` }));
  };
  const endpoints = [`issues/${item.number}/comments`];
  if (item.kind === "pr") endpoints.push(`pulls/${item.number}/reviews`, `pulls/${item.number}/comments`);
  return (await Promise.all(endpoints.map(list))).flat();
}

async function unseen(item, gh, own) {
  return (await comments(item, gh)).filter((row) => !own.has(row.html_url) && !own.has(row.url) && !own.has(`${row.endpoint}:${row.id}`) && (row.body?.trim() || row.state))
    .map((row) => ({ row, stamp: hash(JSON.stringify([row.html_url, row.id, row.updated_at ?? row.submitted_at ?? row.created_at, row.body, row.state])) }))
    .filter(({ stamp }) => !item.seen?.has(stamp));
}

const bodyOf = (row) => [row.state, row.body].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
const truncated = (row) => bodyOf(row).length > 700;
const describe = (item, row) => `@${row.user?.login ?? "unknown"} on ${itemKey(item)} ${row.html_url}: ${bodyOf(row).slice(0, 700)}${truncated(row) ? ` [truncated; read in full: gh ${item.kind === "pr" ? "pr" : "issue"} view ${item.number} -R ${item.repo} --comments${row.endpoint.includes("/pulls/") ? `; gh api ${row.endpoint} --paginate` : ""}]` : ""}`;
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

// Ledger: retain truncated previews so a full read can acknowledge them from any hook.
function recordPreview(state, item, fresh, acknowledge = false) {
  const seen = acknowledge ? fresh.filter(({ row }) => !truncated(row)).map(({ stamp }) => stamp) : [];
  const pending = fresh.filter(({ row }) => truncated(row)).map(({ row, stamp }) => ({ stamp, id: row.id, endpoint: row.endpoint, url: row.url }));
  if (seen.length || pending.length) state.append({ repo: item.repo, number: item.number, seen, pending });
}

// Ledger: acknowledge only pending comments covered by a successful full read.
function acknowledge(state, command, repo, number) {
  const args = command.args;
  const view = ["pr", "issue"].includes(command.group) && command.verb === "view" && args.includes("--comments");
  const request = apiRequest(command);
  const endpoint = request?.method === "GET" ? request.endpoint : null;
  for (const item of state.items.values()) {
    const seen = [...item.pending.values()].filter(pending => !item.seen.has(pending.stamp) && (
      (view && item.repo.toLowerCase() === repo?.toLowerCase() && item.number === number &&
        (command.group === "pr" || !pending.endpoint.includes("/pulls/"))) ||
      (endpoint && (endpoint === pending.endpoint || endpoint === pending.url?.replace(/^https:\/\/api.github.com\//, "") ||
        endpoint === pending.endpoint.replace(/\/(comments|reviews)$/, "") ||
        endpoint === (pending.endpoint.endsWith("/reviews") ? `${pending.endpoint}/${pending.id}` : pending.endpoint.replace(/\/\d+\/comments$/, `/comments/${pending.id}`))))
    )).map(pending => pending.stamp);
    if (seen.length) state.append({ repo: item.repo, number: item.number, seen });
  }
}

// Fragment: identify a REST request and distinguish full reads from session writes.
function apiRequest(command) {
  if (command.group !== "api") return null;
  const apiWords = [command.verb, ...command.args];
  let method;
  let write = false;
  let endpoint;
  const values = new Set(["--method", "--field", "--raw-field", "--input", "--header", "--hostname", "--jq", "--template", "--cache", "--preview"]);
  for (let i = 0; i < apiWords.length; i++) {
    const word = apiWords[i];
    const long = /^(--[^=]+)(?:=(.*))?$/.exec(word);
    if (long && values.has(long[1])) {
      const value = long[2] ?? apiWords[++i];
      if (long[1] === "--method") method = value;
      if (["--field", "--raw-field", "--input"].includes(long[1])) write = true;
      continue;
    }
    if (/^-[^-]/.test(word)) {
      const valueFlag = /[FfHXqtp]/.exec(word.slice(1));
      if (valueFlag) {
        const value = word.slice(valueFlag.index + 2).replace(/^=/, "") || apiWords[++i];
        if (valueFlag[0] === "X") method = value;
        if (/[fF]/.test(valueFlag[0])) write = true;
      }
      continue;
    }
    if (/^(?:https:\/\/api.github.com\/)?\/?repos\//.test(word)) endpoint ??= word.replace(/^https:\/\/api.github.com\//, "").replace(/^\//, "").split("?")[0].replace(/^repos\/([^/]+\/[^/]+)/, match => match.toLowerCase());
  }
  return { endpoint, method: method ?? (write ? "POST" : "GET") };
}

// Fragment: keep the URLs returned by session writes, without using the account login.
function createdKeys(response, endpoint) {
  if (typeof response === "string") {
    try { return createdKeys(JSON.parse(response), endpoint); } catch { /* gh also prints plain URLs. */ }
    return [...response.matchAll(/https:\/\/[^\s"'<>\\]+/g)].map(match => match[0]);
  }
  if (Array.isArray(response)) return response.flatMap(row => createdKeys(row, endpoint));
  if (!response || typeof response !== "object") return [];
  return [response.html_url, response.url, endpoint && response.id ? `${endpoint}:${response.id}` : null,
    ...createdKeys(response.stdout ?? response.output ?? response.content ?? response.text, endpoint)].filter(Boolean);
}

export async function commentWatch(call, { gh: run = runGhAsync, merges: mergeTargets } = {}) {
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
      if (call.tool_response?.is_error || call.tool_response?.exit_code > 0) return null;
      const watched = watchedItems(call, origin, parse);
      const prs = [...state.items.values(), ...watched].filter(item => item.kind === "pr");
      for (const item of watched) state.append({ ...item, prs: prs.filter(pr => pr.repo === item.repo).map(itemKey) });
      for (const { words, env } of ghCalls(call.tool_input?.command ?? "", parse)) {
        const command = ghCommand(words);
        const request = apiRequest(command);
        if (request?.method === "POST" && /^repos\/[^/]+\/[^/]+\/(?:issues(?:\/\d+\/comments)?|pulls(?:\/\d+\/(?:comments|reviews))?)$/.test(request.endpoint ?? "")) {
          state.append({ own: createdKeys(call.tool_response, request.endpoint) });
        }
        const found = fields(command.args, root);
        const created = command.verb === "create" ? [...JSON.stringify(call.tool_response ?? "").matchAll(itemUrl)].find(match => match[2] === "pull") : null;
        let repo = created?.[1] ?? [...(found.selector ?? "").matchAll(itemUrl)][0]?.[1] ?? found.repo ?? command.repo ?? env.GH_REPO ?? origin;
        if (["pr", "issue"].includes(command.group) && ["create", "comment", "review"].includes(command.verb)) {
          state.append({ own: createdKeys(call.tool_response) });
        }
        if (!repo) continue;
        const selector = created?.[3] ?? found.selector;
        let number = /^\d+$/.test(selector ?? "") ? Number(selector) : Number([...(selector ?? "").matchAll(itemUrl)][0]?.[3]);
        if (command.group === "pr" && !["list", "status"].includes(command.verb) && (command.verb !== "create" || created)) {
          const pr = await gh(repo, ["pr", "view", ...(selector ? [selector] : []), "-R", repo, "--json", "number,body"]);
          number = pr.number;
          const key = itemKey({ repo, number });
          state.append({ repo, number, kind: "pr" });
          references(pr.body ?? "", repo, (repo, number) => state.append({ repo, number, kind: "issue", prs: [key] }), true);
        }
        if (Number.isSafeInteger(number) && ["create", "comment", "review"].includes(command.verb)) {
          const resource = command.verb === "review" ? `pulls/${number}/reviews` : `issues/${number}/comments`;
          state.append({ own: createdKeys(call.tool_response, `repos/${repo.toLowerCase()}/${resource}`) });
        }
        acknowledge(state, command, repo, number);
      }
      return null;
    }
    if (event === "UserPromptSubmit" || event === "Stop") {
      const lines = [];
      const items = [...state.items.values()];
      const start = Math.max(0, items.findIndex(item => itemKey(item) === state.next));
      await Promise.all(items.map(async (_, i) => {
        const item = items[(start + i) % items.length];
        try {
          const fresh = await unseen(item, gh, state.own);
          lines.push(...fresh.map(({ row }) => describe(item, row)));
          recordPreview(state, item, fresh, event === "UserPromptSubmit");
        } catch { lines.push(`Comment watch: GitHub comments for ${itemKey(item)} could not be checked; retry on the next prompt.`); }
      }));
      return lines.length ? (event === "Stop" ? { systemMessage: lines.join("\n") } : context(event, lines.join("\n"))) : null;
    }
    if (event === "PreToolUse") {
      const parse = PARSERS[call.tool_name];
      if (!parse) return null;
      const merges = mergeTargets ?? ghMerges(call.tool_input?.command ?? "", parse);
      if (!merges.length) return null;
      const origin = originOf(root, 1000);
      const lines = [];
      let failed = false;
      for (const merge of merges) {
        let repo = merge.repo ?? origin;
        let selector = merge.selector;
        if (merge.nodeId) {
          const result = await gh(repo ?? "", ["api", "graphql", "-f", `query=query { node(id: ${JSON.stringify(merge.nodeId)}) { ... on PullRequest { number repository { nameWithOwner } } } }`]);
          repo = result.data?.node?.repository?.nameWithOwner;
          selector = String(result.data?.node?.number ?? "");
        }
        if (!repo) throw new Error("repository");
        const pr = await gh(repo, ["pr", "view", ...(selector ? [selector] : []), "-R", repo, "--json", "number,body,commits"]);
        const targets = new Map();
        const key = itemKey({ repo, number: pr.number });
        const add = (repo, number, kind = "issue") => targets.set(itemKey({ repo, number }), { repo: repo.toLowerCase(), number, kind, prs: [key] });
        references(pr.body ?? "", repo, add, true);
        for (const commit of pr.commits ?? []) references(`${commit.messageHeadline ?? ""}\n${commit.messageBody ?? ""}`, repo, add);
        for (const item of state.items.values()) {
          if (item.prs.has(key) || (item.kind !== "pr" && !item.prs.size && item.repo === repo.toLowerCase())) add(item.repo, item.number, item.kind);
        }
        add(repo, pr.number, "pr");
        await Promise.all([...targets.values()].map(async target => {
          state.append(target);
          const item = { ...state.items.get(itemKey(target)), ...target };
          try {
            const fresh = await unseen(item, gh, state.own);
            recordPreview(state, item, fresh);
            lines.push(...fresh.map(({ row }) => describe(item, row)));
          }
          catch { failed = true; lines.push(`GitHub comments for ${itemKey(target)} could not be checked.`); }
        }));
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
  try { const result = await commentWatch(JSON.parse(input)); if (result) process.stdout.write(`${JSON.stringify(result)}\n`); } catch { /* Ignore non-hook input. */ }
}
