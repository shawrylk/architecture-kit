import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { readLockedTests } from "./locked-tests.mjs";
import { spawnCommand } from "./spawn-command.mjs";

const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const git = (root, ...args) => execFileSync("git", ["--literal-pathspecs", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const names = (text) => text.split("\0").filter(Boolean);
const script = (file) => /\.[cm]?[jt]sx?$/.test(file);
const testFile = (file) => /\.(test|spec)\.[cm]?[jt]sx?$/.test(file) || /(^|\/)(__tests__|tests?|spec)\/.*\.[cm]?[jt]sx?$/.test(file);

/** Masks literals and comments without moving source offsets, including across lines. */
function codeMask(source) {
  let result = "";
  let state = "code";
  let escaped = false;
  let regexClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i];
    const next = source[i + 1];
    if (state === "line" && c === "\n") state = "code";
    if (state === "code") {
      if (c === "/" && next === "/") state = "line";
      else if (c === "/" && next === "*") { state = "block"; result += "  "; i += 1; continue; }
      else if ('\'"`'.includes(c)) state = c;
      else if (c === "/" && (!result.trim() || /[=(:,!&|?;{[]$/.test(result.trimEnd()) || /\b(return|throw|case)\s*$/.test(result))) state = "regex";
      else { result += c; continue; }
    } else if (state === "block" && c === "*" && next === "/") {
      state = "code"; result += "  "; i += 1; continue;
    } else if (!["line", "block"].includes(state)) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (state === "regex") {
        if (c === "[") regexClass = true;
        else if (c === "]") regexClass = false;
        else if (c === "/" && !regexClass) state = "code";
      } else if (c === state) state = "code";
    }
    result += c === "\n" || c === "\r" ? c : " ";
  }
  return result;
}

function lineMutants(line, mask) {
  const result = new Set();
  const replace = (start, end, value) => result.add(line.slice(0, start) + value + line.slice(end));
  const flips = { "<": ">=", ">": "<=", "<=": ">", ">=": "<", "===": "!==", "!==": "===" };
  for (const match of mask.matchAll(/===|!==|<=|>=|<|>|\btrue\b|\bfalse\b/g)) {
    const token = match[0];
    const start = match.index;
    if (flips[token] && (/[<>=!]/.test(mask[start - 1] ?? "") || /[<>=]/.test(mask[start + token.length] ?? ""))) continue;
    replace(start, start + token.length, flips[token] ?? (token === "true" ? "false" : "true"));
  }
  for (const match of mask.matchAll(/\bif\s*\(/g)) {
    const start = match.index + match[0].length;
    let depth = 1;
    let end = start;
    for (; end < mask.length; end += 1) {
      if (mask[end] === "(") depth += 1;
      if (mask[end] === ")" && --depth === 0) break;
    }
    if (depth === 0) replace(start, end, `!(${line.slice(start, end)})`);
  }
  for (const match of mask.matchAll(/\breturn\b/g)) {
    const start = match.index + match[0].length;
    let end = start;
    let depth = 0;
    for (; end < mask.length; end += 1) {
      const c = mask[end];
      if (depth === 0 && (c === ";" || c === "}" || c === "\r")) break;
      if ("([{".includes(c)) depth += 1;
      if (")]}".includes(c)) depth -= 1;
    }
    const expression = line.slice(start, end).trim();
    if (expression && expression !== "undefined") replace(start, end, " undefined");
  }
  return [...result];
}

export function mutants(line) {
  return lineMutants(line, codeMask(line));
}

function safePath(root, file) {
  if (!file || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).some((part) => !part || part === ".." || part === "." || part.toLowerCase() === ".git")) throw new Error(`unsafe mutation path: ${file}`);
  const target = path.resolve(root, file);
  for (let current = target; current !== root; current = path.dirname(current)) {
    if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`unsafe mutation symlink: ${file}`);
  }
  return target;
}

function changedLines(worktree, base) {
  const untracked = new Set(names(git(worktree, "ls-files", "--others", "--exclude-standard", "-z")));
  const files = new Set([...names(git(worktree, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", base, "--")), ...untracked]);
  const result = [];
  for (const file of files) {
    if (!script(file) || testFile(file)) continue;
    const source = readFileSync(safePath(worktree, file), "utf8");
    const lines = source.split("\n");
    const masks = codeMask(source).split("\n");
    const changed = new Set();
    if (untracked.has(file)) lines.forEach((_, i) => changed.add(i));
    else {
      const diff = git(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, "--", file);
      for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(hunk[1]) - 1;
        const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let i = start; i < start + count; i += 1) changed.add(i);
      }
    }
    for (const i of changed) {
      const variants = lineMutants(lines[i], masks[i]);
      if (variants.length) result.push({ file, line: i + 1, variants, source, lines });
    }
  }
  return result;
}

/** Includes locked files, sibling tests and tests importing changed modules transitively. */
function relatedTests(worktree, files, changed) {
  const scripts = files.filter(script);
  const available = new Set(scripts);
  const cache = new Map();
  const dependencies = (file) => {
    if (cache.has(file)) return cache.get(file);
    const text = readFileSync(safePath(worktree, file), "utf8");
    const imports = [...text.matchAll(/(?:\bfrom\s*|\bimport\s*(?:\(\s*)?|\brequire\s*\(\s*)["'](\.[^"']+)["']/g)];
    const resolved = imports.flatMap((match) => {
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), match[1]));
      return [target, ...[".mjs", ".js", ".ts", ".tsx", ".jsx", ".cjs", ".mts", ".cts"].flatMap((ext) => [target + ext, target.replace(/\.[cm]?js$/, ext), `${target}/index${ext}`])].filter((candidate) => available.has(candidate));
    });
    cache.set(file, resolved);
    return resolved;
  };
  const touches = (file, seen = new Set()) => {
    if (changed.has(file)) return true;
    if (seen.has(file)) return false;
    seen.add(file);
    return dependencies(file).some((dependency) => touches(dependency, seen));
  };
  const stems = new Set([...changed].map((file) => file.replace(/\.[^.]+$/, "")));
  return scripts.filter(testFile).filter((file) => changed.has(file) || stems.has(file.replace(/\.(test|spec)\.[^.]+$/, "")) || touches(file));
}

function snapshot(worktree, checkout, files) {
  for (const file of names(git(worktree, "ls-files", "--deleted", "-z"))) rmSync(safePath(checkout, file), cleanup);
  const copies = files.map((file) => ({ source: safePath(worktree, file), destination: safePath(checkout, file) }));
  for (const { source, destination } of copies) {
    if (!lstatSync(source).isFile()) continue;
    mkdirSync(path.dirname(destination), { recursive: true });
    copyFileSync(source, destination);
  }
  // Dependencies stay shared; source and test files always live in the detached copy.
  const folders = new Set(["", ...files.map((file) => path.dirname(file))]);
  for (const folder of folders) {
    const target = path.join(checkout, folder, "node_modules");
    let origin = path.join(worktree, folder, "node_modules");
    if (!folder) {
      for (let parent = worktree; !existsSync(origin) && path.dirname(parent) !== parent;) {
        parent = path.dirname(parent); origin = path.join(parent, "node_modules");
      }
    }
    if (!existsSync(origin) || existsSync(target)) continue;
    safePath(checkout, path.relative(checkout, target));
    mkdirSync(path.dirname(target), { recursive: true });
    symlinkSync(realpathSync(origin), target, "junction");
  }
}

function runBounded(command, cwd, deadline) {
  if (Date.now() >= deadline) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const child = spawnCommand(command[0], command.slice(1), { cwd, env, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        try { execFileSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true }); }
        catch { child.kill("SIGKILL"); }
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch (error) { if (error.code !== "ESRCH") child.kill("SIGKILL"); }
      }
    }, Math.max(1, deadline - Date.now()));
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (status) => { clearTimeout(timer); resolve(timedOut ? null : status ?? 1); });
  });
}

