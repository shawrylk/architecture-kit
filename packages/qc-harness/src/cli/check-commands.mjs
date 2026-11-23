// A pipeline that runs repository commands after the architecture checks pass.

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { repoFiles } from "./repo-files.mjs";
import { execFileSync } from "node:child_process";
import { spawnCommand as spawn } from "./spawn-command.mjs";

// Quotes group arguments; shell expansion stays off, and Windows path separators stay literal.
function commandWords(command) {
  const words = [];
  let word = "";
  let quote = null;
  let started = false;
  for (let i = 0; i < command.length; i += 1) {
    const char = command[i];
    if (quote === "'") {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === "\\" && /[\\"'\s]/.test(command[i + 1] ?? "") && (quote === null || /[\\"]/.test(command[i + 1]))) {
      word += command[++i];
      started = true;
    } else if (quote !== null) {
      if (char === quote) quote = null;
      else word += char;
    } else if (char === '"' || char === "'") {
      quote = char;
      started = true;
    } else if (/\s/.test(char)) {
      if (started) words.push(word);
      word = "";
      started = false;
    } else {
      word += char;
      started = true;
    }
  }
  if (quote !== null) throw new Error("check command has an unterminated quote");
  if (started) words.push(word);
  if (!words[0]) throw new Error("check command must name an executable");
  return words;
}

export function changedFiles(root, base, sincePush, command = "qc e2e", affected = false) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let ref = base;
  if (sincePush) {
    ref = null;
    for (const candidate of ["@{push}", "@{upstream}"]) {
      try {
        ref = git("rev-parse", "--verify", "-q", candidate).trim();
        break;
      } catch {}
    }
    if (ref === null) {
      console.log(`WARN  no upstream for the branch; running with the merge base with ${base}`);
      ref = base;
    }
  }
  let mergeBase;
  try {
    mergeBase = git("merge-base", "--", "HEAD", ref).trim();
  } catch {
    console.log(`WARN  merge base with ${ref} is unavailable; running ${command} without file arguments`);
    return null;
  }
  return git("diff", "--cached", "--name-only", "-z", "--no-renames", ...(affected ? [] : ["--diff-filter=d"]), mergeBase, "--").split("\0").filter(Boolean);
}

export async function runCommand(root, command, files = []) {
  console.log(`RUN  ${command.replace(/[\r\n]+/g, " ")}`);
  try {
    const [bin, ...args] = commandWords(command);
    return await new Promise((resolve, reject) => {
      const child = spawn(bin, [...args, ...files], { cwd: root, shell: false, stdio: "inherit", windowsHide: true });
      child.on("error", reject);
      child.on("close", (code) => resolve(code ?? 1));
    });
  } catch (error) {
    console.error(`FAIL  ${command}: ${error.message}`);
    return 1;
  }
}

export async function runCheckCommands(config, { sincePush = false, affected = false, base = config.check.base } = {}) {
  const { commands } = config.check;
  const related = sincePush ? config.check.sincePush ?? config.check.related : config.check.related;
  if (affected || related !== null) {
    const files = changedFiles(config.root, base, sincePush, "related tests", affected);
    if (files === null || files.length > 0) {
      const code = related !== null ? await runCommand(config.root, related, files ?? []) : await affectedTests(config.root, files);
      if (code !== 0) return code;
    }
  }
  for (const command of commands) {
    const code = await runCommand(config.root, command);
    if (code !== 0) return code;
  }
  return 0;
}


async function affectedTests(root, changed) {
  const selected = changed === null ? null : await importingTests(root, changed);
  if (selected?.length && selected.join(" ").length < 24000) return runCommand(root, `"${process.execPath}" --test`, selected);
  const pkg = JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  if (!pkg.scripts?.test) { console.log("SKIP  no test script"); return 0; }
  const manager = existsSync(path.join(root, "pnpm-lock.yaml")) ? "pnpm" : existsSync(path.join(root, "yarn.lock")) ? "yarn" : "npm";
  return runCommand(root, `${manager} test`);
}

async function importingTests(root, changed) {
  const extension = /\.(?:[cm]?[jt]s|[jt]sx)$/;
  const isTest = (file) => /\.test\.(?:[cm]?[jt]s|[jt]sx)$/.test(file);
  if (changed.some((file) => !file.startsWith("packages/qc-harness/src/") || !extension.test(file) || !existsSync(path.join(root, file)))) return null;
  try {
    const files = (await repoFiles(root)).filter((file) => extension.test(file));
    const known = new Set(files), readers = new Map(), uncertainFiles = new Set();
    const tests = new Set(files.filter((file) => /^packages\/qc-harness\/src\/gates\/[^/]+\.test\.mjs$/.test(file)));
    const testTexts = new Map();
    for (const file of files) {
      const text = readFileSync(path.join(root, file), "utf8");
      if (isTest(file)) testTexts.set(file, text);
      let uncertain = false;
      const add = (value) => {
        if (/\\|\$\{/.test(value)) { uncertain = true; return; }
        if (value.startsWith(".")) {
          const target = path.posix.normalize(path.posix.join(path.posix.dirname(file), value));
          if (!known.has(target)) uncertain = true;
          else readers.set(target, [...(readers.get(target) ?? []), file]);
        } else if (!value.startsWith("node:")) uncertain = true;
      };
      // Retain original matches when comment stripping misreads regexes or nested templates.
      const stripped = text.replace(/(["'`])(?:\\[\s\S]|(?!\1)[^\\])*\1|\/\*[\s\S]*?\*\/|\/\/[^\r\n]*/g, (token) => token.startsWith("/") ? " " : token);
      for (const source of new Set([text, stripped])) {
        for (const match of source.matchAll(/\b(?:import|from)\s*(["'`])((?:\\[\s\S]|(?!\1)[^\\\r\n])*)\1/g)) add(match[2]);
        for (const match of source.matchAll(/\b(?:import|require)\s*\(\s*/g)) {
          const literal = /^(["'`])((?:\\[\s\S]|(?!\1)[^\\\r\n])*)\1\s*(?=[,)])/.exec(source.slice(match.index + match[0].length));
          if (literal) add(literal[2]);
          else uncertain = true;
        }
      }
      if (uncertain) uncertainFiles.add(file);
    }
    const namedTests = new Map();
    // Unknown loaders can read any changed module; cover their readers too, or run the full suite.
    for (const file of new Set([...changed, ...uncertainFiles])) {
      const seen = new Set([file]), queue = [file], covered = new Set();
      const sibling = file.replace(extension, (suffix) => `.test${suffix}`);
      if (known.has(sibling)) covered.add(sibling);
      for (const next of queue) {
        if (isTest(next)) covered.add(next);
        const basename = path.posix.basename(next);
        if (!namedTests.has(basename)) {
          const matches = new Set();
          for (const [test, text] of testTexts) if (text.includes(basename)) matches.add(test);
          namedTests.set(basename, matches);
        }
        for (const test of namedTests.get(basename)) covered.add(test);
        for (const reader of readers.get(next) ?? []) if (!seen.has(reader)) { seen.add(reader); queue.push(reader); }
      }
      if (!covered.size) return null;
      for (const test of covered) tests.add(test);
    }
    return [...tests].sort();
  } catch { return null; }
}
