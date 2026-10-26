import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathMatcher } from "../glob.mjs";
import { findSecrets } from "./secret-patterns.mjs";

/** Fragment: reads the brief's explicit exceptions to the protected path policy. */
export function protectedAllow(brief) {
  return [...brief.matchAll(/^Protected:[ \t]*(.*)$/gm)]
    .flatMap((match) => match[1].split(",").map((glob) => glob.trim()).filter(Boolean));
}

/** Fragment: decodes Git's quoted patch paths, including control bytes. */
function patchPath(header) {
  let file = header.replace(/\t$/, "");
  if (file.startsWith('"')) {
    file = JSON.parse(file.replace(/\\([0-7]{1,3})/g, (_, octal) => `\\u${parseInt(octal, 8).toString(16).padStart(4, "0")}`)
      .replace(/\\a/g, "\\u0007").replace(/\\v/g, "\\u000b"));
  }
  return file === "/dev/null" ? null : file.slice(2);
}

/** Branch: judges added lines and protected paths without disclosing their contents. */
export function checkDiff(diff, { protectedPaths = [], role, allow = [], paths = [] } = {}) {
  const findings = [];
  const changed = new Set(paths);
  let file;
  let addedLine = 0;
  let inHunk = false;
  let columns = 1;
  for (const line of diff.split("\n")) {
    if (/^diff --(?:git|cc|combined) /.test(line)) {
      file = undefined;
      inHunk = false;
    } else if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      const parsed = patchPath(line.slice(4));
      if (parsed !== null) { file = parsed; changed.add(file); }
    } else if (/^@@+ /.test(line)) {
      const hunk = /^(@{2,}) .*?\+(\d+)(?:,\d+)? \1/.exec(line);
      if (!hunk) throw new Error("cannot parse the guard diff hunk");
      columns = hunk[1].length - 1;
      addedLine = Number(hunk[2]);
      inHunk = true;
    } else if (inHunk && line.startsWith("+".repeat(columns))) {
      if (file === undefined) throw new Error("cannot identify the guard diff path");
      const content = line.slice(columns);
      const rules = findSecrets(content);
      if (/^(<<<<<<< |>>>>>>> )/.test(content)) rules.push("conflict-marker");
      for (const rule of rules) findings.push({ path: file, line: addedLine, rule });
      addedLine += 1;
    } else if (inHunk && line.length >= columns && /^[ +]+$/.test(line.slice(0, columns))) {
      addedLine += 1;
    }
  }
  if (role === "implementer") {
    const protectedPath = pathMatcher(protectedPaths);
    const allowedPath = pathMatcher(allow);
    for (const file of changed) {
      if (protectedPath(file) && !allowedPath(file)) findings.push({ path: file, rule: "protected-path" });
    }
  }
  return findings;
}

let mergeDiffOption;

// A resource: ends the Git process tree before the synchronous caller's deadline.
const remoteReadScript = `
  const { spawn, spawnSync } = require("node:child_process");
  const [deadline, command, ...args] = process.argv.slice(1);
  const child = spawn(command, args, { stdio: ["ignore", "inherit", "inherit"], windowsHide: true, detached: process.platform !== "win32" });
  child.on("error", () => process.exit(1));
  child.on("close", (code) => process.exit(code ?? 1));
  setTimeout(() => {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true, timeout: 1000 });
      child.kill();
    } else {
      try { process.kill(-child.pid, "SIGKILL"); } catch {}
    }
    process.exit(124);
  }, Number(deadline)).unref();
`;

/** Resource: selects the merge diff format once for the process's Git version. */
function mergeDiff(root) {
  if (mergeDiffOption === undefined) {
    const version = /^git version (\d+)\.(\d+)/.exec(git(root, ["--version"]));
    if (!version) throw new Error("cannot read the Git version for merge scanning");
    const major = Number(version[1]);
    const minor = Number(version[2]);
    mergeDiffOption = major > 2 || (major === 2 && minor >= 36) ? "--diff-merges=remerge" : "--cc";
  }
  return mergeDiffOption;
}

