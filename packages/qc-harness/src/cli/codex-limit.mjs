// Keep the limit record separate so the runner and status command share one source.
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export function limitFileOf(env = process.env, tmp = os.tmpdir()) {
  return env.QC_CODEX_LIMIT_FILE || path.join(tmp, "architecture-kit", `codex-${process.getuid?.() ?? os.userInfo().username}`, "codex-limit.json");
}

export function resetTimeOf(line, now) {
  const relative = /\bin\s+(.+)/i.exec(line);
  if (relative) {
    const units = { d: 86_400_000, h: 3_600_000, m: 60_000, s: 1000, ms: 1 };
    let duration = 0;
    for (const match of relative[1].matchAll(/(\d+(?:\.\d+)?)\s*(ms|days?|hours?|minutes?|seconds?|[dhms])(?=\d|\b)/gi)) {
      const unit = match[2].toLowerCase();
      duration += Number(match[1]) * units[unit === "ms" ? unit : unit[0]];
    }
    const until = now + Math.ceil(duration / 1000) * 1000;
    if (Number.isFinite(until) && until > now) return until;
  }
  const absolute = /\bat\s+(.+)/i.exec(line);
  if (!absolute) return null;
  const time = absolute[1].trim().replace(/\.$/, "").replace(/\b(\d+)(?:st|nd|rd|th)\b/gi, "$1");
  let until;
  if (/^\d{1,2}:\d{2}\s*[AP]M$/i.test(time)) {
    const today = new Date(now);
    until = Date.parse(`${today.toDateString()} ${time}`);
    if (until <= now) {
      today.setDate(today.getDate() + 1);
      until = Date.parse(`${today.toDateString()} ${time}`);
    }
  } else {
    until = Date.parse(time);
  }
  return Number.isFinite(until) && until > now ? until : null;
}

/** Branch: refuses a shared or redirected folder before the limit state is read or written. */
function validateLimitFolder(file) {
  const folder = lstatSync(path.dirname(file));
  if (!folder.isDirectory() || folder.isSymbolicLink() ||
    (process.platform !== "win32" && (folder.uid !== process.getuid() || (folder.mode & 0o022) !== 0))) {
    throw new Error(`unsafe limit folder: ${path.dirname(file)}`);
  }
}

export function writeLimit(file, { until, source }, now = Date.now()) {
  const record = { until: new Date(until).toISOString(), source, recordedAt: new Date(now).toISOString() };
  mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  validateLimitFolder(file);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    renameSync(temporary, file);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function readLimit(file, now = Date.now()) {
  try {
    validateLimitFolder(file);
    const record = JSON.parse(readFileSync(file, "utf8"));
    if (typeof record?.until !== "string" || !["codex", "default"].includes(record.source)) return null;
    const until = new Date(record.until);
    return until.getTime() > now ? { until, source: record.source } : null;
  } catch {
    return null;
  }
}

export function runCodexStatus(args, { env = process.env, tmp = os.tmpdir(), now = Date.now(), out = console.log } = {}) {
  const limit = readLimit(limitFileOf(env, tmp), now);
  if (limit) {
    const source = limit.source === "codex" ? "reset time from Codex" : "default: 60 minutes after the limit";
    out(`Codex: limited until ${limit.until.toISOString()} (${source})`);
  } else {
    out("Codex: free");
  }
  return 0;
}
