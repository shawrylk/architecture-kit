import { execFileSync } from "node:child_process";
import { constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { load } from "../config.mjs";
import { readLockedTests } from "./locked-tests.mjs";
import { spawnCommand } from "./spawn-command.mjs";
const cleanup = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 };
const git = (root, ...args) => execFileSync("git", ["--literal-pathspecs", ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 64 * 1024 * 1024 });
const names = (text) => text.split("\0").filter(Boolean);
const testFile = (file) => /\.(test|spec)\.[cm]?js$/.test(file) || /(^|\/)(__tests__|tests?|spec)\//.test(file);
/** Masks literals and comments without moving source offsets, including across lines. */
function codeMask(source) {
  let result = "", state = "code", escaped = false, regexClass = false;
  for (let i = 0; i < source.length; i += 1) {
    const c = source[i], next = source[i + 1];
    if (state === "line" && c === "\n") state = "code";
    if (state === "code") {
      if (c === "/" && next === "/") state = "line";
      else if (c === "/" && next === "*") { state = "block"; result += "  "; i += 1; continue; }
      else if ('\'"`'.includes(c)) state = c;
      else if (c === "/" && (!result.trim() || /[=(:,!&|?;{[]$/.test(result.trimEnd()) || /\b(return|throw|case)\s*$/.test(result))) state = "regex";
      else { result += c; continue; }
    } else if (state === "block" && c === "*" && next === "/") { state = "code"; result += "  "; i += 1; continue; }
    else if (!["line", "block"].includes(state)) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (state === "regex") {
        if (c === "[" || c === "]") regexClass = c === "[";
        else if (c === "/" && !regexClass) state = "code";
      } else if (c === state) state = "code";
    }
    result += c === "\n" || c === "\r" ? c : " ";
  }
  return result;
}

function expressionEnd(mask, start, stops) {
  let depth = 0;
  for (let end = start; end < mask.length; end += 1) {
    const c = mask[end];
    if (!depth && stops.includes(c)) return end;
    depth += "([{".includes(c) ? 1 : ")]}".includes(c) ? -1 : 0;
  }
  return mask.length;
}
export function mutants(line, mask = codeMask(line)) {
  const result = new Set();
  const replace = (start, end, value) => result.add(line.slice(0, start) + value + line.slice(end));
  const flips = { "<": ">=", ">": "<=", "<=": ">", ">=": "<", "===": "!==", "!==": "===" };
  for (const match of mask.matchAll(/===|!==|<=|>=|<|>|\btrue\b|\bfalse\b/g)) {
    const token = match[0], start = match.index;
    if (flips[token] && (/[<>=!]/.test(mask[start - 1] ?? "") || /[<>=]/.test(mask[start + token.length] ?? ""))) continue;
    replace(start, start + token.length, flips[token] ?? (token === "true" ? "false" : "true"));
  }
  for (const match of mask.matchAll(/\bif\s*\(|\breturn\b/g)) {
    const condition = match[0].startsWith("if"), start = match.index + match[0].length;
    const end = expressionEnd(mask, start, condition ? ")" : ";}\r"), expression = line.slice(start, end).trim();
    if (condition ? end < mask.length : expression && expression !== "undefined") replace(start, end, condition ? `!(${line.slice(start, end)})` : " undefined");
  }
  return [...result];
}

function safePath(root, file) {
  if (!file || path.isAbsolute(file) || /^[A-Za-z]:/.test(file) || file.split(/[\\/]/).some((part) => !part || part === ".." || part === "." || part.toLowerCase() === ".git")) throw new Error(`unsafe mutation path: ${file}`);
  const target = path.resolve(root, file);
  for (let current = target; current !== root; current = path.dirname(current)) if (lstatSync(current, { throwIfNoEntry: false })?.isSymbolicLink()) throw new Error(`unsafe mutation symlink: ${file}`);
  return target;
}

function changedLines(worktree, base, siblings) {
  const untracked = new Set(names(git(worktree, "ls-files", "--others", "--exclude-standard", "-z")));
  const files = new Set([...names(git(worktree, "diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", base, "--")), ...untracked]);
  const result = [];
  for (const file of files) {
    if (!/\.(?:js|mjs|cjs)$/.test(file) || testFile(file)) continue;
    const source = readFileSync(safePath(worktree, file), "utf8");
    const sibling = file.replace(/\.(js|mjs|cjs)$/, ".test.$1");
    if (existsSync(path.join(worktree, sibling))) siblings.push(sibling);
    const lines = source.split("\n"), masks = codeMask(source).split("\n");
    const changed = new Set(untracked.has(file) ? lines.keys() : []);
    if (!untracked.has(file)) {
      const diff = git(worktree, "diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=0", base, "--", file);
      for (const hunk of diff.matchAll(/^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/gm)) {
        const start = Number(hunk[1]) - 1, count = hunk[2] === undefined ? 1 : Number(hunk[2]);
        for (let i = start; i < start + count; i += 1) changed.add(i);
      }
    }
    for (const i of changed) {
      const variants = mutants(lines[i], masks[i]);
      if (variants.length) result.push({ file, line: i + 1, variants, source, lines });
    }
  }
  return result;
}

/** Mirror dependency directories so workspace symlinks can resolve inside the snapshot. */
function dependencies(origin, target, relocate, deadline) {
  if (Date.now() >= deadline) throw new Error("dependency snapshot timed out");
  if (lstatSync(target, { throwIfNoEntry: false })) return;
  const stat = lstatSync(origin);
  if (stat.isDirectory()) {
    mkdirSync(target, { recursive: true });
    for (const name of readdirSync(origin)) dependencies(path.join(origin, name), path.join(target, name), relocate, deadline);
  } else if (stat.isSymbolicLink()) {
    const resolved = realpathSync(origin);
    symlinkSync(relocate(resolved), target, lstatSync(resolved).isDirectory() ? "junction" : "file");
  } else copyFileSync(origin, target, constants.COPYFILE_FICLONE);
}
function snapshot(worktree, checkout, files, deadline) {
  for (const file of names(git(worktree, "ls-files", "--deleted", "-z"))) rmSync(safePath(checkout, file), cleanup);
  const copies = files.map((file) => ({ source: safePath(worktree, file), destination: safePath(checkout, file) }));
  for (const { source, destination } of copies) {
    if (!lstatSync(source).isFile()) continue;
    mkdirSync(path.dirname(destination), { recursive: true }); copyFileSync(source, destination);
  }
  const relocate = (source) => {
    const relative = path.relative(worktree, source);
    return relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative) ? path.resolve(checkout, relative) : source;
  };
  const folders = new Set([""]);
  for (const file of files) for (let folder = path.dirname(file); folder !== "."; folder = path.dirname(folder)) folders.add(folder);
  for (const folder of folders) {
    const target = path.join(checkout, folder, "node_modules");
    let origin = path.join(worktree, folder, "node_modules");
    for (let parent = worktree; !folder && !existsSync(origin) && path.dirname(parent) !== parent;) {
      parent = path.dirname(parent); origin = path.join(parent, "node_modules");
    }
    if (!existsSync(origin) || existsSync(target)) continue;
    mkdirSync(path.dirname(safePath(checkout, path.relative(checkout, target))), { recursive: true });
    const resolved = realpathSync(origin), local = relocate(resolved), destination = local === resolved ? target : local;
    if (destination !== checkout) safePath(checkout, path.relative(checkout, destination));
    dependencies(resolved, destination, relocate, deadline);
    if (destination !== target) symlinkSync(destination, target, "junction");
  }
}

function runBounded(command, cwd, deadline) {
  if (Date.now() >= deadline) return Promise.resolve(null);
  return new Promise((resolve, reject) => {
    const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
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
  const deadline = Date.now() + budgetMs, empty = { survived: [], skippedLines: 0 };
  let root, checkout, lines = [];
  try {
    worktree = realpathSync(worktree);
    const siblings = [];
    lines = changedLines(worktree, base, siblings);
    if (!lines.length) return empty;
    const allFiles = [...new Set(names(git(worktree, "ls-files", "--cached", "--others", "--exclude-standard", "-z")))].filter((file) => existsSync(path.join(worktree, file)));
    const tests = [...new Set([...(files ?? Object.keys(readLockedTests(worktree) ?? {})), ...siblings])];
    if (!tests.length) { say("mutation: no test file; no mutation coverage"); return empty; }
    for (const file of tests) safePath(worktree, file);
    command ??= load(worktree).tests.command;
    root = mkdtempSync(path.join(os.tmpdir(), "qc-mutation-"));
    checkout = path.join(root, "checkout");
    git(worktree, "worktree", "add", "--detach", checkout, "HEAD");
    snapshot(worktree, checkout, allFiles, deadline);
    const argv = [...command, ...tests.map((file) => path.resolve(checkout, file))], baseline = await runBounded(argv, checkout, deadline);
    if (baseline !== 0) { say(`mutation: baseline ${baseline === null ? "timed out" : "failed"}; no mutation coverage`); return baseline === null ? { ...empty, skippedLines: lines.length } : empty; }
    const survived = []; let completed = 0;
    for (const entry of lines.slice(0, Math.min(10, Math.max(0, maxLines)))) {
      if (Date.now() >= deadline) break;
      const target = safePath(checkout, entry.file);
      let finished = true;
      try {
        for (const mutant of entry.variants) {
          writeFileSync(target, entry.lines.map((line, i) => i === entry.line - 1 ? mutant : line).join("\n"));
          const syntax = await runBounded([process.execPath, "--check", target], checkout, deadline);
          if (syntax !== 0) { finished = false; if (syntax === null) break; continue; }
          const status = await runBounded(argv, checkout, deadline);
          if (status === null) { finished = false; break; }
          if (status === 0) survived.push({ file: entry.file, line: entry.line, mutant });
        }
      } finally { writeFileSync(target, entry.source); }
      if (finished) completed += 1;
    }
    return { survived, skippedLines: lines.length - completed };
  } catch (error) {
    say(`mutation: ${error.message.replace(/[\r\n]+/g, " ")}; no mutation coverage`);
    return { ...empty, skippedLines: Date.now() >= deadline ? lines.length : 0 };
  } finally {
    if (checkout) try { git(worktree, "worktree", "remove", "--force", checkout); }
    finally { rmSync(root, cleanup); }
  }
}
