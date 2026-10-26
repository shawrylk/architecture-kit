// A pipeline that runs repository commands after the architecture checks pass.

import { execFileSync } from "node:child_process";
import spawn from "cross-spawn";

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

function changedFiles(root, base, sincePush) {
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
    console.log(`WARN  merge base with ${ref} is unavailable; running related tests without file arguments`);
    return null;
  }
  return git("diff", "--cached", "--name-only", "-z", "--no-renames", "--diff-filter=d", mergeBase, "--").split("\0").filter(Boolean);
}

async function runCommand(root, command, files = []) {
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

export async function runCheckCommands(config, { sincePush = false } = {}) {
  const { commands, base } = config.check;
  const related = sincePush ? config.check.sincePush ?? config.check.related : config.check.related;
  if (related !== null) {
    const files = changedFiles(config.root, base, sincePush);
    if (files === null || files.length > 0) {
      const code = await runCommand(config.root, related, files ?? []);
      if (code !== 0) return code;
    }
  }
  for (const command of commands) {
    const code = await runCommand(config.root, command);
    if (code !== 0) return code;
  }
  return 0;
}
