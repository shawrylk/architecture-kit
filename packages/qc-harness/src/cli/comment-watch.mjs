#!/usr/bin/env node
// Trigger: surface GitHub comments and keep their acknowledgments in a session ledger.
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../config.mjs";
import { PARSERS, programName } from "./bash-command-guard.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { commonDirOf } from "./ledger.mjs";
import { originOf } from "./git-read.mjs";
import { ghCalls, ghCommand, ghMerges } from "./gh-merge-command.mjs";
import { expandHome, parsePages } from "./gh-run.mjs";
import { commandWords } from "./shell-command.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
const itemKey = ({ repo, number }) => `${repo.toLowerCase()}#${number}`;
const itemUrl = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/(issues|pull)\/(\d+)/g;

// GitHub links no reference inside code, so a hex colour such as `#128282` names no issue.
const withoutCode = (body) => body.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "").replace(/(`+)[^`]*?\1/g, "");

// Fragment: extract issue references from a body or a commit message.
function references(body, repo, add, linked = false) {
  body = withoutCode(body);
  for (const match of body.matchAll(itemUrl)) add(match[1], Number(match[3]));
  if (linked) for (const match of body.matchAll(/\b([\w.-]+\/[\w.-]+)#(\d+)\b/g)) add(match[1], Number(match[2]));
  if (linked) {
    for (const match of body.matchAll(/(?<![\w/])#(\d+)\b/g)) add(repo, Number(match[1]));
  } else {
    for (const match of body.matchAll(/\b(?:fixes|refs)\s+([^\r\n]*)/gi)) references(match[1], repo, add, true);
  }
}

// Fragment: read a command's body flags without running the shell.
function fields(args, cwd, review = false) {
  const result = { selector: null, repo: null, body: "", state: "COMMENTED" };
  args = [...args];
  const values = new Set(["-R", "--repo", "-b", "--body", "-F", "--body-file", "-m", "--message", "--title", "-t", "--base", "-B", "--head", "-H", "--json", "--jq", "--template"]);
  for (let i = 0; i < args.length; i++) {
    if (/^-[a-zA-Z]/.test(args[i])) {
      const token = args[i];
      const flags = [];
      for (let j = 1; j < token.length; j++) {
        const flag = `-${token[j]}`;
        if (values.has(flag)) {
          flags.push(`-${token.slice(j)}`);
          break;
        }
        flags.push(flag);
      }
      args.splice(i, 1, ...flags);
    }
    const attached = /^-([bmF])(.+)$/s.exec(args[i]);
    const [flag, ...tail] = attached ? [`-${attached[1]}`, attached[2].replace(/^=/, "")] : args[i].split("=");
    if (review) {
      if (["-a", "--approve"].includes(flag)) result.state = "APPROVED";
      if (["-r", "--request-changes"].includes(flag)) result.state = "CHANGES_REQUESTED";
      if (["-c", "--comment"].includes(flag)) result.state = "COMMENTED";
    }
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
    const parsed = { ...ghCommand(words), env };
    const { group, verb, args, repo } = parsed;
    if (group === "api") {
      const match = /^repos\/([^/]+\/[^/]+)\/(issues|pulls)\/(\d+)(?:\/|$)/.exec(apiRequest(parsed)?.endpoint ?? "");
      if (match) add(match[1], Number(match[3]), match[2] === "pulls" ? "pr" : "issue");
    }
    if (!["issue", "pr"].includes(group)) continue;
    const found = fields(args, call.cwd ?? process.cwd(), group === "pr" && verb === "review");
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

// Ledger: a named command reactivates a retired item without invalidating active watches.
function watch(state, item) {
  state.append({ ...item, retired: false, ...(state.items.get(itemKey(item))?.retired ? { updatedAt: null } : {}) });
}

// Resource: append records so simultaneous hooks preserve each other's watches and acknowledgments.
function ledger(root, session) {
  if (!session) return null;
  const common = commonDirOf(root);
  if (!common) return null;
  const file = path.join(common, "qc", `comment-watch-${hash(session)}.jsonl`);
  const items = new Map();
  const own = new Set();
  const reviews = new Map();
  const starts = new Map();
  let next = null;
  try {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      try {
        const record = JSON.parse(line);
        if (record.reviewStart) { starts.set(record.reviewStart, record.start); continue; }
        if (record.review) { reviews.set(record.review.key, record.review); continue; }
        if (record.reviewDone) { reviews.delete(record.reviewDone); continue; }
        if (record.own) { for (const url of record.own) own.add(url); continue; }
        if (record.next) { next = record.next; continue; }
        if (typeof record.retired === "string") { const item = items.get(record.retired); if (item) item.retired = true; continue; }
        const key = itemKey(record);
        const item = items.get(key) ?? { repo: record.repo, number: record.number, seen: new Set(), shown: new Set(), polled: new Set(), pending: new Map(), prs: new Set() };
        if (record.kind) item.kind = record.kind;
        if (record.retired === false) item.retired = false;
        if (record.updatedAt !== undefined) item.updatedAt = record.updatedAt;
        for (const pr of record.prs ?? []) item.prs.add(pr);
        for (const pending of record.pending ?? []) item.pending.set(pending.stamp, pending);
        for (const stamp of record.seen ?? []) item.seen.add(stamp);
        for (const stamp of record.shown ?? []) item.shown.add(stamp);
        for (const stamp of record.polled ?? []) item.polled.add(stamp);
        items.set(key, item);
      } catch { /* A torn record leaves earlier acknowledgments intact. */ }
    }
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return { items, own, reviews, starts, next, append(record) {
    mkdirSync(path.dirname(file), { recursive: true });
    appendFileSync(file, `\n${JSON.stringify(record)}\n`);
  } };
}

const rateLimited = (error) => /rate.?limit|RATE_LIMITED/i.test(String(error));
const failureReason = (error) => rateLimited(error) ? "rate limit" : ["deadline", "pages", "response"].includes(error.message) ? error.message : "gh";

// Resource: retain only a safe failure category from gh stderr.
function runCommentGh(args, { cwd, env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    execFile("gh", args, { cwd, env: { ...process.env, ...env }, encoding: "utf8", windowsHide: true,
      timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) reject(new Error(rateLimited(stderr) ? "rate limit" : error.killed ? "deadline" : "gh"));
      else resolve(stdout);
    });
  });
}

// Resource: bound all gh processes in one invocation to a shared deadline.
function github(root, config, deadline, run) {
  return async (repo, args) => {
    const dir = Object.entries(config.github?.configDirs ?? {}).find(([owner]) => owner.toLowerCase() === repo.split("/")[0].toLowerCase())?.[1];
    const env = expandHome({ GH_PROMPT_DISABLED: "1", ...(dir ? { GH_CONFIG_DIR: dir } : {}) });
    if (env.GH_CONFIG_DIR && !existsSync(path.resolve(root, env.GH_CONFIG_DIR))) delete env.GH_CONFIG_DIR;
    const timeoutMs = deadline - Date.now();
    if (timeoutMs <= 0) throw new Error("deadline");
    const text = await run(args, { cwd: root, env, timeoutMs });
    if (text === null) throw new Error("gh");
    const result = args.includes("--paginate") ? parsePages(text) : JSON.parse(text);
    if (result === null) throw new Error("pages");
    return result;
  };
}

async function comments(item, gh) {
  const prefix = `repos/${item.repo}`;
  const list = async (endpoint) => {
    const pages = await gh(item.repo, ["api", "--paginate", `${prefix}/${endpoint}?per_page=100`]);
    if (!Array.isArray(pages) || !pages.every(Array.isArray)) throw new Error("pages");
    return pages.flat().map(row => ({ ...row, endpoint: `${prefix}/${endpoint}` }));
  };
  const endpoints = [`issues/${item.number}/comments`];
  if (item.kind === "pr") endpoints.push(`pulls/${item.number}/reviews`, `pulls/${item.number}/comments`);
  return (await Promise.all(endpoints.map(list))).flat();
}

// Fragment: ask for every watched item's metadata in one request per repository.
async function itemMetadata(repo, items, gh) {
  const [owner, name] = repo.split("/");
  const fields = items.map(item => `item_${item.number}: issueOrPullRequest(number: ${item.number}) { __typename ... on Issue { state updatedAt } ... on PullRequest { state updatedAt } }`).join(" ");
  const result = await gh(repo, ["api", "graphql", "-f", `owner=${owner}`, "-f", `name=${name}`,
    "-f", `query=query($owner: String!, $name: String!) { repository(owner: $owner, name: $name) { ${fields} } }`]);
  if (result.errors?.length) throw new Error(result.errors.some(error => rateLimited(`${error.type} ${error.message}`)) ? "rate limit" : "response");
  if (!result.data?.repository) throw new Error("response");
  return result.data.repository;
}

async function unseen(item, gh, state) {
  const rows = await comments(item, gh);
  for (const marker of state.reviews.values()) {
    if (itemKey(marker) !== itemKey(item)) continue;
    const row = rows.filter(row => row.endpoint.endsWith("/reviews") &&
      !state.own.has(`${row.endpoint}:${row.id}`) && Date.parse(row.submitted_at) >= Date.parse(marker.start) &&
      (marker.empty ? row.state === marker.state : hash(row.body ?? "") === marker.bodyHash))
      .sort((a, b) => Date.parse(a.submitted_at) - Date.parse(b.submitted_at) || a.id - b.id)[0];
    if (!row) continue;
    const key = `${row.endpoint}:${row.id}`;
    state.append({ own: [key] });
    state.own.add(key);
    state.append({ reviewDone: marker.key });
    state.reviews.delete(marker.key);
  }
  return rows.filter((row) => !state.own.has(row.html_url) && !state.own.has(row.url) && !state.own.has(`${row.endpoint}:${row.id}`) && (row.body?.trim() || row.state))
    .map((row) => ({ row, stamp: hash(JSON.stringify([row.html_url, row.id, row.updated_at ?? row.submitted_at ?? row.created_at, row.body, row.state])) }))
    .filter(({ stamp }) => !item.seen?.has(stamp));
}

const bodyOf = (row) => [row.state, row.body].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
const truncated = (row) => bodyOf(row).length > 700;
const describe = (item, row) => `@${row.user?.login ?? "unknown"} on ${itemKey(item)} ${row.html_url}: ${bodyOf(row).slice(0, 700)}${truncated(row) ? ` [truncated; read in full: gh api ${row.endpoint} --paginate]` : ""}`;
const context = (event, text) => ({ hookSpecificOutput: { hookEventName: event, additionalContext: text } });

// Ledger: retain truncated previews so a full read can acknowledge them from any hook.
function recordPreview(state, item, fresh, acknowledge = false, poll = false) {
  const seen = acknowledge ? fresh.filter(({ row }) => !truncated(row)).map(({ stamp }) => stamp) : [];
  const shown = fresh.filter(({ row }) => truncated(row)).map(({ stamp }) => stamp);
  const pending = fresh.filter(({ row }) => truncated(row) || !acknowledge)
    .map(({ row, stamp }) => ({ stamp, id: row.id, endpoint: row.endpoint, url: row.url, ...(!truncated(row) ? { row } : {}) }));
  // Poll stamps keep repeats quiet while Claude still presents and acknowledges full comments.
  if (seen.length || pending.length) state.append({ repo: item.repo, number: item.number, seen, shown, pending,
    ...(poll ? { polled: fresh.map(({ stamp }) => stamp) } : {}) });
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
        (pending.endpoint.includes("/issues/") || (command.group === "pr" && pending.endpoint.endsWith("/reviews")))) ||
      (endpoint && (endpoint === pending.endpoint ||
        (pending.endpoint.endsWith("/comments") && endpoint === pending.endpoint.replace(/\/\d+\/comments$/, `/comments/${pending.id}`))))
    )).map(pending => pending.stamp);
    if (seen.length) state.append({ repo: item.repo, number: item.number, seen });
  }
}

