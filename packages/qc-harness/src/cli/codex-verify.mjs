// Brief preflight and runner-owned verification proof.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerFileOf, readLedger, shaMatches } from "./ledger.mjs";

/** Refuses ambiguous ownership and manifest changes without a dependency design. */
export function validatePaths(brief) {
  for (const [, value] of brief.matchAll(/^Paths:[ \t]*(.+)$/gm)) {
    if (/^none\.(?:\s|$)/i.test(value)) continue;
    const leftover = value.replace(/`[^`]+`/g, "").replace(/\band\b|,/g, "").trim();
    if (leftover) throw new Error(`Paths: name each path in backticks; unparsed text: "${leftover}"`);
    for (const [, file] of value.matchAll(/`([^`]+)`/g)) {
      if (/(?:^|[\\/])(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^\\/]+\.csproj)$/.test(file) && !/^## Design[ \t]*\r?$/m.test(brief)) {
        throw new Error(`## Design is required when Paths: names ${file}; list each added dependency there`);
      }
    }
  }
}

/** Adds branch review history and the previous code report's runner proof to a review prompt. */
export function reviewContext(brief, settings, branch) {
  if (!settings.review) return "";
  const ledger = ledgerFileOf(settings.worktree);
  const reviews = (ledger ? readLedger(ledger) : []).filter((record) => record.type === "verdict"
    && ["codex", "branch"].includes(record.kind) && record.branch === branch && typeof record.sha === "string");
  const last = reviews.at(-1)?.sha;
  const explicit = /^Reviewed:[ \t]*(.*?)\s*$/m.exec(brief);
  const requested = explicit?.[1].replace(/^`(.*)`$/, "$1");
  if (explicit && !/^[0-9a-f]{7,40}$/.test(requested)) {
    throw new Error("Reviewed: use a 7 to 40 character lowercase hexadecimal SHA");
  }
  const sha = explicit ? reviews.findLast((record) => shaMatches(record.sha, requested))?.sha : last;
  if (explicit && !sha) throw new Error(`Reviewed: ${requested} is not a reviewed head of ${branch}; the last one is ${last ?? "none"}`);
  let context = sha ? `\n\nReviewed: ${sha}\nReview git diff ${sha}..HEAD.` : "";
  const proof = /^Proof:[ \t]*(.+)$/m.exec(brief)?.[1].trim().replace(/^`(.*)`$/, "$1");
  if (proof) {
    const report = readFileSync(path.resolve(path.dirname(settings.brief), proof), "utf8");
    const block = [...report.matchAll(/^## Runner proof[ \t]*\r?\n[\s\S]*?(?=^## |$(?![\s\S]))/gm)].at(-1)?.[0];
    if (block) context += `\n\n${block.trimEnd()}\nThe runner ran these commands. Do not run them again.`;
  }
  return context;
}

/** Reads ordered shell commands without silently dropping an unquoted command. */
export function commandsOf(brief, label) {
  return [...brief.matchAll(new RegExp(`^${label}:[ \t]*(.*)$`, "gm"))].flatMap(([, value]) => {
    if (value.trim() === "none") return [];
    const commands = [...value.matchAll(/`([^`]+)`/g)].map((match) => match[1]);
    const leftover = value.replace(/`[^`]+`/g, "").replace(/\band\b|,/g, "").trim();
    if (!commands.length || commands.some((command) => !command.trim()) || leftover) throw new Error(`${label}: name each command in backticks`);
    return commands;
  });
}

/** Captures runner-owned commands and their proof destination before the child can edit the brief. */
export function verificationPolicy(brief, settings) {
  const verify = commandsOf(brief, "Verify");
  const live = commandsOf(brief, "Live");
  const named = /^Report:[ \t]*(.+)$/m.exec(brief)?.[1].trim().replace(/^`(.*)`$/, "$1");
  const report = named ? path.resolve(path.dirname(settings.brief), named) : `${settings.progress}.report.md`;
  return { verify, live, report };
}

/** Runs through the platform shell, retaining a bounded output tail and enforcing a deadline. */
export function runShell(command, { cwd, env = process.env, timeout = 15 * 60 * 1000 }) {
  return new Promise((resolve) => {
    const started = Date.now();
    let tail = "";
    let timedOut = false;
    let timer;
    const record = (chunk) => { tail = (tail + chunk).slice(-64 * 1024); };
    const child = spawn(command, [], { cwd, env, shell: true, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", record);
    child.stderr.setEncoding("utf8").on("data", record);
    child.on("error", (error) => record(error.message));
    timer = setTimeout(() => {
      timedOut = true;
      if (process.platform === "win32") {
        spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, timeout: 5000, stdio: "ignore" });
      } else {
        try { process.kill(-child.pid, "SIGKILL"); } catch { child.kill("SIGKILL"); }
      }
    }, timeout);
    child.on("close", (status) => {
      clearTimeout(timer);
      if (timedOut) record("\ncommand timed out\n");
      resolve({ status: timedOut ? 124 : status ?? 1, seconds: (Date.now() - started) / 1000, tail: tail.trimEnd().split(/\r?\n/).slice(-10).join("\n") });
    });
  });
}

/** A marker is accepted only after Verify and Live succeed and their proof has been saved. */
export async function verifyBrief(settings, { env = process.env, policy } = {}) {
  if (settings.review) return true;
  const { verify, live, report } = policy ?? verificationPolicy(readFileSync(settings.brief, "utf8"), settings);
  if (!verify.length && !live.length) return true;
  mkdirSync(path.dirname(report), { recursive: true });
  appendFileSync(report, "\n## Runner proof\n");
  for (const [commands, isolated] of [[verify, false], [live, true]]) {
    for (const command of commands) {
      let folder;
      let result;
      try {
        folder = isolated ? mkdtempSync(path.join(os.tmpdir(), "qc-codex-live-")) : undefined;
        result = await runShell(command, { cwd: folder ?? settings.worktree, env: isolated ? { ...env, QC_WORKTREE: settings.worktree } : env });
      } catch (error) {
        result = { status: 1, seconds: 0, tail: error.message };
      } finally {
        if (folder) rmSync(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
      appendFileSync(report, `${command}: exit ${result.status} in ${result.seconds} s\n${result.status !== 0 && result.tail ? result.tail + "\n" : ""}`);
      if (result.status !== 0) return false;
    }
  }
  return true;
}
