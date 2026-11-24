// A branch scans added lines and file metadata for platform risks.
import { execFileSync } from "node:child_process";
import { appendFileSync } from "node:fs";

const CODE_FILE = /\.(?:[cm]?[jt]sx?|sh|bash|zsh|ps1|psm1|bat|cmd|py|go|rs|java|cs|[ch]|[ch]pp|rb|php|swift|kt|kts|scala|sql|tf|hcl|lua|ex|exs|vue|svelte|css|scss)$|(?:^|\/)(?:Dockerfile|Makefile)$/i;

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
  const add = (reason) => { if (CODE_FILE.test(file)) hits.push({ file, line, reason }); };
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
      const source = text.slice(1);
      if (CODE_FILE.test(file) && !/\/\/ qc-platform-ok\s*$/.test(source)) {
        // Mask only exempt literals; other reasons still inspect the original line.
        const paths = source.replace(/(["'`])(?:\\.|(?!\1)[^\\\n])*\1/g, (literal, quote, offset) => {
          const before = source.slice(0, offset);
          const after = source.slice(offset + literal.length);
          const url = /^(?:https?:\/\/|node:)/.test(literal.slice(1));
          const specifier = /\b(?:import|export)\s+[^;"'`]*\bfrom\s*$|\bimport\s*$|\b(?:import|require)\s*\(\s*$/.test(before);
          const relativeUrl = /\bnew\s+URL\s*\(\s*$/.test(before) && /^\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)/.test(after);
          return url || specifier || relativeUrl ? "" : literal;
        });
        for (const [reason, pattern] of patterns) {
          if (pattern.test(reason === "hard-coded path separator" ? paths : source)) add(reason);
        }
      }
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

export function runPlatformRisk(root, args = []) {
  if (!(args.length === 0 || (args.length === 2 && args[0] === "--base" && args[1] && !args[1].startsWith("-")))) {
    console.error("usage: qc platform-risk [--base <ref>]");
    return 1;
  }
  try {
    const hits = platformRisk(root, args[1]);
    const result = `risky=${hits.length > 0}\n`;
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, result);
    for (const { file, line, reason } of hits.slice(0, 10)) console.log(`${file}:${line} ${reason}`);
    process.stdout.write(result);
    return 0;
  } catch (error) {
    console.error(`qc platform-risk: ${String(error.message).replace(/\s+/g, " ")}`);
    return 1;
  }
}