// Fragment: identify a REST request and distinguish full reads from session writes.
function apiRequest(command) {
  if (command.group !== "api") return null;
  // API flags may precede the endpoint; keep their names with their values.
  const apiWords = command.rest;
  let method;
  let hostname = command.env?.GH_HOST ?? "github.com";
  let write = false;
  let endpoint;
  let endpointHost;
  const values = new Set(["--method", "--field", "--raw-field", "--input", "--header", "--hostname", "--jq", "--template", "--cache", "--preview"]);
  for (let i = 0; i < apiWords.length; i++) {
    const word = apiWords[i];
    const long = /^(--[^=]+)(?:=(.*))?$/.exec(word);
    if (long && values.has(long[1])) {
      const value = long[2] ?? apiWords[++i];
      if (long[1] === "--method") method = value;
      if (long[1] === "--hostname") hostname = value;
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
    if (!endpoint && /^(?:https:\/\/api.github.com\/)?\/?repos\//.test(word)) {
      endpointHost = word.startsWith("https://api.github.com/") ? "github.com" : undefined;
      endpoint = word.replace(/^https:\/\/api.github.com\//, "").replace(/^\//, "").split("?")[0].replace(/^repos\/([^/]+\/[^/]+)/, match => match.toLowerCase());
    }
  }
  // Watch identities and comment requests currently cover GitHub.com only.
  if ((endpointHost ?? hostname)?.toLowerCase() !== "github.com") return null;
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

export async function commentWatch(call, { gh: run = runCommentGh, merges: mergeTargets } = {}) {
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
      for (const item of watched) watch(state, { ...item, prs: prs.filter(pr => pr.repo === item.repo).map(itemKey) });
      for (const { words, env } of ghCalls(call.tool_input?.command ?? "", parse)) {
        const command = { ...ghCommand(words), env };
        const request = apiRequest(command);
        if (request?.method === "POST" && /^repos\/[^/]+\/[^/]+\/(?:issues(?:\/\d+\/comments)?|pulls(?:\/\d+\/(?:comments|reviews))?)$/.test(request.endpoint ?? "")) {
          state.append({ own: createdKeys(call.tool_response, request.endpoint) });
        }
        const found = fields(command.args, root, command.group === "pr" && command.verb === "review");
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
          watch(state, { repo, number, kind: "pr" });
          references(pr.body ?? "", repo, (repo, number) => watch(state, { repo, number, kind: "issue", prs: [key] }), true);
        }
        if (Number.isSafeInteger(number) && ["create", "comment", "review"].includes(command.verb)) {
          const resource = command.verb === "review" ? `pulls/${number}/reviews` : `issues/${number}/comments`;
          const endpoint = `repos/${repo.toLowerCase()}/${resource}`;
          const keys = createdKeys(call.tool_response, endpoint);
          state.append({ own: keys });
          if (command.group === "pr" && command.verb === "review" && !keys.some(key => key.startsWith(`${endpoint}:`) || /(?:#pullrequestreview-\d+|\/pulls\/\d+\/reviews\/\d+)$/.test(key))) {
            const body = found.body.replace(/^\n/, "");
            const start = state.starts.get(hash(call.tool_input.command)) ?? new Date(Math.floor(Date.now() / 1000) * 1000).toISOString();
            const review = { repo: repo.toLowerCase(), number, start, bodyHash: hash(body), empty: body.length === 0,
              state: found.state };
            state.append({ review: { ...review, key: randomUUID() } });
          }
          if (command.group === "pr" && command.verb === "review") state.append({ reviewStart: hash(call.tool_input.command), start: null });
        }
        acknowledge(state, command, repo, number);
      }
      return null;
    }
    if (["UserPromptSubmit", "Stop", "Poll"].includes(event)) {
      const lines = [];
      if (event === "UserPromptSubmit") for (const item of state.items.values()) {
        if (!item.retired) continue;
        const pending = [...item.pending.values()].filter(pending => pending.row && !item.seen.has(pending.stamp)).map(({ row, stamp }) => ({ row, stamp }));
        lines.push(...pending.map(({ row }) => describe(item, row)));
        recordPreview(state, item, pending, true);
      }
      const items = [...state.items.values()].filter(item => !item.retired);
      const start = Math.max(0, items.findIndex(item => itemKey(item) === state.next));
      const ordered = [...items.slice(start), ...items.slice(0, start)];
      const repos = new Map();
      for (const item of ordered) {
        const repo = item.repo.toLowerCase();
        if (!repos.has(repo)) repos.set(repo, []);
        repos.get(repo).push(item);
      }
      let failed = 0;
      let checked = 0;
      const reasons = new Set();
      let stopped = false;
      const metadataByRepo = new Map();
      const stopAfter = (item) => {
        stopped = true;
        state.append({ next: itemKey(ordered[(ordered.indexOf(item) + 1) % ordered.length]) });
      };
      for (const item of ordered) {
        const repo = item.repo.toLowerCase();
        if (!metadataByRepo.has(repo)) {
          try {
            metadataByRepo.set(repo, { data: await itemMetadata(item.repo, repos.get(repo), gh) });
          } catch (error) {
            metadataByRepo.set(repo, { error });
          }
        }
        try {
          const { data: metadata, error } = metadataByRepo.get(repo);
          if (error) throw error;
          const info = metadata[`item_${item.number}`];
          if (!info || !["OPEN", "CLOSED", "MERGED"].includes(info.state) || typeof info.updatedAt !== "string" || !info.updatedAt) throw new Error("response");
          if (info.__typename === "PullRequest") item.kind = "pr";
          const changed = info.updatedAt !== item.updatedAt;
          const fresh = changed ? await unseen(item, gh, state)
            : [...item.pending.values()].filter(pending => pending.row && !item.seen.has(pending.stamp)).map(({ row, stamp }) => ({ row, stamp }));
          lines.push(...fresh.filter(({ stamp }) => !item.shown.has(stamp) && (event !== "Poll" || !item.polled.has(stamp))).map(({ row }) => describe(item, row)));
          recordPreview(state, item, fresh, event === "UserPromptSubmit", event === "Poll");
          if (changed) state.append({ repo: item.repo, number: item.number, kind: item.kind, updatedAt: info.updatedAt });
          if (["CLOSED", "MERGED"].includes(info.state)) state.append({ retired: itemKey(item) });
        } catch (error) {
          reasons.add(failureReason(error));
          if (rateLimited(error) || error.message === "deadline") { stopAfter(item); break; }
          failed++;
        }
        checked++;
      }
      if (stopped) failed += items.length - checked;
      if (failed) lines.push(`Comment watch: ${failed} items could not be checked (${[...reasons].join(", ")}); retry on the next prompt.`);
      return lines.length ? (event === "UserPromptSubmit" ? context(event, lines.join("\n")) : { systemMessage: lines.join("\n") }) : null;
    }
    if (event === "PreToolUse") {
      const parse = PARSERS[call.tool_name];
      if (!parse) return null;
      if (ghCalls(call.tool_input?.command ?? "", parse).some(({ words }) => {
        const command = ghCommand(words);
        return command.group === "pr" && command.verb === "review";
      })) state.append({ reviewStart: hash(call.tool_input.command), start: new Date(Math.floor(Date.now() / 1000) * 1000).toISOString() });
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
          watch(state, target);
          const item = { ...state.items.get(itemKey(target)), ...target };
          try {
            const fresh = await unseen(item, gh, state);
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

// Adapter: manual polls share the ledger without acknowledging pending feedback.
export async function runCommentWatch(args) {
  const usage = "usage: qc comment-watch --poll --cwd <dir> --session <id>";
  try {
    const options = {};
    for (let at = 0; at < args.length;) {
      const key = args[at++];
      if (!["--poll", "--cwd", "--session"].includes(key) || Object.hasOwn(options, key)) throw new Error(usage);
      if (key === "--poll") options[key] = true;
      else {
        const value = args[at++];
        if (!value?.trim() || value.startsWith("--")) throw new Error(usage);
        options[key] = value;
      }
    }
    if (!options["--poll"] || !options["--cwd"] || !options["--session"] ||
      !existsSync(options["--cwd"]) || !statSync(options["--cwd"]).isDirectory()) throw new Error(usage);
    const result = await commentWatch({ cwd: path.resolve(options["--cwd"]), session_id: options["--session"], hook_event_name: "Poll" });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return 0;
  } catch (error) {
    console.error(error.message);
    return 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  try { const result = await commentWatch(JSON.parse(input)); if (result) process.stdout.write(`${JSON.stringify(result)}\n`); } catch { /* Ignore non-hook input. */ }
}
