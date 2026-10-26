// Keep the limit record separate so the runner and status command share one source.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function limitFileOf(env = process.env, tmp = os.tmpdir()) {
  return env.QC_CODEX_LIMIT_FILE ?? path.join(tmp, "architecture-kit", "codex-limit.json");
}

export function resetTimeOf(line, now) {
  const relative = /\bin\s+(.+)/i.exec(line);
  if (relative) {
    const units = { day: 86_400_000, hour: 3_600_000, minute: 60_000 };
    let duration = 0;
    for (const match of relative[1].matchAll(/\b(\d+)\s*(day|hour|minute)s?\b/gi)) {
      duration += Number(match[1]) * units[match[2].toLowerCase()];
    }
    const until = now + duration;
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

export function writeLimit(file, { until, source }, now = Date.now()) {
  const record = { until: new Date(until).toISOString(), source, recordedAt: new Date(now).toISOString() };
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, `${JSON.stringify(record)}\n`);
}

export function readLimit(file, now = Date.now()) {
  try {
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
