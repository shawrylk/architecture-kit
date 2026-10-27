// Pipeline: record CI failures and apply the branch's lessons at workflow boundaries.
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, realpathSync } from "node:fs";
import path from "node:path";
import { appendRecord, ledgerFileOf, readLedger, shaMatches } from "./ledger.mjs";
import { runGhResult } from "./gh-run.mjs";
import { holdBranch, holdRefusal } from "./pause.mjs";
import { load } from "../config.mjs";

const sameHead = (a, b) => a === b || shaMatches(a, b);
const recordsOf = (root) => {
  const file = ledgerFileOf(root);
  return file ? readLedger(file) : [];
};

export function openFailures(root, branch) {
  const records = recordsOf(root);
  const resolved = new Set(records.filter((r) => r.type === "ci-resolution" && r.branch === branch).flatMap((r) => r.ids));
  return records.filter((r) => r.type === "ci-failure" && r.branch === branch && !resolved.has(r.id));
}

function testFile(location) {
  const file = location.replace(/:\d+(?::\d+)?$/, "").replaceAll("\\", "/").replace(/^file:\/\//, "").replace(/\/{2,}/g, "/");
  return file.replace(/^(?:.*?\/a\/([^/]+)\/(?:\1\/)?|(?:\/home\/runner|\/Users\/runner)\/work\/[^/]+\/[^/]+\/)/, "");
}

export function parseFailedLog(log) {
  const jobs = new Map();
  for (const raw of log.split(/\r?\n/)) {
    const fields = raw.split("\t");
    const job = fields.length >= 3 ? fields[0] : "CI job";
    const line = (fields.length >= 3 ? fields.slice(2).join("\t") : raw).replace(/^\S+Z\s+/, "");
    if (!jobs.has(job)) jobs.set(job, []);
    jobs.get(job).push(line);
  }
  const failures = [];
  for (const [job, lines] of jobs) {
    const os = /(?:windows|ubuntu|macos)-[\w.]+/i.exec(job)?.[0] ?? "unknown";
    const start = failures.length;
    for (let i = 0; i < lines.length; i += 1) {
      const match = /^\s*not ok \d+ - (.+)/.exec(lines[i]);
      if (!match) continue;
      const details = [];
      for (let j = i + 1; j < lines.length && !/^\s*(?:not ok|ok) \d+ - /.test(lines[j]); j += 1) details.push(lines[j]);
      const block = details.join("\n");
      if (/failureType:\s*['"]?subtestsFailed/.test(block)) continue;
      const location = /^\s*location:\s*['"]?(.*?)['"]?\s*$/m.exec(block)?.[1];
      const errorAt = details.findIndex((line) => /^\s*error:/.test(line));
      const value = errorAt < 0 ? null : details[errorAt].replace(/^\s*error:\s*/, "");
      const error = (value && /^[|>][-+]?\s*$/.test(value)
        ? details.slice(errorAt + 1).find((line) => line.trim())?.trim()
        : value?.replace(/^['"]|['"]$/g, "")) ?? lines.find((line) => /error|Error|failed/i.test(line)) ?? match[1];
      failures.push({ job, os, test: match[1].replace(/\s+#.*$/, ""), file: location ? testFile(location) : null, error });
    }
    if (failures.length === start && lines.some((line) => line.trim())) {
      failures.push({ job, os, test: job, file: null, error: lines.find((line) => /error|Error|failed/i.test(line)) ?? lines.find((line) => line.trim()) });
    }
  }
  return failures;
}

function readGh(args, root) {
  const result = runGhResult(args, { cwd: root, timeoutMs: 20_000 });
  if (result.status !== 0) throw new Error(result.stderr?.trim() || result.error?.message || `exit ${result.status}`);
  return result.stdout;
}

export function recordRun(root, { id, branch, head }, { gh = (args) => readGh(args, root), warn = console.error, repo } = {}) {
  const file = ledgerFileOf(root);
  if (!file) return [];
  let log;
  try {
    log = gh(["run", "view", String(id), "--log-failed", ...(repo ? ["-R", repo] : [])]);
    if (log === null) throw new Error("no answer");
  } catch (error) {
    warn(`ci-failures: gh failed: ${String(error.message).split(/\r?\n/)[0]}`);
    return null;
  }
  const records = recordsOf(root);
  const added = [];
  for (const failure of parseFailedLog(log)) {
    const key = JSON.stringify([String(id), branch, head, failure.job, failure.file, failure.test]);
    if (records.some((r) => r.type === "ci-failure" && r.id === key)) continue;
    const record = { type: "ci-failure", id: key, run: String(id), branch, head, ...failure };
    appendRecord(file, record);
    added.push(record);
  }
  if (added.some((failure) => repeatCount(root, branch, failure) >= 3)) holdBranch(root, branch, "the same CI test failed on three heads in a row");
  return added;
}

const identity = (r) => JSON.stringify([r.test, r.file, r.os]);

export function repeatCount(root, branch, failure) {
  const heads = new Map();
  for (const record of openFailures(root, branch)) {
    const head = [...heads.keys()].find((head) => sameHead(head, record.head)) ?? record.head;
    if (!heads.has(head)) heads.set(head, new Set());
    heads.get(head).add(identity(record));
  }
  let count = 0;
  for (const tests of [...heads.values()].reverse()) {
    if (!tests.has(identity(failure))) break;
    count += 1;
  }
  return count;
}

function section(text, name) {
  const lines = text.split(/\r?\n/);
  const start = lines.findIndex((line) => line.trim() === `## ${name}`);
  if (start < 0) return "";
  const end = lines.findIndex((line, i) => i > start && /^#{1,2}\s/.test(line));
  return lines.slice(start + 1, end < 0 ? undefined : end).join("\n");
}

export function ciBriefRefusal(root, branch, brief) {
  const failures = openFailures(root, branch);
  if (!failures.length) return null;
  const body = section(brief, "CI failures");
  const names = [...new Set(failures.map((r) => r.test))];
  const missing = names.filter((name) => {
    const start = body.indexOf(name);
    if (start < 0) return true;
    const end = Math.min(body.length, ...names.filter((other) => other !== name).map((other) => body.indexOf(other, start + name.length)).filter((i) => i >= 0));
    const next = body.slice(start + name.length, end).split(/\n(?=#{1,3}\s)/)[0];
    return !/^[ \t]*Cause:[ \t]*\S/m.test(next);
  });
  if (missing.length) return `The brief needs ## CI failures with each failed test and a Cause: line: ${missing.join(", ")}`;
  if (failures.some((r) => repeatCount(root, branch, r) >= 2)) {
    const diagnosis = section(brief, "Diagnosis");
    if (!/^[ \t]*Root cause:[ \t]*\S/im.test(diagnosis) || !/^[ \t]*Evidence:[ \t]*\S/im.test(diagnosis)) {
      return "The brief needs ## Diagnosis with Root cause: and Evidence: from the log and the code after two failing heads.";
    }
  }
  return null;
}

export function resolveFailures(root, branch, head, run) {
  const ids = openFailures(root, branch).filter((r) => !sameHead(r.head, head)
    && (run === undefined || !/^\d+$/.test(r.run) || BigInt(run) > BigInt(r.run))).map((r) => r.id);
  if (ids.length) appendRecord(ledgerFileOf(root), { type: "ci-resolution", branch, head, run, ids });
}

export function currentBranch(root) {
  return execFileSync("git", ["branch", "--show-current"], { cwd: root, encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function resolvedFailures(root, branch) {
  const records = recordsOf(root);
  const resolved = new Set(records.filter((r) => r.type === "ci-resolution" && r.branch === branch).flatMap((r) => r.ids));
  return records.filter((r) => r.type === "ci-failure" && r.branch === branch && resolved.has(r.id));
}

export function lessonRefusal(root, branch, text) {
  const missing = [...new Set(resolvedFailures(root, branch).map((r) => r.test))].filter((name) => {
    const body = section(text ?? "", name);
    return ["Symptom", "Cause", "Rule"].some((field) => !new RegExp(`^${field}:[ \\t]*\\S`, "m").test(body));
  });
  return missing.length ? `Merge guard: write a lesson with Symptom:, Cause:, and Rule: for: ${missing.join(", ")}` : null;
}

export function lessonRules(root, lessons) {
  let text;
  try {
    text = readFileSync(path.resolve(root, lessons.file), "utf8");
  } catch (error) {
    if (error.code === "ENOENT") return [];
    throw error;
  }
  return text.split(/\r?\n/).filter((line) => /^Rule:\s*\S/.test(line)).reverse().slice(0, 40);
}

export function rerunFailures(root, branch, lessons, { run = (command, options) => spawnSync(command, { ...options, shell: true, stdio: "inherit", windowsHide: true }), warn = console.error } = {}) {
  const files = [...new Set(openFailures(root, branch).map((r) => r.file).filter(Boolean))];
  if (!files.length) return 0;
  try {
    for (const file of files) {
      const relative = path.relative(realpathSync(root), realpathSync(path.resolve(root, file)));
      if (!/^[\w./ @+-]+$/.test(file) || path.isAbsolute(file) || relative.startsWith("..") || path.isAbsolute(relative)) {
        throw new Error(`unsafe test file ${JSON.stringify(file)}`);
      }
    }
    const command = `${lessons.rerun} ${files.map((file) => `"${file}"`).join(" ")}`;
    const result = run(command, { cwd: root });
    return result.status ?? 1;
  } catch (error) {
    warn(`ci-failures: cannot rerun: ${String(error.message).split(/\r?\n/)[0]}`);
    return 1;
  }
}

export function runCiFailures(root, argv, { gh = (args) => readGh(args, root), say = console.log, warn = console.error } = {}) {
  if (argv[0] === "--rerun" && (argv.length === 1 || (argv.length === 3 && argv[1] === "--branch" && argv[2]))) {
    try {
      const branch = argv[2] ?? currentBranch(root);
      const hold = holdRefusal(root, branch);
      if (hold) { warn(hold); return 5; }
      return rerunFailures(root, branch, load(root).lessons, { warn });
    } catch (error) {
      warn(`ci-failures: ${String(error.message).split(/\r?\n/)[0]}`);
      return 1;
    }
  }
  if (argv.length !== 2 || argv[0] !== "--run" || !/^\d+$/.test(argv[1])) {
    warn("usage: qc ci-failures --run <id> | --rerun [--branch <branch>]");
    return 1;
  }
  try {
    const run = JSON.parse(gh(["run", "view", argv[1], "--json", "headBranch,headSha,conclusion"]));
    if (!run.headBranch || !run.headSha) throw new Error("run has no branch or head");
    if (run.conclusion === "success") resolveFailures(root, run.headBranch, run.headSha, argv[1]);
    else if (recordRun(root, { id: argv[1], branch: run.headBranch, head: run.headSha }, { gh, warn }) === null) return 1;
    say(`CI records updated for ${run.headBranch}`);
    return 0;
  } catch (error) {
    warn(`ci-failures: gh failed: ${String(error.message).split(/\r?\n/)[0]}`);
    return 1;
  }
}
