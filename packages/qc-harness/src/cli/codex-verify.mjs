// Brief preflight and runner-owned verification proof.
import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { ledgerFileOf, readLedger, shaMatches } from "./ledger.mjs";
import { redactOutput } from "./output-redaction.mjs";

/** Refuses ambiguous ownership and manifest changes without a dependency design. */
export function validatePaths(brief) {
  for (const [, value] of brief.matchAll(/^Paths:[ \t]*(.+)$/gm)) {
    if (/^none\.(?:\s|$)/i.test(value)) continue;
    const leftover = value.replace(/`[^`]+`/g, "").replace(/\band\b|,/g, "").trim();
    if (leftover) throw Object.assign(new Error(`Paths: name each path in backticks; unparsed text: "${leftover}"`), { refusal: "brief:paths" });
    for (const [, file] of value.matchAll(/`([^`]+)`/g)) {
      if (/(?:^|[\\/])(?:package\.json|pyproject\.toml|Cargo\.toml|go\.mod|[^\\/]+\.csproj)$/.test(file) && !/^## Design[ \t]*\r?$/m.test(brief)) {
        throw Object.assign(new Error(`## Design is required when Paths: names ${file}; list each added dependency there`), { refusal: "brief:design" });
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
    if (!commands.length || commands.some((command) => !command.trim()) || leftover) throw Object.assign(new Error(`${label}: name each command in backticks`), { refusal: `brief:${label.toLowerCase()}` });
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
    const lines = [];
    let nextLine = 0;
    let timedOut = false;
    let timer;
    const emitLine = (line, order = nextLine++) => {
      const text = line.trim() ? redactOutput(line.replace(/\r$/, "")) : "";
      lines.push({ text, order });
      lines.sort((a, b) => a.order - b.order);
      let blanks = 0;
      for (let index = 0; index < lines.length; index++) {
        blanks = lines[index].text ? 0 : blanks + 1;
        if (blanks > 10) lines.splice(index--, 1);
      }
      if (lines.length > 200) lines.shift();
    };
    const recorder = () => {
      let group = null;
      let blankLines = 0;
      let blankOrder = 0;
      const heldEntries = () => [
        ...(group ? [group] : []),
        ...Array.from({ length: blankLines }, (_, index) => ({ text: "", order: blankOrder + index })),
      ];
      const emit = (line) => {
        const entry = { text: line.replace(/\r$/, ""), order: nextLine++ };
        if (!entry.text.trim()) {
          if (!blankLines) blankOrder = entry.order;
          blankLines = Math.min(10, blankLines + 1);
          return;
        }
        const entries = heldEntries();
        const redacted = redactOutput([...entries.map(({ text }) => text), entry.text].join("\n")).split("\n");
        for (let index = 0; index < redacted.length - 1; index++) emitLine(redacted[index], entries[index].order);
        // Keep completion order when a held line is emitted after another stream's lines.
        group = { text: redacted.at(-1), order: entry.order };
        blankLines = 0;
      };
      let buffer = "";
      let end = "";
      let dropping = false;
      let prefix = "";
      const consume = (value, discard = false) => {
        const length = value.length;
        const inSpan = Boolean(end);
        let lastMarker = 0;
        if (discard && prefix) emit(prefix);
        let output = discard ? "" : prefix;
        prefix = "";
        while (value || end) {
          if (end) {
            const index = value.indexOf(end);
            if (index < 0) {
              if (!discard) prefix = output;
              return lastMarker;
            }
            value = value.slice(index + end.length);
            lastMarker = length - value.length;
            end = "";
          } else {
            const begin = /-----BEGIN ([A-Z ]*PRIVATE KEY)-----/.exec(value);
            if (!begin) {
              if (!discard) output += value;
              break;
            }
            if (discard) emit("[REDACTED]");
            else output += value.slice(0, begin.index) + "[REDACTED]";
            // Match the BEGIN label, as in output-redaction.mjs:7.
            end = `-----END ${begin[1]}-----`;
            value = value.slice(begin.index + begin[0].length);
            lastMarker = length - value.length;
          }
        }
        if (!discard && (output || !inSpan)) emit(output);
        return lastMarker;
      };
      return {
        record(chunk) {
          buffer += chunk;
          let newline;
          while ((newline = buffer.indexOf("\n")) >= 0) {
            const line = buffer.slice(0, newline);
            consume(line, dropping || newline >= 64 * 1024);
            buffer = buffer.slice(newline + 1);
            dropping = false;
          }
          if (buffer.length > 64 * 1024 || dropping) {
            // Retain enough overlap to recognize a BEGIN or matching END split across chunks.
            const lastMarker = consume(buffer, true);
            // Never scan a complete marker twice when it falls inside the overlap.
            buffer = buffer.slice(Math.max(lastMarker, buffer.length - 100));
            dropping = true;
          }
        },
        flush() {
          if (buffer) consume(buffer, dropping);
          if (prefix) emit(prefix);
          const entries = heldEntries();
          const redacted = redactOutput(entries.map(({ text }) => text).join("\n")).split("\n");
          for (let index = 0; index < entries.length && index < redacted.length; index++) emitLine(redacted[index], entries[index].order);
          group = null;
          blankLines = 0;
          buffer = "";
          prefix = "";
        },
      };
    };
    const stdout = recorder();
    const stderr = recorder();
    const child = spawn(command, [], { cwd, env, shell: true, detached: process.platform !== "win32", windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.setEncoding("utf8").on("data", stdout.record);
    child.stderr.setEncoding("utf8").on("data", stderr.record);
    child.on("error", (error) => stderr.record(error.message));
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
      stdout.flush();
      stderr.flush();
      if (timedOut) emitLine("command timed out");
      while (lines.length && !lines.at(-1).text.trim()) lines.pop();
      resolve({ status: timedOut ? 124 : status ?? 1, seconds: (Date.now() - started) / 1000, tail: lines.slice(-10).map(({ text }) => text).join("\n").trimEnd() });
    });
  });
}

/** A marker is accepted only after Verify and Live succeed and their proof has been saved. */
export async function verifyBrief(settings, { env = process.env, policy, outcome = {} } = {}) {
  outcome.verify = null;
  outcome.live = null;
  if (settings.review) return true;
  const { verify, live, report } = policy ?? verificationPolicy(readFileSync(settings.brief, "utf8"), settings);
  if (!verify.length && !live.length) return true;
  mkdirSync(path.dirname(report), { recursive: true });
  appendFileSync(report, "\n## Runner proof\n");
  for (const [commands, isolated, group] of [[verify, false, "verify"], [live, true, "live"]]) {
    let passed = 0;
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
      if (result.status !== 0) outcome[group] = "fail";
      else if (++passed === commands.length) outcome[group] = "pass";
      appendFileSync(report, `${redactOutput(command)}: exit ${result.status} in ${result.seconds} s\n${result.status !== 0 && result.tail ? redactOutput(result.tail) + "\n" : ""}`);
      if (result.status !== 0) return false;
    }
  }
  return true;
}