/** Resource: reads Git without external diff drivers, text converters, or rename folding. */
function git(root, args, input) {
  const remote = args[0] === "ls-remote";
  const words = ["-c", "core.quotePath=false", ...(root === null ? [] : ["-C", root]), ...args];
  return execFileSync(remote ? process.execPath : "git",
    remote ? ["-e", remoteReadScript, "--", "29000", "git", ...words] : words, {
    encoding: "utf8", input, stdio: [input === undefined ? "ignore" : "pipe", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, windowsHide: true,
    ...(root === null ? { cwd: os.tmpdir() } : {}),
    ...(remote ? { timeout: 30_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" } } : {}),
  });
}

/** Resource: reads the effective origin URL without opening an interactive prompt. */
function originUrl(root) {
  try { return git(root, ["ls-remote", "--get-url", "origin"]).trim(); }
  catch { return null; }
}

/** Fragment: captures the commit boundary before the child runs. */
export function guardHead(root) {
  git(root, ["rev-parse", "--git-dir"]);
  try { return git(root, ["rev-parse", "--verify", "HEAD"]).trim(); }
  catch (error) { if (error.status === 128) return null; throw error; }
}

/** Resource: records every ref tip, including remote-tracking refs, before the child runs. */
export function guardRefs(root) {
  const refs = Object.fromEntries(git(root, ["for-each-ref", "--format=%(refname) %(objectname)"]).trim().split("\n").filter(Boolean).map((line) => line.split(" ")));
  return { head: guardHead(root), branch: git(root, ["branch", "--show-current"]).trim(), refs: [...new Set(Object.values(refs))], recordedRefs: refs, originUrl: originUrl(root) };
}

/** Fragment: excludes commits reached by the configured remote base. */
function baseExclusion(root, base = "origin/main", recordedRefs = {}, recordedUrl) {
  const branch = base.replace(/^origin\//, "");
  const recorded = recordedRefs[`refs/remotes/origin/${branch}`];
  const fallback = recorded ? [recorded] : [];
  const currentUrl = originUrl(root);
  if (recordedUrl == null || currentUrl === null || currentUrl !== recordedUrl) return fallback;
  try {
    const refname = `refs/heads/${branch}`;
    const tip = git(null, ["ls-remote", recordedUrl, refname]).trim().split(/\r?\n/)
      .map((line) => line.split(/\s+/)).find(([, ref]) => ref === refname)?.[0];
    return tip ? [tip] : [];
  } catch {
    return fallback;
  }
}

/** Branch: scans every commit added during one run, including intermediate commits. */
export function checkRunCommits(root, before, options) {
  const head = typeof before === "object" && before !== null ? before.head : before;
  if (head) git(root, ["merge-base", "--is-ancestor", head, "HEAD"]);
  const refs = typeof before === "object" && before !== null ? before.refs : [];
  const branch = options.branch ?? git(root, ["branch", "--show-current"]).trim();
  const runRefs = branch ? [`refs/heads/${branch}`, `refs/remotes/origin/${branch}`] : [];
  const tips = Object.fromEntries(git(root, ["for-each-ref", "--format=%(refname) %(objectname)", ...runRefs]).trim().split("\n").filter(Boolean).map((line) => line.split(" ")));
  const revisions = [...(guardHead(root) ? ["HEAD"] : []), ...runRefs.map((ref) => tips[ref]).filter(Boolean)];
  return scanCommits(root, revisions, [...refs, ...(head ? [head] : [])], options, before?.recordedRefs, before?.originUrl);
}

/** Pipeline: scans the selected commits with one shared content and path policy. */
function scanCommits(root, revisions, excluded, options, recordedRefs, recordedUrl) {
  const boundary = new Set([...excluded, ...baseExclusion(root, options.base, recordedRefs, recordedUrl)]);
  const input = [...new Set(revisions), ...[...boundary].map((oid) => `^${oid}`)].join("\n") + "\n";
  const commits = git(root, ["rev-list", "--reverse", "--parents", "--stdin"], input).trim().split("\n").filter(Boolean);
  const findings = [];
  for (const entry of commits) {
    const [commit, ...parents] = entry.split(" ");
    const args = ["show", "--format=", "--root", ...(parents.length > 1 ? [mergeDiff(root)] : []), "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const paths = git(root, [...args, "--name-only", "-z", commit, "--"]).split("\0").filter(Boolean);
    const diff = git(root, [...args, "--unified=0", "--no-color", commit, "--"]);
    findings.push(...checkDiff(diff, { ...options, paths }).map((finding) => ({ ...finding, commit })));
  }
  return findings;
}

/** Fragment: formats locations and rule names while keeping secret values out of logs. */
export const findingName = ({ path, line, rule, commit }) => `${commit ? `${commit} ` : ""}${path}${line ? `:${line}` : ""}: ${rule}`;

/** Trigger: refuses staged findings before the commit can leave the index. */
export function runCommitGuard(config, { env = process.env, say = (line) => console.error(line), argv = process.argv.slice(3) } = {}) {
  try {
    const options = { protectedPaths: config.guard.protectedPaths, role: env.QC_ROLE, allow: protectedAllow(`Protected: ${env.QC_PROTECTED_ALLOW ?? ""}`), base: config.worktree?.base };
    if (argv.length) {
      const [mode, local, remote] = argv;
      if (mode !== "--push" || argv.length !== 3 || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(local) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(remote)) throw new Error("expected --push <local oid> <remote oid>");
      const findings = scanCommits(config.root, [local], /^0+$/.test(remote) ? [] : [remote], options);
      for (const finding of findings) say(`qc commit-guard: guard refused: ${findingName(finding)}`);
      return findings.length ? 4 : 0;
    }
    const mergeFile = path.resolve(config.root, git(config.root, ["rev-parse", "--git-path", "MERGE_HEAD"]).trim());
    const parents = existsSync(mergeFile) ? ["HEAD", ...readFileSync(mergeFile, "utf8").trim().split(/\s+/)] : [null];
    let findings;
    for (const parent of parents) {
      const args = ["diff", "--cached", "--src-prefix=a/", "--dst-prefix=b/", "--no-ext-diff", "--no-textconv", "--no-renames"];
      const revision = parent ? [parent] : [];
      const paths = git(config.root, [...args, "--name-only", "-z", ...revision, "--"]).split("\0").filter(Boolean);
      const diff = git(config.root, [...args, "--unified=0", "--no-color", ...revision, "--"]);
      const current = checkDiff(diff, { ...options, paths });
      const keys = new Set(current.map(findingName));
      findings = findings === undefined ? current : findings.filter((finding) => keys.has(findingName(finding)));
    }
    for (const finding of findings) say(`qc commit-guard: guard refused: ${findingName(finding)}`);
    return findings.length ? 4 : 0;
  } catch (error) {
    say(`qc commit-guard: cannot check changes: ${error.message}`);
    return 4;
  }
}
