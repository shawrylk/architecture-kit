// A branch scans added lines and file metadata for platform risks.
import { execFileSync } from "node:child_process";

const patterns = [
  ["fixed port", /\b(?:listen|connect)\s*\(\s*[1-9]\d{0,4}\b|\bport\s*[:=]\s*[1-9]\d{0,4}\b|https?:\/\/[^\s'"`]+:[1-9]\d{0,4}\b/i],
  ["hard-coded path separator", /["'`][^"'`\n]*(?:\/|\\\\)[^"'`\n]*["'`]/],
  ["CRLF", /\\r\\n|\r$/],
  ["EPERM", /\bEPERM\b/],
  ["process.platform", /\bprocess\s*\.\s*platform\b/],
];

export function riskHits(diff) {
  const hits = [];
  let file = "";
  let line = 1;
  let renamedFrom = "";
  const add = (reason) => hits.push({ file, line, reason });
  for (const text of diff.split("\n")) {
    if (text.startsWith("diff --git ")) {
      file = text.slice(text.lastIndexOf(" b/") + 3);
      line = 1;
      renamedFrom = "";
    } else if (text.startsWith("+++ b/")) file = text.slice(6);
    else if (text.startsWith("rename from ")) renamedFrom = text.slice(12);
    else if (text.startsWith("rename to ")) {
      file = text.slice(10);
      add("rename");
      if (renamedFrom !== file && renamedFrom.toLowerCase() === file.toLowerCase()) add("path case change");
    } else if (/^(?:new file mode|old mode|new mode) 120000$/.test(text)) add("symlink");
    else if (text.startsWith("@@")) line = Number(/\+(\d+)/.exec(text)?.[1] ?? 1);
    else if (text.startsWith("+") && !text.startsWith("+++")) {
      for (const [reason, pattern] of patterns) if (pattern.test(text.slice(1))) add(reason);
      line += 1;
    } else if (text.startsWith(" ")) line += 1;
  }
  return hits;
}

export function platformRisk(root, base = "origin/main", head = "HEAD") {
  const diff = execFileSync("git", ["-c", "core.quotePath=false", "diff", "--no-ext-diff", "--no-textconv", "--find-renames", "--unified=0", `${base}...${head}`, "--"], {
    cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024,
  });
  return riskHits(diff);
}
