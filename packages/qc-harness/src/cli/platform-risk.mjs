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

// Keep literal offsets stable while masking exemptions and walking template expressions.
function scanLine(source) {
  const paths = source.split("");
  let optedOut = false;
  const mask = (start, end) => { paths.fill(" ", start, end); };
  const exempt = (start, end) => {
    const before = source.slice(0, start);
    const after = source.slice(end);
    const url = /^(?:https?:\/\/|node:)/.test(source.slice(start + 1));
    const requireCall = /\brequire\s*\(\s*$/.exec(before);
    const bareRequire = requireCall && !/[\w$.?]\s*$/.test(before.slice(0, requireCall.index));
    const specifier = /\b(?:import|export)\s+[^;"'`]*\bfrom\s*$|\bimport\s*$|\bimport\s*\(\s*$/.test(before) || bareRequire;
    const relativeUrl = /\bnew\s+URL\s*\(\s*$/.test(before) && /^\s*,\s*import\s*\.\s*meta\s*\.\s*url\s*\)/.test(after);
    return url || specifier || relativeUrl;
  };
  const walk = (start, inTemplate = false) => {
    let braces = 0;
    let i = start;
    while (i < source.length) {
      const char = source[i];
      if (source.startsWith("//", i)) {
        if (!inTemplate && /^\/\/ qc-platform-ok\s*$/.test(source.slice(i))) optedOut = true;
        return source.length;
      }
      if (source.startsWith("/*", i)) {
        const end = source.indexOf("*/", i + 2);
        i = end < 0 ? source.length : end + 2;
      } else if (char === '"' || char === "'") {
        const begin = i++;
        while (i < source.length && source[i] !== char) i += source[i] === "\\" ? 2 : 1;
        if (i < source.length) {
          i += 1;
          if (exempt(begin, i)) mask(begin, i);
        }
      } else if (char === "`") {
        const begin = i++;
        const raw = [];
        let segment = begin;
        while (i < source.length) {
          if (source[i] === "\\") i += 2;
          else if (source.startsWith("${", i)) {
            raw.push([segment, i + 2]);
            i = walk(i + 2, true);
            segment = i;
            if (source[i] === "}") i += 1;
          } else if (source[i] === "`") {
            raw.push([segment, ++i]);
            if (exempt(begin, i)) for (const [from, to] of raw) mask(from, to);
            break;
          } else i += 1;
        }
      } else if (char === "}" && inTemplate && braces === 0) return i;
      else {
        if (char === "{") braces += 1;
        if (char === "}") braces -= 1;
        i += 1;
      }
    }
    return i;
  };
  walk(0);
  return { paths: paths.join(""), optedOut };
}

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
      if (CODE_FILE.test(file)) {
        const { paths, optedOut } = scanLine(source);
        if (!optedOut) for (const [reason, pattern] of patterns) {
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
