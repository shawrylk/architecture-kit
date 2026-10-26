import { execFileSync } from "node:child_process";
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
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git ")) {
      file = undefined;
      inHunk = false;
    } else if (!inHunk && (line.startsWith("--- ") || line.startsWith("+++ "))) {
      const parsed = patchPath(line.slice(4));
      if (parsed !== null) { file = parsed; changed.add(file); }
    } else if (line.startsWith("@@ ")) {
      const hunk = /\+(\d+)(?:,\d+)? @@/.exec(line);
      if (!hunk) throw new Error("cannot parse the guard diff hunk");
      addedLine = Number(hunk[1]);
      inHunk = true;
    } else if (inHunk && line.startsWith("+")) {
      if (file === undefined) throw new Error("cannot identify the guard diff path");
      const content = line.slice(1);
      const rules = findSecrets(content);
      if (/^(<<<<<<< |>>>>>>> )/.test(content)) rules.push("conflict-marker");
      for (const rule of rules) findings.push({ path: file, line: addedLine, rule });
      addedLine += 1;
    } else if (inHunk && line.startsWith(" ")) {
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

/** Resource: reads Git without external diff drivers, text converters, or rename folding. */
function git(root, args) {
  return execFileSync("git", ["-c", "core.quotePath=false", "-C", root, ...args], {
    encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024, windowsHide: true,
  });
}

/** Fragment: captures the commit boundary before the child runs. */
export function guardHead(root) {
  git(root, ["rev-parse", "--git-dir"]);
  try { return git(root, ["rev-parse", "--verify", "HEAD"]).trim(); }
  catch (error) { if (error.status === 128) return null; throw error; }
}

/** Branch: scans every commit added during one run, including intermediate commits. */
export function checkRunCommits(root, before, options) {
  if (before) git(root, ["merge-base", "--is-ancestor", before, "HEAD"]);
  const head = guardHead(root);
  if (!head) return [];
  const commits = git(root, ["rev-list", "--reverse", head, ...(before ? [`^${before}`] : [])]).trim().split("\n").filter(Boolean);
  const findings = [];
  for (const commit of commits) {
    const args = ["show", "--format=", "--root", "--first-parent", "--diff-merges=first-parent", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const paths = git(root, [...args, "--name-only", "-z", commit, "--"]).split("\0").filter(Boolean);
    const diff = git(root, [...args, "--unified=0", "--no-color", commit, "--"]);
    findings.push(...checkDiff(diff, { ...options, paths }).map((finding) => ({ ...finding, commit })));
  }
  return findings;
}

/** Fragment: formats locations and rule names while keeping secret values out of logs. */
export const findingName = ({ path, line, rule, commit }) => `${commit ? `${commit} ` : ""}${path}${line ? `:${line}` : ""}: ${rule}`;

/** Trigger: refuses staged findings before the commit can leave the index. */
export function runCommitGuard(config, { env = process.env, say = (line) => console.error(line) } = {}) {
  try {
    const args = ["diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames"];
    const paths = git(config.root, [...args, "--name-only", "-z", "--"]).split("\0").filter(Boolean);
    const diff = git(config.root, [...args, "--unified=0", "--no-color", "--"]);
    const findings = checkDiff(diff, { protectedPaths: config.guard.protectedPaths, role: env.QC_ROLE, allow: protectedAllow(`Protected: ${env.QC_PROTECTED_ALLOW ?? ""}`), paths });
    for (const finding of findings) say(`qc commit-guard: guard refused: ${findingName(finding)}`);
    return findings.length ? 4 : 0;
  } catch (error) {
    say(`qc commit-guard: cannot check staged changes: ${error.message}`);
    return 4;
  }
}
