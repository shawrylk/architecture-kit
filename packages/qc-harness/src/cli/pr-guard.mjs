#!/usr/bin/env node
// The PreToolUse trigger that keeps each issue in one draft PR and checks its platform legs before readiness.
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { nestedCommand, programName } from "./bash-command-guard.mjs";
import { checkoutRootOf } from "./checkout-root.mjs";
import { branchAt, originOf, repoOfSpelling } from "./git-read.mjs";
import { runGh } from "./gh-run.mjs";
import { readyProblems } from "./legs.mjs";
import { cdTarget, commandEnv, commandWords, segmentsOf } from "./shell-command.mjs";

const deny = (reason) => ({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: reason } });
const settings = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => ["GH_REPO", "GH_HOST", "GH_CONFIG_DIR"].includes(name)));
const line = (value) => String(value).replace(/[\r\n]+/g, " ");

function optionsOf(words) {
  const options = { positional: [] };
  const names = { "-R": "repo", "--repo": "repo", "-b": "body", "--body": "body", "-F": "bodyFile", "--body-file": "bodyFile", "-H": "head", "--head": "head" };
  const values = new Set(["--title", "-t", "--base", "-B", "--assignee", "-a", "--label", "-l", "--reviewer", "-r", "--project", "-p", "--milestone", "-m", "--template", "-T", "--recover"]);
  for (let i = 0; i < words.length; i++) {
    const word = words[i];
    const at = word.startsWith("--") ? word.indexOf("=") : -1;
    const flag = at < 0 ? word : word.slice(0, at);
    if (names[flag] || values.has(flag)) {
      const value = at < 0 ? words[++i] : word.slice(at + 1);
      if (names[flag]) options[names[flag]] = value;
    } else if (/^-[RbFH].+/.test(word)) options[names[word.slice(0, 2)]] = word.slice(2).replace(/^=/, "");
    else if (word === "--draft" || word === "-d" || word === "--draft=true") options.draft = true;
    else if (word === "--undo" || word === "--undo=true") options.undo = true;
    else if (!word.startsWith("-")) options.positional.push(word);
  }
  return options;
}

function issuesOf(branch, body) {
  const issues = new Set();
  const branchIssue = /^[^/]+\/([1-9]\d*)-/.exec(branch ?? "")?.[1];
  if (branchIssue) issues.add(branchIssue);
  for (const match of String(body ?? "").matchAll(/\b(?:Refs|Fixes)\s+#([1-9]\d*)\b/gi)) issues.add(match[1]);
  return issues;
}

function refusal(call, options, root, cwd, repo, env, gh, problems) {
  const args = ["-R", repo];
  if (options.verb === "create") {
    if (call.agent_id != null) return "PR guard: push the sub-branch and let the controller run `qc integrate`.";
    if (!options.draft) return "PR guard: create the pull request with `--draft`.";
    let prs;
    try {
      prs = JSON.parse(gh(["pr", "list", "--state", "open", ...args, "--limit", "1000", "--json", "number,headRefName,body"], { cwd, env, timeoutMs: 5000 }));
      if (!Array.isArray(prs) || prs.length >= 1000 || prs.some((pr) => !Number.isInteger(pr?.number) || typeof pr.body !== "string" || typeof pr.headRefName !== "string")) throw new Error("unreadable list");
    } catch { return "PR guard: cannot list the open pull requests; retry when gh can read them."; }
    let body = options.body ?? "";
    if (options.bodyFile) {
      try { body = readFileSync(path.resolve(cwd, options.bodyFile), "utf8"); }
      catch { return "PR guard: cannot read the pull request body file."; }
    }
    const issues = issuesOf(options.head ?? branchAt(root), body);
    for (const pr of prs) {
      const duplicate = [...issuesOf(pr.headRefName, pr.body)].find((issue) => issues.has(issue));
      if (duplicate) return `PR guard: issue #${duplicate} already has open pull request #${pr.number}; update that pull request.`;
    }
    return null;
  }
  if (options.undo) return null;
  try {
    const selector = options.positional[0];
    const pr = JSON.parse(gh(["pr", "view", ...(selector ? [selector] : []), ...args, "--json", "headRefOid"], { cwd, env, timeoutMs: 5000 }));
    if (!/^[0-9a-f]{40,64}$/i.test(pr?.headRefOid ?? "")) throw new Error("missing head");
    const { missing, hits } = problems(root, pr.headRefOid);
    if (!missing.length) return null;
    const commands = missing.map((os) => `qc ci-preview --os ${os}`).join("; ");
    const evidence = hits.slice(0, 3).map((hit) => line(`${hit.file}:${hit.line}: ${hit.reason}`)).join("; ");
    return `PR guard: missing platform legs: ${missing.join(", ")}. Run ${commands}; then qc ready-check.` + (evidence ? `\n${evidence}` : "");
  } catch { return "PR guard: cannot check the pull request head or its platform legs; run qc ready-check after gh can read the head."; }
}

export function decidePr(call, { gh = runGh, problems = readyProblems } = {}) {
  if (call?.tool_name !== "Bash" || call.hook_event_name !== "PreToolUse") return null;
  const command = call.tool_input?.command;
  if (typeof command !== "string" || !/\bgh(?:\.exe)?\b/i.test(command)) return null;
  function visit(text, cwd, inherited = {}, parse = segmentsOf) {
    let env = { ...inherited };
    for (const segment of parse(text)) {
      const moved = cdTarget(segment);
      if (moved) cwd = path.resolve(cwd, moved);
      if (segment.words[0] === "export") {
        for (const word of segment.words.slice(1)) {
          const match = /^(GH_REPO|GH_HOST|GH_CONFIG_DIR)=(.*)$/s.exec(word);
          if (match) env[match[1]] = match[2];
        }
      }
      const nested = nestedCommand(segment);
      if (nested) {
        const answer = visit(nested.command, cwd, { ...env, ...settings(commandEnv(segment)) }, nested.parse);
        if (answer) return answer;
      }
      const [program, ...words] = commandWords(segment);
      if (programName(program) !== "gh") continue;
      const group = words.indexOf("pr");
      if (group < 0) continue;
      let verbAt = group + 1;
      while (/^(?:-R|--repo(?:=|$))/.test(words[verbAt] ?? "")) verbAt += ["-R", "--repo"].includes(words[verbAt]) ? 2 : 1;
      if (!["create", "ready"].includes(words[verbAt])) continue;
      const options = { ...optionsOf(words.filter((_, i) => i !== group && i !== verbAt)), verb: words[verbAt] };
      const root = checkoutRootOf(cwd);
      if (!root || !existsSync(path.join(root, "qc.config.json"))) continue;
      const origin = originOf(root);
      if (!origin) continue;
      const ghEnv = { ...settings(process.env), ...env, ...settings(commandEnv(segment)) };
      const urlRepo = /^https?:\/\/[^/]+\/([^/]+\/[^/]+)\/pull\/\d+/.exec(options.positional[0] ?? "")?.[1];
      const target = urlRepo ?? options.repo ?? ghEnv.GH_REPO;
      if (target && repoOfSpelling(target) !== origin) continue;
      const message = refusal(call, options, root, cwd, origin, ghEnv, gh, problems);
      if (message) return deny(message);
    }
    return null;
  }
  return visit(command, call.cwd ?? process.cwd());
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const output = decidePr(JSON.parse(input));
  if (output) console.log(JSON.stringify(output));
}
