// A fragment that finds each `gh pr merge` in a Bash or PowerShell command line, with the head sha it pins,
// the PR and repository it names, and the GH_* settings the command makes for gh.
// It also finds each `gh api` call to a PR's merge endpoint or with a `mergePullRequest` mutation, which merge with no review check.

import { readFileSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { nestedCommand, programName } from "./bash-command-guard.mjs";
import { commandWords } from "./shell-command.mjs";

const GH_SETTINGS = ["GH_CONFIG_DIR", "GH_HOST"];
const VALUE_FLAGS = new Set(["-b", "--body", "-F", "--body-file", "-t", "--subject", "-A", "--author-email", "--match-head-commit", "-R", "--repo"]);
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/s;
const POWERSHELL_ENV = /^\$env:([A-Za-z_][A-Za-z0-9_]*)(?:=(.*))?$/is;
const MERGE_ENDPOINT = /^(?:https?:\/\/[^/]+\/(?:api\/v3\/)?)?\/?(?:repos\/[^/]+\/[^/]+\/)?pulls\/\d+\/merge\/?(?:\?.*)?$/;
const MERGE_MUTATION = /\bmergePullRequest\b/;
const GRAPHQL_ENDPOINT = /(?:^|\/)graphql\/?(?:\?.*)?$/;
const FIELD_FLAGS = new Set(["--field"]);
const MAX_QUERY_BYTES = 1024 * 1024;

/** Only the settings that choose gh's account or host; a token is a credential and is never kept. */
const kept = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => GH_SETTINGS.includes(name)));

/** The settings one segment makes for the segments after it: `export NAME=value`, or PowerShell's `$env:NAME = value`. */
function settingsMadeBy(segment) {
  const [first, second, third] = segment.words;
  if (first === "export") {
    return kept(Object.fromEntries(segment.words.slice(1).map((word) => ASSIGNMENT.exec(word)).filter(Boolean).map((m) => [m[1], m[2]])));
  }
  const powershell = POWERSHELL_ENV.exec(first ?? "");
  if (!powershell) return {};
  const value = powershell[2] ?? (second === "=" ? third : undefined);
  return value === undefined ? {} : kept({ [powershell[1].toUpperCase()]: value });
}

/** The `NAME=value` words before a command, which set its environment alone. */
function prefixOf(segment) {
  const env = {};
  for (const word of segment.words) {
    const match = ASSIGNMENT.exec(word);
    if (!match) break;
    env[match[1]] = match[2];
  }
  return kept(env);
}

function mergeOf(args) {
  const merge = { sha: null, repo: null, selector: null, auto: false };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const at = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = at === -1 ? arg : arg.slice(0, at);
    if (flag === "--disable-auto") return null;
    if (flag === "--auto") merge.auto = true;
    if (VALUE_FLAGS.has(flag)) {
      const value = at === -1 ? args[++i] : arg.slice(at + 1);
      if (flag === "--match-head-commit") merge.sha = value ?? null;
      if (flag === "-R" || flag === "--repo") merge.repo = value ?? null;
    } else if (!arg.startsWith("-") && merge.selector === null) {
      merge.selector = arg;
    }
  }
  return merge;
}

/** Every gh call in the command, in order, as `{ words, env }` with the words after `gh`; a nested shell's lines count. */
function ghCalls(command, parse) {
  const calls = [];
  let env = {};
  for (const segment of parse(command)) {
    env = { ...env, ...settingsMadeBy(segment) };
    const nested = nestedCommand(segment);
    if (nested) {
      calls.push(...ghCalls(nested.command, nested.parse).map((call) => ({ ...call, env: { ...env, ...call.env } })));
      continue;
    }
    const [program, ...words] = commandWords(segment);
    if (programName(program) === "gh") calls.push({ words, env: { ...env, ...prefixOf(segment) } });
  }
  return calls;
}

/** Every `gh pr merge` in the command, in order, the lines of a nested `bash -c` or `pwsh -Command` included. */
export function ghMerges(command, parse) {
  const merges = [];
  for (const { words, env } of ghCalls(command, parse)) {
    const [group, verb, ...args] = words;
    if (group !== "pr" || verb !== "merge") continue;
    const merge = mergeOf(args);
    if (merge) merges.push({ ...merge, env });
  }
  return merges;
}

/** A file path as the command wrote it: `~` and a Git Bash `/c/...` spelling resolve the way the shell would. */
function fileOf(cwd, spelled) {
  let file = spelled.replace(/^~(?=$|[\\/])/, os.homedir());
  if (process.platform === "win32") file = file.replace(/^\/([A-Za-z])(?=\/|$)/, "$1:");
  return path.resolve(cwd, file);
}

/**
 * The files a `gh api` call reads its body from: each `-F key=@file`, and `--input file`. `-` is standard input.
 * pflag reads a short flag with its value attached (`-Fkey=@file`, `-F=key=@file`) and a cluster of short flags
 * that ends in `-F` (`-iFkey=@file`, `-iF key=@file`). A letter that takes a value ends a cluster, so it hides an `F` after it.
 */
function bodyFiles(args) {
  const files = [];
  const add = (field) => {
    if (/^[^=]*=@/.test(field)) files.push(field.slice(field.indexOf("@") + 1));
  };
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const cluster = /^-([A-Za-z]*)F(.*)$/s.exec(arg);
    if (cluster && !/[fFHXqt]/.test(cluster[1])) {
      const value = cluster[2] === "" ? args[++i] : cluster[2].replace(/^=/, "");
      if (value !== undefined) add(value);
      continue;
    }
    const at = arg.startsWith("--") ? arg.indexOf("=") : -1;
    const flag = at === -1 ? arg : arg.slice(0, at);
    if (flag !== "--input" && !FIELD_FLAGS.has(flag)) continue;
    const value = at === -1 ? args[++i] : arg.slice(at + 1);
    if (value === undefined) continue;
    if (flag === "--input") files.push(value);
    else add(value);
  }
  return files;
}

/** The text of a query file, or null when it is standard input, too large, or unreadable. */
function queryText(cwd, spelled) {
  if (spelled === "-") return null;
  try {
    const file = fileOf(cwd, spelled);
    if (statSync(file).size > MAX_QUERY_BYTES) return null;
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Each `gh api` call that merges with no review check, as `{ endpoint, unreadable }`. `endpoint` is the PR merge
 * endpoint as written, or the GraphQL URL as written (`graphql` when the call spells none). A call holds a
 * `mergePullRequest` mutation when any argument, or any query file it reads, names it, whatever the URL spelling.
 * A GraphQL call whose query file the guard cannot read fails closed, and `unreadable` names that file.
 * @param options.cwd the folder a relative query file resolves against
 */
export function ghApiMerges(command, parse, { cwd = process.cwd() } = {}) {
  return ghCalls(command, parse)
    .filter(({ words }) => words[0] === "api")
    .flatMap(({ words }) => {
      const args = words.slice(1);
      const found = args.filter((word) => MERGE_ENDPOINT.test(word)).map((endpoint) => ({ endpoint }));
      const graphql = args.find((word) => GRAPHQL_ENDPOINT.test(word));
      let mutation = args.some((word) => MERGE_MUTATION.test(word));
      let unreadable;
      for (const file of bodyFiles(args)) {
        const text = queryText(cwd, file);
        if (text === null) unreadable ??= file;
        else if (MERGE_MUTATION.test(text)) mutation = true;
      }
      if (mutation) found.push({ endpoint: graphql ?? "graphql" });
      else if (graphql !== undefined && unreadable !== undefined) found.push({ endpoint: graphql, unreadable });
      return found;
    });
}