/** Checks a snapshot under one deadline; survivors are advisory and never touch the issue checkout. */
export async function runMutation({ worktree, base, maxLines = 10, budgetMs = 180000, command, files, say = console.error }) {
  const deadline = Date.now() + budgetMs;
  const empty = { survived: [], skippedLines: 0 };
  let root;
  let checkout;
  try {
    worktree = realpathSync(worktree);
    const lines = changedLines(worktree, base);
    if (!lines.length) return empty;
    const allFiles = [...new Set(names(git(worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z")))].filter((file) => existsSync(path.join(worktree, file)));
    const changed = new Set(names(git(worktree, "diff", "--name-only", "-z", base, "--")));
    for (const line of lines) changed.add(line.file);
    const tests = [...new Set([...(files ?? Object.keys(readLockedTests(worktree) ?? {})), ...relatedTests(worktree, allFiles, changed)])];
    if (!tests.length) { say("mutation: no test file; no mutation coverage"); return empty; }
    for (const file of tests) safePath(worktree, file);
    command ??= load(worktree).tests.command;
    root = mkdtempSync(path.join(os.tmpdir(), "qc-mutation-"));
    checkout = path.join(root, "checkout");
    git(worktree, "worktree", "add", "--detach", checkout, "HEAD");
    snapshot(worktree, checkout, allFiles);
    const argv = [...command, ...tests.map((file) => path.resolve(checkout, file))];
    const baseline = await runBounded(argv, checkout, deadline);
    if (baseline !== 0) { say(`mutation: baseline ${baseline === null ? "timed out" : "failed"}; no mutation coverage`); return baseline === null ? { ...empty, skippedLines: lines.length } : empty; }
    const survived = [];
    let completed = 0;
    const selected = lines.slice(0, Math.min(10, Math.max(0, maxLines)));
    for (const entry of selected) {
      if (Date.now() >= deadline) break;
      const target = safePath(checkout, entry.file);
      let finished = true;
      try {
        for (const mutant of entry.variants) {
          const modified = [...entry.lines];
          modified[entry.line - 1] = mutant;
          writeFileSync(target, modified.join("\n"));
          const status = await runBounded(argv, checkout, deadline);
          if (status === null) { finished = false; break; }
          if (status === 0) survived.push({ file: entry.file, line: entry.line, mutant });
        }
      } finally { writeFileSync(target, entry.source); }
      if (!finished) break;
      completed += 1;
    }
    return { survived, skippedLines: lines.length - completed };
  } catch (error) {
    say(`mutation: ${error.message.replace(/[\r\n]+/g, " ")}; no mutation coverage`);
    return empty;
  } finally {
    if (checkout) {
      try { git(worktree, "worktree", "remove", "--force", checkout); }
      finally { rmSync(root, cleanup); }
    }
  }
}
